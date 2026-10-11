---
name: onboard-repo
description: "Map a registered repo into a knowledge pack (AGENTS.md, ARCHITECTURE.md, FEATURE-MAP.md, COMMANDS.md, RISK-MAP.md, TEST-READINESS.md) in agentbox's store, or refresh a stale one. Use when asked to map, onboard or re-map a repo."
---

# Map a repo (onboarding)

You produce a **knowledge pack** that lets any agent find its way around the repo without reading
everything. You work in **your task worktree** (from the prompt, or `mcp__team__use_repo(name)`);
the canonical clone under `/work/repos/` is read-only. You write the pack to the map folder named in
the prompt (`<data>/repos/<name>/map/`), **not into the repo**, unless the prompt says the owner
wants it proposed as a PR too.

## 1. Look before you write (≈ 15 min)
- `git log --oneline -30`, `git ls-files | head -300`, the top-level README, package manifests
  (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Makefile`, `Dockerfile`, CI
  workflows under `.github/workflows/` or `.gitlab-ci.yml`), existing `AGENTS.md` / `CLAUDE.md` / docs.
- Find the entry points (servers, CLIs, jobs, handlers, pages) and where tests live.
- Never read or copy secrets (`.env*`, key files). Don't run anything that deploys, migrates a real
  database, sends messages or needs production credentials.

## 2. Run the commands for real
Install dependencies and run the build, the tests, the linter and the dev server (briefly) **in your
worktree**. Time them. Note what failed and why. Only commands you actually ran go in COMMANDS.md.

## 3. Write the six files (Markdown, concise, every path relative to the repo root)
| File | Contents |
|---|---|
| `AGENTS.md` | Lean: what this is, how to build / test / run it, conventions, what not to touch. Points to the other files instead of copying them. |
| `ARCHITECTURE.md` | Components, data flow, external services, deploy targets, a mermaid diagram. |
| `FEATURE-MAP.md` | A table: feature → entry points → key files → tests → risk tier (low / medium / high). |
| `COMMANDS.md` | Exact build, test, lint and dev commands **as run**, with result (pass / fail, duration, notes). |
| `RISK-MAP.md` | Prod-critical paths, migrations, auth, billing, secrets handling: the files that raise a change's risk. |
| `TEST-READINESS.md` | Coverage (if measurable), flaky or slow tests, untested critical paths, suite duration. |

Add a line at the top of each: `Mapped from <commit sha> on <date>.`

## 4. Refreshing an existing map
Read the current pack first. `git log <mapped sha>..origin/<default branch> --stat` shows what
changed; update only what drifted, re-run the test command, bump the "Mapped from" line.

## 5. Finish
- Call `mcp__team__repo_map_done(name, description, test_command)`: a one-line description and the
  test command you verified. It refuses while a file is missing or empty.
- If the prompt asks for a PR: copy the files under `docs/agent/` (AGENTS.md at the root), commit on
  your branch, push it and open a PR to the default branch. Never merge it.
- Report: what you mapped, the commands that worked, what didn't, and the riskiest areas.
