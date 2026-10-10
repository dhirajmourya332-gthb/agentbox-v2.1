#!/usr/bin/env bash
# aws: AWS CLI v2 (official zip) and the Session Manager plugin (official .deb). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure curl unzip ca-certificates
if ! have aws; then
  log "aws cli v2"
  tmp="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscli.zip"
  unzip -q "$tmp/awscli.zip" -d "$tmp" && "$tmp/aws/install" >/dev/null
  rm -rf "$tmp"
fi
if ! have session-manager-plugin; then
  log "session manager plugin"
  case "$(uname -m)" in x86_64) arch=ubuntu_64bit ;; aarch64) arch=ubuntu_arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
  tmp="$(mktemp -d)"
  curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/$arch/session-manager-plugin.deb" -o "$tmp/ssm.deb"
  dpkg -i "$tmp/ssm.deb" >/dev/null
  rm -rf "$tmp"
fi
aws --version
