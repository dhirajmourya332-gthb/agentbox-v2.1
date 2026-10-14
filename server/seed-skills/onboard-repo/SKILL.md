---
name: onboard-repo
description: "Map a registered repo at a high level (ARCHITECTURE.md and FEATURE-MAP.md) in agentbox's store, or refresh a stale map. Use when asked to map, onboard or re-map a repo."
---

# Map a repo (onboarding)

<!-- Built into agentbox (server/seed-skills/onboard-repo); refreshed at every start. -->

You give the team a **high-level map** of the repo: how it's built and what it does. Nothing more.
Lower-level knowledge (commands, setup, tests, gotchas, how a feature really works) is **not** your
job here: agents record it in the repo's memory while they work on real tasks.

You work in **your task worktree** (from the prompt, or `mcp__team__use_repo(name)`); the canonical
clone under `/work/repos/` is read-only. You write the map to the folder named in the prompt
(`<data>/repos/<name>/map/`), **not into the repo**, unless the prompt says the owner wants it proposed
as a PR too.

## 1. Read (don't run)
- The top-level README and docs, `git ls-files` (the tree, by directory), package manifests and
  workspace files to see the components, the entry points (servers, apps, CLIs, jobs, firmware,
  pages), configuration that reveals external services, and `git log --oneline -30` for what's active.
- **Don't install dependencies, build, run tests or start anything.** Don't open secrets (`.env*`, keys).
- Keep it short: about 15–20 minutes. Breadth, not depth.

## 2. Write two files (Markdown, concise, paths relative to the repo root)
| File | Contents |
|---|---|
| `ARCHITECTURE.md` | What the system is; its components (one line each, with their directory); how they talk to each other and to external services (data flow); where it runs/deploys if the repo shows it; a small mermaid diagram. |
| `FEATURE-MAP.md` | A table: feature → what it does (one line) → where it lives (entry points / directories). Group by component or product area. |

Start each with `Mapped from <commit sha> on <date>.` Stay at the level of components and features:
no file-by-file walkthroughs, no commands, no test notes.

## 3. Refreshing an existing map
Read the current map first. `git log <mapped sha>..origin/<default branch> --stat` shows what
changed; update only what the change affects at this level (a new component, a new or removed feature),
and bump the "Mapped from" line.

## 4. Finish
- Call `mcp__team__repo_map_done(name, description)` with a one-line description of the repo. It
  refuses while a file is missing or empty.
- If the prompt asks for a PR: copy the two files under `docs/agent/`, commit on your branch, push it
  and open a PR to the default branch. Never merge it.
- Report: the architecture in a few lines and the main features.
