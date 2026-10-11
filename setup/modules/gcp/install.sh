#!/usr/bin/env bash
# gcp: the Google Cloud CLI (google-cloud-cli) and the GKE auth plugin for kubectl, from Google's
# official apt repository (https://cloud.google.com/sdk/docs/install#deb). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure curl ca-certificates gnupg apt-transport-https
if ! have gcloud; then
  log "google cloud cli (apt)"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor --yes -o /usr/share/keyrings/cloud.google.gpg
  chmod 0644 /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list
  wait_for_apt && apt-get update -qq && apt_install google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin
fi
gcloud --version 2>/dev/null | head -1
