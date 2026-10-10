#!/usr/bin/env bash
# claude: one real (tiny) prompt. Runs as the agent user; costs one short request.
source "$(dirname "$0")/../../lib/common.sh"
have claude || die "claude isn't installed for $(id -un)"
out="$(timeout 120 claude -p "Reply with the single word: ok" 2>&1 || true)"
grep -qi "ok" <<<"$out" || die "claude didn't answer (is it logged in? run 'claude' then /login): ${out:0:200}"
echo "claude ok"
