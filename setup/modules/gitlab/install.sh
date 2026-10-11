#!/usr/bin/env bash
# gitlab: git and glab, GitLab's official CLI, from the .deb on its GitLab releases page (checksum
# verified). Idempotent; upgrades only when glab is missing.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure git curl ca-certificates jq
if ! have glab; then
  log "glab (GitLab CLI)"
  case "$(dpkg --print-architecture)" in amd64) arch=amd64 ;; arm64) arch=arm64 ;; *) die "unsupported arch $(dpkg --print-architecture)" ;; esac
  api="https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest"
  rel="$(curl -fsSL "$api")" || die "couldn't read the latest glab release ($api)"
  ver="$(jq -r '.tag_name | ltrimstr("v")' <<<"$rel")"
  deb="glab_${ver}_linux_${arch}.deb"
  asset() { jq -r --arg n "$1" '.assets.links[] | select(.name == $n) | .url' <<<"$rel" | head -1; }
  deb_url="$(asset "$deb")"; sums_url="$(asset checksums.txt)"
  [ -n "$deb_url" ] && [ -n "$sums_url" ] || die "glab $ver has no $deb or checksums.txt"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$deb_url" -o "$tmp/$deb"
  curl -fsSL "$sums_url" -o "$tmp/checksums.txt"
  (cd "$tmp" && grep " $deb\$" checksums.txt | sha256sum --check --quiet) || die "glab checksum mismatch"
  wait_for_apt
  apt-get install -y -qq "$tmp/$deb" >/dev/null
fi
glab version | head -1
