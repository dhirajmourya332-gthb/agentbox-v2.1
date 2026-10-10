#!/usr/bin/env bash
# Install the setup guide (docs/GUIDE.md). Run as root by setup/bootstrap.sh (its GUIDE HOOK), with
# AGENTBOX_CONFIG, AGENTBOX_SRC, AGENTBOX_USER and AGENTBOX_HOME set; safe to re-run.
#   - build tools for node-pty (compiled here: it has no prebuilt Linux binaries);
#   - <paths.app>/guide from the source tree, its npm packages, the built page (guide/dist);
#   - /etc/systemd/system/agentbox-guide.service (not enabled at boot).
# It starts nothing; `agentbox guide` does (bootstrap runs it at the end). A guide that is already
# running is restarted so it picks up the new code.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
CONFIG="${AGENTBOX_CONFIG:-/etc/agentbox/config.yaml}"
cfg() { AGENTBOX_CONFIG="$CONFIG" agentbox config get "$1" 2>/dev/null || true; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root (setup/bootstrap.sh runs this)"

SRC="${AGENTBOX_SRC:-$(cfg paths.src)}"
AGENT_USER="${AGENTBOX_USER:-$(cfg user)}"
AGENT_HOME="${AGENTBOX_HOME:-$(getent passwd "$AGENT_USER" | cut -d: -f6)}"
APP="$(cfg paths.app)"; APP="${APP:-/opt/agentbox/app}"
DATA="$(cfg paths.data)"; DATA="${DATA:-/opt/agentbox/data}"
PORT="$(cfg ports.guide)"; PORT="${PORT:-7699}"
[ -f "$SRC/guide/server.ts" ] || die "no guide/ under $SRC"
if [ -z "$AGENT_USER" ] || ! id "$AGENT_USER" >/dev/null 2>&1; then die "no agent user ($AGENT_USER)"; fi

echo "--> build tools for the terminal (node-pty)"
missing=()
for p in make g++ python3; do command -v "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends build-essential python3 >/dev/null
fi

echo "--> $APP/guide"
install -d -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" "$APP" "$APP/guide"
rsync -a --delete --exclude node_modules --exclude dist "$SRC/guide/" "$APP/guide/"
chown -R "$AGENT_USER:$AGENT_USER" "$APP/guide"
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA" "$DATA/guide" "$DATA/guide/tokens"

echo "--> npm packages and the page (a few minutes the first time)"
sudo -u "$AGENT_USER" -H bash -lc "
  set -euo pipefail
  cd '$APP/guide'
  npm install --no-audit --no-fund --loglevel=error
  npx vite build --logLevel error
"

echo "--> agentbox-guide.service"
sed -e "s|@USER@|$AGENT_USER|g" -e "s|@HOME@|$AGENT_HOME|g" -e "s|@APP@|$APP|g" -e "s|@DATA@|$DATA|g" \
    -e "s|@CONFIG@|$CONFIG|g" -e "s|@GUIDE_PORT@|$PORT|g" \
    "$SRC/guide/agentbox-guide.service" > /etc/systemd/system/agentbox-guide.service.tmp
chmod 0644 /etc/systemd/system/agentbox-guide.service.tmp
mv -f /etc/systemd/system/agentbox-guide.service.tmp /etc/systemd/system/agentbox-guide.service
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  if systemctl is-active --quiet agentbox-guide; then systemctl restart agentbox-guide; echo "    restarted the running guide"; fi
fi
echo "--> the guide is installed: run 'agentbox guide' to start it and get its link"
