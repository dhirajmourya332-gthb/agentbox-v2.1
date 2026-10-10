#!/usr/bin/env bash
# Verifies the access mode: the portal enforces the login through the access path, and nothing it
# serves listens on a public address. Read-only. Works as the agent user (root-only checks are
# skipped with a note). --quiet: print only failures (for the module's `check`). Exit 1 on failure.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

quiet=0; [ "${1:-}" = --quiet ] && quiet=1
fails=0
pass() { [ $quiet = 1 ] || ok "$*"; }
fail() { printf '  \033[31m✖\033[0m %s\n' "$*" >&2; fails=$((fails + 1)); }
note() { [ $quiet = 1 ] || warn "$*"; }

port="$(portal_port)"
m="$(mode)"
token_file="$(data_dir)/local-token"

# --- every mode -----------------------------------------------------------------------------
# The portal, screen, terminal, gateway and guide ports must be bound to loopback only.
for p in "$port" "$(cfg ports.screen)" "$(cfg ports.terminal)" "$(cfg ports.gateway)" "$(cfg ports.guide)"; do
  [ -n "$p" ] || continue
  public="$(ss -Hltn "sport = :$p" 2>/dev/null | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]):' || true)"
  if [ -n "$public" ]; then fail "port $p listens on a non-loopback address: $public"; else pass "port $p: loopback only (or not listening)"; fi
done

# DNS rebinding: a foreign Host is refused whatever the mode.
s="$(portal_status evil.example)"
[ "$s" = 403 ] && pass "foreign Host refused (403)" || fail "a request with Host: evil.example got $s, expected 403"

# The terminal: ttyd must check the Origin and bind loopback (owned by the terminal module).
if unit="$(systemctl cat agentbox-ttyd.service 2>/dev/null)"; then
  grep -Eq 'ttyd .*(-O|--check-origin)' <<<"$unit" && pass "ttyd checks Origin (-O)" || fail "ttyd runs without -O (check origin); see docs/ACCESS.md › Terminal and screen"
  grep -Eq 'ttyd .*(-i lo|-i 127\.0\.0\.1|--interface (lo|127\.0\.0\.1))' <<<"$unit" && pass "ttyd bound to loopback" || fail "ttyd isn't bound to loopback (-i lo)"
fi
if unit="$(systemctl cat agentbox-vnc.service 2>/dev/null)"; then
  grep -q -- '-nopw' <<<"$unit" && fail "x11vnc runs without a password (-nopw)" || pass "x11vnc has no -nopw"
fi

