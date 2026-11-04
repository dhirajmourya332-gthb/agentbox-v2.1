#!/usr/bin/env bash
# mobile-app: the build helper; the EAS CLI only when the owner chose to build the app (not when
# they download one they already have).
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure jq rsync curl
install_bin "$MODULE_DIR/bin/agentbox-mobile-build"
if [ "$(cfg mobile.app_source)" = build ]; then
  have eas || npm install -g --no-audit --no-fund --loglevel=error eas-cli
  eas --version
else
  echo "app source: $(cfg mobile.app_source || true)" | sed 's/: $/: not chosen yet (download or build)/'
fi
