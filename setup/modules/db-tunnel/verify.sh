#!/usr/bin/env bash
# db-tunnel: each tunnel opens, answers and closes. Runs as the agent user.
source "$(dirname "$0")/../../lib/common.sh"
agentbox-tunnel check
rc=0
for n in $(agentbox-tunnel list); do
  if agentbox-tunnel start "$n" && agentbox-tunnel status "$n"; then echo "$n ok"; else echo "$n FAILED" >&2; rc=1; fi
  agentbox-tunnel stop "$n" >/dev/null
done
exit "$rc"
