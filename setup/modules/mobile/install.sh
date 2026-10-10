#!/usr/bin/env bash
# mobile: the tailnet firewall script (units and the tailscaled drop-in are installed by the CLI).
source "$(dirname "$0")/../../lib/common.sh"
need_root
[ "$(cfg access)" = tailscale ] || die "the phone gateway needs access: tailscale (agentbox config get access)"
apt_ensure nftables
install_bin "$MODULE_DIR/bin/agentbox-tailnet-guard"
