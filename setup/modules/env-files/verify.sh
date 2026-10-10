#!/usr/bin/env bash
# env-files: list them (names only, never contents) and check permissions.
source "$(dirname "$0")/../../lib/common.sh"
S="$(cfg paths.secrets)"
files="$(find "$S" -mindepth 2 -name '*.env' -type f | sort)"
[ -n "$files" ] || die "no <repo>/*.env files under $S yet"
bad="$( { find "$S" -type f ! -perm 600; find "$S" -type d ! -perm 700; } )"
[ -z "$bad" ] || die "not private: $bad (fix: chmod 600 files, 700 folders)"
echo "env-files ok:"; sed "s|^$S/|  |" <<<"$files"
