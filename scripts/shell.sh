#!/usr/bin/env bash
# Open a shell (or run a command) inside the agentbox VM.
source "$(dirname "$0")/env.sh"
if [ $# -eq 0 ]; then exec "$LIMACTL" shell --workdir /work "$VM_NAME"; fi
vm "$@"
