#!/usr/bin/env python3
"""Put a GitHub issue on a project board and set its sprint (iteration) field to the current sprint.

usage: board-sprint.py <issue-url> --owner ORG_OR_USER --project NUMBER [--field NAME] [--dry-run]

The board can belong to an organization or a user. --field is the board's iteration field
(default "Iteration"); pass --field "" to only put the issue on the board.
Prints the issue's assignees, whether it is on the board, and its sprint, before and after.
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
    p.add_argument("--owner", required=True, help="org or user that owns the project, e.g. acme")
    p.add_argument("--project", required=True, type=int, help="project number, e.g. 1")
    p.add_argument("--field", default="Iteration", help='iteration field name ("" = no sprint)')
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    m = re.match(r"https://github\.com/([^/]+)/([^/]+)/issues/(\d+)", a.issue_url)
    if not m:
        sys.exit("expected an issue URL like https://github.com/OWNER/REPO/issues/123")
    repo_owner, repo, number = m.group(1), m.group(2), int(m.group(3))

    fname = a.field or "Iteration"
    project_fields = """projectV2(number: $n) { id title
             field(name: $f) { ... on ProjectV2IterationField {
               id configuration { iterations { id title startDate duration } } } } }"""
    owner = gql(
        f"""query($login: String!, $n: Int!, $f: String!) {{ repositoryOwner(login: $login) {{
             ... on Organization {{ {project_fields} }} ... on User {{ {project_fields} }} }} }}""",
        login=a.owner, n=a.project, f=fname,
    )["repositoryOwner"]
    proj = (owner or {}).get("projectV2")
    if not proj:
        sys.exit(f"no project #{a.project} found for '{a.owner}'")
    sprint = None
    field = {}
    if a.field:
        field = proj.get("field") or {}
        if not field.get("id"):
            sys.exit(f"project '{proj['title']}' has no iteration field named '{a.field}'")
        sprint = current_iteration(field["configuration"]["iterations"])
        if not sprint:
            sys.exit("no iteration covers today; ask the owner to create the next sprint")

    issue = gql(
        """query($o: String!, $r: String!, $n: Int!, $f: String!) { repository(owner: $o, name: $r) { issue(number: $n) {
             id title url assignees(first: 10) { nodes { login } }
             projectItems(first: 20) { nodes { id project { id }
               fieldValueByName(name: $f) { ... on ProjectV2ItemFieldIterationValue { title iterationId } } } } } } }""",
        o=repo_owner, r=repo, n=number, f=fname,
    )["repository"]["issue"]

    item = next((i for i in issue["projectItems"]["nodes"] if i["project"]["id"] == proj["id"]), None)
    assignees = [n["login"] for n in issue["assignees"]["nodes"]]
    current_value = (item or {}).get("fieldValueByName") or {}

    print(f"Issue:      #{number} {issue['title']}")
    print(f"Assignees:  {', '.join(assignees) or '(none)'}")
    print(f"Board:      {proj['title']}: {'on the board' if item else 'NOT on the board'}")
    if sprint:
        print(f"Sprint:     {current_value.get('title') or '(none)'}  (current sprint: {sprint['title']})")

    changes = []
    if not item:
        changes.append("add to board")
    if sprint and current_value.get("iterationId") != sprint["id"]:
        changes.append(f"set {fname} to {sprint['title']}")
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
    if not sprint:
        print("Done: " + "; ".join(changes))
        return
    gql(
        """mutation($p: ID!, $i: ID!, $f: ID!, $it: String!) { updateProjectV2ItemFieldValue(input: {
             projectId: $p, itemId: $i, fieldId: $f, value: { iterationId: $it } }) { projectV2Item { id } } }""",
        p=proj["id"], i=item["id"], f=field["id"], it=sprint["id"],
    )
    print("Done: " + "; ".join(changes))


if __name__ == "__main__":
    main()
