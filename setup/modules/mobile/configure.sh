#!/usr/bin/env bash
# mobile: `tailscale serve` the gateway on :<mobile.serve_port> (the portal owns :443), refusing if
# Funnel is on or allowed for this machine. Ported from scripts/mobile-setup.sh; `tailscale up`
# itself is the access module's job, and nothing here takes the machine off the tailnet (that would
# cut the owner's way in).
source "$(dirname "$0")/../../lib/common.sh"
need_root
GW="$(cfg ports.gateway)"
SP="$(cfg mobile.serve_port)"; SP="${SP:-8443}"
have tailscale || die "tailscale isn't installed: set up the access module (tailscale) first"
state="$(tailscale status --json 2>/dev/null | jq -r '.BackendState // ""' || true)"
[ "$state" = Running ] || die "tailscale isn't logged in and running (state: ${state:-unknown}); finish the access step first"

has_systemd && { systemctl is-active --quiet agentbox-tailnet-guard || die "the tailnet firewall isn't active"; }
agentbox-tailnet-guard --ensure || die "the tailnet firewall didn't load"

funnel_on() {
  tailscale serve status --json 2>/dev/null | jq -e '[(.AllowFunnel // {}) | .[]] | any' >/dev/null && return 0
  tailscale funnel status 2>/dev/null | grep -qi "funnel on"
}
funnel_capable() {
  tailscale status --json 2>/dev/null | jq -e '((.Self.CapMap // {}) | keys) + ((.Self.Capabilities // []) | map(tostring)) | map(ascii_downcase) | any(test("funnel"))' >/dev/null
}
funnel_on && die "Tailscale Funnel is ON. Turn it off (sudo tailscale funnel reset), then rerun."
funnel_capable && die "your tailnet policy grants this machine the funnel capability. Remove the \"funnel\" nodeAttr for its tag (and \"*\", autogroup:tagged)."

log "tailscale serve :$SP → 127.0.0.1:$GW (tailnet only)"
tailscale serve --bg --https="$SP" "http://127.0.0.1:$GW" >/dev/null || die "tailscale serve failed. Enable MagicDNS and HTTPS certificates for your tailnet (admin console → DNS)."
if funnel_on; then
  tailscale serve --https="$SP" off >/dev/null 2>&1 || true
  die "Funnel came on after serve; the gateway was taken off again."
fi
dns="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
echo "Funnel: off, and not allowed for this machine."
echo "Gateway URL: https://$dns:$SP  (portal → Computer → Devices → Pair a phone)"
