# agentbox backlog

Requirements to work on later. Newest at the bottom of each section. When an item is picked up,
move it to "In progress", and to "Done" (with the commit) when it ships.

## To do

### 1. Esc stops the current execution in the agent chat
**Area:** agent chat (main agent interface: header with Working / Stop, timeline, composer).

**Requirement:** like the Claude CLI, pressing **Esc** while an agent is working stops its current
execution, the same as clicking **Stop** in the chat header.

**Acceptance criteria**
- In an agent's chat, Esc stops the running turn of the agent being viewed. The turn shows
  "Stopped" and keeps the partial reply, exactly like the Stop button.
- Works while the composer has focus, and when focus is elsewhere in the chat.
- Esc keeps its current meaning first where one exists: closing an open popover, dialog,
  @-mention suggestions or the side panel. Only when there's nothing to close does it stop the
  agent.
- Nothing running → Esc does nothing (no error).
- Only the running turn stops; queued messages stay queued (as with Stop today).
- Visible hint so it's discoverable, e.g. the composer hint reads "Esc to stop" while working,
  and the Stop button's tooltip says "Stop (Esc)".
- Group chats: Esc stops the members currently replying in that group (same as the group Stop).

**Notes**
- UI only: `api.stop(taskId)` already exists. Add a key handler in `AgentChat` / `GroupChat`.
- Avoid accidental stops: ignore Esc during IME composition, and ignore auto-repeat.
- Decide: stop immediately, or a second Esc within ~1s to confirm? (Claude CLI stops on one.)

### 2. Light theme, with a theme switch
**Requirement:** a light theme you can choose, not just the dark one.

**Where it stands today:** the UI already has light colour tokens, but they only apply when the
Mac itself is in light mode (`prefers-color-scheme`). There's no way to pick a theme in agentbox.

**Acceptance criteria**
- A theme switch in the top bar (or a settings menu): **Light / Dark / System**. Default:
  System. The choice is remembered per browser and applies immediately, without a reload.
- Every screen reads well in light: rail, top bar, chats and work logs, code blocks and diffs, the
  interview, skills, groups, routines, task board and graph, activity feed, popovers, the paused
  bar, the screen preview, and error/warning boxes.
- Contrast: text at least 4.5:1 against its background (3:1 for large text and icons). Status
  colours (ok / warn / bad) and agent colours stay distinguishable in both themes.
- Agent avatar colours stay recognisable and their initials stay readable on light backgrounds.
- No flash of the wrong theme on load (apply the saved theme before first paint).

**Notes**
- Tokens live in `web/src/styles.css` (`:root` + the `prefers-color-scheme: light` block). Move the
  light values under `:root[data-theme="light"]` (and keep the system default via the media
  query when `data-theme` is unset), set `data-theme` from the switch, and persist it in
  localStorage (wrapped in try/catch).
- Check the hard-coded colours: avatar initials and the graph's node text use `#0E0F12`; the
  noVNC/terminal iframes and `background: #000` stay dark (they show the VM screen) — fine, but
  frame them so they don't look broken in light mode.
- Update `docs/UI-DESIGN.md` › Visual system with the final light tokens.

## In progress

_Nothing yet._

## Done

_Nothing yet._

---

## Parked from earlier discussions (not yet requested)

Ideas raised while building, kept here so they aren't lost. Not commitments.

- **Approval gate:** `gh pr merge`, deploy workflow runs and AWS write commands pause for the
  owner's Approve / Reject in the UI, enforced on every tool call (like the screen lock).
- **Hard tool blocking per agent:** tools left unticked in the interview (e.g. Docker, AWS for
  coder) are refused, not just discouraged.
- **Teams listener via Microsoft Graph:** cheap polling of chosen channels/chats that wakes the
  right agent on new messages, and replies through the API. Needs an Azure app registration.
- **Deployment trigger policy for tech-lead:** after every merge, batched, or only on request.
- **devops placeholders:** fill `[AWS PROFILE / REGION]` and `[STAGING AWS SERVICES]`.
- **VM memory:** raise to 8 GiB if many replicas run at once (`lima/agentbox.yaml`).
