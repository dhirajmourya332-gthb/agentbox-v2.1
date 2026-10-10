#!/usr/bin/env bash
# agentbox bootstrap (docs/V2-ARCHITECTURE.md § 7). On a fresh Ubuntu 24.04, as root or a
# sudo-capable user, from a clone of the repo:
#
#   git clone <repo> agentbox && sudo ./agentbox/setup/bootstrap.sh [--host cloud|lima] [--user NAME]
#
# Installs only what setup needs: base packages, Node 22, git, ttyd, the Claude Code CLI, the agent
# user and directories, /etc/agentbox/config.yaml (kept if it exists) and the `agentbox` CLI. Then
# the setup guide (guide workstream) takes over; until it exists, the next steps are printed.
# Safe to re-run.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="" AGENT_USER="" ACCESS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --user) AGENT_USER="${2:?}"; shift 2 ;;
    --access) ACCESS="${2:?}"; shift 2 ;;
    --src) SRC="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" --src "$SRC" ${HOST:+--host "$HOST"} ${AGENT_USER:+--user "$AGENT_USER"} ${ACCESS:+--access "$ACCESS"}
fi

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
export DEBIAN_FRONTEND=noninteractive

. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "agentbox supports Ubuntu 24.04 (found ${PRETTY_NAME:-unknown})"
[ "${VERSION_ID:-}" = 24.04 ] || echo "warning: tested on Ubuntu 24.04; this is ${VERSION_ID:-unknown}" >&2

# --- where are we, and as whom do agents run? --------------------------------------------------------
CONFIG=/etc/agentbox/config.yaml
if [ -z "$HOST" ]; then
  if [ -d /mnt/agentbox-src ]; then HOST=lima; else HOST=cloud; fi
fi
[[ "$HOST" =~ ^(cloud|lima)$ ]] || die "--host must be cloud or lima"
if [ -z "$AGENT_USER" ]; then
  if [ -f "$CONFIG" ]; then AGENT_USER="$(sed -n 's/^user:[[:space:]]*\([a-z_][a-z0-9_-]*\).*/\1/p' "$CONFIG" | head -1)"; fi
  # Lima: agents run as the login user (as before v2); cloud: a dedicated `agentbox` user.
  if [ -z "$AGENT_USER" ]; then
    if [ "$HOST" = lima ]; then AGENT_USER="${SUDO_USER:-$(logname 2>/dev/null || echo agentbox)}"; else AGENT_USER=agentbox; fi
  fi
fi
[[ "$AGENT_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$AGENT_USER" != root ] || die "bad agent user: $AGENT_USER"
# Lima reaches the portal through its localhost port forwards; cloud starts on Tailscale.
[ -n "$ACCESS" ] || { [ "$HOST" = lima ] && ACCESS=ssh-tunnel || ACCESS=tailscale; }
echo "agentbox bootstrap · host $HOST · agent user $AGENT_USER · access $ACCESS · source $SRC"

# --- 1. base packages, Node 22, git, ttyd ---------------------------------------------------------------
say "base packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg git jq rsync unzip python3 sudo iproute2 netcat-openbsd ttyd >/dev/null
# Ubuntu's ttyd package starts a ttyd on all interfaces: never.
if [ -d /run/systemd/system ]; then systemctl disable --now ttyd.service >/dev/null 2>&1 || true; fi

say "node 22"
if ! have node || [[ "$(node -v)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

# --- 2. the agent user, directories, config -----------------------------------------------------------
say "agent user $AGENT_USER"
if ! id "$AGENT_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group "$AGENT_USER"
  echo "created $AGENT_USER"
fi
AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"

say "config $CONFIG"
install -d -m 0755 /etc/agentbox
if [ -f "$CONFIG" ]; then
  echo "kept the existing config"
else
  sed -e "s|@HOST@|$HOST|" -e "s|@ACCESS@|$ACCESS|" -e "s|@USER@|$AGENT_USER|" -e "s|@SRC@|$SRC|" \
    "$SRC/setup/config.default.yaml" > "$CONFIG.tmp"
  install -m 0644 -o root -g root "$CONFIG.tmp" "$CONFIG" && rm -f "$CONFIG.tmp"
  echo "wrote $CONFIG"
fi

# --- 3. the agentbox CLI -------------------------------------------------------------------------------
say "agentbox CLI"
install -d -m 0755 /opt/agentbox /opt/agentbox/cli
rsync -a --delete --exclude node_modules "$SRC/cli/" /opt/agentbox/cli/
(cd /opt/agentbox/cli && npm install --omit=dev --no-audit --no-fund --loglevel=error)
chmod 0755 /opt/agentbox/cli/agentbox.mjs
ln -sf /opt/agentbox/cli/agentbox.mjs /usr/local/bin/agentbox
install -m 0755 "$SRC/setup/modules/core/bin/agentbox-check-loopback" /usr/local/bin/agentbox-check-loopback
agentbox config get host >/dev/null || die "the CLI can't read $CONFIG"

cfg() { agentbox config get "$1"; }
say "directories"
for key in agents work skills team; do install -d -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" "$(cfg "paths.$key")"; done
install -d -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" "$(cfg paths.app)"
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$(cfg paths.data)" "$(cfg paths.secrets)"
if ! sudo -u "$AGENT_USER" test -r "$SRC/setup/modules/core/module.yaml"; then
  echo "warning: $AGENT_USER can't read $SRC; clone the repo somewhere it can (e.g. /opt/agentbox/src)" >&2
fi

# --- the Claude Code CLI (official installer, for the agent user) ---------------------------------------
say "claude code"
sudo -u "$AGENT_USER" -H bash -lc 'command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || curl -fsSL https://claude.ai/install.sh | bash >/dev/null'
sudo -u "$AGENT_USER" -H bash -lc 'PATH="$HOME/.local/bin:$PATH" claude --version' || echo "warning: claude isn't working yet" >&2

# --- 4. GUIDE HOOK (guide workstream) -------------------------------------------------------------------
# The guide (guide/) installs itself and starts on 127.0.0.1:<ports.guide>. Its installer is
# guide/install.sh, run as root with the same environment the module scripts get.
GUIDE_PORT="$(cfg ports.guide)"
if [ -x "$SRC/guide/install.sh" ]; then
  say "setup guide"
  AGENTBOX_CONFIG="$CONFIG" AGENTBOX_SRC="$SRC" AGENTBOX_USER="$AGENT_USER" AGENTBOX_HOME="$AGENT_HOME" \
    bash "$SRC/guide/install.sh"
  GUIDE=1
else
  GUIDE=0
fi
# --- end GUIDE HOOK ---------------------------------------------------------------------------------------

say "bootstrap done"
if [ "$GUIDE" = 1 ]; then
  # Start the guide and print its one-time link (lima: host/lima/up.sh prints it with the Mac port).
  if [ "$HOST" = cloud ]; then agentbox guide --tunnel || echo "warning: the guide didn't start: journalctl -u agentbox-guide -n 50" >&2
  else agentbox guide || echo "warning: the guide didn't start: journalctl -u agentbox-guide -n 50" >&2; fi
  echo "A new link any time: agentbox guide   ·   stop it: agentbox guide stop"
else
  cat <<EOF
The setup guide isn't in this tree yet. Next steps, by hand (as $AGENT_USER or with sudo):
  agentbox module list                          what's on and off
  sudo agentbox config set modules.<id> true    choose modules
  sudo agentbox module install --enabled        install them in order (prints YOUR TURN steps)
  agentbox status                               checks, services, listeners
  sudo agentbox selftest                        the security self-test
EOF
fi
