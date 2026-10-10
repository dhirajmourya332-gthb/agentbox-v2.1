#!/usr/bin/env bash
# Copy the server and web app from the source tree into paths.app, install, build, restart the
# portal. Run as root (agentbox update; core's install.sh). Used by every host: on cloud after
# `git pull` (host/cloud/deploy.sh), on lima straight from the read-only mount.
set -euo pipefail
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
# Hook for the guide workstream: guide/ is deployed the same way when it exists.
if [ -d "$SRC/guide" ]; then rsync -a --delete --exclude node_modules --exclude dist "$SRC/guide/" "$APP/guide/"; fi
chown -R "$AGENT_USER:$AGENT_USER" "$APP"

sudo -u "$AGENT_USER" -H bash -lc "
  set -euo pipefail
  cd '$APP/server' && npm install --no-audit --no-fund --loglevel=error
  cd '$APP/web' && npm install --no-audit --no-fund --loglevel=error && npx vite build --logLevel error
"

if [ -d /run/systemd/system ] && [ -f /etc/systemd/system/agentbox-web.service ]; then
  systemctl restart agentbox-web
  echo "==> restarted agentbox-web"
fi
