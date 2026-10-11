#!/usr/bin/env bash
# v2: the phone gateway is the `mobile` integration (setup/modules/mobile), installed inside the VM after
# the access module has put the VM on your tailnet:
#   host/lima/shell.sh [--instance NAME] sudo agentbox integration connect mobile
exec "$(dirname "$0")/../host/lima/shell.sh" "$@" sudo agentbox integration connect mobile
