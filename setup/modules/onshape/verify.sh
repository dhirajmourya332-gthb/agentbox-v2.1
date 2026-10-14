#!/usr/bin/env bash
# onshape: the key works and belongs to the expected account.
source "$(dirname "$0")/../../lib/common.sh"
who="$(agentbox-onshape whoami --short 2>&1)" || die "the Onshape key doesn't work: $who"
echo "onshape ok: the key belongs to $who"
