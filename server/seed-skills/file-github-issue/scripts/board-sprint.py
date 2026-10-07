#!/usr/bin/env python3
"""Put a GitHub issue on an org project board and set its Iteration to the current sprint.

usage: board-sprint.py <issue-url> --owner ORG --project NUMBER [--dry-run]

Prints the issue's assignees, whether it is on the board, and its Iteration, before and after.
--dry-run reports what it would change without changing anything.
Needs a gh login with the `project` scope.
"""
import argparse
import datetime
import json
import re
import subprocess
import sys


def gql(query: str, **variables) -> dict:
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        args += ["-F" if isinstance(v, int) else "-f", f"{k}={v}"]
    out = subprocess.run(args, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"gh api graphql failed: {out.stderr.strip() or out.stdout.strip()}")
    data = json.loads(out.stdout)
    if data.get("errors"):
        sys.exit(f"GraphQL error: {data['errors'][0].get('message')}")
    return data["data"]


def current_iteration(iterations: list[dict]) -> dict | None:
    today = datetime.date.today()
    for it in iterations:
        start = datetime.date.fromisoformat(it["startDate"])
        if start <= today < start + datetime.timedelta(days=it["duration"]):
            return it
    return None


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("issue_url")
    p.add_argument("--owner", required=True, help="org that owns the project, e.g. Brandsek")
    p.add_argument("--project", required=True, type=int, help="project number, e.g. 6")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    m = re.match(r"https://github\.com/([^/]+)/([^/]+)/issues/(\d+)", a.issue_url)
    if not m:
        sys.exit("expected an issue URL like https://github.com/OWNER/REPO/issues/123")
    repo_owner, repo, number = m.group(1), m.group(2), int(m.group(3))

    proj = gql(
        """query($org: String!, $n: Int!) { organization(login: $org) { projectV2(number: $n) {
             id title
             field(name: "Iteration") { ... on ProjectV2IterationField {
               id configuration { iterations { id title startDate duration } } } } } } }""",
        org=a.owner, n=a.project,
    )["organization"]["projectV2"]
    field = proj.get("field") or {}
    if not field.get("id"):
        sys.exit(f"project '{proj['title']}' has no Iteration field")
    sprint = current_iteration(field["configuration"]["iterations"])
    if not sprint:
        sys.exit("no iteration covers today; ask the owner to create the next sprint")

    issue = gql(
        """query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { issue(number: $n) {
             id title url assignees(first: 10) { nodes { login } }
             projectItems(first: 20) { nodes { id project { id }
               fieldValueByName(name: "Iteration") { ... on ProjectV2ItemFieldIterationValue { title iterationId } } } } } } }""",
        o=repo_owner, r=repo, n=number,
    )["repository"]["issue"]

    item = next((i for i in issue["projectItems"]["nodes"] if i["project"]["id"] == proj["id"]), None)
    assignees = [n["login"] for n in issue["assignees"]["nodes"]]
    current_value = (item or {}).get("fieldValueByName") or {}

    print(f"Issue:      #{number} {issue['title']}")
    print(f"Assignees:  {', '.join(assignees) or '(none)'}")
    print(f"Board:      {proj['title']}: {'on the board' if item else 'NOT on the board'}")
    print(f"Iteration:  {current_value.get('title') or '(none)'}  (current sprint: {sprint['title']})")

    changes = []
    if not item:
        changes.append("add to board")
    if current_value.get("iterationId") != sprint["id"]:
        changes.append(f"set Iteration to {sprint['title']}")
    if not changes:
        print("Nothing to change.")
        return
    if a.dry_run:
        print("Dry run, would: " + "; ".join(changes))
        return

    if not item:
        item = gql(
            """mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: {projectId: $p, contentId: $c}) { item { id } } }""",
            p=proj["id"], c=issue["id"],
        )["addProjectV2ItemById"]["item"]
    gql(
        """mutation($p: ID!, $i: ID!, $f: ID!, $it: String!) { updateProjectV2ItemFieldValue(input: {
             projectId: $p, itemId: $i, fieldId: $f, value: { iterationId: $it } }) { projectV2Item { id } } }""",
        p=proj["id"], i=item["id"], f=field["id"], it=sprint["id"],
    )
    print("Done: " + "; ".join(changes))


if __name__ == "__main__":
    main()
