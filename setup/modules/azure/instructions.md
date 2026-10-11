# Microsoft Azure

How agents use Azure here. agentbox renders this file from the Azure integration's settings.

## Settings

| Setting | Value |
|---|---|
| Subscription | `{{subscription}}` |
| Tenant | {{#tenant}}`{{tenant}}`{{/tenant}}{{^tenant}}(the account's default){{/tenant}} |
| Resource group | {{#resource_group}}`{{resource_group}}`{{/resource_group}}{{^resource_group}}(not set){{/resource_group}} |
| Location | {{#location}}`{{location}}`{{/location}}{{^location}}(not set){{/location}} |
| Access | {{access}} |
| Protected resources | {{#protected}}`{{.}}` {{/protected}}{{^protected}}(none listed){{/protected}} |

## Rules

- `az` is logged in on this VM with subscription `{{subscription}}` selected. Pass
  `--subscription` explicitly for any other subscription, and only if the task says so.
{{#resource_group}}
- Work in the resource group `{{resource_group}}` unless the task names another (`-g {{resource_group}}`).
{{/resource_group}}
{{#access_read_only}}
- **Read only.** You may `list`, `show`, read logs and metrics (`az monitor …`). Anything that
  creates, changes, deletes, deploys or scales needs the owner's explicit OK in the conversation
  first: say exactly which command you will run.
{{/access_read_only}}
{{#access_non_production}}
- You may change **non-production** resources (dev, staging, test) after saying what you will run.
  Production, role assignments, networking, Key Vault and anything listed as protected need the
  owner's explicit OK.
{{/access_non_production}}
{{#access_full}}
- You may change resources the task is about. Role assignments, deletes, Key Vault and anything
  listed as protected still need the owner's explicit OK first.
{{/access_full}}
- Never print secret values (`az keyvault secret show`, storage keys, connection strings,
  `az account get-access-token`); refer to them by name.
- Prefer `what-if` first for deployments (`az deployment group what-if …`).
- If az says the login expired, stop and tell the owner. Never log in yourself.
- AKS: `az aks get-credentials -g <group> -n <cluster>` sets up kubectl (the Kubernetes
  integration's rules then apply).
