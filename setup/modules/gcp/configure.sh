#!/usr/bin/env bash
# gcp: the agent user's gcloud defaults from the settings (project, region, zone). Works before the
# login too (gcloud only records them). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
setting() { agentbox integration settings gcp --get "$1"; }
project="$(setting project)"; region="$(setting region)"; zone="$(setting zone)"
[ -n "$project" ] && as_user "gcloud config set project '$project' --quiet >/dev/null 2>&1 || true"
[ -n "$region" ] && as_user "gcloud config set compute/region '$region' --quiet >/dev/null 2>&1 || true"
[ -n "$zone" ] && as_user "gcloud config set compute/zone '$zone' --quiet >/dev/null 2>&1 || true"
echo "gcloud defaults: project=${project:-(not set)} region=${region:-(not set)} zone=${zone:-(not set)}"
