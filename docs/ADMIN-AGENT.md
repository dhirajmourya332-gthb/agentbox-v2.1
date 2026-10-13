# The admin agent

Branch: `feature/admin-agent`.

## Code

| Part | Files |
|---|---|
| Server | `server/src/teamAdmin.ts`; changes in `approvals.ts`, `setupTools.ts`, `setup.ts`, `roleGuards.ts`, `work.ts` |
| Job description | `server/setup-agent/CLAUDE.md` |
| UI | `web/src/components/Setup.tsx` (approval cards), `web/src/components/AskAdmin.tsx` |
| Tests | `server/test/team-admin.test.ts` |

## What it is

The built-in setup agent is now the owner's **admin**. You talk to it in plain words. It turns what you
ask into exact changes, and you approve each one with a click. It can:
- **Change how an agent works.** For example, "Make the tech-lead only orchestrate and delegate, never
  write code." It rewrites only the parts of the job description that need to change, and shows you the
  diff.
- **Create an agent.** For example, "Create a sales agent." It runs the New agent interview as a short
  conversation, then proposes the full agent: job description, model, skills, integrations and repos.
- **Add or improve a skill, and give it to agents.** It can also import a skill from GitHub. The
  imported text is treated as data: anything risky is dropped and reported to you.
- **Do what the setup agent did:** connect integrations, add repos, propose team rules, handle setup
  requests from agents, and repair base modules.
- **Get work started.** When you ask for real work, it starts the task with the right agent
  (`start_work`). The task shows under Work, exactly as if you had started it. The admin never does the
  work itself.
- **Answer questions** about the team: who does what, what's running, why something stopped.

**Where to find it:**
- **Admin** in the sidebar (Configure → Admin), the same workspace as before.
- **Ask admin** under New task, or ⌘K / Ctrl+K anywhere. Either starts a new conversation, or adds
  to the open one.

The role's internal id stays `builtin = 'setup'`, and its home folder stays where it was. Its name
becomes `admin`, unless another agent already has that name.

## How changes are applied

Every team change is an **approval card** in the admin's chat. There are 5 kinds:

| Kind | Tool | What the card shows |
|---|---|---|
| `agent_create` | `propose_new_agent` | Name, title, model, skills, integrations and repos, plus the job description (collapsed) |
| `agent_change` | `propose_agent_change` | Setting changes (before → after), +/− skills, integrations and repos, and the job-description diff |
| `skill` | `propose_skill` | Description, source link and the agents it goes to, plus the SKILL.md diff (or full text if new) |
| `skill_assign` | `propose_skill_assignment` | The agents that get the skill (+) or lose it (−) |
| `bundle` | `propose_changes` | Several of the above on one card, approved together |

**Edit before approving.** Job descriptions and skill text can be edited on the card. The approved
version is your edited one.

**All or nothing.** First, every item is checked against what's on disk now. If a job description or
skill changed after the proposal, the card is refused with a 409 and nothing is applied. If applying
fails part-way, everything already applied is rolled back.

**Undo.** Applying records undo steps, and the card's Undo button puts everything back. Undo is refused
in 2 cases:
- what it would restore was changed again since;
- a new agent from the card has already done work.

**Who applies.** Only the owner's click applies or undoes a card: the
`POST /api/approvals/:id/approve|reject|undo` routes refuse calls made with the local agent token. No
agent tool can approve anything.

**When it takes effect.** Agents read their job description and skills at the start of each turn, so a
change applies from their next turn.

**Bundles.** Items can refer to agents and skills that the same bundle creates, for example a new skill
given to a new agent. Order doesn't matter. Applying runs in 2 passes:
1. create the agents and the skill texts;
2. link them (skills, integrations, repos).

## Test drive

`test_drive(agent, task, approval_id?)` asks an agent what it would do with a realistic task. It answers
from its current job description, or from the one a pending proposal would give it. It's a dry run with
no tools and no files, on Sonnet. The admin uses it to show you a behaviour change took before you
approve it.

## Guardrails

- **Only through cards.** The admin can't write other agents' homes, `/skills` or `/team` with the edit
  tools or the shell (`adminGuard`), even while it has temporary sudo. Its own home stays writable.
- **What it can't change:** its own instructions (you add notes on its page). It also can't delete
  agents or skills; you do that on their pages.
- **Built-in roles** can't be changed through these proposals.
- **Only for the admin:** other agents can't call these tools, and their proposals are refused.
- **Its skill proposals** go straight to cards. For the admin, `mcp__team__propose_skill` (the
  draft-for-review tool) is hidden.

## Not done yet

- **Skill files:** importing or editing a skill's scripts. Only SKILL.md is proposed; other files are
  left as they are.
- **Retiring agents and deleting skills** through the admin: you do these on their pages.
- **A needs-you item for pending admin cards** when you've left the conversation: the card sits in the
  admin's chat, like mapping and team-rule cards.
