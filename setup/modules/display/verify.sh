#!/usr/bin/env bash
# display: services up, the browser's CDP answers, and VNC/noVNC/CDP are loopback only.
source "$(dirname "$0")/../../lib/common.sh"
systemctl is-active --quiet agentbox-xvfb agentbox-wm agentbox-vnc agentbox-novnc agentbox-chromium || die "a display service isn't running"
curl -sf --max-time 3 http://127.0.0.1:9222/json/version >/dev/null || die "the shared browser (CDP 9222) doesn't answer"
agentbox-check-loopback "$(cfg ports.screen)" 5900 9222 || die "the screen, VNC or CDP listen beyond loopback"
systemctl cat agentbox-vnc | grep -q -- '-passwdfile' || die "x11vnc runs without a password"
echo "display ok"
