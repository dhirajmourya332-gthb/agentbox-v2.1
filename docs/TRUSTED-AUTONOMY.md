# Trusted autonomy: research and options

**Status:** research and proposal. Nothing here is built yet.
**Date:** 2026-10-11.
**Applies to:** agentbox v2, where it would be built. Most of it could be backported to v1.

**The question:** how can agents follow a proper workflow, so that their work can be trusted and the owner can hand off responsibility?

That breaks down into six asks:
- verification;
- high-quality skills (gstack-style);
- agent-friendly repos (feature map, architecture map);
- adding and removing repos after the initial setup;
- memory;
- taking the owner out of the loop.

---

## 1. The short answer

You can't make agents trustworthy by writing better job descriptions. Prompts are suggestions; an agent under pressure skips steps, and it can make its own checks pass, for example by editing a failing test until CI is green. What the field converges on, and what we can build, is a combination of four things.

1. **The server enforces a workflow, the prompt doesn't.** A task can't move to "merge" until the evidence the workflow requires is attached. agentbox already does this partly: `rulesGuard` blocks tool calls and routine rules bind the agents. This extends that idea from "forbidden commands" to "required steps".
2. **Verification is independent.** The agent that wrote the change never approves it. Deterministic gates (build, types, tests, scanners) run outside the agent. A separate reviewer agent checks the change against the spec, ideally with a fresh context and possibly a different model.
3. **Every task ends with a proof bundle.** That's what was asked, what changed, what was run, what passed, screenshots or logs, risks, and how to roll back. You read a one-page summary instead of trusting a sentence like "done, all tests pass".
4. **Autonomy is tiered by risk and earned by track record.** The owner isn't removed from everything at once. Each kind of action has a risk tier; low tiers run unattended from day one, higher tiers unlock per repo once the agents' record shows they are reliable, and irreversible actions always keep a human or a hard technical wall.

**The result is "human on the loop", not "human in the loop".** You stop approving things one by one and instead get a daily digest plus exceptions. You can still stop everything at any time.

---

## 2. What agentbox already has

| Area | Already there | Gap |
|---|---|---|
| Orchestration | tech-lead per work item; delegation; rework goes back to the original author | Steps are prompt-driven; nothing proves that a review or test actually happened |
| Guards | Routine rules + `rulesGuard` (PreToolUse); CI wait cap; background-command limits | Rules only forbid things; they can't require a step |
| Visibility | Live progress, attention items, routine runs, push notifications | No per-task evidence; "done" is the agent's claim |
| Skills | `/skills` per role; integrations add skills while connected (v2) | No curated engineering skill set (planning, TDD, QA, review, ship) |
| Knowledge | Room workspace (`state.md`, `scripts/`, `notes/`); team rule files; integration summaries | No repo maps, no long-term memory across rooms, no lessons learned |
| Repos | Repos are cloned by hand or by agents into `/work` | Repos aren't first-class objects; nothing to add or remove one cleanly |
| Autonomy | Owner approvals for prod; epic-branch merges allowed | One fixed level for everything; no track record; no automatic rollback |

---

## 3. Pillar A: a workflow the server enforces

### The pipeline

Each work item moves through stages. Each stage has an **exit gate**: evidence the server checks before the next stage can start.

```
 intake ─► spec ─► plan ─► build (test-first) ─► verify ─► review ─► merge ─► deploy ─► watch ─► close
           │        │            │                  │         │         │          │         │
       acceptance  tasks +   failing test       gates run   reviewer  required   canary /   proof
       criteria    risk tier  then passing      outside     ≠ author  checks     health    bundle
                               test             the agent   approves  green      checks
```

