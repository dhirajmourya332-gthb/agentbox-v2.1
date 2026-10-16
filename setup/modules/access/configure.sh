#!/usr/bin/env bash
# Configures the chosen access mode. Idempotent; run as root (the setup agent uses sudo).
#   tailscale:  tailscale serve (tailnet-only HTTPS → the portal), refusing Funnel; records the
#               node's ts.net name and the owner's Tailscale login in the config.
#   cloudflare: a named tunnel + config.yml (hostname → the portal) as a service, then prints the
#               Cloudflare Access steps.
#   ssh-tunnel: prints the port-forward commands.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# `tailscale serve` waits forever, printing only a consent link, while Serve/HTTPS isn't enabled for the
# tailnet. Run it with a timeout and surface that link instead of hanging silently.
serve_or_explain() {
  local out rc=0
  out="$(timeout 30 tailscale serve "$@" 2>&1)" || rc=$?
  local url; url="$(grep -oE 'https://login\.tailscale\.com/[^[:space:]]+' <<<"$out" | head -1 || true)"
  if [ -n "$url" ]; then
    die "Serve (HTTPS) isn't enabled on your tailnet yet. Open this link, approve it, then run this step again:
  $url"
  fi
  [ "$rc" = 0 ] || { printf '%s\n' "$out" >&2; return 1; }
}
. "$here/lib.sh"

port="$(portal_port)"

restart_portal() {
  # The portal reads the config at start.
  if agentbox restart >/dev/null 2>&1; then ok "portal restarted with the new access config"
  else warn "couldn't restart the portal; run: agentbox restart"; fi
}

configure_tailscale() {
  need_root
  local st host self_login tags capfunnel allowfunnel current
  st="$(tailscale status --json 2>/dev/null)" || die "tailscale isn't running (install and login steps)"
  [ "$(json_get 'd.get("BackendState")' <<<"$st")" = Running ] || die "Tailscale isn't logged in yet: run the login step"
  host="$(json_get 'd["Self"]["DNSName"].rstrip(".").lower()' <<<"$st")"
  [ -n "$host" ] || die "No MagicDNS name. Turn on MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page)."
  tags="$(json_get 'd["Self"].get("Tags") or ""' <<<"$st")"
  self_login="$(json_get 'd["User"][str(d["Self"]["UserID"])]["LoginName"]' <<<"$st")"

  # Funnel would put the portal on the public internet. Refuse if it's on, or if the tailnet policy
  # merely allows it for this node (a later `tailscale funnel` would need no policy change).
  capfunnel="$(json_get 'any("funnel" in k for k in list((d["Self"].get("CapMap") or {}).keys()) + list(d["Self"].get("Capabilities") or []))' <<<"$st")"
  [ "$capfunnel" = False ] || die "This node is allowed to use Funnel (the tailnet policy has a 'funnel' nodeAttr for it). Remove that grant in the Tailscale admin console (Access controls) and run this again."
  allowfunnel="$(tailscale serve status --json 2>/dev/null | json_get 'any((d.get("AllowFunnel") or {}).values())')"
  [ "$allowfunnel" != True ] || die "Funnel is ON for this node. Run 'sudo tailscale funnel reset' and then this again."

  # Serve: tailnet-only HTTPS on 443 → the portal. Don't clobber another target (e.g. the phone gateway).
  current="$(tailscale serve status --json 2>/dev/null | json_get "((d.get('Web') or {}).get('$host:443') or {}).get('Handlers', {}).get('/', {}).get('Proxy', '')")"
  if [ -n "$current" ] && [ "$current" != "http://127.0.0.1:$port" ]; then
    die "tailscale serve already sends https://$host/ to $current. The portal needs '/': see docs/ACCESS.md › 'Tailscale and the phone gateway'."
  fi
  if [ -z "$current" ]; then
    serve_or_explain --bg --https=443 "http://127.0.0.1:$port" \
      || die "tailscale serve failed. Turn on HTTPS certificates in the Tailscale admin console (DNS page) and run this again."
  fi
  ok "tailscale serve: https://$host/ → 127.0.0.1:$port (tailnet only)"

  # What agents host (hosting.ts): its own HTTPS port, so hosted pages never share the portal's origin.
  local aport sport hcur
  aport="$(apps_port)"; sport="$(hosting_serve_port)"
  hcur="$(tailscale serve status --json 2>/dev/null | json_get "((d.get('Web') or {}).get('$host:$sport') or {}).get('Handlers', {}).get('/', {}).get('Proxy', '')")"
  if [ -n "$hcur" ] && [ "$hcur" != "http://127.0.0.1:$aport" ]; then
    warn "tailscale serve already sends https://$host:$sport/ to $hcur; hosted services won't have links. Set hosting.serve_port to a free one of 443, 8443, 10000."
  else
    [ -n "$hcur" ] || serve_or_explain --bg --https="$sport" "http://127.0.0.1:$aport" || warn "tailscale serve :$sport failed; hosted services won't have links"
    ok "tailscale serve: https://$host:$sport/ → hosted services (127.0.0.1:$aport, owner only)"
  fi

  cfg_set tailscale.hostname "$host"
  local owner; owner="$(cfg owner.tailscale_login)"
  if [ -z "$owner" ]; then
    if [ -n "$tags" ] || [ -z "$self_login" ] || [ "$self_login" = tagged-devices ]; then
      die "This node is tagged, so its login isn't a person. Set the owner yourself: agentbox config set owner.tailscale_login you@example.com"
    fi
    cfg_set owner.tailscale_login "$self_login"
    ok "portal owner: $self_login (the account that logged this node in)"
  elif [ "${owner,,}" != "${self_login,,}" ]; then
    warn "owner.tailscale_login is $owner, but this node was logged in by $self_login. Keeping $owner."
  else
    ok "portal owner: $owner"
  fi
  restart_portal
  say ""
  say "Open https://$host from a device on your tailnet, logged in as $(cfg owner.tailscale_login)."
}

