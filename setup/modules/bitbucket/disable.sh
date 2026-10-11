#!/usr/bin/env bash
# bitbucket: stop git from using the helper (the token file stays: the owner removes or revokes it).
source "$(dirname "$0")/../../lib/common.sh"
as_user 'git config --global --unset-all credential.https://bitbucket.org.helper || true'