- **Intake → spec:** tech-lead writes `spec.md`, with the problem, acceptance criteria and what's out of scope. For small tasks this is five lines. It's the same idea as GitHub Spec Kit's spec/plan/tasks flow and superpowers' brainstorm-then-plan step.
- **Plan:** tasks small enough to verify, each with exact files and a verification step, plus a **risk tier** (§8).
- **Build:** test-first wherever the code has tests. The proof bundle records the failing test before the fix and the passing test after. For bugs, reproduce before fixing.
- **Verify:** deterministic gates run by the server or CI, never self-reported (§4).
- **Review:** a reviewer agent that did not write the code (§4.3).
- **Merge / deploy / watch:** allowed only if the tier allows it; after a deploy, health checks and automatic rollback (§4.5).
- **Close:** the proof bundle is attached; the owner's digest links to it.

### How to enforce it

- A `stage` column on work items, plus a `gates` table recording each gate's result, its evidence and who produced it.
- An MCP tool `submit_evidence(stage, kind, data)`. Agents attach evidence; the server checks it, for example by re-running the test command itself or reading the CI status from the provider API instead of trusting the agent's word.
- The `rulesGuard` hook gains **required-step rules**: `gh pr merge` is refused unless the work item is in `review: approved` and its gates are green. This is the same mechanism that already blocks merges to main in routines.
- **One workflow, scaled to the task.** A typo fix uses a "small" profile (spec = the PR description, one review). A feature uses the full profile. tech-lead picks the profile; the reviewer can raise it.

---

## 4. Pillar B: verification

Sources agree on one point: an agent's own tests and self-review don't count as verification. One reported case: an agent rewrote a failing test so CI went green. Verification has to be **separate from the author, deterministic where possible, and measured**.

### 4.1 Deterministic gates (cheap, always on)
- **Build, type-check, lint, unit tests:** run by CI or by the server in a clean worktree, not by the authoring agent.
- **Diff-scoped security scan:** secrets (gitleaks, already used by the security agent), SAST, dependency existence and licence checks.
- **The anti-gaming check.** Flag any change that modifies tests *and* the code under test in the same PR, deletes or skips tests, lowers coverage, or adds `skip`, `xfail` or `--no-verify`. A flag doesn't block the change, but it forces a second review.

### 4.2 Behavioural verification (proves the change does what was asked)
- **Reproduce-then-fix** for bugs: the evidence shows the failure before the fix and the pass after.
- **Browser QA** for UI changes: a QA agent drives the real page in the VM's browser (agentbox already has the shared screen), clicks through the acceptance criteria and attaches screenshots. gstack's `/qa` works this way, using Playwright.
- **API checks** against a local or staging run, using the DB tunnel read-only where it's needed.

### 4.3 Independent review
- **Enforced in code:** the reviewer is a different agent instance from the author. Open-source orchestrators such as AIOS enforce exactly this.
- **The reviewer starts with a fresh context.** It gets only the spec, the diff and the evidence, so it can't inherit the author's assumptions.
- **Two passes**, as in superpowers' subagent-driven flow: first, does the change meet the spec; then, code quality and risk.
- **Optionally a different model as reviewer** for higher tiers. Codacy describes using a different model as a separate review gate.
- **The reviewer can block or send back for rework**, and rework goes back to the original author, as it already does.

### 4.4 Test quality (so a green run means something)
- Run **mutation testing** periodically, per repo (Stryker for JS/TS, mutmut for Python). It measures whether the tests actually catch bugs. Use it as a repo health metric, not on every PR.
- Track flaky tests, and keep them out of gates until they're fixed.

### 4.5 After deploy
- **Health checks** after every deploy: error rate *and* latency, not just "pods are running".
- **Progressive delivery with automatic rollback** for Kubernetes services: Argo Rollouts or Flagger promote a canary only if its metrics hold, and roll back on their own if not. This is the largest single step towards leaving prod deploys unattended, and it works without any AI.
- **Revert-ready:** every deploy in the proof bundle names its rollback command.

---

## 5. Pillar C: high-quality skills

