---
name: open-pr
description: Implement an issue or sub-issue on the right branch (epic sub-branch or feature/fix/hotfix off main) in its own git worktree, and open a pull request to the right base. Use whenever you've been asked to implement or fix something.
---

# Implement and open a pull request

Branching rules: `/team/integrations/github.md` (Branching and Pull requests). This skill is the procedure.

## 1. Know your base before you branch

From the handoff or the issue, you need: the repo (`owner/name`; the Default repo in
`/team/integrations/github.md` unless the task names another), the issue number, whether it's a **sub-issue of an
epic** (then the base is `epic/<parent#>-<slug>`) or **standalone** (base `main`), and the branch
prefix (`feature/`, `fix/`, `hotfix/`, `chore/`, `refactor/`, `docs/`, `test/`). If any of that is
missing, ask whoever handed you the work before creating anything.

## 2. Your own worktree

```bash
OWNER=<owner>; REPO=<name>; ISSUE=<issue#>; BASE=<main | epic/…>; BRANCH=<prefix>/<issue#>-<slug>
[ -d /work/$REPO ] || gh repo clone $OWNER/$REPO /work/$REPO
cd /work/$REPO && git fetch origin
git worktree list | grep -q -- "-$ISSUE\b" && echo "already being worked on: stop and ask"
git worktree add -b "$BRANCH" /work/$REPO-$ISSUE "origin/$BASE"
cd /work/$REPO-$ISSUE
```

Never edit in `/work/$REPO` (the shared clone) or in another agent's worktree.

## 3. Change

- Read the issue and its acceptance criteria first; if unclear, ask before building.
- Follow the repo's existing patterns; keep the diff to this issue only.
- Add or update tests that fail without the change; run the tests and linters you can.

## 4. Commit

Conventional commits with an optional scope, small and logical:
`fix(charts): backfill blank date axis`.

## 5. Update from the base, then open the PR

```bash
git fetch origin && git merge "origin/$BASE"   # resolve conflicts, rerun tests
git push -u origin HEAD
gh pr create -R $OWNER/$REPO --base "$BASE" --title "<type>(<scope>): <summary>" --body-file /tmp/pr-$ISSUE.md
```

Body for a standalone issue (base `main`):

```markdown
Closes #<issue>

## What changed
## Why
## How I tested
## Risks / follow-ups
```

Body for an epic sub-issue (base `epic/…`): start with

```markdown
Part of #<parent>
Resolves #<sub-issue>
```

(GitHub only auto-closes issues on merges into `main`; the sub-issue is closed by hand after this
PR merges into the epic.)

## 6. After opening

`gh pr checks <n> --watch` until CI finishes; fix failures on the same branch. Report the PR link,
its base branch, CI status, and anything the reviewer should look at.

## 7. After it merges

- Epic sub-issue: `gh issue close <sub#> -R $OWNER/$REPO --comment "Merged into <epic branch> in #<pr>"`.
- Clean up: `cd /work/$REPO && git worktree remove /work/$REPO-$ISSUE && git branch -D "$BRANCH"`
  and `git push origin --delete "$BRANCH"` if GitHub didn't delete it.
