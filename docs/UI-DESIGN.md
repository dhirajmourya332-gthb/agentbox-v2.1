# agentbox — UI design

The web UI is the only way you operate agentbox, so it has to answer four questions at a
glance, all the time:

1. **What is every agent doing right now?**
2. **What is on the shared computer's screen?**
3. **Who handed what to whom, and where is it stuck?**
4. **How do I step in?** (talk, take over the screen, pause everything)

Everything below serves those four.

## Principles

- **Live by default.** Status, streaming replies, the task board and the screen preview
  update over WebSocket. Nothing needs a refresh.
- **Work is visible but folded.** An agent's tool calls (shell commands, file edits,
  browser actions) are always there to inspect but collapsed into one "worked for 2m ·
  14 steps" line so conversations stay readable.
- **Every handoff is a link.** Delegations, group mentions and scheduled runs render as
  cards that open the task, its parent and its children.
- **You can always stop it.** A global *Pause all* in the top bar and *Stop* on every
  running turn. Agents have full control of the VM, so the brake is never more than one
  click away.
- **Status never relies on colour alone.** Each state has a shape/icon and a word.
- **Calm, dense, readable.** A tool for watching a team work all day: neutral surfaces,
  one accent, monospace only where the content is code or logs.

## App shell

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ agentbox   ⌘K Search or jump…                 ● VM ok  ◔ Claude 62%  [⏸ Pause all] │  top bar 48px
├──────────────┬─────────────────────────────────────────────────┬───────────────────┤
│ Activity  12 │                                                 │                   │
│ Tasks     3  │                                                 │  Context panel    │
│              │                 Main view                       │  (agent profile,  │
│ AGENTS     + │                                                 │   group members,  │
│ ◉ tech-lead  │                                                 │   task details)   │
│ ◉ coder    ⟳ │                                                 │                   │
│ ○ tester     │                                                 │  collapsible,     │
│ ◷ devops     │                                                 │  360px            │
│              │                                                 │                   │
│ GROUPS     + │                                          ┌──────┴──────┐            │
│ # release    │                                          │ screen  PiP │            │
│ # triage     │                                          │ coder is    │            │
│              │                                          │ using it    │            │
│ Routines     │                                          └─────────────┘            │
│ Skills    •2 │                                                                     │
│ Computer     │                                                                     │
│ Terminal     │                                                                     │
│ Settings     │                                                                     │
└──────────────┴─────────────────────────────────────────────────────────────────────┘
  rail 240px
```

- **Rail (240px):** Activity and Tasks at the top (with counts), then Agents and Groups,
  each with a `+`. Below: Routines, Skills (badge = drafts waiting for you), Computer,
  Terminal, Settings. Each agent row shows its avatar, name and status glyph; hovering
  shows the current task title.
- **Top bar:** command palette, VM health chip, Claude usage chip (5-hour window; turns
  orange near the limit, shows "resumes 14:20" when rate-limited), *Pause all*.
- **Context panel:** right side, collapsible, remembers its state per view.
- **Screen picture-in-picture:** a small live view of the shared display, pinned
  bottom-right on every page. Caption says who holds the display lock. Click to open
  Computer; drag to a corner; hide from its menu. This is how you keep an eye on what
  agents are clicking while you read a chat.

## Screens

### Activity (home)
A single live timeline across all agents.

```
 Filters: [All agents ▾] [All types ▾] [Last 24h ▾]                        ⏵ Live
 ────────────────────────────────────────────────────────────────────────────────
 14:02  ◆ tech-lead  delegated  "Add e2e for login" → ◆ tester          #142 ›
 14:01  ◆ coder      opened PR  org/app#311 "Fix token refresh"         #139 ›
 13:58  ◆ coder      ran        npm test   ✓ 212 passed   (collapsed)        ›
 13:40  ⏱ routine    started    tech-lead · PR review (every 2h)        #138 ›
 13:12  ◆ devops     took display  "Teams: post release note"                ›