### What's out there
- **gstack** (Garry Tan): a large pack of Claude Code skills (reports range from 23 to 31) organised as a sprint: office hours / plan reviews (CEO and eng), design, `/review`, `/qa` (browser, Playwright), security and `/ship`. The skills share a `bin/` directory and a browser daemon, so you install the pack as a whole; individual skills mostly don't work on their own.
- **superpowers** (obra): a lighter workflow. The steps are brainstorm, write plans (2–5 minute tasks with exact files and checks), then subagent-driven development, with a fresh subagent per task and two-stage review. Its TDD skill makes the agent delete code written before its test.
- **GitHub Spec Kit:** constitution → specify → plan → tasks → implement, all as markdown files per feature. It works with Claude Code.

### Recommendation
- **Take the patterns, not the packs wholesale.** Write agentbox's own small set of skills that map onto the pipeline stages: `spec`, `plan`, `tdd`, `verify`, `review`, `qa-browser`, `ship`, `postmortem`, `onboard-repo`. Borrow freely from gstack and superpowers, since both are open source; check their licences before vendoring text.
- **Treat skills as code with full agent permissions.** A skill can tell an agent to run anything. So skills are vendored into a repo, pinned to a commit, reviewed by the security agent, and updated through a PR, never pulled live from the internet. It's the same rule as for dependencies.
- **Map skills to roles,** the way integrations already map to roles: coder gets `tdd`, `plan`; reviewer gets `review`, `verify`; QA gets `qa-browser`; tech-lead gets `spec`, `plan`, `ship`.
- **Measure them.** Track rework and revert rates before and after a skill is adopted, so a skill that adds tokens without improving outcomes can be dropped.

---

## 6. Pillar D: agent-friendly repos (onboarding)

When a repo is added, an **onboarding run** (a routine using the `onboard-repo` skill) produces a knowledge pack and keeps it fresh.

### What it produces
Committed in the repo under `docs/agent/` by PR, or kept in agentbox's own store if the repo owner doesn't want files added:

| File | Contents |
|---|---|
| `AGENTS.md` (root) | Lean: what this is, how to build, test and run it, conventions, and what not to touch. It's the cross-tool standard; Claude Code, Codex, Cursor and others read it. It points to the files below instead of copying them. |
| `ARCHITECTURE.md` | Components, data flow, external services, deploy targets, a diagram (mermaid). |
| `FEATURE-MAP.md` | Feature → entry points → key files → tests → owners → risk tier. This is what lets an agent find "where is the login retry logic" without reading everything. |
| `COMMANDS.md` | Exact build, test, lint and dev-server commands, as verified by actually running them during onboarding. |
| `RISK-MAP.md` | Prod-critical paths, migrations, auth, billing, secrets handling, i.e. which files raise a change's risk tier. |
| `TEST-READINESS.md` | Coverage, flaky tests, untested critical paths, and how long the test suite takes. |

### A code graph for navigation
- Generate an index on top of the docs: symbols, call and import graph. Aider's **repo map** pioneered this, with tree-sitter definitions ranked by PageRank to fit a token budget; RepoMapper reimplements it as an MCP server.
- Several MCP servers now provide this as a queryable graph: cgraphy, Codebase Memory MCP, codegraph and others. Serena is LSP-based.
- **Recommendation:** start with a tree-sitter repo-map MCP tool (cheap, local, no service). Only add an LSP-based tool (Serena-style) if agents still get lost in large repos.

### Keeping it fresh
- A **drift check** routine re-validates the maps after merges, for example weekly or after N merged PRs. It opens a PR when they're stale.
- Reviewers flag "the map was wrong" as feedback, and that feeds the next refresh.

### Refactoring for agent-friendliness
- **Never an automatic big rewrite.** The onboarding run produces a **friction report**: where agents struggled. The signals are rework loops, files that are too large, missing tests, hidden coupling, and slow or flaky test suites.
- From that, tech-lead proposes small, separately reviewable refactor PRs (the strangler pattern, adding tests first). They go through the same pipeline, at a higher risk tier when they touch critical paths.
- **The goal is measurable:** fewer rework loops and less token spend per task in that area.

---

## 7. Pillar E: adding and removing repos after setup

