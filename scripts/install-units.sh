#!/usr/bin/env bash
# v2: systemd units belong to the modules (setup/modules/<id>/units). This re-installs the
# enabled modules' units and scripts inside the VM:  host/lima/shell.sh sudo agentbox module install --enabled
exec "$(dirname "$0")/../host/lima/shell.sh" "$@" sudo agentbox module install --enabled
