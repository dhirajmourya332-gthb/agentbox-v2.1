#!/usr/bin/env bash
# mobile-app: start the EAS build as the agent user (needs `eas login` first).
source "$(dirname "$0")/../../lib/common.sh"
as_user agentbox-mobile-build "$@"
