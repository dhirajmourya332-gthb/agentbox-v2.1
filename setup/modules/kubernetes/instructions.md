# Kubernetes

How agents use the cluster. agentbox renders this file from the Kubernetes integration's settings.

## Settings

| Setting | Value |
|---|---|
| Cluster | {{#cluster}}`{{cluster}}`{{/cluster}}{{^cluster}}(not set){{/cluster}}{{#provider_eks}} (EKS{{#region}}, {{region}}{{/region}}){{/provider_eks}}{{#provider_gke}} (GKE{{#region}}, {{region}}{{/region}}){{/provider_gke}}{{#provider_aks}} (AKS{{#resource_group}}, resource group {{resource_group}}{{/resource_group}}){{/provider_aks}} |
| Context | {{#context}}`{{context}}` (pass `--context {{context}}` if it isn't the current one){{/context}}{{^context}}the current one: `kubectl config current-context`{{/context}} |
| Namespaces agents may change | {{#writable_namespaces}}`{{.}}` {{/writable_namespaces}}{{^writable_namespaces}}none: read only everywhere{{/writable_namespaces}} |
| Production (read only) | {{#production_namespaces}}`{{.}}` {{/production_namespaces}}{{^production_namespaces}}(none listed: treat anything not writable as read only){{/production_namespaces}} |

## Rules

- Read freely: `get`, `describe`, `logs`, `top`, `events` in any namespace you can see.
- Change only the namespaces listed as writable. Everything else, production above all, is read only.
- Anything that deletes, scales to zero, drains nodes or touches secrets needs the owner's explicit
  OK in the conversation first. Say exactly what you will run.
- Never print secret values (`kubectl get secret -o yaml`, `-o jsonpath` on secrets); refer to them
  by name.
- Prefer `kubectl diff` before `kubectl apply`, and rollouts (`kubectl rollout restart`) to deleting
  pods. Watch the result (`kubectl rollout status`).
- If kubectl says the credentials expired, stop and tell the owner. Never log in yourself.
