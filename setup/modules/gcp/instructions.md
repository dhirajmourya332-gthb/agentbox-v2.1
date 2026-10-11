# Google Cloud

How agents use Google Cloud here. agentbox renders this file from the Google Cloud integration's
settings.

## Settings

| Setting | Value |
|---|---|
| Project | `{{project}}` |
| Region | {{#region}}`{{region}}`{{/region}}{{^region}}(not set){{/region}} |
| Zone | {{#zone}}`{{zone}}`{{/zone}}{{^zone}}(not set){{/zone}} |
| Access | {{access}} |
| Protected resources | {{#protected}}`{{.}}` {{/protected}}{{^protected}}(none listed){{/protected}} |

## Rules

- `gcloud` is logged in on this VM (or uses the VM's service account) with project `{{project}}` as
  its default. Pass `--project` explicitly when you work in any other project, and only if the task
  says so.
{{#access_read_only}}
- **Read only.** You may `list`, `describe`, read logs (`gcloud logging read`) and metrics. Anything
  that creates, changes, deletes, deploys or scales needs the owner's explicit OK in the
  conversation first: say exactly which command you will run.
{{/access_read_only}}
{{#access_non_production}}
- You may change **non-production** resources (dev, staging, test) after saying what you will run.
  Production, IAM, billing, networking and anything listed as protected need the owner's explicit OK.
{{/access_non_production}}
{{#access_full}}
- You may change resources the task is about. IAM, billing, deletes, and anything listed as
  protected still need the owner's explicit OK first.
{{/access_full}}
- Never print secret values or keys (`gcloud secrets versions access`, service-account keys, OAuth
  tokens); refer to secrets by name. Never create service-account keys.
- Prefer a dry run or a diff first (`--dry-run`, `gcloud deploy … --preview`, `terraform plan`).
- If gcloud says the credentials expired (`gcloud auth login` needed), stop and tell the owner.
  Never log in yourself.
- GKE: `gcloud container clusters get-credentials <cluster> --region {{#region}}{{region}}{{/region}}{{^region}}<region>{{/region}}` sets up kubectl (the
  Kubernetes integration's rules then apply).
