#!/usr/bin/env bash
# terminal: ttyd (Ubuntu's package). The unit binds lo only and checks Origin (-O).
source "$(dirname "$0")/../../lib/common.sh"
need_root
log "ttyd"
apt_ensure ttyd
# The package's own ttyd.service listens on all interfaces: keep it off.
if has_systemd && systemctl list-unit-files ttyd.service >/dev/null 2>&1; then
  systemctl disable --now ttyd.service >/dev/null 2>&1 || true
fi
