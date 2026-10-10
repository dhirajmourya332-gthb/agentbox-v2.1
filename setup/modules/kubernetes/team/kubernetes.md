# Kubernetes rules (example: edit to fit your team)

- Cluster: `example-cluster` in `us-east-1` (replace). Context: `kubectl config current-context`.
- Read freely: `get`, `describe`, `logs`, `top` in any namespace you can see.
- Namespaces agents may change: `dev`, `staging` (replace). Production: read only.
- Anything that deletes, scales to zero, or touches secrets needs the owner's explicit OK in the
  conversation first. Say exactly what you will run.
- Never print secret values (`kubectl get secret -o yaml`); refer to them by name.
- Prefer `kubectl diff` before `kubectl apply`; prefer rollouts (`kubectl rollout restart`) to
  deleting pods.
