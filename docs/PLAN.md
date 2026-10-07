# agentbox — plan

A self-hosted, Claude-powered take on Grok Bot: a team of role-based agents (tech-lead,
coder, tester, devops, …) that share one Linux computer and automate the software
development process. Everything is driven from a locally hosted web UI.

## What we are copying from Grok Bot

| Grok Bot | agentbox |
|---|---|
| Bots share one cloud computer (files, browser sessions, CLI credentials) | One Lima VM, `agentbox`, shared by all agents |
| Each bot has a name, a role and its own memory/context | Each agent has a role prompt, `memory/`, its own Claude sessions and chat history |
| Message any bot like a teammate | Chat with any agent in the web UI |
| Bots message each other and hand off work | Team MCP tools: `delegate_task`, `send_message`, … |
| Group chats with 2–6 bots | Groups: you pick members and a lead; @mention routing |
| Skills | Skill library (`SKILL.md`), assigned per agent; agents can propose drafts |
| Routines | Cron schedules per agent (e.g. tech-lead PR review every 2h) |
| Computer use when no API exists | Agents drive a persistent Chromium (CDP) and the whole X display |

Grok Bot treats the shared computer as one trust zone, not one per bot. We do the same:
**the VM is the security boundary**, and agents have full control inside it.

## Architecture

```
macOS host
 └── browser → http://localhost:7700   web UI: chats, groups, skills, schedules,
       │                                activity, Computer tab, Terminal tab
       │  Lima port forwards (127.0.0.1 only): 7700 UI · 7701 screen · 7702 terminal
       ▼
 limactl VM "agentbox" (Ubuntu 24.04, vz)       ← the single shared computer
   ├── Xvfb :99 + fluxbox + x11vnc → noVNC (:7701)   shared screen, watchable/controllable
   ├── ttyd (:7702)                                  web terminal for you
   ├── Chromium on :99, persistent profile, CDP on 127.0.0.1:9222
   ├── gh · git · aws · docker · node · python · playwright · xdotool
   ├── /work      shared repos (one git worktree per coding task)
   ├── /skills    skill library
   ├── /agents/<name>/  CLAUDE.md (job description) · memory/ · .claude/skills/ · scratch/
   └── orchestrator (/opt/agentbox/app, systemd: agentbox-web)
       ├── API + WebSocket + static UI
       ├── Agent Runner  → Claude Agent SDK query({ resume, cwd, env })
       ├── Task Queue    → one serial worker per agent
       ├── Team MCP      → in-process tools (below)
       ├── Scheduler     → croner → enqueue task
       └── Event Bus     → SQLite `events` + WebSocket
```

The repo is mounted **read-only** at `/mnt/agentbox-src`; `scripts/deploy.sh` copies the
app to `/opt/agentbox/app`. Your Mac's home directory is **not** mounted, so agents
cannot reach host files or keys.

## Logins (done once, by you)

| Platform | How you sign in | How agents use it |
|---|---|---|
| Claude (subscription) | `claude` → `/login` in the Terminal tab | Agent SDK uses the Claude Code login |
| GitHub | `gh auth login` in the Terminal tab | `gh`, `git` |
| AWS | `aws configure sso` / profiles in the Terminal tab | `aws` with named profiles |
| MS Teams + other web apps | Sign in on the shared Chromium via the Computer tab | Browser automation over CDP |

> Subscription auth: the Agent SDK docs say third-party *products* may not offer
> claude.ai login without approval. This is an internal tool run on your own
> subscription; switch the auth adapter to `ANTHROPIC_API_KEY` if that ever changes.
> Subscription 5-hour/weekly limits are the real ceiling, so queues pause on rate limits.

## Agents

- **Hiring (creating) an agent is an interview**, like Grok Bot: pick a starting role, answer
  7 core questions (name, main job, where it works, what great work looks like, tools,
  what to ask first, how to report), answer 2–4 follow-ups Claude writes for that role, then
  review and edit the job description Claude drafts. That becomes the agent's `CLAUDE.md`.
- **Role and capability:** the Claude Code system prompt + an agentbox section (identity,
  the shared computer, memory, reporting) + the agent's `CLAUDE.md`; per-agent model and
  `maxTurns`. `strictMcpConfig` keeps the owner's claude.ai connectors away from agents.
