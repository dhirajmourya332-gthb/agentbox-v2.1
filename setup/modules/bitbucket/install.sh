#!/usr/bin/env bash
# bitbucket: git, curl, jq and agentbox-bitbucket (Atlassian maintains no Bitbucket Cloud CLI, so the
# REST API through curl). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure git curl ca-certificates jq
install_bin "$MODULE_DIR/bin/agentbox-bitbucket"
echo "agentbox-bitbucket installed"
