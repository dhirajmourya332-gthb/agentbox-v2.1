#!/usr/bin/env bash
# The human's step: cloudflared's browser login. The certificate it saves can create tunnels and
# DNS records in the authorised zone, so it is kept root-only in /etc/cloudflared.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
need_root
[ "$(mode)" = cloudflare ] || die "access is '$(mode)', not cloudflare"
command -v cloudflared >/dev/null || die "cloudflared isn't installed yet (install step)"
[ -n "$(cfg cloudflare.hostname)" ] || die "Set the hostname first: agentbox config set cloudflare.hostname agentbox.example.com"

install -d -m 0755 /etc/cloudflared
if [ -s /etc/cloudflared/cert.pem ]; then ok "Already logged in (/etc/cloudflared/cert.pem)"; exit 0; fi
umask 077
[ -s /root/.cloudflared/cert.pem ] || cloudflared tunnel login
[ -s /root/.cloudflared/cert.pem ] || die "No certificate was saved; run this again and finish the login in the browser"
install -m 0600 -o root -g root /root/.cloudflared/cert.pem /etc/cloudflared/cert.pem
rm -f /root/.cloudflared/cert.pem
ok "Logged in. Next: the configure step creates the tunnel."
