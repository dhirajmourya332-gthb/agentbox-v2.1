# AWS

How agents use AWS here. agentbox renders this file from the AWS integration's settings.

## Settings

| Setting | Value |
|---|---|
| Region | `{{region}}` |
| Profile | {{#profile}}`{{profile}}` (`export AWS_PROFILE={{profile}}` or `--profile {{profile}}`){{/profile}}{{^profile}}the default credentials (instance role or default profile){{/profile}} |
| Account | {{#account_id}}`{{account_id}}`: check `aws sts get-caller-identity` before any change{{/account_id}}{{^account_id}}(not set){{/account_id}} |
| Access | {{access}} |
| Protected resources | {{#protected}}`{{.}}` {{/protected}}{{^protected}}(none listed){{/protected}} |

## Rules

- Work in `{{region}}` unless the task names another region.
{{#access_read_only}}
- **Read only.** You may `describe`, `list`, `get` and read logs and metrics (CloudWatch). Anything
  that creates, changes, deletes, deploys or scales needs the owner's explicit OK in the
  conversation first: say exactly which command you will run.
{{/access_read_only}}
{{#access_non_production}}
- You may change **non-production** resources (dev, staging, test) after saying what you will run.
  Production, IAM, billing, networking (VPCs, security groups) and anything listed as protected need
  the owner's explicit OK.
{{/access_non_production}}
{{#access_full}}
- You may change resources the task is about. IAM, deletes and anything listed as protected still
  need the owner's explicit OK first.
{{/access_full}}
- Never print secret values (`secretsmanager get-secret-value`, `ssm get-parameter --with-decryption`,
  access keys); refer to secrets by name. Never create access keys.
- Never open security groups to `0.0.0.0/0` or make buckets public.
- Session Manager (`aws ssm start-session`) is available for instances; prefer it to SSH.
- If the credentials expired (`aws sso login` needed), stop and tell the owner. Never log in yourself.
- EKS: `aws eks update-kubeconfig --name <cluster> --region {{region}}` sets up kubectl (the
  Kubernetes integration's rules then apply).