configure_cloudflare() {
  need_root
  local hostname name id creds team aud
  hostname="$(cfg cloudflare.hostname | tr 'A-Z' 'a-z')"
  [ -n "$hostname" ] || die "Set the hostname first: agentbox config set cloudflare.hostname agentbox.example.com"
  [ -s /etc/cloudflared/cert.pem ] || die "Log in first (the cloudflared login step)"
  export TUNNEL_ORIGIN_CERT=/etc/cloudflared/cert.pem
  install -d -m 0700 /var/lib/agentbox-access
  [ -s /var/lib/agentbox-access/cloudflare-tunnel-name ] \
    || printf 'agentbox-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')" > /var/lib/agentbox-access/cloudflare-tunnel-name
  name="$(cat /var/lib/agentbox-access/cloudflare-tunnel-name)"
  creds=/etc/cloudflared/tunnel.json

  tunnel_id() { cloudflared tunnel list --output json --name "$name" 2>/dev/null | json_get 'd[0]["id"] if d else ""'; }
  id="$(tunnel_id)"
  if [ -z "$id" ]; then
    (umask 077; cloudflared tunnel create --credentials-file "$creds" "$name" >/dev/null)
    id="$(tunnel_id)"
    [ -n "$id" ] || die "Creating the tunnel failed"
    ok "created tunnel $name ($id)"
  else
    ok "tunnel $name exists ($id)"
  fi
  [ -s "$creds" ] || die "The tunnel exists but its credentials file $creds is missing. Delete it (cloudflared tunnel delete $name) and run this again."
  chmod 0600 "$creds"

  team="$(cfg cloudflare.team_domain)"; aud="$(cfg cloudflare.aud)"
  local access_block=""
  if [ -n "$team" ] && [ -n "$aud" ]; then
    # Defence in depth: cloudflared itself refuses requests without a valid Access token for this app.
    team="${team#https://}"; team="${team%%/*}"
    access_block="      access:
        required: true
        teamName: ${team%%.cloudflareaccess.com}
        audTag:
          - $aud"
  fi
  local tmp; tmp="$(mktemp)"
  cat >"$tmp" <<YML
