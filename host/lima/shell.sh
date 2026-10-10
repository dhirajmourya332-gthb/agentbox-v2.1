#!/usr/bin/env bash
# Open a shell (or run a command) inside the VM.   host/lima/shell.sh [--instance NAME] [cmd...]
source "$(dirname "$0")/lib.sh"
if [ ${#ARGS[@]} -eq 0 ]; then exec "$LIMACTL" shell --workdir /work "$VM_NAME"; fi
vm "${ARGS[@]}"