- **Full control:** `permissionMode: bypassPermissions`, passwordless sudo, `DISPLAY=:99`.
- **Separate context:** each agent runs with its home as `cwd`, so its `CLAUDE.md` and project
  skills load and its transcripts land in their own project folder. One Claude session per
  (agent, thread), resumed with `resume`. (A per-agent `CLAUDE_CONFIG_DIR` was dropped: it
  would hide the shared subscription login.)
- **Memory:** `/agents/<name>/memory/MEMORY.md` + files; shared across that agent's threads.
- **Browser and desktop control:**
  - Playwright MCP attached to the shared Chromium via CDP (`http://127.0.0.1:9222`)
  - Desktop tools for non-browser GUI: `screenshot`, `click`, `type`, `key` (xdotool + scrot)
  - `acquire_display` / `release_display` lock with auto-expiry; headless work needs no lock

## Team MCP tools

| Tool | Purpose |
|---|---|
| `list_agents()` | Roster with role, skills and status |
| `delegate_task(to, title, instructions)` | Queue a task for another agent; result comes back as a new turn |
| `get_task(id)` / `complete_task(id, result)` | Track and finish tasks |
| `send_message(to, text)` | FYI without a task |
| `post_to_group(group_id, text, mentions[])` | Speak in a group; mentions trigger those agents |
| `list_my_groups()` | Groups this agent belongs to |
| `schedule_task(agent, cron, prompt)` | Create a routine |
| `propose_skill(name, description, body)` | Draft a skill for your approval |
| `acquire_display(reason)` / `release_display()` | Take turns on the GUI |

Loop guards: delegation depth ≤ 3, no delegating back to the sender, ≤ 12 agent turns per
user message in a group, per-task `maxTurns`.

## Groups

You create a group, pick members and a lead. @mentioned agents get a task; un-mentioned
messages go to the lead. Each agent gets the group messages since its last turn, in its
own (agent, group) session.

## Skills

Library at `/skills/<name>/SKILL.md` (+ scripts). Assigning a skill symlinks it into
`/agents/<agent>/.claude/skills/<name>`. Agents' `propose_skill` creates a draft you
approve. Starter skills: `pr-review`, `plan-feature`, `triage-issue`, `implement-ticket`,
`open-pr`, `run-tests`, `e2e-check`, `deploy-staging`, `check-pipeline`.

## Software development flow

```
 Teams msg / GitHub issue / you
            │
       tech-lead ── plans, splits, assigns ──► coder (worktree per task → PR)
            ▲                                    │
            │                                    ▼
     PR review (cron 2h) ◄── tester (runs tests, comments on PR, files bugs)
            │
            ▼
         devops ── deploys to staging (AWS), reports in Teams
```

## Data model (SQLite)

```
agents(id, name, role, system_prompt, model, allowed_tools, disallowed_tools, max_turns, status)
threads(id, kind[dm|group], agent_id, name, purpose, lead_agent_id)
thread_members(thread_id, agent_id)
agent_sessions(agent_id, thread_id, session_id)
messages(id, thread_id, author[user|agent_id], content, created_at)
tasks(id, agent_id, from_agent_id, parent_task_id, depth, source[user|agent|cron],
      thread_id, title, instructions, status, result, started_at, finished_at)
schedules(id, agent_id, cron, prompt, enabled, last_run_at, next_run_at)
skills(id, name, description, path, status[active|draft], created_by)
agent_skills(agent_id, skill_id)
events(id, ts, agent_id, task_id, type, payload_json)
```

## Stack

Node 22 + TypeScript, `@anthropic-ai/claude-agent-sdk`, Fastify + WebSocket,
better-sqlite3 + Drizzle, croner, zod. UI: React + Vite (static, served by Fastify).

## Milestones

| # | Milestone | Done when |
|---|---|---|
| 0 ✓ | Shared computer | `scripts/up.sh` builds the VM; UI at :7700 shows the screen (noVNC) and a terminal (ttyd); Chromium runs on :99 with CDP |
| 1 ✓ | One agent end to end | Interview-based agent creation; chat with streaming and work log; runs commands and drives the shared browser; session survives restart; Stop |
| 2 | Agents + skills | 4 role agents, each with its own home, config, sessions, memory; skill library and assignment |
| 3 | Delegation | tech-lead → tester handoff with result returned; loop guards hold |
| 4 | Groups | Create group, pick members and lead, @mention routing |
| 5 | Routines | tech-lead PR review every 2h; overlapping runs skipped |
| 6 | Visibility | Activity feed, task board, agent graph, display-lock indicator |
| later | | Approval gate, MS Graph MCP for Teams, per-agent GitHub identities |
