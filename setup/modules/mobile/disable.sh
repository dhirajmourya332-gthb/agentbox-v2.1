#!/usr/bin/env bash
# mobile off: stop serving the gateway; detach tailscaled from the firewall BEFORE the CLI stops
# the firewall unit (Requires= would otherwise stop tailscaled, cutting the access path).
source "$(dirname "$0")/../../lib/common.sh"
SP="$(cfg mobile.serve_port)"; SP="${SP:-8443}"
if have tailscale; then tailscale serve --https="$SP" off >/dev/null 2>&1 || true; fi
rm -f /etc/systemd/system/tailscaled.service.d/agentbox-guard.conf
has_systemd && systemctl daemon-reload
nft delete table inet agentbox_tailnet 2>/dev/null || true
