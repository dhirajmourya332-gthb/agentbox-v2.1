#!/usr/bin/env bash
# gitlab: logged in, the API answers. Runs as the agent user; prints the username, never the token.
source "$(dirname "$0")/../../lib/common.sh"
host="$(agentbox integration settings gitlab --get host)"
glab auth status --hostname "$host" >/dev/null 2>&1 || die "glab isn't logged in to $host: run 'glab auth login --hostname $host'"
user="$(glab api user --hostname "$host" | jq -r .username)" || die "the GitLab API on $host didn't answer"
project="$(agentbox integration settings gitlab --get default_project)"
if [ -n "$project" ]; then
  glab api "projects/$(jq -rn --arg p "$project" '$p|@uri')" --hostname "$host" >/dev/null 2>&1 || die "logged in as $user, but can't see the project $project"
fi
echo "gitlab ok: logged in to $host as $user${project:+; project $project visible}"
