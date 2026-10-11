#!/usr/bin/env bash
# Copy the server and web app from the source tree into paths.app, install, build, restart the
# portal. Run as root (agentbox update; core's install.sh). Used by every host: on cloud after
# `git pull` (host/cloud/deploy.sh), on lima straight from the read-only mount.
#
# The setup guide (guide/) is never touched while it runs: core's install runs this in the middle
# of guided setup, and replacing or restarting the guide then cuts the owner's page and the setup
# agent off mid-step. A running guide is updated with `agentbox guide restart` (guide/install.sh:
# sync, build, restart; sessions and the setup agent's progress survive it). A guide that is
# installed but stopped is updated here.
set -euo pipefail

guide_running() { [ -d "${AGENTBOX_SYSTEMD_RUN:-/run/systemd/system}" ] && systemctl is-active --quiet agentbox-guide; }
guide_installed() { [ -f "${AGENTBOX_GUIDE_UNIT:-/etc/systemd/system/agentbox-guide.service}" ]; }

# Update <app>/guide unless the guide is running. Prints what it did.
sync_guide() {
  [ -f "$SRC/guide/install.sh" ] || return 0
  if guide_running; then
    echo "==> the setup guide is running: not updated now (that would restart it mid-setup)"
    echo "    apply it later with: agentbox guide restart"
  elif guide_installed; then
    echo "==> updating the setup guide (it isn't running)"
    AGENTBOX_SRC="$SRC" AGENTBOX_USER="$AGENT_USER" bash "$SRC/guide/install.sh"
  fi
}

main() {
  cfg() { agentbox config get "$1" 2>/dev/null || true; }
  SRC="${AGENTBOX_SRC:-$(cfg paths.src)}"
  APP="$(cfg paths.app)"; APP="${APP:-/opt/agentbox/app}"
  AGENT_USER="${AGENTBOX_USER:-$(cfg user)}"
  [ -d "$SRC/server" ] || { echo "error: no server/ under $SRC" >&2; exit 1; }
  [ "$(id -u)" -eq 0 ] || { echo "error: run as root (sudo agentbox update)" >&2; exit 1; }

  echo "==> deploying $SRC → $APP"
  install -d -o "$AGENT_USER" -g "$AGENT_USER" "$APP" "$APP/server" "$APP/web"
  rsync -a --delete --exclude node_modules --exclude data "$SRC/server/" "$APP/server/"
  rsync -a --delete --exclude node_modules --exclude dist "$SRC/web/" "$APP/web/"
  chown -R "$AGENT_USER:$AGENT_USER" "$APP/server" "$APP/web"

  sudo -u "$AGENT_USER" -H bash -lc "
    set -euo pipefail
    cd '$APP/server' && npm install --no-audit --no-fund --loglevel=error
    cd '$APP/web' && npm install --no-audit --no-fund --loglevel=error && npx vite build --logLevel error
  "

  sync_guide

  if [ -d /run/systemd/system ] && [ -f /etc/systemd/system/agentbox-web.service ]; then
    systemctl restart agentbox-web
    echo "==> restarted agentbox-web"
  fi
}

# Sourced (tests) → only the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
