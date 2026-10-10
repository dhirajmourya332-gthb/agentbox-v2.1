#!/usr/bin/env bash
# Start agentbox (e.g. after the Mac reboots): check the VM exists, start it, and wait until the
# portal and the enabled services are healthy.
#   host/lima/start.sh [--instance NAME] [--ports BASE] [--open]
# First-time setup is host/lima/up.sh instead.
source "$(dirname "$0")/lib.sh"

say() { printf '%s\n' "$*"; }

# 1. Is the VM set up?
status="$(vm_status)"
if [ -z "$status" ]; then
  say "VM $VM_NAME isn't set up in $LIMA_HOME."
  say "Run host/lima/up.sh --instance $VM_NAME for the first-time setup (about 10 minutes)."
  exit 1
fi

# 2. Start it if needed. "Broken" (seen after the Mac sleeps): Lima's helper lost its control socket
# while the VM kept running; a clean stop and start fixes it.
if [ "$status" = "Broken" ]; then
  say "==> VM $VM_NAME is in a broken state; restarting it cleanly"
  "$LIMACTL" stop "$VM_NAME" >"$LIMA_HOME/$VM_NAME/agentbox-stop.log" 2>&1 || "$LIMACTL" stop --force "$VM_NAME" >>"$LIMA_HOME/$VM_NAME/agentbox-stop.log" 2>&1
  status="$(vm_status)"
fi
if [ "$status" = "Running" ]; then
  say "==> VM $VM_NAME is already running"
else
  for port in $PORT_PORTAL $PORT_GUIDE; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      say "error: port $port is already in use on this Mac:"
      lsof -nP -iTCP:"$port" -sTCP:LISTEN | tail -n +2 >&2
      exit 1
    fi
  done
  log="$LIMA_HOME/$VM_NAME/agentbox-start.log"
  say "==> starting VM $VM_NAME (was: $status). Booting usually takes 2–4 minutes; log: $log"
  if ! "$LIMACTL" start --tty=false "$VM_NAME" >"$log" 2>&1; then
    say "error: the VM failed to start. Last log lines:"
    tail -n 20 "$log" >&2
    exit 1
  fi
fi

# 3. Wait for the portal and the services inside the VM (they start on boot).
say "==> waiting for agentbox to come up"
restarted=0
for i in $(seq 1 90); do
  health="$(vm agentbox api /api/health 2>/dev/null || true)"
  if [ -n "$health" ]; then
    down="$(python3 -c '
import json, sys
h = json.loads(sys.argv[1])
bad = [k for k, v in h["services"].items() if v != "active"] + ([] if h["browser"]["ok"] else ["shared browser"])
print(" ".join(bad))' "$health")"
    [ -z "$down" ] && break
    [ $((i % 10)) -eq 0 ] && say "    still starting: $down"
  elif [ "$i" -eq 45 ] && [ "$restarted" -eq 0 ]; then
    say "    portal not answering yet; restarting it once"
    vm sudo systemctl restart agentbox-web || true
    restarted=1
  fi
  sleep 2
done

if [ -z "${health:-}" ]; then
  say "error: the portal didn't come up. Last log lines:"
  vm sudo journalctl -u agentbox-web -n 30 --no-pager >&2 || true
  exit 1
fi
if [ -n "${down:-}" ]; then
  say "warning: up, but not healthy yet: $down  (see the System page, or: host/lima/shell.sh --instance $VM_NAME agentbox status)"
fi

# 4. Summary.
state="$(vm agentbox api /api/state 2>/dev/null || echo '{}')"
python3 -c '
import json, sys
s = json.loads(sys.argv[1] or "{}")
agents = s.get("agents", [])
print(f"==> agentbox is up: {len(agents)} agent(s)" + (" · ALL AGENTS PAUSED (Resume in the UI)" if s.get("paused") else ""))' "$state"
echo
urls
[ "${ARGS[0]:-}" = "--open" ] && open "http://localhost:$PORT_PORTAL"
exit 0
