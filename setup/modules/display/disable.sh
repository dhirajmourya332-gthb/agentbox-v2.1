#!/usr/bin/env bash
# display off: drop the shell hooks (packages stay; units are removed by the CLI).
source "$(dirname "$0")/../../lib/common.sh"
rm -f /etc/profile.d/agentbox-display.sh
[ "$(readlink /usr/local/bin/xdg-open 2>/dev/null)" = /usr/local/bin/agentbox-open ] && rm -f /usr/local/bin/xdg-open
true
