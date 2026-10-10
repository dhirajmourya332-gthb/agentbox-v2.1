#!/usr/bin/env bash
# Stop the VM cleanly; refuses while agents are working.   host/lima/stop.sh [--instance NAME] [--force]
source "$(dirname "$0")/lib.sh"
if [ "$(vm_status)" != Running ]; then echo "VM $VM_NAME isn't running."; exit 0; fi
if [ "${ARGS[0]:-}" != --force ]; then
  busy="$(busy_count)"
  if [ "${busy:-0}" -gt 0 ]; then
    echo "error: $busy agent task(s) running or queued; stopping would interrupt them." >&2
    echo "Wait, use Pause all in the UI, or rerun with --force." >&2
    exit 1
  fi
fi
echo "==> stopping VM $VM_NAME"
"$LIMACTL" stop "$VM_NAME" >"$LIMA_HOME/$VM_NAME/agentbox-stop.log" 2>&1
echo "==> stopped. Start again with host/lima/start.sh --instance $VM_NAME"
