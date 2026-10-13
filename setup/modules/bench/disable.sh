#!/usr/bin/env bash
# bench off: delete the token so no bridge can connect again (the portal drops a live one within 15 s).
source "$(dirname "$0")/../../lib/common.sh"
rm -f "$(cfg paths.secrets)/bench.token"
echo "bench: token deleted; stop the bridge on your computer and delete ~/.agentbox-bench there"