Make repos first-class objects, managed by the **setup agent** with approval cards, the same model as v2 integrations.

**A Repos page** lists each repo with its provider, its default and protected branches, its health (CI status, map freshness, test readiness), and which roles and rooms use it.

### Add
1. Choose a provider integration (GitHub, GitLab or Bitbucket must already be connected), then the repo.
2. **Clone** into `/work/repos/<name>`. Agents use per-task worktrees from it.
3. **Per-repo settings:**
   - default branch;
   - branch protection the agents must respect;
   - required checks;
   - deploy targets;
   - risk tier defaults;
   - who may merge.
4. Start the **onboarding run** (§6).
5. An approval card shows which roles get access to it.

### Remove
1. Archive or remove the clone and its worktrees.
2. Remove it from roles and rooms, after checking that no task is open on it.
3. Archive its memory and maps (kept read-only, not deleted).
4. Show the "revoke" text: deploy keys, webhooks, and anything else created for it.

**CLI:** `agentbox repo add|remove|list|status` lets the setup agent and scripts use the same path.

---

## 8. Pillar F: memory

### Layers
1. **Constitution (team rules):** principles and quality gates; Spec Kit keeps this in `constitution.md`. agentbox already has `/team/*.md`. **Only the owner changes it,** through approval cards.
2. **Repo knowledge:** the maps from §6. Generated, versioned, refreshed.
3. **Episodic (what happened):** a decision log per work item, i.e. what was tried, why, and the outcome. It's written automatically from proof bundles and the tech-lead's summaries.
4. **Procedural (how to do things):** scripts and runbooks. Room workspaces already hold these (`scripts/`, `notes/`); promote proven ones to a team-wide library.
5. **Lessons learned:** after rework, a revert or an incident, a short postmortem writes a lesson ("in repo X, the payments tests need the tunnel; run `mongodb_tunnel_start` first"). Lessons start as **proposals**; once repeated or approved they're promoted to the repo knowledge or the constitution.

### How agents use it
- **Retrieval on demand, not dumping everything into every prompt.** Sources agree that a memory store stuffed into every prompt wastes tokens and brings stale facts into fresh work.
- An MCP `memory_search` / `memory_write` tool backed by plain markdown files plus SQLite full-text search. It's simple, inspectable and works offline. Embeddings or a knowledge graph (agentmemory, MemoryGraph, the reference MCP Knowledge Graph server) are an option later if search quality isn't good enough.
- This matches Anthropic's **memory tool** pattern: a memory directory the agent reads and writes, stored on our side, alongside context editing for long runs.

### Hygiene
- Every entry records its **provenance** (task, agent, date) and an **expiry or "last confirmed"** date. Stale entries are flagged, not trusted.
- **No secrets** in memory; the scanner runs on writes.
- **Agents may write episodic memory and proposals freely; promotion to rules needs the owner** (or, once trusted, the tech-lead for repo-level knowledge).

---

## 9. Pillar G: removing the owner from the loop

### Risk tiers per action

| Tier | Examples | Default control |
|---|---|---|
| T0: read | read code, logs, metrics, read-only DB queries | autonomous |
| T1: local / branch | edit on a branch, run tests, open a PR | autonomous |
| T2: shared non-prod | merge to epic or feature branches, deploy to staging | autonomous with gates (already allowed for epic branches) |
| T3: prod, reversible | merge to main, deploy to prod with canary and auto-rollback | **earned:** autonomous per repo once the track record qualifies; otherwise the owner approves |
| T4: irreversible / high blast radius | DB migrations on live data, deleting data, IAM/secrets, cluster-wide kubectl, cost-incurring infra, anything financial | **always** owner approval (dual control), plus a hard technical wall |

### Earned autonomy
- **Track record** per role × repo × tier: merges, reverts, rework loops, incidents and gate failures over a rolling window.
- **Promotion is proposed, not automatic.** For example: "tech-lead in repo X: 40 T3-eligible changes, 0 reverts, 1 rework in 30 days, so propose letting it deploy unattended." The owner approves once; after that, that tier needs no per-change approvals.
- **Automatic step-down** after a revert or an incident: the tier drops back to approval until the record recovers.

