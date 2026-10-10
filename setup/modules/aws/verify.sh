#!/usr/bin/env bash
# aws: who are we? (prints the ARN, never keys)
source "$(dirname "$0")/../../lib/common.sh"
arn="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)" || die "no AWS credentials: attach an instance role, or run 'aws configure sso'"
echo "aws ok: $arn"
