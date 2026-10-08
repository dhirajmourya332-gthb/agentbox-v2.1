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

### 3. Replicas in a dropdown under their agent in the sidebar
**Requirement:** when tech-lead runs several copies of coder, list them in a dropdown on the
**coder** entry in the sidebar, where you can click any instance to see what it's doing.

**Where it stands today:** replicas are always listed, indented under coder (`coder#1`, `coder#2`…).
With 5 replicas that crowds the sidebar, and there's no summary.

**Acceptance criteria**
- The coder entry gets an expand/collapse arrow and a count, e.g. `coder  ▸ 3`. Collapsed, the
  sidebar shows only coder; expanded, it lists coder#1…#5 with each one's status.
- Collapsed still shows at a glance that replicas are busy, e.g. "2 working" or a working
  indicator on the coder entry.
- Clicking an instance opens its chat, with its live work log and current task. The current
  instance stays highlighted, and its parent auto-expands, when you navigate to it directly.
- The expanded or collapsed state is remembered. Retired instances disappear from the list;
  their history stays reachable from tasks and activity.
- Works the same for any agent that has replicas, not just coder.

### 4. Task rooms: an automatic group per multi-agent task
**Requirement:** with several coders working at once, it's hard to tell which instances work
together on which task. When tech-lead puts **more than one coder instance** on a task, agentbox
automatically creates a group for that task:
- a task-specific title, and a distinct look so it's easy to tell apart from normal groups;
- members: tech-lead, the coder instances on the task, and **any other agent that works on that
  task**, such as devops for its deployment or security for a fix. This holds even for agents
  without replicas;
- it shows only the logs and outputs related to that task. For an agent like devops, which also
  does other work, only its work on this task appears there;
- once the task is done, the group is deleted after **24 hours**, unless you cancel or stop the
  deletion.

**What this needs: tasks classified by the work they belong to.** Today, tasks link by
delegation (`parent_task_id`), and reports flow back along that chain. That's not enough by
itself. For example, tech-lead may hand the deployment to devops in a later, separate turn (after
your "ship it"), which starts a new chain. So:
- Give every task a **work item**: the task tree it belongs to, labelled by its issue or epic
  where there is one (`#2958`, `epic/2958-cspm-module`).
- A delegated task inherits its parent's work item. `delegate_task` takes an optional
  `work_item`, so tech-lead can attach a later handoff, such as the deploy, to the same room.
  agentbox can also suggest one when the handoff mentions an issue or branch that belongs to an
  open room.
- The room shows the turns, work logs, handoffs and reports of tasks in that work item only.
  devops's other tasks stay out.

**Acceptance criteria**
- Trigger: the second coder instance (`coder` or any `coder#N`) receives work in the same work
  item → the room is created, with every agent that has already worked on it. Decide whether
  two different agents (for example coder + security) should also trigger a room.
- Title from the epic or issue (e.g. "#2958 CSPM module"), else from tech-lead's task title.
  Rooms get their own icon and accent colour, and their own "Task rooms" section in the sidebar.
- Members are added automatically as new agents get work in the item, with a "devops joined"
  note. Replicas show by instance name; if a replica is retired, its past entries stay.
- The room's timeline holds the room's messages and all its tasks in time order: who's working
  on what, live work logs, handoffs ("tech-lead → coder#2: …") and reports. You can filter by agent.
- You can post in the room. That goes to tech-lead (the room's lead) with the work item attached,
  like a normal group.
- Done = every task in the work item has finished and nothing is queued. If the work is an epic,
  done = epic merged into `main` and deployed. Then the room shows "Deletes in 24 h — Keep".
  **Keep** cancels the deletion; you can also delete it right away.
- New work in the item before deletion cancels the countdown automatically.
- Deleting a room removes the room view only; the tasks, chats and activity history stay.

**Notes**
- Builds on: replicas (`base_agent_id`), groups (`threads.kind = 'group'`), the task tree
  (`parent_task_id`), and `find_work`. Likely new: `tasks.work_item`, `threads.kind = 'room'`
  with `work_item` and `delete_after`, and a sweep (like the routine scheduler) that deletes
  rooms whose time is up.
- Open questions: should a single coder plus devops on one task also get a room? Should rooms
  pause at a turn limit like groups? Should a room post a summary to Teams when the task
  completes?

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
