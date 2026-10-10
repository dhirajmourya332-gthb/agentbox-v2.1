#!/usr/bin/env bash
# voice: POST /api/voice/clean → cleaned:true. Needs the portal restarted with voice on.
source "$(dirname "$0")/../../lib/common.sh"
out="$(agentbox api -d '{"text":"um so this is uh a test"}' /api/voice/clean || true)"
grep -q '"cleaned":true' <<<"$out" || die "voice cleanup didn't work: ${out:0:200} (is the module on and the portal restarted? is the key right?)"
echo "voice ok"
