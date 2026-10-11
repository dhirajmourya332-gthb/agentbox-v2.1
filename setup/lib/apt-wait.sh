# wait_for_apt: wait, with a clear progress line, while another process holds the apt/dpkg lock.
# Sourced by setup/lib/common.sh (every module script), setup/bootstrap.sh, guide/install.sh and the
# access module. Call it right before every apt-get / dpkg action.
#
# A fresh Ubuntu VM runs unattended-upgrades on first boot and holds the dpkg lock for minutes.
# apt-get would wait silently (bootstrap sets DPkg::Lock::Timeout) or fail; this prints, every 15 s,
#   ⏳ Waiting for Ubuntu's automatic security updates to finish (…) — 3 min elapsed, up to 15 min · now: Setting up …
# The setup guide recognises the "⏳ " prefix and shows it as a calm "waiting" badge, not an error.
# Gives up after 15 minutes with an actionable error (returns 1).
#
# Tunables (tests): AGENTBOX_APT_LOCKS (space-separated lock files), AGENTBOX_APT_WAIT_MAX (s, 900),
# AGENTBOX_APT_WAIT_EVERY (s between lines, 15), AGENTBOX_APT_WAIT_POLL (s between checks, 2),
# AGENTBOX_APT_UU_LOG (unattended-upgrades' dpkg log).
# shellcheck shell=bash

APT_WAIT_MARK="⏳"

# PIDs holding any of the lock files open (fuser, from psmisc). Without fuser: the usual holders.
_apt_lock_pids() {
  local locks="${AGENTBOX_APT_LOCKS:-/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock}"
  local f pids=""
  if command -v fuser >/dev/null 2>&1; then
    for f in $locks; do
      [ -e "$f" ] || continue
      pids="$pids $(fuser "$f" 2>/dev/null | tr -cs '0-9' ' ')"
    done
  elif [ -z "${AGENTBOX_APT_LOCKS:-}" ] && command -v pgrep >/dev/null 2>&1; then
    pids="$(pgrep -d ' ' -f '(^|/)(unattended-upgrade|apt-get|apt|aptitude|dpkg)( |$)|apt\.systemd\.daily' 2>/dev/null || true)"
  fi
  local p out=""
  for p in $pids; do
    [ "$p" = "$$" ] && continue
    case " $out " in *" $p "*) ;; *) out="$out $p" ;; esac
  done
  printf '%s' "${out# }"
}

# "45 s" / "3 min" / "3 min 10 s"
_apt_dur() {
  local s="$1"
  if [ "$s" -lt 60 ]; then printf '%s s' "$s"
  elif [ $((s % 60)) -eq 0 ] || [ "${2:-}" = short ]; then printf '%s min' $((s / 60))
  else printf '%s min %s s' $((s / 60)) $((s % 60)); fi
}

# The package unattended-upgrades is on right now ("Setting up libssl3t64:amd64 (3.0.13-0ubuntu3.5)").
_apt_uu_now() {
  local log="${AGENTBOX_APT_UU_LOG:-/var/log/unattended-upgrades/unattended-upgrades-dpkg.log}"
  [ -r "$log" ] || return 0
  tail -n 200 "$log" 2>/dev/null | grep -E '^(Setting up|Unpacking|Preparing to unpack|Processing triggers for|Removing) ' | tail -n 1 \
    | sed -e 's/ \.\.\.$//' -e 's/\.\.\.$//' | cut -c1-120
}

# Who holds the lock, in words.
_apt_who() {
  local p comm names="" uu=0
  for p in $1; do
    comm="$(ps -o comm= -p "$p" 2>/dev/null | head -1)"; comm="${comm##*/}"; comm="${comm// /}"
    [ -n "$comm" ] || continue
    case "$comm" in unattended-upgr*|apt.systemd.dai*) uu=1 ;; esac
    case " $names " in *" $comm "*) ;; *) names="$names $comm" ;; esac
  done
  if [ "$uu" = 1 ]; then echo "uu"; else echo "${names# }"; fi
}

wait_for_apt() {
  local max="${AGENTBOX_APT_WAIT_MAX:-900}" every="${AGENTBOX_APT_WAIT_EVERY:-15}" poll="${AGENTBOX_APT_WAIT_POLL:-2}"
  local pids start now elapsed last=-1 who now_pkg line waited=0
  pids="$(_apt_lock_pids)"
  [ -n "$pids" ] || return 0
  start="$(date +%s)"
  while [ -n "$pids" ]; do
    now="$(date +%s)"; elapsed=$((now - start))
    if [ "$elapsed" -ge "$max" ]; then
      who="$(_apt_who "$pids")"
      [ "$who" = uu ] && who="unattended-upgrades"
      printf 'error: the package manager has been busy for %s (held by %s, pid %s).\n' "$(_apt_dur "$elapsed" short)" "${who:-another process}" "$pids" >&2
      printf '  Wait for it to finish (watch: sudo tail -f /var/log/unattended-upgrades/unattended-upgrades-dpkg.log), then Retry.\n' >&2
      printf '  If it is stuck: sudo systemctl stop unattended-upgrades (or end that process), then Retry.\n' >&2
      return 1
    fi
    if [ "$last" -lt 0 ] || [ $((elapsed - last)) -ge "$every" ]; then
      last="$elapsed"
      who="$(_apt_who "$pids")"
      if [ "$who" = uu ]; then
        line="$APT_WAIT_MARK Waiting for Ubuntu's automatic security updates to finish (unattended-upgrades is installing updates; this is normal on a new VM)"
        now_pkg="$(_apt_uu_now)"
      else
        line="$APT_WAIT_MARK Waiting for another package manager to finish (${who:-a process} holds the apt/dpkg lock)"
        now_pkg=""
      fi
      line="$line — $(_apt_dur "$elapsed" short) elapsed, up to $(_apt_dur "$max" short)"
      [ -z "$now_pkg" ] || line="$line · now: $now_pkg"
      printf '%s\n' "$line"
    fi
    waited=1
    sleep "$poll"
    pids="$(_apt_lock_pids)"
  done
  [ "$waited" = 0 ] || printf '✔ The package manager is free again (waited %s); continuing\n' "$(_apt_dur $(( $(date +%s) - start )))"
  return 0
}
