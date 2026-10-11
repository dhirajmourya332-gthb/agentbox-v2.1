#!/usr/bin/env bash
# azure: logged in, on the configured subscription. Runs as the agent user; prints names, never tokens.
source "$(dirname "$0")/../../lib/common.sh"
az account show >/dev/null 2>&1 || die "az isn't logged in: run 'az login --use-device-code' (or 'az login --identity' on an Azure VM)"
want="$(agentbox integration settings azure --get subscription)"
if [ -n "$want" ] && ! az account show --query '[id,name]' -o tsv | tr '\t' '\n' | grep -Fxq -- "$want"; then
  az account set --subscription "$want" || die "logged in, but can't select the subscription $want"
fi
rg="$(agentbox integration settings azure --get resource_group)"
if [ -n "$rg" ]; then az group show --name "$rg" --query name -o tsv >/dev/null || die "can't see the resource group $rg"; fi
echo "azure ok: $(az account show --query user.name -o tsv), subscription $(az account show --query name -o tsv)${rg:+, resource group $rg}"
