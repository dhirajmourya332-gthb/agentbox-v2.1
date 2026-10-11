# GitLab

How this team uses GitLab ({{host}}). agentbox renders this file from the GitLab integration's
settings. A setting shown as "(not set)" means: skip that part and say so in your report; never
guess a project or person.

## Settings

| Setting | Value |
|---|---|
| Host | `{{host}}` |
| Default project | {{#default_project}}`{{default_project}}` (clone: `{{paths.work}}/<name>`){{/default_project}}{{^default_project}}(not set: ask the owner){{/default_project}} |
| Other projects | {{#other_projects}}`{{.}}` {{/other_projects}}{{^other_projects}}(none: anything else needs the owner's OK){{/other_projects}} |
| Issue assignee | {{#issue_assignee}}`{{issue_assignee}}`{{/issue_assignee}}{{^issue_assignee}}(not set){{/issue_assignee}} |
| Label catalogue | {{#labels}}`{{.}}` {{/labels}}{{^labels}}(not set: only labels that already exist){{/labels}} |
| Main branch | `{{base_branch}}` |
| Merge approval | {{merge_approval}} |

## Working with glab

- `glab` is logged in for `{{host}}`; pass `--repo <group/name>` (or `-R`) when you're not inside a
  clone. Clone with `glab repo clone <group/name> {{paths.work}}/<name>`.
- Issues: `glab issue create --title … --description … {{#issue_assignee}}--assignee {{issue_assignee}} {{/issue_assignee}}--label …`,
  `glab issue list`, `glab issue view <n>`.
- Merge requests: `glab mr create --source-branch <branch> --target-branch {{base_branch}} --fill`,
  `glab mr view <n>`, `glab mr diff <n>`, `glab mr note <n> -m …`.
- Pipelines: `glab ci status`, `glab ci view`, `glab ci trace <job>`. Wait for the pipeline and fix
  failures on the same branch.
- Anything else: `glab api <endpoint>` (REST v4), read-only unless the task says otherwise.
- If glab says the token expired or lacks a scope, stop and tell the owner. Never log in yourself.

## Branching and merge requests

1. Branch `<prefix>/<issue#>-<slug>` off `{{base_branch}}` (`feature/`, `fix/`, `chore/`, `docs/`…),
   one git worktree per issue: `{{paths.work}}/<repo>-<issue#>`. Never edit in the shared clone or
   another agent's worktree.
2. Commits follow Conventional Commits: `type(scope): summary`.
3. The MR description starts with `Closes #<issue>` and has: What changed, Why, How I tested,
   Risks / follow-ups.
4. Merges to `{{base_branch}}` need {{merge_approval}}'s approval. Never push to `{{base_branch}}` directly.
5. After the merge, delete the branch and its worktree (`git worktree prune`).
