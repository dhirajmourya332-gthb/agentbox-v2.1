#!/usr/bin/env bash
# display: Xvfb, fluxbox, x11vnc, noVNC, GUI tools, fonts, Playwright's Chromium. Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
log "display packages"
apt_ensure xvfb fluxbox x11vnc novnc python3-websockify xdotool scrot imagemagick wmctrl xclip x11-utils \
  fonts-noto fonts-noto-color-emoji fonts-liberation
log "chromium (playwright build)"
if ! as_user 'ls "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome' >/dev/null 2>&1; then
  npx -y playwright@latest install-deps chromium >/dev/null
  as_user "npx -y playwright@latest install chromium >/dev/null"
fi
log "screen page (noVNC + clipboard)"
# noVNC as packaged, plus agentbox-clipboard.js loaded by vnc.html; rebuilt on every run, so a noVNC
# upgrade is picked up. websockify serves this directory (units/agentbox-novnc.service).
web=/usr/local/share/agentbox-novnc
rm -rf "$web" && install -d -m 0755 "$web"
for f in /usr/share/novnc/*; do
  case "$(basename "$f")" in vnc.html|vnc_auto.html) ;; *) ln -s "$f" "$web/" ;; esac
done
install -m 0644 "$MODULE_DIR/novnc/agentbox-clipboard.js" "$web/agentbox-clipboard.js"
sed 's#</head>#    <script type="module" src="agentbox-clipboard.js"></script>\n</head>#' /usr/share/novnc/vnc.html > "$web/vnc.html"
grep -q agentbox-clipboard.js "$web/vnc.html" || die "couldn't add the clipboard script to noVNC's vnc.html"
ln -s vnc.html "$web/vnc_auto.html"
log "helpers"
install_bin "$MODULE_DIR/bin/agentbox-chromium"
install_bin "$MODULE_DIR/bin/agentbox-open"
# Tools that open a browser (gh, aws sso, claude, OAuth) use the shared Chromium.
ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
cat > /etc/profile.d/agentbox-display.sh <<'PROFILE'
# agentbox (setup/modules/display): login shells see the shared display and browser.
export DISPLAY=:99
export BROWSER=/usr/local/bin/agentbox-open
PROFILE
