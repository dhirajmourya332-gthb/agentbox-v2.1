#!/usr/bin/env bash
# mobile-app: the APK the phone installs. Download: the saved link answers. Build: logged in, and the
# latest finished Android build (link only).
source "$(dirname "$0")/../../lib/common.sh"
case "$(cfg mobile.app_source)" in
  download)
    url="$(cfg mobile.app_url)"
    [ -n "$url" ] || die "no APK link saved: sudo agentbox config set mobile.app_url <link>"
    curl -fsSL --max-time 30 -r 0-3 -o /dev/null "$url" || die "the APK link doesn't answer: $url"
    echo "mobile-app ok: APK $url (also on the portal's Devices page, with a QR code)"
    ;;
  build)
    eas whoami >/dev/null 2>&1 || die "not logged in to Expo (eas login)"
    url="$(cd "$(cfg paths.work)/agentbox-mobile" 2>/dev/null && eas build:list --platform android --status finished --limit 1 --json --non-interactive 2>/dev/null | jq -r '.[0].artifacts.buildUrl // empty' || true)"
    [ -n "$url" ] || die "no finished Android build yet: run agentbox-mobile-build"
    echo "mobile-app ok: latest APK $url"
    ;;
  *) die "choose how to get the app first: sudo agentbox config set mobile.app_source download (or build)" ;;
esac
