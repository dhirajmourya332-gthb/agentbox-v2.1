#!/usr/bin/env bash
# aws: who are we, in the right account? (prints the ARN, never keys)
source "$(dirname "$0")/../../lib/common.sh"
profile="$(agentbox integration settings aws --get profile)"
[ -n "$profile" ] && export AWS_PROFILE="$profile"
arn="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)" || die "no AWS credentials: attach an instance role, or run 'aws configure sso'"
want="$(agentbox integration settings aws --get account_id)"
if [ -n "$want" ]; then
  have="$(aws sts get-caller-identity --query Account --output text)"
  [ "$have" = "$want" ] || die "these credentials are for account $have, not $want"
fi
echo "aws ok: $arn"
