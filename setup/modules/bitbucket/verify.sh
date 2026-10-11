#!/usr/bin/env bash
# bitbucket: the token works and the workspace is visible. Runs as the agent user; never prints the token.
source "$(dirname "$0")/../../lib/common.sh"
who="$(agentbox-bitbucket whoami)" || die "the Bitbucket API refused the token: see the token step"
ws="$(agentbox integration settings bitbucket --get workspace)"
if [ -n "$ws" ]; then
  agentbox-bitbucket api "/workspaces/$ws" >/dev/null 2>&1 || agentbox-bitbucket api "/repositories/$ws?pagelen=1" >/dev/null 2>&1 \
    || die "the token works (as $who), but can't see the workspace $ws"
fi
echo "bitbucket ok: as $who${ws:+; workspace $ws}"
