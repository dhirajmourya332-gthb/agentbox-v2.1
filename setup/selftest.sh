#!/usr/bin/env bash
# The security self-test (docs/V2-ARCHITECTURE.md § 6). Run as root: `sudo agentbox selftest`.
# Prints PASS / WARN / FAIL / NOTE lines; exits 1 if anything FAILs. Read-only.
set -uo pipefail
cfg() { agentbox config get "$1" 2>/dev/null || true; }
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo agentbox selftest" >&2; exit 2; }

HOST="$(cfg host)"; ACCESS="$(cfg access)"; USER_="$(cfg user)"
PORTAL="$(cfg ports.portal)"; SCREEN="$(cfg ports.screen)"; TERMINAL="$(cfg ports.terminal)"; GATEWAY="$(cfg ports.gateway)"
SECRETS="$(cfg paths.secrets)"; DATA="$(cfg paths.data)"
on() { [ "$(cfg "modules.$1")" = true ]; }

fails=0 warns=0
pass() { printf '\033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }
warn() { printf '\033[33mWARN\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
note() { printf 'NOTE  %s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

echo "agentbox selftest · host $HOST · access $ACCESS · user $USER_"

# 1. Listeners: nothing on a non-loopback address except the allowed system daemons.
#    sshd is allowed on lima (Lima drives the VM over SSH, forwarded to the Mac's loopback) and
#    with access: ssh-tunnel (port 22 is how you get in).
allowed='tailscaled|systemd-network|systemd-resolve|dhclient|chronyd'
[ "$HOST" = lima ] || [ "$ACCESS" = ssh-tunnel ] && allowed="$allowed|sshd|systemd"
bad_listeners=""
while read -r proto _ _ _ local _ proc; do
  [ -n "$local" ] || continue
  addr="${local%:*}"
  case "$addr" in 127.*|"[::1]"|"[::ffff:127."*) continue ;; esac
  # Link-local DHCPv6 / mDNS-style sockets on a specific interface (addr%iface) are the DHCP client.
  name="$(sed -n 's/.*(("\([^"]*\)".*/\1/p' <<<"$proc")"
  if [[ "$name" =~ ^($allowed)$ ]]; then continue; fi
  bad_listeners="$bad_listeners
      $proto $local ${name:-unknown process}"
done < <(ss -Hltunp 2>/dev/null)
if [ -z "$bad_listeners" ]; then pass "no listeners beyond loopback (other than: ${allowed//|/, })"
else fail "listening beyond loopback:$bad_listeners"; fi

# The agentbox ports themselves: loopback only.
ports="$PORTAL"
on terminal && ports="$ports $TERMINAL"
on display && ports="$ports $SCREEN 5900 9222"
on mobile && ports="$ports $GATEWAY"
if agentbox-check-loopback -- $ports >/dev/null 2>&1; then pass "agentbox ports loopback-only ($ports)"
else fail "an agentbox port listens beyond loopback: $(agentbox-check-loopback -- $ports 2>&1 | grep NOT | tr '\n' ' ')"; fi

# 2. The portal refuses requests that don't come from the owner.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: attacker.example' "http://127.0.0.1:$PORTAL/api/state")"
case "$code" in
  000) warn "the portal isn't answering on 127.0.0.1:$PORTAL (is agentbox-web running?)" ;;
  200) fail "the portal answered a request for a foreign Host (DNS rebinding)" ;;
  *) pass "portal refuses a foreign Host ($code)" ;;
esac
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Origin: https://attacker.example" "http://127.0.0.1:$PORTAL/api/state")"
[ "$code" = 200 ] && fail "the portal answered a cross-origin request" || { [ "$code" = 000 ] || pass "portal refuses a foreign Origin ($code)"; }

ts_dns=""
if has tailscale; then ts_dns="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"; fi
case "$ACCESS" in
  tailscale)
    if [ -n "$ts_dns" ]; then
      # From this machine (a tagged node, no user identity), the portal must refuse.
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$ts_dns/api/state")"
      case "$code" in
        200) fail "https://$ts_dns/api/state answered without a login" ;;
        000) note "couldn't reach https://$ts_dns from the VM itself; test from another tailnet device without your login" ;;
        *) pass "portal through tailscale serve refuses an unauthenticated request ($code)" ;;
      esac
    else warn "access is tailscale but this machine isn't on a tailnet yet"; fi ;;
  cloudflare)
    h="$(cfg cloudflare.hostname)"
    if [ -n "$h" ]; then
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$h/api/state")"
      [ "$code" = 200 ] && fail "https://$h/api/state answered without Cloudflare Access" || pass "https://$h refuses without a login ($code)"
    else warn "access is cloudflare but cloudflare.hostname isn't set"; fi ;;
  ssh-tunnel) pass "access: ssh-tunnel (localhost only)" ;;
esac

