#!/usr/bin/env bash
# Copy server + web from the read-only repo mount into /opt/agentbox/app and restart.
source "$(dirname "$0")/env.sh"

echo "==> deploying app"
vm bash -lc "
  set -euo pipefail
  rsync -a --delete --exclude node_modules $SRC_MOUNT/server/ /opt/agentbox/app/server/
  rsync -a --delete $SRC_MOUNT/web/ /opt/agentbox/app/web/
  cd /opt/agentbox/app/server && npm install --no-audit --no-fund --loglevel=error
"
vm sudo systemctl restart agentbox-web
