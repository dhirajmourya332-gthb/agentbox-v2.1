#!/usr/bin/env bash
# github: logged in, the API answers, git uses gh for credentials.
source "$(dirname "$0")/../../lib/common.sh"
gh auth status >/dev/null 2>&1 || die "gh isn't logged in: run 'gh auth login'"
login="$(gh api user -q .login)" || die "the GitHub API didn't answer"
gh auth setup-git
scopes="$(gh auth status 2>&1 | grep -i 'token scopes' || true)"
echo "github ok: logged in as $login. ${scopes# }"
