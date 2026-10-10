# GitHub team rules

<!--
  This file is an EXAMPLE. The github module copies it to /team/github.md; edit that copy.
  Every agent reads /team/github.md before it files an issue, cuts a branch or opens a PR, and the
  GitHub seed skills (file-github-issue, run-epic, open-pr, review-pr, fix-vulnerability) take
  their parameters from the "Settings" table below. Replace every value in angle brackets, delete
  rows you don't use, and keep the row names as they are (the skills look for them).
-->

## Settings

| Setting | Value | Notes |
|---|---|---|
| Default repo | `acme/web-app` | `owner/name`. Used when a task doesn't name a repo. Clone path: `/work/<name>`. |
| Other repos | `acme/api`, `acme/infra` | Repos agents may work in. Anything else: ask the owner first. |
| Issue assignee | `<your-github-login>` | Assigned to every new issue. Leave empty to not assign. |
| Project owner | `acme` | The org (or user) that owns the project board. Empty = no board. |
| Project number | `1` | From the board URL: `github.com/orgs/acme/projects/1`. |
| Project name | `Acme - Scrum` | Only for messages and checks. |
| Sprint field | `Iteration` | The board's iteration field. Empty = no sprints. |
| Issue types | `Feature`, `Bug`, `Task`, `Security` | Must exist in the org's issue types; otherwise use labels instead. |
| Sub-issue type | `Task` | The type every sub-issue of an epic gets. |
| Title prefixes | `[BUG] `, `[FEAT] ` | For standalone issues. Epic parents and sub-issues have none. Empty = none. |
| Required labels (sub-issues) | one workstream label + one `size:` label | |
| Label catalogue | `backend`, `frontend`, `infra`, `docs`, `size: S`, `size: M`, `size: L` | Only use labels from this list; GitHub drops unknown ones silently. |
| Epic approval | owner | Who approves the final epic → main PR. |
| Merge style | squash into epics and for small PRs; merge commit for epic → main | |

## Issues

- One issue per independently shippable piece of work, with concrete scope and acceptance criteria.
- Set the type with `--type`, never with a label.
- A sub-issue references its parent and is linked as a GitHub sub-issue.
- Put new issues on the board in the current sprint (the `file-github-issue` skill does this).
- If `gh` reports a missing scope (`project`, `read:project`), stop and tell the owner. Never
  re-authenticate on your own.

## Branching

1. **Small work** (one PR, one agent): branch `<prefix>/<issue#>-<slug>` off `main`, PR to `main`.
   Prefixes: `feature/`, `fix/`, `hotfix/` (urgent production fix, owner's call), `chore/`,
   `refactor/`, `docs/`, `test/`.
2. **Big work** (several PRs, agents or modules, more than about a day, or phased) is an **epic**:
   a parent issue plus sub-issues, and a branch `epic/<parent#>-<slug>` pushed from `main`.
3. Sub-issue branches come off the epic branch, and their PRs target the epic (squash merge).
4. The epic is kept current by merging `main` into it. Never rebase or force-push an epic.
5. The final PR is epic → `main`, approved by the person in "Epic approval", merged with a merge
   commit.
6. **One git worktree per issue:** `/work/<repo>-<issue#>` (epics: `/work/<repo>-epic-<parent#>`).
   Never edit in the shared clone `/work/<repo>` or in another agent's worktree.
7. Commits follow Conventional Commits: `type(scope): summary`.
8. **Clean up right after a merge:** delete the branch on GitHub and locally, remove its worktree,
   then `git worktree prune`.

## Pull requests

- Standalone PR body starts with `Closes #<issue>`; an epic sub-issue PR with
  `Part of #<parent>` and `Resolves #<sub-issue>`.
- Sections: What changed, Why, How I tested, Risks / follow-ups.
- Wait for CI (`gh pr checks <n> --watch`) and fix failures on the same branch.