# 3. Funnel: never on, never allowed.
if has tailscale && [ -n "$ts_dns" ]; then
  if tailscale serve status --json 2>/dev/null | jq -e '[(.AllowFunnel // {}) | .[]] | any' >/dev/null || tailscale funnel status 2>/dev/null | grep -qi "funnel on"; then
    fail "Tailscale Funnel is ON (sudo tailscale funnel reset)"
  else pass "Funnel off"; fi
  if tailscale status --json 2>/dev/null | jq -e '((.Self.CapMap // {}) | keys) + ((.Self.Capabilities // []) | map(tostring)) | map(ascii_downcase) | any(test("funnel"))' >/dev/null; then
    fail "the tailnet policy grants this machine Funnel (remove the funnel nodeAttr)"
  else pass "Funnel not permitted by the tailnet policy"; fi
  # Terminal and screen must only be reached through the portal: never served directly.
  served="$(tailscale serve status --json 2>/dev/null || true)"
  if grep -Eq "127\.0\.0\.1:($TERMINAL|$SCREEN)\b|localhost:($TERMINAL|$SCREEN)\b" <<<"$served"; then
    fail "tailscale serve exposes the terminal or screen directly (only the portal may be served)"
  else pass "terminal and screen aren't served directly"; fi
fi

# 4. Secrets: dir 0700, files 0600, all owned by the agent user.
if [ -d "$SECRETS" ]; then
  bad="$( { find "$SECRETS" -type d ! -perm 700; find "$SECRETS" -type f ! -perm 600; find "$SECRETS" ! -user "$USER_"; } 2>/dev/null | sort -u)"
  if [ -z "$bad" ]; then pass "$SECRETS: 0700/0600, owned by $USER_"
  else fail "$SECRETS permissions/ownership: $(tr '\n' ' ' <<<"$bad")"; fi
else warn "$SECRETS doesn't exist"; fi

# 5. Data and DB: not world-readable.
if [ -d "$DATA" ]; then
  bad="$(find "$DATA" -perm /o+rwx 2>/dev/null | head -5)"
  if [ -z "$bad" ]; then pass "$DATA (DB) not accessible to other users"
  else fail "world-accessible in $DATA: $(tr '\n' ' ' <<<"$bad")"; fi
fi

# 6. Terminal and screen: loopback (above), plus their own protections.
if on terminal; then
  if systemctl cat agentbox-ttyd 2>/dev/null | grep -Eq -- ' -O( |$)'; then pass "ttyd checks Origin (-O)"
  else fail "ttyd runs without the Origin check (-O)"; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$TERMINAL/")"
  case "$code" in 401) pass "ttyd refuses without its credential" ;; 000) warn "ttyd isn't answering" ;; *) fail "ttyd answered without its credential ($code)" ;; esac
fi
# The credentials the portal's /term/ and /screen/ proxies use: 0600, the agent user's.
for f in /etc/agentbox/ttyd.credential /etc/agentbox/vnc.password; do
  [ -e "$f" ] || continue
  if [ "$(stat -c '%a %U' "$f")" = "600 $USER_" ]; then pass "$f: 0600, owned by $USER_"
  else fail "$f: $(stat -c '%a %U' "$f") (want 600 $USER_)"; fi
done
if on display; then
  if systemctl cat agentbox-vnc 2>/dev/null | grep -q -- '-passwdfile'; then pass "VNC has a password"
  else fail "x11vnc runs without a password"; fi
fi

# 7. The tailnet firewall, when the phone gateway is on.
if on mobile; then
  out="$(nft list table inet agentbox_tailnet 2>/dev/null || true)"
  if grep -q 'iifname "tailscale0" .*drop' <<<"$out" && grep -q 'oifname "tailscale0" .*drop' <<<"$out"; then pass "tailnet firewall loaded"
  else fail "tailnet firewall missing (sudo agentbox-tailnet-guard)"; fi
  systemctl is-active --quiet agentbox-tailnet-guard-watch.timer && pass "tailnet firewall watch timer active" || fail "tailnet firewall watch timer not active"
fi

# 8. Passwordless sudo for the agent user (audit H3): a warning for now.
if sudo -l -U "$USER_" 2>/dev/null | grep -q NOPASSWD; then
  warn "$USER_ has passwordless sudo (agent_sudo: $(cfg agent_sudo)); agents can do anything on this VM (audit H3)"
else pass "$USER_ has no passwordless sudo"; fi

# 9. Cloud: what the VM can't see.
if [ "$HOST" = cloud ]; then
  note "check in your cloud console: the firewall / security group has NO inbound rules (not even 22)."
  note "on EC2: IMDSv2 required, an instance role with least privilege, encrypted EBS; use SSM for break-glass."
fi

echo
if [ "$fails" -gt 0 ]; then echo "selftest: $fails failure(s), $warns warning(s)"; exit 1; fi
echo "selftest: passed ($warns warning(s))"
