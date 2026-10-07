---
name: file-github-issue
description: Create a GitHub issue (Bug, Feature, Task sub-issue, …) that follows the team's issue rules — type, title, labels, parent link, owner as assignee, on the Scrum board, in the current sprint. Use whenever you open a new issue.
---

# File a GitHub issue the team's way

The rules live in `/team/brandsek-issue-guidelines.md` and `/team/owner-issue-rules.md`. Read
them before your first issue in a task; the owner's rules win where they differ. This skill is
the checklist and the commands.

## 1. Decide the shape

- **Type** (`--type`, never a label): parents are `Stability`, `Feature` or `Bug`; a sub-issue
  is always `Task`; `Security` is standalone.
- **Title:** standalone/parent issues use the template prefix (`[BUG] `, `[FEAT] `, `[BE] `,
  `[FE] `, `[MS] `, `[QUEUE] `); epic parents have no prefix; sub-issues are a plain imperative
  sentence or `[M<milestone>-<seq>] …`. Never `[Task]`.
- **Labels:** sub-issues get a workstream label + a `size:` label. Only use labels from the
  catalogue in the guidelines; unknown labels are silently dropped.
- **Body:** concrete scope and acceptance criteria; for a sub-issue, reference the parent.

## 2. Create it

```bash
gh issue create -R Brandsek/digital_risk \
  --title "…" --body-file /tmp/issue-body.md \
  --type Task \
  --assignee dhirajmourya332-gthb \
  --label "<workstream>,size: M"
```

The assignee is always the owner at creation (owner's rule 1). Note the issue URL it prints.

## 3. Link the parent (sub-issues only)

```bash
P=$(gh api graphql -f query='query{repository(owner:"Brandsek",name:"digital_risk"){issue(number:PARENT){id}}}' -q .data.repository.issue.id)
C=$(gh api graphql -f query='query{repository(owner:"Brandsek",name:"digital_risk"){issue(number:CHILD){id}}}' -q .data.repository.issue.id)
gh api graphql -f query="mutation{addSubIssue(input:{issueId:\"$P\",subIssueId:\"$C\"}){subIssue{number}}}"
```

## 4. Board and sprint

```bash
python3 scripts/board-sprint.py <issue-url> --owner Brandsek --project 6
```

(`scripts/` is next to this file.) It adds the issue to the "Brandsek - Scrum" board if
automation hasn't, sets Iteration to the sprint covering today, and prints assignees, board and
Iteration so you can check them. Use `--dry-run` to only look.

## 5. Verify before you report it filed

Run the script again with `--dry-run` and confirm: assignee is `dhirajmourya332-gthb`, it's on
the board, Iteration is the current sprint ("Nothing to change."). Then report the issue link.

If `gh` says a scope is missing (`project` / `read:project`), stop and tell the owner; don't try
to re-authenticate.
