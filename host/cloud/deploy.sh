#!/usr/bin/env bash
# cloud host: update in place on the VM. `git pull` the source (as its owner), then build and restart.
# Run by `sudo agentbox update` (which first refuses while agents are busy, unless --force).
set -euo pipefail
cfg() { agentbox config get "$1" 2>/dev/null || true; }
SRC="${AGENTBOX_SRC:-$(cfg paths.src)}"
[ "$(id -u)" -eq 0 ] || { echo "error: run via: sudo agentbox update" >&2; exit 1; }
if [ -d "$SRC/.git" ]; then
  owner="$(stat -c %U "$SRC")"
  echo "==> git pull ($SRC, as $owner)"
  sudo -u "$owner" -H git -C "$SRC" pull --ff-only
else
  echo "warning: $SRC isn't a git clone; deploying it as is" >&2
fi
# Refresh the CLI too (it lives outside the app).
rsync -a --delete --exclude node_modules "$SRC/cli/" /opt/agentbox/cli/
(cd /opt/agentbox/cli && npm install --omit=dev --no-audit --no-fund --loglevel=error)
exec bash "$SRC/setup/lib/deploy-app.sh"
