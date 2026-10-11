# Bitbucket

How this team uses Bitbucket Cloud (workspace `{{workspace}}`). agentbox renders this file from the
Bitbucket integration's settings. Atlassian has no Bitbucket CLI: use the REST API through
`agentbox-bitbucket`, which adds the saved token for you (never read or print the token).

## Settings

| Setting | Value |
|---|---|
| Workspace | `{{workspace}}` |
| Default repo | {{#default_repo}}`{{workspace}}/{{default_repo}}` (clone: `{{paths.work}}/{{default_repo}}`){{/default_repo}}{{^default_repo}}(not set: ask the owner){{/default_repo}} |
| Other repos | {{#other_repos}}`{{.}}` {{/other_repos}}{{^other_repos}}(none: anything else needs the owner's OK){{/other_repos}} |
| Main branch | `{{base_branch}}` |
| Merge approval | {{merge_approval}} |

## Working with the API

- `agentbox-bitbucket api <path> [curl args]`: paths are under `https://api.bitbucket.org/2.0`, e.g.
  - `agentbox-bitbucket api "/repositories/{{workspace}}/<repo>/pullrequests?state=OPEN"`
  - open a pull request: write `/tmp/pr.json` as below, then
    `agentbox-bitbucket api /repositories/{{workspace}}/<repo>/pullrequests -X POST -H 'Content-Type: application/json' -d @/tmp/pr.json`

    ```json
    {
      "title": "…", "description": "…",
      "source": { "branch": { "name": "<branch>" } },
      "destination": { "branch": { "name": "{{base_branch}}" } }
    }
    ```
  - `agentbox-bitbucket api /repositories/{{workspace}}/<repo>/pullrequests/<id>/comments -X POST …`
  - `agentbox-bitbucket api "/repositories/{{workspace}}/<repo>/pipelines/?sort=-created_on&pagelen=5"`
- Results are paged (`next` in the JSON); pipe through `jq`.
- git over HTTPS works without a password prompt: `git clone https://bitbucket.org/{{workspace}}/<repo>.git {{paths.work}}/<repo>`.
- A 401 or 403 means the token expired or lacks a scope: stop and tell the owner. Never create or
  save tokens yourself.

## Branching and pull requests

1. Branch `<prefix>/<issue>-<slug>` off `{{base_branch}}` (`feature/`, `fix/`, `chore/`, `docs/`…), one
   git worktree per task: `{{paths.work}}/<repo>-<issue>`. Never edit in the shared clone or another
   agent's worktree.
2. Commits follow Conventional Commits: `type(scope): summary`.
3. The PR description has: What changed, Why, How I tested, Risks / follow-ups.
4. Merges to `{{base_branch}}` need {{merge_approval}}'s approval. Never push to `{{base_branch}}` directly.
5. After the merge, delete the branch and its worktree (`git worktree prune`).
