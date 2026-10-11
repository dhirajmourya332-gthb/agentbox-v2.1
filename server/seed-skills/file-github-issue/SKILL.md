---
name: file-github-issue
description: Create a GitHub issue (Bug, Feature, Task sub-issue, …) that follows the team's issue rules in /team/integrations/github.md — type, title, labels, parent link, assignee, on the project board, in the current sprint. Use whenever you open a new issue.
---

# File a GitHub issue the team's way

The rules live in `/team/integrations/github.md`. Read it before your first issue in a task. This skill is the
checklist and the commands; the values in `<angle brackets>` come from its **Settings** table:

| Placeholder | Setting in `/team/integrations/github.md` |
|---|---|
| `<repo>` | Default repo, unless the task names another (`owner/name`) |
| `<assignee>` | Issue assignee |
| `<project-owner>`, `<project-number>`, `<project-name>` | Project owner, number, name |
| `<sprint-field>` | Sprint field |

If `/team/integrations/github.md` is missing, or a setting you need is empty, skip that part (no assignee, no
board, no sprint) and say so in your report. Never guess an org, board or person.

## 1. Decide the shape

- **Type** (`--type`, never a label): from "Issue types". A sub-issue of an epic always gets the
  "Sub-issue type". If the repo's org has no issue types, leave `--type` out.
- **Title:** standalone issues use a "Title prefix" if the team defines them (e.g. `[BUG] `);
  epic parents and sub-issues have none. Never `[Task]`.
- **Labels:** only labels from the "Label catalogue" (GitHub silently drops unknown ones). Sub-issues
  get the "Required labels (sub-issues)".
- **Body:** concrete scope and acceptance criteria; for a sub-issue, reference the parent.

## 2. Create it

```bash
gh issue create -R <repo> \
  --title "…" --body-file /tmp/issue-body.md \
  --type <type> \
  --assignee <assignee> \
  --label "<label>,<label>"
```

Note the issue URL it prints.

## 3. Link the parent (sub-issues only)

```bash
REPO=<repo>; OWNER=${REPO%%/*}; NAME=${REPO#*/}
P=$(gh api graphql -f query="query{repository(owner:\"$OWNER\",name:\"$NAME\"){issue(number:PARENT){id}}}" -q .data.repository.issue.id)
C=$(gh api graphql -f query="query{repository(owner:\"$OWNER\",name:\"$NAME\"){issue(number:CHILD){id}}}" -q .data.repository.issue.id)
gh api graphql -f query="mutation{addSubIssue(input:{issueId:\"$P\",subIssueId:\"$C\"}){subIssue{number}}}"
```

## 4. Board and sprint (only if the team uses a project board)

```bash
python3 scripts/board-sprint.py <issue-url> --owner <project-owner> --project <project-number> \
  --field "<sprint-field>"
```

(`scripts/` is next to this file.) It adds the issue to the board if automation hasn't, sets the
sprint field to the iteration covering today, and prints assignees, board and sprint so you can
check them. It works for boards owned by an org or by a user. `--field ""` only puts the issue on
the board (no sprints). Use `--dry-run` to only look.

## 5. Verify before you report it filed

Run the script again with `--dry-run` and confirm: the assignee is `<assignee>`, it's on
`<project-name>`, and the sprint is the current one ("Nothing to change."). Then report the issue
link.

If `gh` says a scope is missing (`project` / `read:project`), stop and tell the owner; don't try
to re-authenticate.