### Hard walls (what makes trust safe, not just likely)
- **Provider-side branch protection and required checks** on main and release branches. Even a misbehaving agent can't merge around them. This matters more than any prompt.
- **Scoped credentials per tier.** Today the EKS role is cluster-admin, by your earlier choice. Real T3/T4 autonomy needs narrower credentials: a deploy-only role for agents, with admin kept for break-glass.
- **Separate unix users per role** (audit item H3). Today all agents share one user, so the guards are hook-level, not OS-level.
- **Budgets:** token and time caps per work item; agentbox already has background-command limits and the CI wait cap.
- **Kill switch:** Pause all already exists; add "pause this repo" and "drop this repo to approval mode".

### What the owner sees instead of approvals
- A **daily digest:** what merged and deployed, links to the proof bundles, anything flagged by the anti-gaming check, and tiers promoted or demoted.
- **Exception-only notifications:** T4 approvals, failed canaries, reverts, rework loops over a limit.
- **A trust dashboard:** gate pass rate, rework rate, revert rate, time to merge, and tokens per task, per repo and per role.

---

## 10. Suggested phases

| Phase | Contents | Rough size | Owner gain |
|---|---|---|---|
| **1. Proof and independent review** | Proof bundle; reviewer ≠ author enforced; gates read from CI, not self-reported; anti-gaming flags; merge refused without gates (rulesGuard); branch protection checklist per repo | ~1 week | You can trust "done" without re-checking |
| **2. Repos and onboarding** | Repos page + `agentbox repo add/remove`; onboarding run producing AGENTS.md, architecture, feature, commands and risk maps; repo-map MCP tool; drift routine | ~1–2 weeks | Agents find their way faster; adding a repo is self-service |
| **3. Skills** | agentbox's pipeline skills (spec, plan, tdd, verify, review, qa-browser, ship, postmortem), vendored and pinned; per-role mapping; before/after metrics | ~1 week | Consistent quality per stage |
| **4. Memory** | Decision log, lessons with promotion, `memory_search`/`memory_write` MCP (files + SQLite FTS), hygiene | ~1 week | Fewer repeated mistakes; less re-discovery |
| **5. Earned autonomy** | Risk tiers, track record, promotion proposals, step-down, daily digest, trust dashboard | ~1–2 weeks | Approvals turn into a digest |
| **6. Safe prod autonomy** | Canary + auto-rollback (Argo Rollouts or Flagger) per service; scoped deploy credentials; separate unix users (H3) | ~2 weeks + infra changes | Unattended prod deploys become reasonable |

Phases 1 and 2 give the most trust per unit of effort. Phase 6 is what makes taking yourself out of prod deploys responsible rather than hopeful.

---

## 11. Risks and limits

- **Agents gaming gates:** mitigated by independence, the anti-gaming flags and mutation testing, but never zero. Keep sampling proof bundles now and then.
- **Cost:** reviewers, QA runs and onboarding all spend tokens. Use profiles (small vs full) and measure tokens per task.
- **Skill supply chain:** third-party skills run with full agent rights; vendor, pin and review them.
- **Stale knowledge:** maps and memory that drift are worse than none; hence provenance, expiry and the drift routine.
- **Irreversible actions stay human.** Data migrations, deletions, IAM and spending keep dual control, whatever the track record.
- **Shared unix user and cluster-admin** limit how strong the walls are until H3 and scoped credentials are done.

---

## 12. Decisions for the owner

