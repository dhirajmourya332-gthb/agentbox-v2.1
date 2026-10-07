#!/usr/bin/env bash
# Copy server + web from the read-only repo mount into /opt/agentbox/app, build, restart.
source "$(dirname "$0")/env.sh"

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
