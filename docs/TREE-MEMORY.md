# Repo memory (tree memory)

Status: experimental, on branch `experiments/tree-memory`. Code: `server/src/memory.ts`, tests:
`server/test/memory.test.ts`.

## What it is

Each repo has a shared memory: a tree of short markdown notes about the codebase at
`<paths.work>/memory/<repo>/` (in v2.1, `/work-v21/memory/<repo>/`). Any agent working on the repo can read it
at any time, at the start of a task or in the middle.

The agents own the tree. They choose the folder names, file names and layout, and keep an `INDEX.md` in each
folder with one line per note or subfolder. agentbox has no fixed taxonomy. For example:

```
portals/
  INDEX.md
  portal-a/  INDEX.md · auth.md (Keycloak) · payments.md (Stripe)
  portal-b/  INDEX.md · auth.md (JWT) · styling.md (Bootstrap)
```

Notes hold only what the code can't tell quickly:
- decisions and why;
- gotchas;
- where things live;
- conventions;
- dead code to avoid.

When the memory shows several variants (three portals with three auth setups), agents are told to name the
one they mean, and to ask whoever gave them the task when it's ambiguous. That narrows the scope of the task.

This is separate from:
- each agent's own `memory/` folder (personal working lessons);
- the team rules in `/team`;
- the repo **map** (the onboarding knowledge pack).

## The rules agentbox enforces

1. **Knowledge lands only when work merges to the default branch.**
   - **While working:** a task writes notes to its own draft folder,
     `<paths.work>/memory-drafts/<repo>/<task-id>/`. These are plain files and belong to the task.
   - **Merge detection:** a background pass every 10 minutes follows each task's branch through `gh pr list`
     (GitHub). Elsewhere, it checks whether the branch's commits are in origin/<default>.
   - **On merge to the default branch:** the agent that did the work is woken to fold its drafts into the
     tree. A closed task is revived first. If that isn't possible, a fresh instance of its role does it.
   - **Merged into an epic branch:** the drafts wait until the epic reaches the default branch.
   - **Discarded** when:
     - the PR closes unmerged and the task is closed;
     - the branch was never pushed;
     - nothing has merged after 30 days.
   - Merges with no draft notes wake nobody.
2. **Notes are anchored to code, and staleness costs no tokens.**
   - **Anchors:** a note lists the code it describes in its frontmatter,
     `anchors: [portal-a/auth.ts#refreshToken, portal-a/roles.ts]`. Each anchor is a file, or a file plus a
     symbol: a function, class, method or constant.
   - **Hashing:** agentbox hashes each anchor at origin/<default>. For a symbol, it hashes only that symbol's
     block, ignoring whitespace.
   - **Re-checking:** when the default branch moves, the background pass re-hashes the anchors. This is plain
     git and sha256, with no model involved. Notes whose anchored code changed get a `stale:` line naming
     what changed and the commits.
   - **Changes that don't mark a note stale:** edits elsewhere in the same file, and reformatting.
   - **Clearing:** a revert clears the mark.
   - **Re-verifying is lazy.** No agent is started to fix stale notes. The first agent that needs one for its
     task re-checks it against the code and rewrites it. Token use therefore grows with the agents' own work,
     not with how many people commit.
3. **Writes are safe with many agents.**
   - **Read-only to normal tools:** the file tools and shell writes can't change the tree (repoGuard). Changes
     go through these team tools:
     - `memory_write`, which also re-hashes anchors and clears `stale:`;
     - `memory_move`;
     - `memory_delete`.
   - **One at a time:** writes to a repo's tree run one at a time.
   - **Revisions:** each note carries a `rev`. An update must pass the rev it read, so a change made in between
     is never overwritten silently; the agent re-reads and merges.
   - **New notes:** only while folding in merged work. Rework, corrections and reorganising are allowed any
     time.

## Note format

```markdown
---
title: Portal A auth            # the agent's own fields are kept
rev: 3                          # agentbox
verified: 1a2b3c4d5e6f 2026-10-12 by coder#12   # agentbox: commit, date, who
anchors:
  - portal-a/auth.ts#refreshToken @9f3c2a1b7d0e  # agentbox adds the hash
stale: portal-a/auth.ts#refreshToken changed on main (ab12cd3) since it was verified; …  # agentbox, when it applies
---
# Portal A auth
Keycloak realm `portal-a`; refreshToken rotates the token, never cache it. …
```

## Tools (team MCP)

| Tool | Use |
|---|---|
| `memory_write(repo, path, content, rev?)` | Create a note while folding in merged work, or update one (pass its `rev`). |
| `memory_move(repo, from, to)` | Rename or reorganise a note or a folder. |
| `memory_delete(repo, path)` | Remove a wrong or obsolete note or folder. |
| `memory_promoted(repo)` | After folding in: removes the task's drafts. |

Reading is plain file access: `Read`, `Grep` and `Glob` on the tree.

## Where it shows

- **Agent instructions:** every task's instructions get a "Repo memory" section. It lists each tree's path,
  its note and stale counts, and the task's own draft folders.
- **Repos page:** each repo shows its notes (a link to the root `INDEX.md`), how many may be stale, and which
  tasks have drafts waiting for a merge.
- **API:** `GET /api/memory` returns the same summary. `POST /api/memory/check` runs the background pass now.

## Not done yet

- **Archiving notes nobody reads:** reads are plain file access and aren't tracked.
- **Owner editing:** you can open notes from the Repos page but not edit them there.
- **The feedback/rating loop:** it's planned to build on this.
