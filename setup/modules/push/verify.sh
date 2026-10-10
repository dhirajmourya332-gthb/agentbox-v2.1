#!/usr/bin/env bash
# push: the portal runs with push on, and google-services.json is in place and private.
source "$(dirname "$0")/../../lib/common.sh"
S="$(cfg paths.secrets)"
[ -s "$S/google-services.json" ] || die "google-services.json is missing (agentbox secret set google-services.json)"
[ "$(stat -c %a "$S/google-services.json")" = 600 ] || die "$S/google-services.json isn't 0600"
curl -sf --max-time 5 "http://127.0.0.1:$(cfg ports.portal)/api/config/public" | grep -q '"push":true' \
  || die "the portal doesn't have push on (agentbox module enable push, then agentbox restart)"
echo "push ok: now send a test notification from the portal (Devices)"