# Written by agentbox (setup/modules/access/configure.sh). Outbound-only tunnel: nothing listens publicly.
tunnel: $id
credentials-file: $creds
no-autoupdate: true
ingress:
  - hostname: $hostname
    service: http://127.0.0.1:$port
    originRequest:
      noHappyEyeballs: true
${access_block}
  - service: http_status:404
YML
  install -m 0644 "$tmp" /etc/cloudflared/config.yml; rm -f "$tmp"
  cloudflared tunnel ingress validate --config /etc/cloudflared/config.yml >/dev/null || die "config.yml is invalid"
  ok "/etc/cloudflared/config.yml: $hostname → 127.0.0.1:$port, everything else 404"

  local out
  if out="$(cloudflared tunnel route dns "$id" "$hostname" 2>&1)"; then ok "DNS: $hostname → the tunnel"
  elif grep -qi "already exists" <<<"$out"; then warn "A DNS record for $hostname already exists; make sure it's this tunnel's CNAME ($id.cfargotunnel.com)"
  else die "Creating the DNS record failed: $out"; fi

  if systemctl list-unit-files cloudflared.service >/dev/null 2>&1 && systemctl cat cloudflared.service >/dev/null 2>&1; then
    systemctl restart cloudflared
  else
    cloudflared --config /etc/cloudflared/config.yml service install >/dev/null
  fi
  systemctl is-active --quiet cloudflared || die "cloudflared.service isn't running: journalctl -u cloudflared"
  ok "cloudflared.service running"
  restart_portal

  cat <<TXT

YOUR TURN: put Cloudflare Access in front of https://$hostname (the portal refuses everything until then)
  1. https://one.dash.cloudflare.com → Access → Applications → Add an application → Self-hosted.
  2. Application name: agentbox. Session duration: 8 hours (or less).
     Application domain: $hostname   (path empty: the whole hostname).
  3. Identity providers: your SSO, or "One-time PIN". Turn on "Instant Auth" if there is only one.
  4. Add a policy: name "owner only", Action: Allow, Include → Emails → your email (exactly one).
     No "Everyone", no "Emails ending in", no Bypass or Service Auth rules.
  5. Save. Open the application → Overview → copy the "Application Audience (AUD) Tag".
  6. Your team domain is under Settings → Custom Pages (or Zero Trust → Settings): <team>.cloudflareaccess.com
  7. In the terminal:
       agentbox config set cloudflare.team_domain <team>.cloudflareaccess.com
       agentbox config set cloudflare.aud <the AUD tag>
       agentbox config set owner.email <your email>
       sudo bash $(app_dir)/setup/modules/access/configure.sh   # adds the same check to cloudflared
TXT
}

configure_ssh_tunnel() {
  local user; user="$(id -un)"
  cat <<TXT
access = ssh-tunnel: the portal only answers on 127.0.0.1:$port. Open it through a port forward and
browse http://localhost:$port. Pick the one that matches how you reach this VM:

  AWS (SSM Session Manager, no port 22):
    aws ssm start-session --target <instance-id> \\
      --document-name AWS-StartPortForwardingSession \\
      --parameters '{"portNumber":["$port"],"localPortNumber":["$port"]}'

  Google Cloud (SSH through IAP; the firewall allows 22 only from 35.235.240.0/20):
    gcloud compute ssh <vm-name> --zone <zone> --tunnel-through-iap -- -N -L $port:127.0.0.1:$port

  Plain SSH (port 22 restricted to your IP; the least preferred):
    ssh -N -L $port:127.0.0.1:$port $user@<vm-address>

The terminal and screen are inside the portal (/term, /screen); nothing else needs forwarding.
TXT
}

case "$(mode)" in
  tailscale) configure_tailscale ;;
  cloudflare) configure_cloudflare ;;
  ssh-tunnel) configure_ssh_tunnel ;;
  *) die "access is '$(mode)'; set it first: agentbox config set access tailscale|cloudflare|ssh-tunnel" ;;
esac