```

- One row per meaningful event; consecutive tool calls from the same turn are grouped.
- The verb is coloured by kind (delegation, PR, deploy, error), never the whole row.
- Clicking a row opens the task in the context panel with its transcript.

### Agent chat (direct message)

```
 ◆ coder · Coder                                    Working on #139 · ⏹ Stop   [ⓘ]
 ────────────────────────────────────────────────────────────────────────────────
 You        Fix the token refresh bug from issue #88 and open a PR.

 ◆ coder    I found the cause: the refresh timer is cleared on tab blur…
            ▸ Worked for 3m 12s · 14 steps  (Bash ×6 · Edit ×4 · Browser ×4)
              ▾ $ npm test -- auth          ✓ 38 passed
                ✎ src/auth/refresh.ts       +12 −3      [view diff]
                ◎ Browser: localhost:3000/login         [screenshot]
            ┌ Delegated to ◆ tester ───────────────────────────────┐
            │ Add e2e test for token refresh          ⟳ running  › │
            └──────────────────────────────────────────────────────┘
            PR opened: org/app#311 ↗

 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ Message coder…  (@ to mention, / for skills)                         ⏎ Send │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- Streaming text appears as it arrives; the work log fills in live and folds when the
  turn ends.
- Step types have distinct icons: shell `$`, edit `✎`, browser `◎`, desktop `▣`, MCP
  tool `⚙`, delegation `→`. Diffs and screenshots open in a viewer, not inline.
- Messages you send while the agent is busy are queued and marked "queued".
- The context panel shows the agent's profile (below).

### Group chat
Same as the agent chat, plus:
- Header: group name, member avatars, the lead marked with a ★, *Manage members*.
- Every agent message carries its avatar and name; your messages stay right-aligned.
- `@` autocomplete lists members only; un-mentioned messages show "→ routed to lead".
- When the agent-turn limit is hit: a banner, "Paused after 12 agent turns",
  with *Continue* and *Stop here*.

### Agent profile (context panel, and full page from the rail)
Tabs: **Overview · Instructions · Memory · Skills · Sessions · Routines**
- **Overview:** role, model, status, current task, today's tasks and runtime.
- **Instructions:** the agent's `CLAUDE.md` in an editor with preview.
- **Memory:** file list of `memory/`, markdown preview, edit and delete. You can read
  and correct what the agent "knows".
- **Skills:** assigned skills with toggles; link to the library.
- **Sessions:** one row per thread with token use; *Start fresh session* per row.
- **Routines:** this agent's schedules.

### Create agent
A single sheet, not a wizard:
- **Role template** cards first (Tech lead, Coder, Tester, DevOps, Custom). Picking one
  pre-fills everything below.
- Name, colour, model (Opus / Sonnet / Haiku with a one-line trade-off each),
  instructions editor, skills checklist, max turns per task.
- Live preview on the right of how the agent will appear in the rail and in chat.

### Tasks
A board with columns **Queued · Running · Waiting · Done · Failed**.
- Card: title, assignee avatar, source icon (you / agent / routine), age, parent link.
- Detail (context panel): status timeline, delegation tree (parent → children, each with
  status), transcript, result, *Retry* and *Cancel*.
- A toggle switches the board to a **graph** view: agents as nodes, delegations in the
  selected window as edges (thicker = more tasks). Clicking an edge filters the board.

### Routines
A table: agent · schedule · prompt · next run · last result · enabled.
- Schedules read as words first ("Every 2 hours, on the hour"), cron underneath.
- The editor has presets (hourly, every 2h, weekdays 9:00, …), a cron field, and a
  preview of the next 5 run times in your timezone.
- *Run now* on every row. Skipped runs (still running, rate-limited) are listed with
  the reason.

### Skills
- **Library:** name, description, assigned agents, last used.
- **Drafts inbox:** skills agents proposed. Each opens side-by-side: the proposal
  (and a diff, if it updates an existing skill), who proposed it and from which task,
  *Approve*, *Edit*, *Reject*.
- **Editor:** name + "when to use" description, markdown body, attached scripts,
  agent assignment checkboxes.

