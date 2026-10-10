#!/usr/bin/env bash
# voice: POST /api/voice/clean → cleaned:true. Needs the portal restarted with voice on.
source "$(dirname "$0")/../../lib/common.sh"
PORT="$(cfg ports.portal)"
out="$(curl -s --max-time 30 -H 'content-type: application/json' -d '{"text":"um so this is uh a test"}' "http://127.0.0.1:$PORT/api/voice/clean")"
grep -q '"cleaned":true' <<<"$out" || die "voice cleanup didn't work: ${out:0:200} (is the module on and the portal restarted? is the key right?)"
echo "voice ok"
