#!/usr/bin/env bash
# (Re)install the VM's network-facing systemd units from vm/systemd and verify everything listens
# on loopback only. Run on the Mac. Safe to re-run. Used by scripts/mobile-setup.sh.
#
#   scripts/install-units.sh            refuses while agent tasks are running (restarting
#                                       agentbox-web interrupts them)
#   scripts/install-units.sh --force    restarts anyway
#
# Installs, with @USER@/@HOME@ filled in (as vm/provision.sh does):
#   agentbox-web (127.0.0.1:7700 + mobile gateway 127.0.0.1:7710), agentbox-novnc (127.0.0.1:7701),
#   agentbox-ttyd (127.0.0.1:7702), the tailnet firewall (agentbox-tailnet-guard + a 60 s watch
#   timer that reloads it if it goes missing) and a tailscaled drop-in so Tailscale only runs with
#   the firewall loaded. Then restarts those services and checks `ss`: 7700, 7701, 7702 and 7710
#   must be listening on loopback only, or this exits non-zero.
#
# agentbox-web must already run code that binds 127.0.0.1 and starts the gateway (scripts/deploy.sh).
source "$(dirname "$0")/env.sh"

if [ "${1:-}" != "--force" ]; then
  busy="$(curl -sf localhost:7700/api/tasks 2>/dev/null | python3 -c 'import sys, json; print(sum(t["status"] in ("running", "queued") for t in json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  if [ "${busy:-0}" -gt 0 ]; then
    echo "error: $busy agent task(s) running or queued; restarting agentbox-web would interrupt them. Wait, or rerun with --force." >&2
    exit 1
  fi
fi

echo "==> installing units"
vm sudo bash -c "
  set -euo pipefail
  SRC=$SRC_MOUNT
  AGENT_USER=\$(stat -c %U /opt/agentbox/app)
  AGENT_HOME=\$(getent passwd \"\$AGENT_USER\" | cut -d: -f6)
  [ -n \"\$AGENT_USER\" ] && [ -n \"\$AGENT_HOME\" ] || { echo 'cannot tell the agent user' >&2; exit 1; }
  for u in agentbox-web.service agentbox-novnc.service agentbox-ttyd.service \
           agentbox-tailnet-guard.service agentbox-tailnet-guard-watch.service agentbox-tailnet-guard-watch.timer; do
    sed -e \"s|@USER@|\$AGENT_USER|g\" -e \"s|@HOME@|\$AGENT_HOME|g\" \"\$SRC/vm/systemd/\$u\" > \"/etc/systemd/system/\$u\"
  done
  install -d /etc/systemd/system/tailscaled.service.d
  install -m 0644 \"\$SRC/vm/systemd/tailscaled.service.d/agentbox-guard.conf\" /etc/systemd/system/tailscaled.service.d/agentbox-guard.conf
  install -m 0755 \"\$SRC/vm/bin/agentbox-tailnet-guard\" /usr/local/bin/agentbox-tailnet-guard
  install -m 0755 \"\$SRC/vm/bin/agentbox-check-loopback\" /usr/local/bin/agentbox-check-loopback
  systemctl daemon-reload
  systemctl enable agentbox-tailnet-guard.service agentbox-tailnet-guard-watch.timer >/dev/null 2>&1
  systemctl restart agentbox-tailnet-guard.service
  systemctl start agentbox-tailnet-guard-watch.timer
  systemctl restart agentbox-novnc agentbox-ttyd agentbox-web
"

echo "==> waiting for the services"
for _ in $(seq 60); do
  vm bash -c 'ss -Hltn "sport = :7710" | grep -q . && ss -Hltn "sport = :7700" | grep -q .' && break
  sleep 1
done

echo "==> checking listeners (loopback only)"
if ! vm /usr/local/bin/agentbox-check-loopback 7700 7701 7702 7710; then
  echo "error: a service is missing or listens beyond loopback (see above). Is the current code deployed (scripts/deploy.sh)?" >&2
  exit 1
fi
vm sudo /usr/local/bin/agentbox-tailnet-guard --ensure
echo "units installed; all four ports are loopback only; tailnet firewall loaded"
