#!/usr/bin/env bash
# mobile-app: the EAS CLI (global npm) and the build helper.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure jq rsync
have eas || npm install -g --no-audit --no-fund --loglevel=error eas-cli
install_bin "$MODULE_DIR/bin/agentbox-mobile-build"
eas --version
