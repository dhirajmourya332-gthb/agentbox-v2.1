---
name: open-pr
description: Implement a change on its own branch in a separate git worktree and open a well-described pull request linked to its issue. Use when you've been asked to implement or fix something.
---

# Open a pull request

## 1. Workspace

Never work in another agent's checkout. Use a worktree per change:

```bash
cd /work/<repo> || gh repo clone <owner>/<repo> /work/<repo>
cd /work/<repo> && git fetch origin
git worktree add -b <type>/<issue>-<slug> /work/<repo>-<issue> origin/main
cd /work/<repo>-<issue>
```

Branch `<type>`: `fix`, `feat`, `chore`, `build`, `docs`.

## 2. Change

- Read the issue and its acceptance criteria first; if they're unclear, ask before building.
- Follow the repo's existing patterns; keep the diff focused on the issue.
- Add or update tests that fail without the change. Run the test suite and linters locally.

## 3. Commit

Conventional commits with an optional scope: `fix(graphs): backfill blank scan-date axis`.
Small, logical commits.

## 4. Open the PR

```bash
git push -u origin HEAD
gh pr create -R <owner>/<repo> --base main --title "<type>(<scope>): <summary>" --body-file /tmp/pr.md
```

Body:

```markdown
Closes #<issue>

## What changed
- …

## Why
…

## How I tested
- …

## Risks / follow-ups
- …
```

## 5. After opening

`gh pr checks <n> --watch` until CI finishes; fix failures on the same branch. Report the PR
link, CI status and anything a reviewer should look at. Remove the worktree after merge.
