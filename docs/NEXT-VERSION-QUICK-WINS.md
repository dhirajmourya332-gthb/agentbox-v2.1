# Next version: quick wins for agent quality

`docs/TRUSTED-AUTONOMY.md` describes the full plan: an enforced pipeline, proof bundles, risk tiers and earned autonomy. That's several weeks of work. This document picks the parts that **raise agent quality the most for the least code**. Most items are a prompt-layer change, a seed skill, a small MCP tool or a hook. None needs new infrastructure.

Each item lists what it is, why it helps, where it goes in the code, and a rough size: **S** is under a day, **M** is 1–3 days.

---

## 0. What exists today (the base we build on)

| Area | Today | File |
|---|---|---|
| Agent memory | `<home>/memory/` + `MEMORY.md`. The prompt tells the agent to read it "when a task may depend on past work". Nothing loads it automatically. | `runner.ts` (platform layer), `agents.ts` |
| Role memory | Replicas (coder#3) use their base agent's home, so all coder instances already share one memory | `agents.ts` |
| Work memory | Task rooms and routines have a shared folder with `state.md` and `notes/` | `runner.ts` `workNote` |
| Group memory | **None.** Groups are excluded from `workNote`. | `runner.ts` |
| Team memory | `/team/*.md` rules, which only the owner edits | `runner.ts` `teamLayer` |
| Repo memory | Onboarding maps in `<data>/repos/<name>/map/` | `repos.ts`, `onboard-repo` skill |
| Skills | Six seeds: `onboard-repo`, `open-pr`, `review-pr`, `fix-vulnerability`, `file-github-issue`, `run-epic`. Agents propose drafts and the owner approves them. | `server/seed-skills/`, `skills.ts` |
| Hooks | `PreToolUse` guards only: rules, repos, sudo, screen | `runner.ts` |

---

## 1. Memory, tiered (the biggest win for the effort)

### 1.1 Five clear tiers with one tool — **M**
Give memory explicit scopes, all plain markdown files with an index:

| Tier | Path | Who reads it | Who writes it |
|---|---|---|---|
| **agent** | `<home>/memory/` (exists) | the agent and its instances | the agent |
| **work** (task room / routine) | `<work-folder>/memory/` next to `state.md` | everyone on that work | everyone on that work |
| **group** | `<data>/groups/<id>/memory/` (new) | group members | group members |
| **repo** | `<data>/repos/<name>/memory/` (next to `map/`) | anyone using that repo | anyone using that repo (as lessons, see 1.4) |
| **team** | `/team/memory/` | everyone | **proposals only**; the owner approves |

Add two MCP tools on the existing `team` server:
- `remember({ scope, title, body, tags? })` writes one file with frontmatter (`scope`, `by`, `task`, `date`, `confirmed`) and updates that tier's `MEMORY.md` index. For `team`, it creates a proposal instead.
- `recall({ query, scopes? })` searches all tiers the caller can see. Start with simple keyword matching over the files. SQLite FTS5 is a later upgrade, and only if search proves weak.

Plain files keep everything inspectable from the Documents/agent pages and need no new store.

### 1.2 Load the indexes automatically, not the contents — **S**
Today the agent has to remember to read `MEMORY.md`. Instead, add a `memory` instruction layer that injects **only the index lines** of the tiers that apply this turn: agent, work, group, and the repos in use. Cap it at about 40 lines per tier, newest first.

The agent sees what exists and pulls the full file with `Read` or `recall` when relevant. This is the same pattern as Claude Code's own `MEMORY.md`. It costs a few hundred tokens and removes most "re-discovered the same thing" turns.

### 1.3 Group shared folder — **S**
Groups currently get no shared folder. Give them the same `state.md` + `notes/` + `memory/` as task rooms, so a group conversation keeps its decisions between turns and across members.

### 1.4 Lessons from rework — **S**
When a follow-up goes to a live instance (rework via `delegate_task` to `coder#3`), add a line to that turn's prompt: *"This is rework. When done, if there's a general lesson (not specific to this change), save it with `remember(scope: "repo")`."* Rework is the clearest signal that something was missed, and this captures it while the context is fresh.

### 1.5 Memory hygiene — **S**
- Frontmatter carries `date` and `confirmed`. The index layer marks entries older than 60 days as `(unconfirmed)`, so agents treat them as hints and re-check.
- Run the existing secret redaction (`redact.ts`) on every `remember` write.
- On the agent page, add a "Memory" list per tier with delete. `listMemory` already exists for the agent tier.

---

## 2. High-quality skills (curated, small, mapped to roles)

### 2.1 Add six core engineering skills — **M** total
Write our own short versions of the patterns that work in **superpowers** (obra) and **gstack**. Borrow the structure and check licences before copying text. Keep each skill under about 120 lines, because long skills get skimmed.

| Skill | What it makes the agent do | Roles |
|---|---|---|
| `plan-change` | Before code: restate the goal, list files to touch, write acceptance checks, list risks; save the plan to the work folder | tech-lead, coder |
| `tdd` | Write or extend a failing test first, see it fail, then implement, then see it pass | coder |
| `systematic-debugging` | Reproduce, form a hypothesis, test one variable at a time, fix the root cause, add a regression test. No "try random changes". | coder, devops |
| `verify-before-done` | Before reporting done: run build, types, tests and lint, and exercise the change (curl, browser, CLI). Report the **actual commands and output**, not "tests pass". | everyone who changes code |
| `receive-review` | Address each review comment: fix, or reply with a reason. Never silently skip. Re-run checks after. | coder |
| `qa-browser` | Drive the shared browser through the changed flow, take screenshots, check the console for errors | QA, coder (web repos) |

`review-pr` and `open-pr` already exist. Tighten `review-pr` so it checks the change **against the plan's acceptance checks**, not just code style.

### 2.2 Default skill mapping per role — **S**
Seed the `agent_skills` rows for built-in roles, so a fresh install has the right skills on the right agents without the owner wiring them by hand. Show the mapping on the Skills page, where the owner can still change it.

### 2.3 Better skill descriptions — **S**
The model only picks a skill if its `description` matches the situation. Rewrite all seed descriptions as "Use when …" triggers. For example: *"Use before reporting any code change as done"* instead of *"Verification steps"*. This is the cheapest improvement on the list.

### 2.4 Skill usage counter — **S**
Log an event whenever the `Skill` tool runs (name, agent, task). Show "used N times / last used" on the Skills page. This tells us which skills matter and which to drop. It's the first step toward the before/after metrics in TRUSTED-AUTONOMY §5.

---

## 3. Verification nudges (cheap trust)

### 3.1 Report format in the platform layer — **S**
Change the Reporting section so every final report for code work ends with:
```
Verified: <commands run + result>   Not verified: <what and why>   Risks: <…>
```
"Not verified" is the important line. It makes gaps visible instead of hidden behind "done".

### 3.2 Stop hook: "you edited but didn't test" — **M**
Add a `Stop` hook next to the existing `PreToolUse` guards. If the turn used `Edit`/`Write` on files inside a repo worktree and **no** Bash command after the last edit looks like a test, build or typecheck (`npm test`, `pytest`, `go test`, `tsc`, `make`, …), block the stop **once** with: *"You changed code but ran no checks after the last edit. Run them, or say in the report why not."*

Allow it only once per turn so it can't loop. This is the smallest piece of "the server enforces the workflow" from TRUSTED-AUTONOMY §3.

### 3.3 Reviewer is never the author — **S**
In `delegate_task`, when the task text asks for a review of a branch or PR, refuse to send it to the instance that authored that branch (look up the branch via `find_work`), and suggest a fresh instance instead. A fresh context catches what the author's context hides.

### 3.4 Acceptance criteria in delegation — **S**
Add an `acceptance` field to `delegate_task`: a list of checks, required for coder/devops tasks. Pass it into the instance's prompt and repeat it in the report request ("for each acceptance check: met / not met + evidence"). The tech-lead then compares like for like.

---

## 4. Context and focus

### 4.1 Repo instructions travel with the worktree — **S**
Check whether the SDK loads a repo's own `CLAUDE.md`/`AGENTS.md` from `additionalDirectories`. If it doesn't, the repos layer should include the first ~60 lines of that file, plus the map's `commands` section (how to build/test/run), for each worktree in this task. Knowing the right test command is half of verification.

### 4.2 `state.md` before compaction — **S**
Before a long conversation is compacted, prompt the agent to update `state.md` (or its memory) with open items and decisions. The SDK has a `PreCompact` hook for this; otherwise use a one-line prompt prefix on the compaction task. What survives compaction stops depending on luck.

### 4.3 Model per role, defaults that fit — **S**
`agent.model` already exists. Ship sensible defaults: the strongest model for tech-lead, reviewer and security; a faster model for routine checks and simple triage routines. This saves usage that can then go to reviews.

---

## 5. Owner feedback loop

### 5.1 "Remember this" on any reply — **S**
Add a small action on agent replies in the chat UI: **Remember…** opens a one-line box and saves it as a memory for that agent (or as a team proposal). Corrections the owner makes in chat become durable without the owner writing files.

### 5.2 Weekly memory and skill digest — **S**
Add a built-in routine that lists new memories, pending team proposals, skill drafts and skill usage for the week as one needs-you item. The owner reviews once a week instead of as each item arrives.

---

## 6. Suggested order

| Step | Items | Size | Gain |
|---|---|---|---|
| 1 | 2.3 descriptions, 3.1 report format, 1.2 index loading, 4.1 repo instructions | ~1–2 days | Agents use what they already have |
| 2 | 1.1 tiers + `remember`/`recall`, 1.3 group folder, 1.5 hygiene | ~2–3 days | Memory at every level, searchable |
| 3 | 2.1 core skills + 2.2 role mapping | ~2–3 days | Consistent planning, testing and verification |
| 4 | 3.2 Stop hook, 3.3 reviewer ≠ author, 3.4 acceptance criteria | ~2 days | First enforced quality steps |
| 5 | 1.4 lessons, 2.4 usage counter, 4.2 pre-compaction, 4.3 models, 5.1, 5.2 | ~2 days | Learning loop and measurement |

That's roughly **two working weeks** in total. Step 1 alone is a day or two and should show a visible difference.

## 7. Deliberately left for later (from TRUSTED-AUTONOMY.md)

- Full proof bundles and gates read from CI (§3–4): a larger build. Items 3.1–3.4 here are the lightweight first step toward them.
- Risk tiers and earned autonomy (§9): this needs track-record data, which 2.4 and the reports start collecting.
- Embeddings or a knowledge graph for memory: only if keyword `recall` proves insufficient.
- Canary deploys and auto-rollback, separate unix users: these need infrastructure work.

## 8. Decisions for the owner

1. **Team memory:** proposals the owner approves (recommended), or agents can write it directly?
2. **Repo memory location:** in agentbox's store (recommended for now, since it needs no PRs), or committed to each repo under `docs/agent/`?
3. **Stop hook (3.2):** nudge once (recommended), or block until checks run?
4. **Skill sources:** write our own from the patterns (recommended), or vendor superpowers/gstack files pinned to a commit?
