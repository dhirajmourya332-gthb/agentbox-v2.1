#!/usr/bin/env bash
# aws: the agent user's default region (for the configured profile, or the default one). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
region="$(agentbox integration settings aws --get region)"
profile="$(agentbox integration settings aws --get profile)"
if [ -n "$region" ] && [ -n "$profile" ]; then as_user "aws configure set region '$region' --profile '$profile'"
elif [ -n "$region" ]; then as_user "aws configure set region '$region'"; fi
echo "aws defaults: region=${region:-(not set)} profile=${profile:-default}"
