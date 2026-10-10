#!/usr/bin/env bash
# Sync the repo (read-only mount) into the VM's app, build, restart.
#   host/lima/deploy.sh [--instance NAME] [--force]
source "$(dirname "$0")/lib.sh"
[ "$(vm_status)" = Running ] || { echo "error: VM $VM_NAME isn't running (host/lima/start.sh)" >&2; exit 1; }
# Refresh the CLI from the mount first, so `agentbox update` is the current one.
vm sudo bash -c "rsync -a --delete --exclude node_modules $SRC_MOUNT/cli/ /opt/agentbox/cli/ && cd /opt/agentbox/cli && npm install --omit=dev --no-audit --no-fund --loglevel=error"
vm sudo agentbox update "${ARGS[@]+"${ARGS[@]}"}"
