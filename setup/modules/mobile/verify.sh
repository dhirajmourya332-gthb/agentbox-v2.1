#!/usr/bin/env bash
# mobile: gateway loopback-only, firewall unit active, served on the tailnet, Funnel off.
source "$(dirname "$0")/../../lib/common.sh"
GW="$(cfg ports.gateway)"; SP="$(cfg mobile.serve_port)"
agentbox-check-loopback "$GW" || die "the gateway isn't listening on loopback only (is the portal restarted with mobile on?)"
systemctl is-active --quiet agentbox-tailnet-guard || die "the tailnet firewall unit isn't active"
systemctl is-active --quiet agentbox-tailnet-guard-watch.timer || die "the firewall watch timer isn't active"
tailscale serve status --json 2>/dev/null | grep -q "127.0.0.1:$GW" || die "the gateway isn't served on the tailnet (run: sudo agentbox module install mobile)"
if tailscale funnel status 2>/dev/null | grep -qi "funnel on"; then die "Funnel is ON"; fi
echo "mobile ok: gateway on 127.0.0.1:$GW, served tailnet-only on :${SP:-8443}"