### Computer
- Full-size noVNC view, scaled to fit, with a slim toolbar:
  display holder ("coder · since 14:01 · running e2e"), **Take control** (takes the
  display lock from the agent; the agent waits and is told), *Release*, *Open URL in
  shared browser*, *Screenshot*, *Clipboard*.
- While you hold control, a coloured frame surrounds the view so you know your input is
  live.

### Terminal
The ttyd shell, full height, with a note on first use: "Sign in here: `claude /login`,
`gh auth login`, `aws configure sso`."

### Settings
- **Connections:** Claude login, GitHub, AWS, plus a manual checklist for web sign-ins
  (Teams, …), each with a status and how to fix it.
- **Limits:** delegation depth, group turn limit, per-task max turns.
- **System:** VM health, service states, data location.

## States

| State | Treatment |
|---|---|
| First run, no agents | Activity shows role template cards: "Create your first agent". |
| Claude not signed in | Banner on every page with a button to Terminal. Agents can't start. |
| Rate-limited | Usage chip turns orange with resume time; agents show ◷ "waiting for limit". |
| Agent error | Red ✕ on the agent; the failed turn shows the error and *Retry*. |
| VM unreachable | Full-width banner, all live views greyed, auto-reconnect countdown. |
| Paused (Pause all) | A thin amber bar under the top bar: "All agents paused · Resume". |
| Empty lists | One sentence on what goes there and the action that fills it. |

## Visual system

**Look:** a quiet control room. Dark graphite by default with a light theme, one blue
accent, agent colours as the only other colour.

**Type**
- UI: IBM Plex Sans (self-hosted), 14px base, 1.45 line height; 12 / 14 / 16 / 20 / 24.
- Code, commands, logs, cron: IBM Plex Mono, 13px.
- Weights: 400 body, 500 labels, 600 headings. No all-caps except tiny rail section labels.

**Colour tokens**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0E0F12` | `#F7F7F8` | app background |
| `--surface` | `#15171C` | `#FFFFFF` | panels, rail |
| `--raised` | `#1C1F26` | `#F0F1F3` | hover, cards |
| `--line` | `#2A2E38` | `#E2E4E8` | borders, dividers |
| `--text` | `#E7E9EE` | `#16181D` | primary text |
| `--muted` | `#9AA3B2` | `#5B6474` | secondary text (≥4.5:1 on surface) |
| `--accent` | `#8AB4FF` | `#2F5BD3` | focus, links, primary buttons |
| `--ok` | `#5BD69A` | `#13804B` | success |
| `--warn` | `#F2B45A` | `#A15C00` | waiting, rate limits, paused |
| `--bad` | `#FF7A7A` | `#C3282D` | errors, Stop |

**Agent colours:** 8 hues that also step in lightness (so neighbours differ without colour
vision): `#8AB4FF #F2B45A #C59BFF #5BD69A #FF8FB1 #6FD3E0 #E0D06F #B0B8C6`. Used for the
avatar square and the name label only, never for message backgrounds.

**Status glyphs**

| State | Glyph | Word |
|---|---|---|
| Idle | ○ hollow | Idle |
| Working | ⟳ spinning ring (accent) | Working |
| Waiting on another agent / you | ◔ | Waiting |
| Rate-limited | ◷ (warn) | Limited |
| Using the display | ▣ | On screen |
| Error | ✕ (bad) | Error |
| Paused | ⏸ (warn) | Paused |

**Shape and spacing:** 4px grid; 8px radius on cards, 6px on controls; 1px borders
instead of shadows; 44px minimum hit targets; rail rows 36px.

**Motion:** 120ms ease-out for panels and folds; the working ring is the only constant
motion; honour `prefers-reduced-motion` (ring becomes a static dot).

## Interaction details

- **Keyboard:** `⌘K` palette (jump to agent, group, task; actions like "New agent",
  "Pause all"), `⌘1–9` agents in rail order, `/` focuses the composer, `Esc` closes the
  context panel, `⌘⏎` sends as a task when a toggle offers it.
