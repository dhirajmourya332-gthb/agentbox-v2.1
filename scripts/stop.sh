#!/usr/bin/env bash
# Stop agentbox cleanly (e.g. before shutting down the Mac). Refuses while agents are working,
# since stopping would cut their turns off. Usage: ./scripts/stop.sh [--force]
source "$(dirname "$0")/env.sh"

if [ "$(vm_status)" != "Running" ]; then
  echo "VM $VM_NAME isn't running."
  exit 0
fi

if [ "${1:-}" != "--force" ]; then
  busy="$(curl -sf --max-time 5 localhost:7700/api/tasks 2>/dev/null | python3 -c 'import sys, json; print(sum(t["status"] in ("running", "queued") for t in json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  if [ "${busy:-0}" -gt 0 ]; then
    echo "error: $busy agent task(s) running or queued; stopping would interrupt them." >&2
    echo "Wait, use Pause all in the UI, or rerun with --force." >&2
    exit 1
  fi
fi

echo "==> stopping VM $VM_NAME"
"$LIMACTL" stop "$VM_NAME" >"$LIMA_HOME/$VM_NAME/agentbox-stop.log" 2>&1
echo "==> stopped. Start again with ./scripts/start.sh"
