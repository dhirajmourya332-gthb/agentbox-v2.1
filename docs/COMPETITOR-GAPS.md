# What similar agent systems have that agentbox doesn't

This document is research from 2026-10-11. It compares agentbox v2 with Devin, OpenHands, Factory, Cursor (background agents and BugBot), OpenAI Codex (cloud), GitHub Copilot's coding agent, Google Jules, Conductor and Sculptor.

Most sources are blogs and news write-ups rather than official docs. Claims that rest on a single source, or on our own knowledge, are marked.

**Chosen for v2.1:** **#1 diff review** and **#6 plan approval**. Plan approval leads with a simple before/after diagram (see `docs/V2.1-PLAN.md`).

---

## Worth doing (high value, small to medium effort)

| # | Feature | Who has it | agentbox today |
|---|---|---|---|
| 1 | **Diff review per task.** You see only what changed and can approve, reject, or request changes with comments that go back to the agent. | Conductor, Sculptor | Each task has worktrees, but no screen shows their changes. You read the PR on GitHub. |
| 2 | **Start work from where issues live.** Assign an issue or add a label, or @mention the agent in Slack, Linear or Jira, and it returns a PR. | Copilot, Codex, OpenHands, Devin | Tasks start from the portal, a routine, or another agent. |
| 3 | **Automatic review of every PR** in connected repos, including PRs opened by humans, with findings posted on the PR. | Cursor BugBot, Copilot, Codex | A `review-pr` skill exists, but something has to start it. |
| 4 | **A self-review pass before "done".** A separate check looks for bugs and edge cases before the task is marked finished. | Jules (Critic), Devin | No. See items 3.2 and 3.3 in `NEXT-VERSION-QUICK-WINS.md`. |
| 5 | **Saved environment per repo.** The install, build and test commands are worked out once, confirmed, and reused by every task. | Codex environments, Jules snapshots, Sculptor devcontainers, Conductor setup scripts | Onboarding writes a map, but nothing runs or verifies a setup script per task. |
| 6 | **Plan approval before coding.** The agent shows a plan and doesn't start until it's approved. This is optional per task. | Devin, Jules, Copilot | There's no plan step. |
| 7 | **Playbooks built from good sessions,** and improved from failed ones ("here are 3 runs where it went wrong, fix the playbook"). | Devin | Agents can propose a skill, but nothing builds one from a task or improves it from failures. |
| 8 | **Knowledge clean-up.** Find duplicate and contradicting entries, and suggest knowledge from patterns in the code. | Devin | Nothing. |

## Medium effort

| # | Feature | Who has it | Notes |
|---|---|---|---|
| 9 | **A budget per task and a cost report.** Each session has a cap, and cost is shown per task and per agent. | Devin (usage limit per session), Factory | Usage is tracked, but there's no cap and no per-task breakdown. |
| 10 | **Open the agent's work in your IDE.** Mirror the agent's branch locally or open the VM folder in VS Code or Cursor, then hand it back. | Sculptor (Pairing Mode), Conductor | We have a web terminal and the shared screen. An "Open in VS Code" link per worktree would be cheap. |
| 11 | **Several attempts, keep the best.** 2–3 agents try the same task and a reviewer picks one. | Codex (from our own knowledge, not confirmed in the search) | This costs more tokens. Use it only for hard tasks. |
| 12 | **Replay and evaluation sets.** A full timeline of each run with cost per step, plus a fixed set of sample tasks to rerun after changing a skill or prompt. | AgentOps, Langfuse, LangSmith, Braintrust | We have live progress and steps, but no way to measure whether a change helped. |
| 13 | **A second model as reviewer.** For example, Codex reviews Claude's change. | Factory Router, OpenHands, GitHub Agent HQ | agentbox is Claude-only. A different model catches different mistakes. |

## Larger, later

- **An isolated container or VM per task** (Codex, Cursor, Sculptor, OpenHands). agentbox shares one unix user; this is H3 in TRUSTED-AUTONOMY.
- **Persistent long-running agents across days** (Factory "Droid Computers"; Cursor long-running agents, from a single source).
- **Enterprise features** such as SSO and audit logs (Factory, OpenHands). These aren't relevant for a single owner yet.

## Where agentbox is already ahead

- **A standing team.** Named roles hand work to each other, with a lead per piece of work.
- **Automation:** routines with owner rules.
- **Visibility:** a shared screen and browser.
- **Setup:** a guided setup workspace, plus agent setup requests as cards.
- **Mobile app and voice.**
- **Self-hosted** on the owner's own VM, using the owner's own Claude login.

Most competitors work as "one task in, one PR out". agentbox's gaps are in **reviewing and measuring work** (items 1, 3, 4, 6, 9 and 12), not in doing it.

## Sources

**Devin:**
- [Devin advanced mode docs](https://docs.devin.ai/product-guides/advanced-mode)
- [Devin playbooks guide](https://fast.io/resources/devin-ai-playbook-guide/)
- [Devin June '24 update (Knowledge)](https://cognition.com/blog/june-24-product-update)

**OpenHands:**
- [OpenHands Series A](https://pulse2.com/openhands-18-8-million-series-a-to-bring-open-source-cloud-coding-agents-to-enterprises)
- [OpenHands review 2026](https://dev.to/jovan_chan_9500711396d4e6/openhands-review-2026-the-76k-star-coding-agent-5pa)

**Factory:**
- [Factory research](https://rywalker.com/research/factory-ai)
- [Factory (Sacra)](https://sacra.com/c/factory/)

**Cursor:**
- [Cursor agent explained](https://www.morphllm.com/comparisons/cursor-agent)
- [Cursor AI review 2026](https://softpicker.com/cursor-ai-review-2026/)

**OpenAI Codex:**
- [Codex cloud reusable environments](https://aicatchup.com/news/codex-cloud-reusable-environments)
- [Codex in Slack and Linear](https://codex.danielvaughan.com/2026/03/27/codex-slack-linear-cloud-tasks/)

**GitHub Copilot:**
- [Copilot agents](https://github.com/features/copilot/agents)
- [Copilot coding agent 2026](https://www.morphllm.com/copilot-coding-agent)

**Google Jules:**
- [Jules wiki](https://www.aiwiki.ai/wiki/jules_google/raw)
- [Jules out of beta (TechCrunch)](https://techcrunch.com/2025/08/06/googles-ai-coding-agent-jules-is-now-out-of-beta/)

**Conductor:**
- [Conductor workflows](https://www.conductor.build/workflows)
- [Conductor vs Claude Code](https://conductor.build/compare/claude-code)

**Sculptor:**
- [Sculptor containers docs](https://docs.imbue.com/features/containers)

**Observability and evaluation:**
- [AI agent observability tools 2026](https://last9.io/blog/best-ai-observability-tools-2026)
- [AgentOps monitoring guide](https://qaskills.sh/blog/agentops-agent-monitoring-guide-2026)
