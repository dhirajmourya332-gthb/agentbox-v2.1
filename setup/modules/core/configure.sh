#!/usr/bin/env bash
# core: deploy and build the app from the source tree (the unit is installed and started by the CLI).
source "$(dirname "$0")/../../lib/common.sh"
need_root
# Optional environment for the portal (e.g. EXPO_ACCESS_TOKEN): <secrets>/agentbox-web.env, 0600.
bash "$SRC/setup/lib/deploy-app.sh"
