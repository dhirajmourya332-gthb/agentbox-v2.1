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
