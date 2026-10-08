#!/usr/bin/env bash
# Put the agentbox mobile gateway on your tailnet (docs/MOBILE-SETUP.md). Run on the Mac. Safe to re-run.
#
#   AGENTBOX_TS_TAG=tag:agentbox scripts/mobile-setup.sh [--force]
#
#   1. scripts/install-units.sh: web, noVNC and ttyd units bound to loopback, the tailnet firewall
#      and its watch timer, the tailscaled drop-in; refuses unless 7700/7701/7702/7710 are
#      loopback-only (--force is passed through: it restarts agentbox-web even if agents are busy);
#   2. installs Tailscale in the VM (official repo, Ubuntu 24.04 noble);
#   3. `tailscale up` as a TAGGED node with a random, non-descriptive hostname (ts.net certificate
#      names are published in Certificate Transparency logs). The first time, it prints a login URL;
#   4. refuses (and takes the node off the tailnet) if Funnel is on or the policy grants this node
#      the funnel capability;
#   5. `tailscale serve --bg --https=443 http://127.0.0.1:7710` (tailnet only, never Funnel);
#   6. checks Funnel again and prints the https://<host>.<tailnet>.ts.net URL.
#
# AGENTBOX_TS_TAG is required. Create the tag and the ACL first (docs/MOBILE-SETUP.md › 1):
#
#   "tagOwners": { "tag:agentbox": ["autogroup:admin"] },
#   "acls": [
#     { "action": "accept", "src": ["you@example.com"], "dst": ["tag:agentbox:443"] }
#     // no "*:*" rule; tag:agentbox never appears as a "src"
#   ],
#   // and no "nodeAttrs" entry giving "funnel" to tag:agentbox, "*" or autogroup:tagged
#
# Optional: AGENTBOX_TS_HOSTNAME (default: a random node-xxxxxx, kept across reruns),
#           AGENTBOX_MOBILE_PORT (default 7710).
source "$(dirname "$0")/env.sh"

GATEWAY_PORT="${AGENTBOX_MOBILE_PORT:-7710}"
TS_TAG="${AGENTBOX_TS_TAG:-}"
if ! [[ "$TS_TAG" =~ ^tag:[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: set AGENTBOX_TS_TAG (e.g. AGENTBOX_TS_TAG=tag:agentbox). Create the tag and the ACL" >&2
  echo "       in the Tailscale admin console first: see docs/MOBILE-SETUP.md." >&2
  exit 1
fi

json_get() { python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); $1"; }

# Funnel is on if the serve config allows it or `tailscale funnel status` lists a Funnel entry.
funnel_on() {
  vm sudo tailscale serve status --json 2>/dev/null \
    | json_get 'sys.exit(0 if any((d.get("AllowFunnel") or {}).values()) else 1)' && return 0
  vm sudo tailscale funnel status 2>/dev/null | grep -qi "funnel on" && return 0
  return 1
}
# The tailnet policy grants this node Funnel (a "funnel" nodeAttr): Self.CapMap / Self.Capabilities.
funnel_capable() {
  vm sudo tailscale status --json 2>/dev/null | json_get '
s = d.get("Self") or {}
keys = list((s.get("CapMap") or {}).keys()) + [str(c) for c in (s.get("Capabilities") or [])]
sys.exit(0 if any("funnel" in k.lower() for k in keys) else 1)'
}
refuse() {
  echo "error: $1" >&2
  if [ "${2:-}" = down ]; then
    vm sudo tailscale serve reset >/dev/null 2>&1 || true
    vm sudo tailscale down >/dev/null 2>&1 || true
    echo "       Took this machine off the tailnet (tailscale down). Fix it, then rerun." >&2
  fi
  exit 1
}

echo "==> units and listeners"
"$(dirname "$0")/install-units.sh" "${1:-}"

echo "==> tailscale package"
vm sudo bash -c '
  set -euo pipefail
  if ! command -v tailscale >/dev/null 2>&1; then
    . /etc/os-release
    [ "$VERSION_CODENAME" = noble ] || { echo "expected Ubuntu 24.04 (noble), got $VERSION_CODENAME" >&2; exit 1; }
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tailscale >/dev/null
  fi
  systemctl daemon-reload
  systemctl enable --now tailscaled >/dev/null 2>&1
  tailscale version | head -1
'
# The drop-in makes tailscaled require the firewall; confirm both are up before going online.
vm systemctl is-active --quiet agentbox-tailnet-guard || refuse "the tailnet firewall isn't active"
vm sudo /usr/local/bin/agentbox-tailnet-guard --ensure || refuse "the tailnet firewall didn't load"

funnel_on && refuse "Tailscale Funnel is ON. Turn it off (in the VM: sudo tailscale funnel reset), then rerun." down

echo "==> tailscale up as $TS_TAG (open the login URL it prints, if any)"
# A random, stable, non-descriptive name: kept in the VM so reruns reuse it.
TS_HOSTNAME="${AGENTBOX_TS_HOSTNAME:-$(vm sudo bash -c '
  f=/etc/agentbox/ts-hostname
  if [ ! -s "$f" ]; then install -d -m 0755 /etc/agentbox; echo "node-$(head -c3 /dev/urandom | od -An -tx1 | tr -d " \n")" > "$f"; fi
  cat "$f"')}"
[[ "$TS_HOSTNAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || refuse "bad hostname: $TS_HOSTNAME"
# Blocks until you finish signing in. --reset: flags not given here go back to their defaults.
vm sudo tailscale up --reset --hostname="$TS_HOSTNAME" --advertise-tags="$TS_TAG" \
  --ssh=false --accept-dns=false --accept-routes=false

funnel_capable && refuse "your tailnet policy grants this machine the funnel capability. Remove the
       \"funnel\" nodeAttr for $TS_TAG (and \"*\", autogroup:tagged) in Access controls." down
funnel_on && refuse "Tailscale Funnel is ON." down

echo "==> tailscale serve :443 → 127.0.0.1:$GATEWAY_PORT (tailnet only)"
if ! vm sudo tailscale serve --bg --https=443 "http://127.0.0.1:$GATEWAY_PORT"; then
  refuse "tailscale serve failed. Enable MagicDNS and HTTPS certificates for your tailnet
       (admin console → DNS), then rerun."
fi

funnel_on && refuse "Tailscale Funnel is ON after serve." down
funnel_capable && refuse "this machine has the funnel capability." down

dns="$(vm sudo tailscale status --json | json_get 'print(d["Self"]["DNSName"].rstrip("."))')"
echo
echo "Funnel: off, and not allowed for this machine (good; keep it that way)."
echo "Gateway URL: https://$dns"
echo "Next: open the portal → Computer → Devices → Pair a phone."
