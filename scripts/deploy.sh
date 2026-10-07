#!/usr/bin/env bash
# Copy server + web from the read-only repo mount into /opt/agentbox/app, build, restart.
source "$(dirname "$0")/env.sh"

# A restart kills running agent turns. Refuse unless nothing is running (or --force).
if [ "${1:-}" != "--force" ]; then
  busy="$(curl -sf localhost:7700/api/tasks 2>/dev/null | python3 -c 'import sys, json; print(sum(t["status"] in ("running", "queued") for t in json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  if [ "${busy:-0}" -gt 0 ]; then
    echo "error: $busy agent task(s) running or queued; a deploy would interrupt them. Wait, or rerun with --force." >&2
    exit 1
  fi
fi

echo "==> deploying app"
vm bash -lc "
  set -euo pipefail
  APP=/opt/agentbox/app
  rsync -a --delete --exclude node_modules $SRC_MOUNT/server/ \$APP/server/
  rsync -a --delete --exclude node_modules --exclude dist $SRC_MOUNT/web/ \$APP/web/
  cd \$APP/server && npm install --no-audit --no-fund --loglevel=error
  cd \$APP/web && npm install --no-audit --no-fund --loglevel=error && npx vite build --logLevel error
"
vm sudo systemctl restart agentbox-web
