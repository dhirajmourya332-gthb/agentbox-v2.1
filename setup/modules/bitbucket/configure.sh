#!/usr/bin/env bash
# bitbucket: git asks agentbox-bitbucket for credentials for https://bitbucket.org (the agent user's
# global git config). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
as_user 'git config --global credential.https://bitbucket.org.helper "!agentbox-bitbucket git-credential"'
echo "git uses agentbox-bitbucket for https://bitbucket.org"