- **Composer:** `⏎` sends, `⇧⏎` newline; `@` mention; `/` inserts a skill hint; paste an
  image to attach a screenshot.
- **Deep links:** every agent, group, task, skill and routine has a URL.
- **Accessibility:** real buttons and links; visible 2px accent focus ring; `aria-live`
  announces completed agent messages and errors (not every streamed token); the screen
  view has a text caption of who is using it.
- **Narrow windows:** below 1100px the context panel becomes an overlay drawer; below
  760px the rail collapses behind a menu button and the PiP hides.

## Front-end stack

React + Vite + TypeScript, served as static files by the orchestrator.
- Routing: TanStack Router. Server state: TanStack Query fed by REST + a WebSocket event
  stream.
- Styling: CSS variables (tokens above) + CSS modules; no component library, so the look
  stays ours. Radix primitives for dialog, popover, tabs and menus (accessible behaviour).
- Fonts: `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono` (no external requests).

## Build order (matches the milestones)

| Milestone | UI delivered |
|---|---|
| 0 | Shell (rail, top bar), Computer, Terminal, Settings › System |
| 1 | Agent chat with streaming and work log, agent profile (Overview, Instructions) |
| 2 | Create agent, agents list, profile Memory/Skills/Sessions, Skills library |
| 3 | Delegation cards, Tasks board + detail |
| 4 | Groups: create, members, lead, mentions, turn-limit banner |
| 5 | Routines table and editor |
| 6 | Activity timeline, graph view, screen PiP, display-lock UI, Pause all |

---

## Revision: work-first navigation (backlog #3–#6)

agentbox now runs **one instance per task**. An agent (tech-lead, coder, devops…) is a **role**: its
job description, skills, model and memory. Work happens on **instances** (`coder#2`), each doing
one task with its own conversation. The UI is organised around that, so it stays simple however
many instances run.

### Words used in the UI
- **Agent**: a role you hire through the interview. Shown under **Team**.
- **Task** (instance): one piece of work by one agent. Shown by its title ("Backend API keys"),
  with `coder#2` as a small subtitle.
- **Task room**: a task that started other tasks (tech-lead's "MSP API keys" plus its coder,
  devops… tasks). Opens as one combined timeline.

### Sidebar
```
[ + New task ]
Overview · Activity · Tasks · Routines · Documents · Skills
WORK
 ▾ ◆ MSP API keys            ⟳     ← task room (has sub-tasks): accent diamond
      Backend API keys       ⟳       coder#1
      Portal token page      ○       coder#2
 ▸ ○ Alert #3232 tinypool           ← single task
   Done (2) ▸                        ← finished in the last 24 h, then hidden (Keep pins)
TEAM
   tech-lead    1 working  ▸        ← expand: its live tasks
   coder        2 working  ▸
   devops       idle
   + New agent
GROUPS
COMPUTER  Screen · Terminal · System
```
- Work shows only top-level tasks; sub-tasks fold under their room. Routine and group tasks
  live under Routines and Groups, never in Work.
- Every section collapses and remembers it. Counts and live status replace long lists.

### Starting work
**New task** opens one small dialog: pick who (tech-lead is suggested for anything with more than
one step), write what's needed, Start. That creates the task and opens its chat. There's no
"chat with a role": each conversation is a task, so contexts never mix.

### A task (instance) page
The chat as before, with the task title in the header, `coder#2 · from tech-lead#1` under it, and
**Done** (retires it after confirming). The side panel has **Overview** (what it's doing, who
started it, tasks it started) and **Documents**. Instructions, skills and memory belong to the
role and are edited on the role's page.

### A task room
One timeline of every task in the room, each entry labelled with its task and agent, with chips
to filter by task. The composer talks to the room's lead. The side panel has **Tasks** (members
with status) and **Documents**. When the room's lead task is marked done, the room shows
"Hidden in 24 h — Keep".

### An agent (role) page
Header with the agent and **New task**. Tabs: **Tasks** (live and recent), **Instructions**,
**Skills**, **Memory**, **Documents**, **Settings** (model, limits, can scale, delete).
