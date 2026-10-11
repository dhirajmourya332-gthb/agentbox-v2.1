#!/usr/bin/env bash
# gcp: who we are and whether the project is visible. Runs as the agent user; prints the account, never keys.
source "$(dirname "$0")/../../lib/common.sh"
account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
[ -n "$account" ] || die "no Google Cloud credentials: run 'gcloud auth login --no-launch-browser' (or give the GCE VM a service account)"
want="$(agentbox integration settings gcp --get project)"
have_p="$(gcloud config get-value project 2>/dev/null || true)"
if [ -n "$want" ] && [ "$have_p" != "$want" ]; then
  gcloud config set project "$want" --quiet >/dev/null 2>&1 || true
  have_p="$want"
fi
[ -n "$have_p" ] || die "no project set: gcloud config set project <id>"
gcloud projects describe "$have_p" --format='value(projectId)' >/dev/null || die "$account can't see the project $have_p"
echo "gcp ok: $account, project $have_p"
