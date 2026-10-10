#!/usr/bin/env bash
# terminal: running, loopback only, Origin checked (audit H1), credential required.
source "$(dirname "$0")/../../lib/common.sh"
PORT="$(cfg ports.terminal)"
systemctl is-active --quiet agentbox-ttyd || die "agentbox-ttyd isn't running"
agentbox-check-loopback "$PORT" || die "ttyd listens beyond loopback"
systemctl cat agentbox-ttyd | grep -Eq -- ' -O( |$)' || die "ttyd runs without the Origin check (-O)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/")"
[ "$code" = 401 ] || die "ttyd answered without its credential ($code)"
echo "terminal ok: ttyd on 127.0.0.1:$PORT with -O and a credential"
