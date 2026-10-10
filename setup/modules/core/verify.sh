#!/usr/bin/env bash
# core: the portal answers, only on loopback, and refuses a foreign Host (DNS rebinding).
source "$(dirname "$0")/../../lib/common.sh"
PORT="$(cfg ports.portal)"
curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null || die "the portal doesn't answer on 127.0.0.1:$PORT"
agentbox-check-loopback "$PORT" || die "the portal listens beyond loopback"
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: attacker.example' "http://127.0.0.1:$PORT/api/state")"
[ "$code" != 200 ] || die "the portal answered a request for a foreign Host"
data="$(cfg paths.data)"
[ -z "$(find "$data" -perm /o+rwx -print -quit 2>/dev/null)" ] || die "$data has world-accessible files"
echo "core ok: portal on 127.0.0.1:$PORT, foreign Host refused ($code), data private"
