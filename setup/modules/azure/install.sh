#!/usr/bin/env bash
# azure: the Azure CLI from Microsoft's official apt repository
# (https://learn.microsoft.com/cli/azure/install-azure-cli-linux?pivots=apt). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure curl ca-certificates gnupg apt-transport-https lsb-release
if ! have az; then
  log "azure cli (apt)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
  chmod 0644 /etc/apt/keyrings/microsoft.gpg
  cat > /etc/apt/sources.list.d/azure-cli.sources <<SRC
Types: deb
URIs: https://packages.microsoft.com/repos/azure-cli/
Suites: $(lsb_release -cs)
Components: main
Architectures: $(dpkg --print-architecture)
Signed-by: /etc/apt/keyrings/microsoft.gpg
SRC
  wait_for_apt && apt-get update -qq && apt_install azure-cli
fi
az version --query '"azure-cli"' -o tsv 2>/dev/null || az --version | head -1
