#!/usr/bin/env bash
# kubernetes: kubectl, the current stable release from dl.k8s.io (checksum verified). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
if ! have kubectl; then
  log "kubectl"
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
  ver="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
  tmp="$(mktemp -d)"
  curl -fsSL "https://dl.k8s.io/release/$ver/bin/linux/$arch/kubectl" -o "$tmp/kubectl"
  curl -fsSL "https://dl.k8s.io/release/$ver/bin/linux/$arch/kubectl.sha256" -o "$tmp/kubectl.sha256"
  echo "$(cat "$tmp/kubectl.sha256")  $tmp/kubectl" | sha256sum --check --quiet
  install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl
  rm -rf "$tmp"
fi
kubectl version --client 2>/dev/null | head -1
