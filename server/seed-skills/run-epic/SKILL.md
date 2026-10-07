---
name: run-epic
description: Run big work as an epic — parent issue and sub-issues, an epic branch off main, sub-issue work delegated on branches off the epic and merged back into it, the epic kept current with main, and a final epic → main PR. Use when planned work needs more than one PR or agent.
---

# Run an epic

Rules: `/team/branching.md` (flow), `/team/brandsek-issue-guidelines.md` and
`/team/owner-issue-rules.md` (issues). Use the `file-github-issue` skill for every issue.

## 1. Decide it's an epic

Epic if it needs more than one PR or agent, spans several modules, takes more than about a day,
or is phased. Otherwise use a single `feature/`/`fix/` branch and skip this skill.

## 2. Issues

1. Parent issue: type `Feature` / `Stability` / `Bug` (epic parents have no title prefix). Body:
   goal, scope, design decisions, risks, and a checklist of the sub-issues.
2. One sub-issue per independently mergeable piece: type `Task`, linked as a sub-issue of the
   parent, with acceptance criteria, labels (workstream + size) and dependencies between them.
3. All of them: assigned to the owner, on the Brandsek - Scrum board, in the current sprint.

## 3. Epic branch

```bash
cd /work/digital_risk && git fetch origin
EPIC=epic/<parent#>-<slug>
git push origin "origin/main:refs/heads/$EPIC"
```

Add `Epic branch: \`$EPIC\`` to the parent issue body.

## 4. Delegate the sub-issues

For each sub-issue that's ready (dependencies merged), delegate to the right teammate with:
- the sub-issue and parent links, acceptance criteria and constraints;
- **base branch `$EPIC`**, the branch name to use (`feature/<sub#>-<slug>` etc.), worktree
  `/work/digital_risk-<sub#>`;
- **PR target `$EPIC`**, body starting `Part of #<parent>` / `Resolves #<sub#>`.

Independent sub-issues can run in parallel; dependent ones wait for their prerequisite's merge.

## 5. Review and merge into the epic

Review each sub-issue PR (`review-pr` skill). Check its base is the epic. When it's approved and
green, squash-merge it into the epic and close the sub-issue
(`gh issue close <sub#> --comment "Merged into $EPIC in #<pr>"`).

## 6. Keep the epic current

When `main` has moved (check `git log origin/$EPIC..origin/main`):

```bash
cd /work/digital_risk && git fetch origin
git worktree add /work/digital_risk-epic-<parent#> "origin/$EPIC" 2>/dev/null || true
cd /work/digital_risk-epic-<parent#> && git checkout -B "$EPIC" "origin/$EPIC"
git merge origin/main   # resolve conflicts, run tests
git push origin "$EPIC"
```

Never rebase or force-push the epic: other agents branch from it.

## 7. Finish

When every sub-issue is merged and the epic is green:

```bash
gh pr create -R Brandsek/digital_risk --base main --head "$EPIC" \
  --title "<type>(<scope>): <epic summary>" --body-file /tmp/epic-<parent#>.md
```

Body: `Closes #<parent>`, what the epic delivers, the list of sub-issues and PRs, how it was
tested, risks. This is always a big PR: review it, then **ask the owner to approve** before it's
merged, with a **merge commit** (not squash). Afterwards delete the epic branch and its worktree.
