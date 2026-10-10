#!/usr/bin/env bash
# db-tunnel: agentbox-tunnel plus ssh and nc. The tunnels themselves are the owner's config.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure openssh-client netcat-openbsd
install_bin "$MODULE_DIR/bin/agentbox-tunnel"
user_dir "$(cfg paths.secrets)/tunnels" 0700
