---
name: review-pr
description: Review a GitHub pull request thoroughly — context, diff, dependencies, tests, CI — and leave specific inline and summary comments. Use when asked to review a PR or when doing scheduled PR reviews.
---

# Review a pull request

Your job description decides what you may merge; this skill is how to review.

## 1. Context first

```bash
gh pr view <n> -R <owner/repo> --json title,body,author,baseRefName,headRefName,files,additions,deletions,labels,closingIssuesReferences,reviews
gh pr checks <n> -R <owner/repo>
```

Read the linked issue(s) and their acceptance criteria. No linked issue: note it in the review.

## 2. Read the change in a worktree

```bash
cd /work/<repo> && git fetch origin pull/<n>/head:pr-<n>
git worktree add /work/review-<repo>-<n> pr-<n> && cd /work/review-<repo>-<n>
git diff origin/<base>...HEAD --stat && git diff origin/<base>...HEAD
```

For each changed public function, endpoint, schema or shared module, search its callers
(`grep -rn`) and check they still hold. Run the relevant tests if CI didn't.

## 3. Judge

- Right branch and base (`/team/branching.md`)? An epic sub-issue PR must come from
  `<prefix>/<sub#>-<slug>` and target `epic/<parent#>-<slug>`, with `Part of #<parent>` /
  `Resolves #<sub>`; a standalone PR targets `main` with `Closes #<issue>`. Wrong base is blocking.
- Is the branch current with its base (no conflicts, `git merge origin/<base>` clean)?
- Does it do what the issue asks — all acceptance criteria, nothing unasked?
- Correctness: edge cases, error handling, null/empty inputs, concurrency, migrations.
- Breaking changes for callers, APIs and stored data.
- Tests: do they cover the change and would they fail without it?
- Security: input validation, authz checks, secrets, injection.
- Clarity: naming, structure, dead code, comments that lie.

Label every finding: **blocking** (must fix), **should** (fix unless there's a reason),
**nit** (optional). Don't pad with praise or restate the diff.

## 4. Comment

Inline comments for specific lines (path, line on the PR's head commit):

```bash
gh api repos/<owner>/<repo>/pulls/<n>/comments -f body="**blocking:** …" \
  -f commit_id="$(gh pr view <n> -R <owner/repo> --json headRefOid -q .headRefOid)" \
  -f path="src/x.ts" -F line=42 -f side=RIGHT
```

Then one summary review: `gh pr review <n> -R <owner/repo> --request-changes|--comment|--approve --body-file /tmp/review.md`
with the verdict first, then blocking items, then the rest.

## 5. Merging (if your job description lets you merge it)

- Sub-issue PR into an epic: squash-merge, then close the sub-issue
  (`gh issue close <sub#> --comment "Merged into <epic> in #<pr>"`).
- Small PR into `main`: squash-merge.
- Epic → `main`: never merge it yourself without the owner's approval; it uses a merge commit.

## 6. Clean up

`git worktree remove /work/review-<repo>-<n>` and delete the `pr-<n>` branch.
Remember (in your memory) PRs you reviewed and at which head commit, so you don't re-review
unchanged PRs.
