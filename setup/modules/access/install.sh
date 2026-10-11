#!/usr/bin/env bash
# Installs the client for the chosen access mode from its vendor's official apt repository.
# Idempotent. Run as root (the setup agent uses sudo).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
# shellcheck source=setup/lib/apt-wait.sh
. "$here/../../lib/apt-wait.sh"
need_root

. /etc/os-release
codename="${VERSION_CODENAME:?no VERSION_CODENAME in /etc/os-release}"
export DEBIAN_FRONTEND=noninteractive
install -d -m 0755 /usr/share/keyrings

case "$(mode)" in
  tailscale)
    if command -v tailscale >/dev/null; then ok "tailscale already installed ($(tailscale version | head -1))"; exit 0; fi
    # https://pkgs.tailscale.com/stable/#ubuntu-<codename>
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
    grep -q 'signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg' /etc/apt/sources.list.d/tailscale.list \
      || die "Unexpected tailscale.list contents; refusing to continue"
    wait_for_apt
    apt-get update -qq
    wait_for_apt
    apt-get install -y -qq tailscale
    systemctl enable --now tailscaled
    ok "tailscale installed ($(tailscale version | head -1))"
    ;;
  cloudflare)
    if command -v cloudflared >/dev/null; then ok "cloudflared already installed ($(cloudflared --version 2>&1 | head -1))"; exit 0; fi
    # https://pkg.cloudflare.com/index.html
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      > /etc/apt/sources.list.d/cloudflared.list
    wait_for_apt
    apt-get update -qq
    wait_for_apt
    apt-get install -y -qq cloudflared
    ok "cloudflared installed ($(cloudflared --version 2>&1 | head -1))"
    ;;
  ssh-tunnel) ok "ssh-tunnel needs nothing installed" ;;
  *) die "access is '$(mode)'; set it first: agentbox config set access tailscale|cloudflare|ssh-tunnel" ;;
esac
