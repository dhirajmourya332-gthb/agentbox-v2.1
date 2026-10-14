#!/usr/bin/env bash
# onshape: the agents' tool (Python stdlib only; talks to Onshape's REST API with the owner's API key).
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure python3
install_bin "$MODULE_DIR/bin/agentbox-onshape"
echo "onshape: agentbox-onshape installed; next, the owner saves the API key (agentbox secret set onshape.env)"
