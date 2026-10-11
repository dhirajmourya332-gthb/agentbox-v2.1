---
name: run-epic
description: Run big work as an epic — parent issue and sub-issues, an epic branch off main, sub-issue work delegated on branches off the epic and merged back into it, the epic kept current with main, and a final epic → main PR. Use when planned work needs more than one PR or agent.
---

# Run an epic

Rules: `/team/integrations/github.md` (its Branching and Issues sections, and the Settings table for the repo,
board and approver). Use the `file-github-issue` skill for every issue. Below, `<repo>` is
`owner/name` (the Default repo unless the task names another) and `<name>` is the part after the
slash; the shared clone is `/work/<name>`.

## 1. Decide it's an epic

Epic if it needs more than one PR or agent, spans several modules, takes more than about a day,
or is phased. Otherwise use a single `feature/`/`fix/` branch and skip this skill.

## 2. Issues

1. Parent issue: a parent type from the team's "Issue types" (e.g. `Feature` or `Bug`; epic
   parents have no title prefix). Body: goal, scope, design decisions, risks, and a checklist of
   the sub-issues.
2. One sub-issue per independently mergeable piece: the team's "Sub-issue type", linked as a
   sub-issue of the parent, with acceptance criteria, the required labels and dependencies
   between them.
3. All of them: assigned, on the board and in the current sprint as `/team/integrations/github.md` says.

## 3. Epic branch

```bash
cd /work/<name> && git fetch origin
EPIC=epic/<parent#>-<slug>
git push origin "origin/main:refs/heads/$EPIC"
```

Add `Epic branch: \`$EPIC\`` to the parent issue body.

## 4. Delegate the sub-issues

For each sub-issue that's ready (dependencies merged), delegate to the right teammate with:
- the sub-issue and parent links, acceptance criteria and constraints;
- **base branch `$EPIC`**, the branch name to use (`feature/<sub#>-<slug>` etc.), worktree
  `/work/<name>-<sub#>`;
- **PR target `$EPIC`**, body starting `Part of #<parent>` / `Resolves #<sub#>`.

Independent sub-issues can run in parallel; dependent ones wait for their prerequisite's merge.

## 5. Review and merge into the epic

Review each sub-issue PR (`review-pr` skill). Check its base is the epic. When it's approved and
green, squash-merge it into the epic (`gh pr merge <n> --squash --delete-branch`), close the
sub-issue (`gh issue close <sub#> --comment "Merged into $EPIC in #<pr>"`), and remove the
sub-issue's worktree and local branch right away (`/team/integrations/github.md`, Branching: clean up).

## 6. Keep the epic current

When `main` has moved (check `git log origin/$EPIC..origin/main`):

```bash
cd /work/<name> && git fetch origin
git worktree add /work/<name>-epic-<parent#> "origin/$EPIC" 2>/dev/null || true
cd /work/<name>-epic-<parent#> && git checkout -B "$EPIC" "origin/$EPIC"
git merge origin/main   # resolve conflicts, run tests
git push origin "$EPIC"
```

Never rebase or force-push the epic: other agents branch from it.

## 7. Finish

When every sub-issue is merged and the epic is green:

```bash
gh pr create -R <repo> --base main --head "$EPIC" \
  --title "<type>(<scope>): <epic summary>" --body-file /tmp/epic-<parent#>.md
```

Body: `Closes #<parent>`, what the epic delivers, the list of sub-issues and PRs, how it was
tested, risks. This is always a big PR: review it, then **ask for approval** from the team's
"Epic approval" person (the owner by default) before it's merged, with a **merge commit** (not
squash). Right after the merge, clean up (`/team/integrations/github.md`, Branching: clean up): delete the epic
branch on GitHub and locally, remove `/work/<name>-epic-<parent#>`, and remove any sub-issue
worktrees still left, then `git worktree prune`.
