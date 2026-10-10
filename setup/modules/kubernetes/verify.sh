#!/usr/bin/env bash
# kubernetes: the context, and what this identity can do.
source "$(dirname "$0")/../../lib/common.sh"
ctx="$(kubectl config current-context 2>/dev/null)" || die "no kubeconfig context: see the cluster step"
kubectl auth can-i get pods >/dev/null 2>&1 || die "context $ctx: can't get pods"
echo "kubernetes ok: context $ctx"
for verb in "create deployments" "delete pods" "get secrets"; do
  printf '  can-i %-18s %s\n' "$verb" "$(kubectl auth can-i $verb 2>/dev/null || true)"
done
