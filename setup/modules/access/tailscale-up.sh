#!/usr/bin/env bash
# The human's step: brings Tailscale up under a random node name and prints the login URL.
# A random name because every ts.net HTTPS certificate is published in Certificate Transparency
# logs: the name shouldn't say what the machine is.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
need_root
[ "$(mode)" = tailscale ] || die "access is '$(mode)', not tailscale"
command -v tailscale >/dev/null || die "Tailscale isn't installed yet (install step)"

state="$(tailscale status --json 2>/dev/null | json_get 'd.get("BackendState")')"
if [ "$state" = Running ]; then ok "Tailscale is already up as $(tailscale status --json | json_get 'd["Self"]["DNSName"].rstrip(".")')"; exit 0; fi

install -d -m 0700 /var/lib/agentbox-access
namefile=/var/lib/agentbox-access/tailscale-name
[ -s "$namefile" ] || printf 'n-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')" > "$namefile"
name="$(cat "$namefile")"
say "Bringing Tailscale up as '$name'. Open the URL below and log in with the account that will use the portal."
say "(Tailscale SSH stays off; this node accepts no routes or DNS changes from the tailnet.)"
# --ssh=false: no Tailscale SSH. --accept-routes=false: don't route through other nodes.
# --shields-up is NOT used: it would also block tailscale serve.
tailscale up --hostname "$name" --ssh=false --accept-routes=false --accept-dns=false
ok "Tailscale is up. Next: the configure step (tailscale serve)."
