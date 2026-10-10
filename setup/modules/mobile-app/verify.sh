#!/usr/bin/env bash
# mobile-app: logged in, and the latest finished Android build (link only).
source "$(dirname "$0")/../../lib/common.sh"
eas whoami >/dev/null 2>&1 || die "not logged in to Expo (eas login)"
url="$(cd "$(cfg paths.work)/agentbox-mobile" 2>/dev/null && eas build:list --platform android --status finished --limit 1 --json --non-interactive 2>/dev/null | jq -r '.[0].artifacts.buildUrl // empty' || true)"
[ -n "$url" ] || die "no finished Android build yet: run agentbox-mobile-build"
echo "mobile-app ok: latest APK $url"