case "$m" in
  ssh-tunnel)
    s="$(portal_status localhost:$port)"
    [ "$s" = 200 ] && pass "portal answers on localhost (ssh-tunnel)" || fail "portal on localhost answered $s, expected 200"
    ;;

  tailscale)
    host="$(cfg tailscale.hostname)"
    [ -n "$host" ] || { fail "tailscale.hostname isn't set (configure step)"; host=unset.invalid; }
    st="$(tailscale status --json 2>/dev/null || true)"
    [ "$(json_get 'd.get("BackendState")' <<<"$st")" = Running ] && pass "tailscale running" || fail "tailscale isn't running"
    [ "$(json_get 'd["Self"]["DNSName"].rstrip(".").lower()' <<<"$st")" = "$host" ] && pass "node name is $host" || fail "the node's name isn't $host"
    capfunnel="$(json_get 'any("funnel" in k for k in list((d["Self"].get("CapMap") or {}).keys()) + list(d["Self"].get("Capabilities") or []))' <<<"$st")"
    [ "$capfunnel" = False ] && pass "Funnel not permitted for this node" || fail "the tailnet policy permits Funnel for this node"
    serve="$(tailscale serve status --json 2>/dev/null || true)"
    if [ -z "$serve" ]; then note "can't read tailscale serve status as $(id -un); run with sudo for these checks"
    else
      [ "$(json_get 'any((d.get("AllowFunnel") or {}).values())' <<<"$serve")" != True ] && pass "Funnel off" || fail "Funnel is ON"
      target="$(json_get "((d.get('Web') or {}).get('$host:443') or {}).get('Handlers', {}).get('/', {}).get('Proxy', '')" <<<"$serve")"
      [ "$target" = "http://127.0.0.1:$port" ] && pass "serve https://$host/ → 127.0.0.1:$port" || fail "serve doesn't send https://$host/ to the portal (got '${target:-nothing}')"
    fi
    # Through the access path without an identity, and as someone else: refused.
    s="$(portal_status "$host")"
    [ "$s" = 401 ] && pass "no identity → 401" || fail "the portal answered $s without an identity (expected 401)"
    s="$(portal_status "$host" -H 'Tailscale-User-Login: not-the-owner@example.invalid')"
    [ "$s" = 401 ] && pass "another tailnet user → 401" || fail "another tailnet user got $s (expected 401)"
    [ -n "$(cfg owner.tailscale_login)" ] && pass "owner: $(cfg owner.tailscale_login)" || fail "owner.tailscale_login isn't set"
    ;;

  cloudflare)
    host="$(cfg cloudflare.hostname)"; team="$(cfg cloudflare.team_domain)"; team="${team#https://}"; team="${team%%/*}"
    [ -n "$host" ] || { fail "cloudflare.hostname isn't set"; host=unset.invalid; }
    systemctl is-active --quiet cloudflared && pass "cloudflared running" || fail "cloudflared.service isn't running"
    if [ -r /etc/cloudflared/config.yml ]; then
      grep -q "hostname: $host" /etc/cloudflared/config.yml && grep -q "service: http://127.0.0.1:$port" /etc/cloudflared/config.yml \
        && grep -q 'service: http_status:404' /etc/cloudflared/config.yml \
        && pass "tunnel ingress: $host → the portal, everything else 404" || fail "/etc/cloudflared/config.yml doesn't map $host to 127.0.0.1:$port with a 404 catch-all"
    fi
    for k in cloudflare.team_domain cloudflare.aud owner.email; do
      [ -n "$(cfg $k)" ] && pass "$k set" || fail "$k isn't set (the Access application step)"
    done
    # From the internet, without a login: Cloudflare Access must answer (a redirect to the team's
    # login), never the portal.
    out="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "https://$host/api/auth/me" || echo "000 ")"
    code="${out%% *}"; loc="${out#* }"
    if [[ "$code" =~ ^30[1-8]$ ]] && [[ "$loc" =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com/ ]] && { [ -z "$team" ] || [[ "$loc" == "https://$team/"* ]]; }; then
      pass "unauthenticated https://$host → Cloudflare Access login"
    else
      fail "unauthenticated https://$host answered '$code ${loc}', not a redirect to Cloudflare Access: the Access application isn't protecting the hostname"
    fi
    # Locally, as cloudflared would deliver it: no JWT, or a forged one, is refused by the portal.
    s="$(portal_status "$host")"
    [ "$s" = 401 ] && pass "no Access JWT → 401" || fail "the portal answered $s without an Access JWT (expected 401)"
    forged="$(printf '{"alg":"RS256","kid":"x"}' | base64 | tr '+/' '-_' | tr -d '=\n').$(printf '{"email":"%s","aud":["x"]}' "$(cfg owner.email)" | base64 | tr '+/' '-_' | tr -d '=\n').AAAA"
    s="$(portal_status "$host" -H "Cf-Access-Jwt-Assertion: $forged")"
    [ "$s" = 401 ] && pass "forged Access JWT → 401" || fail "a forged Access JWT got $s (expected 401)"
    ;;

  *) fail "access is '$m'; set it: agentbox config set access tailscale|cloudflare|ssh-tunnel" ;;
esac

# Local tools: the token works from here, with a loopback Host (remote modes only).
if [ "$m" != ssh-tunnel ]; then
  if [ -r "$token_file" ]; then
    s="$(portal_status "localhost:$port" -H "X-Agentbox-Local-Token: $(cat "$token_file")")"
    [ "$s" = 200 ] && pass "local token accepted on localhost" || fail "the local token got $s on localhost (expected 200)"
    s="$(portal_status "localhost:$port")"
    [ "$s" = 403 ] && pass "localhost without the token → 403" || fail "localhost without the token got $s (expected 403)"
  else
    note "can't read $token_file as $(id -un); skipped the local-token check"
  fi
fi

if [ $fails -gt 0 ]; then
  [ $quiet = 1 ] || say "$fails check(s) failed."
  exit 1
fi
[ $quiet = 1 ] || say "access ($m): all checks passed."
