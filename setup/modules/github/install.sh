#!/usr/bin/env bash
# github: git and the official gh CLI apt repository. Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure git curl ca-certificates
if ! have gh; then
  log "github cli"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod 0644 /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  wait_for_apt && apt-get update -qq && apt_install gh
fi
# git uses gh's login for HTTPS remotes.
as_user 'gh auth status >/dev/null 2>&1 && gh auth setup-git || true'
gh --version | head -1
