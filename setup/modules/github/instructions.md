# GitHub

How this team uses GitHub. agentbox renders this file from the GitHub integration's settings; the
GitHub skills (file-github-issue, run-epic, open-pr, review-pr, fix-vulnerability) take their
parameters from the **Settings** table. A setting shown as "(not set)" means: skip that part (no
assignee, no board, no sprint) and say so in your report. Never guess an org, board or person.

## Settings

| Setting | Value |
|---|---|
| Default repo | {{#default_repo}}`{{default_repo}}` (clone: `{{paths.work}}/<name>`){{/default_repo}}{{^default_repo}}(not set: ask the owner which repo){{/default_repo}} |
| Other repos | {{#other_repos}}`{{.}}` {{/other_repos}}{{^other_repos}}(none: anything else needs the owner's OK){{/other_repos}} |
| Issue assignee | {{#issue_assignee}}`{{issue_assignee}}`{{/issue_assignee}}{{^issue_assignee}}(not set){{/issue_assignee}} |
| Project owner | {{#project_owner}}`{{project_owner}}`{{/project_owner}}{{^project_owner}}(not set: no board){{/project_owner}} |
| Project number | {{#project_number}}`{{project_number}}`{{/project_number}}{{^project_number}}(not set){{/project_number}} |
| Project name | {{#project_name}}{{project_name}}{{/project_name}}{{^project_name}}(not set){{/project_name}} |
| Sprint field | {{#sprint_field}}`{{sprint_field}}`{{/sprint_field}}{{^sprint_field}}(not set: no sprints){{/sprint_field}} |
| Issue types | {{#issue_types}}`{{.}}` {{/issue_types}}{{^issue_types}}(none: use labels){{/issue_types}} |
| Sub-issue type | `{{sub_issue_type}}` |
| Title prefixes | {{#title_prefixes}}`{{.}} ` {{/title_prefixes}}{{^title_prefixes}}(none){{/title_prefixes}} |
| Required labels (sub-issues) | {{#required_labels}}{{required_labels}}{{/required_labels}}{{^required_labels}}(none){{/required_labels}} |
| Label catalogue | {{#labels}}`{{.}}` {{/labels}}{{^labels}}(not set: use only labels that already exist in the repo){{/labels}} |
| Epic approval | {{epic_approval}} |
| Main branch | `{{base_branch}}` |

## Issues

- One issue per independently shippable piece of work, with concrete scope and acceptance criteria.
- Set the type with `--type`{{#has_issue_types}} (one of the issue types above){{/has_issue_types}}, never with a label.
- A sub-issue references its parent and is linked as a GitHub sub-issue; it gets the sub-issue type.
- Only use labels from the label catalogue: GitHub drops unknown ones silently.
{{#project_owner}}
- Put new issues on the board ({{#project_name}}{{project_name}}, {{/project_name}}`{{project_owner}}` project {{project_number}}){{#sprint_field}} in the current sprint ({{sprint_field}}){{/sprint_field}}; the `file-github-issue` skill does this.
{{/project_owner}}
- If `gh` reports a missing scope (`project`, `read:project`), stop and tell the owner. Never
  re-authenticate on your own.

## Branching

1. **Small work** (one PR, one agent): branch `<prefix>/<issue#>-<slug>` off `{{base_branch}}`, PR to
   `{{base_branch}}`. Prefixes: `feature/`, `fix/`, `hotfix/` (urgent production fix, the owner's
   call), `chore/`, `refactor/`, `docs/`, `test/`.
2. **Big work** (several PRs, agents or modules, more than about a day, or phased) is an **epic**:
   a parent issue plus sub-issues, and a branch `epic/<parent#>-<slug>` pushed from `{{base_branch}}`.
3. Sub-issue branches come off the epic branch, and their PRs target the epic (squash merge).
4. Keep the epic current by merging `{{base_branch}}` into it. Never rebase or force-push an epic.
5. The final PR is epic → `{{base_branch}}`, approved by {{epic_approval}}, merged with a merge commit.
6. **One git worktree per issue:** `{{paths.work}}/<repo>-<issue#>` (epics:
   `{{paths.work}}/<repo>-epic-<parent#>`). Never edit in the shared clone `{{paths.work}}/<repo>`
   or in another agent's worktree.
7. Commits follow Conventional Commits: `type(scope): summary`.
8. **Clean up right after a merge:** delete the branch on GitHub and locally, remove its worktree,
   then `git worktree prune`.

## Pull requests

- A standalone PR body starts with `Closes #<issue>`; an epic sub-issue PR with
  `Part of #<parent>` and `Resolves #<sub-issue>`.
- Sections: What changed, Why, How I tested, Risks / follow-ups.
- Wait for CI (`gh pr checks <n> --watch`) and fix failures on the same branch.
- Never merge to `{{base_branch}}` without the approval the rules above require.