1. **The order of phases.** The recommendation is 1 → 2 → 3 → 4 → 5 → 6.
2. **Where repo knowledge lives:** committed in each repo (`docs/agent/`, via PR) or in agentbox's own store. The recommendation is in the repo, so humans and other tools benefit too.
3. **Reviewer model:** the same model with a fresh context, or a different model for T3+.
4. **Canary tool** for Kubernetes services: Argo Rollouts (explicit steps; migrates Deployments to Rollouts) or Flagger (keeps Deployments).
5. **Which tiers you want to keep approving** in the first month: suggested T3 and T4, with T3 earned per repo afterwards.

---

## Sources

- gstack: [augmentcode overview](https://www.augmentcode.com/learn/garry-tan-open-sources-gstack-claude-code), [Daniel Vaughan review](https://codex.danielvaughan.com/2026/03/30/gstack-garry-tan-production-skills-toolkit/), [Hora de Codar guide](https://horadecodar.com.br/?p=43601)
- superpowers: [glukhov.org quickstart](https://glukhov.org/ai-devtools/superpowers/), [emelia.io overview](https://emelia.io/hub/superpowers-claude-code-framework), [agentpedia listing](https://agentpedia.codes/agent-skills/publisher/obra)
- Spec Kit: [Plannotator profile](https://docs.plannotator.ai/frameworks/github-spec-kit), [walkthrough (Fred Hutch)](https://matsen.fredhutch.org/general/2026/02/10/spec-kit-walkthrough.html)
- Verification: [Sonar on Skyscanner](https://www.sonarsource.com/blog/what-skyscanners-ai-rollout-proves-about-verifying-ai-generated-code/), [Codacy dogfooding](https://blog.codacy.com/how-codacy-dogfoods-verity-with-its-own-ai-agents), [Augment pre-merge verification](https://www.augmentcode.com/guides/ai-agent-pre-merge-verification), [FetchSandbox](https://fetchsandbox.com/blog/verify-ai-generated-code-before-merge), [AIOS](https://gitblind.noratr.app/devin-lai/AIOS)
- AGENTS.md / CLAUDE.md: [BuildBetter guide](https://blog.buildbetter.ai/agents-md-complete-guide-for-engineering-teams-in-2026/), [deep dive](https://redreamality.com/blog/claude-md-agents-md-deep-dive/), [Tembo](https://www.tembo.io/blog/how-to-write-a-great-claude-md)
- Repo maps and code graphs: [Aider repo map](https://aider.chat/docs/repomap.html), [Aider tree-sitter post](https://aider.chat/2023/10/22/repomap.html), [RepoMapper MCP](https://glama.ai/mcp/servers/@pdavis68/RepoMapper/tree/3ef8914b3a2271695ac9e4b07ce1e8bf5a4c9be6), [cgraphy](https://pypi.org/project/cgraphy/), [Codebase Memory MCP](https://landscape.jimmysong.io/projects/codebase-memory-mcp/), [code knowledge graph post](https://www.grahambrooks.com/post/building-a-code-knowledge-graph-for-ai-agents/)
- Memory: [Anthropic context management](https://www.anthropic.com/news/context-management), [memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), [memory MCP servers 2026](https://mcp.directory/blog/claude-code-memory-mcp-servers-2026), [MemoryGraph](https://github.com/gregorydickson/memory-graph)
- Autonomy and guardrails: [progressive autonomy](https://www.mindstudio.ai/blog/progressive-autonomy-ai-agents-safe-deployment), [permission ladder](https://www.mindstudio.ai/blog/ai-agent-permission-ladder-autonomy-levels/), [in/on/out of the loop](https://www.famulor.io/blog/human-in-the-loop-vs-on-the-loop-vs-out-of-the-loop), [Stanford agentic AI practices](https://uit.stanford.edu/security/agenticai/best-practices)
- Canary and rollback: [Flagger canary analysis](https://oneuptime.com/blog/post/2026-02-09-canary-analysis-rollback-flagger/view), [Argo Rollouts vs Flagger](https://oneuptime.com/blog/post/2026-02-26-argocd-rollouts-vs-flagger/view)

Most sources are practitioner or vendor write-ups; their benchmark and popularity numbers are self-reported. Check primary repos before adopting a specific tool.
