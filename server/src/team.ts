import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { getAgent, listAgents, retireReplica, spawnReplica, type Agent } from "./agents.ts";
import { proposeSkill, skillsOf } from "./skills.ts";
import { agentStatus, enqueueTask, openTasksOf, taskRow } from "./runner.ts";
import { createRoutine, defaultTimezone, deleteRoutine, describeCron, listRoutines } from "./routines.ts";

/**
 * The internal channel between agents. Agents call these tools; agentbox queues the work,
 * runs it, and routes the report back. Teams/GitHub are for people and records, not this.
 */

export const LIMITS = { depth: 3, handoffsPerTurn: 6 };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export function findAgent(nameOrSlug: string): Agent | undefined {
  const k = nameOrSlug.trim().toLowerCase().replace(/^@/, "");
  // "coder#2", "coder-2" and "coder 2" all name the same replica.
  const alt = k.replace(/[#\s]+/g, "-");
  return listAgents().find((a) => a.slug === k || a.name.toLowerCase() === k || a.slug === alt);
}

/** The thread where `to` works on what `from` hands it; one per pair, kept for context. */
export function handoffThread(to: Agent, from: Agent) {
  const existing = get<{ id: string }>(
    `SELECT id FROM threads WHERE kind = 'handoff' AND agent_id = ? AND peer_agent_id = ?`, to.id, from.id,
  );
  if (existing) return existing.id;
  const id = newId();
  run(`INSERT INTO threads (id, kind, agent_id, peer_agent_id, created_at) VALUES (?, 'handoff', ?, ?, ?)`, id, to.id, from.id, now());
  publish({ type: "thread.created", thread: { id, kind: "handoff", agent_id: to.id, peer_agent_id: from.id } });
  return id;
}

type Handoff = { kind: "task" | "message"; from: Agent; fromTask: any; to: string; title: string; body: string };

/** Checks shared by delegations and messages. Returns an error for the agent, or the target. */
function check(h: Handoff): string | Agent {
  const target = findAgent(h.to);
  const names = listAgents().filter((a) => a.id !== h.from.id).map((a) => a.name).join(", ") || "none";
  if (!target) return `No teammate called "${h.to}". Teammates: ${names}.`;
  if (target.id === h.from.id) return "That's you. Do the work yourself or pick a teammate.";
  if (h.fromTask.from_agent_id && h.fromTask.from_agent_id === target.id) {
    return `${target.name} handed this task to you. Don't hand it back: finish what you can and put questions or blockers in your final reply, which goes to ${target.name} automatically.`;
  }
  const depth = (h.fromTask.depth ?? 0) + 1;
  if (depth > LIMITS.depth) {
    return `Delegation chain limit (${LIMITS.depth}) reached. Do this yourself, or report back and let the owner decide.`;
  }
  const sent = (get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND source IN ('agent', 'message')`, h.fromTask.id,
  )?.n ?? 0) as number;
  if (sent >= LIMITS.handoffsPerTurn) return `You've handed off ${sent} items in this turn, the limit. Wait for reports before handing off more.`;
  return target;
}

export function handOff(h: Handoff) {
  const target = check(h);
  if (typeof target === "string") throw new Error(target);
  const threadId = handoffThread(target, h.from);
  const prompt = h.kind === "task"
    ? `[agentbox] Task from ${h.from.name} (${h.from.title})

Title: ${h.title}

${h.body}

Your final reply is sent back to ${h.from.name} automatically as your report. Make it complete
and self-contained: the outcome, links (issues, PRs, commits), what you verified, and anything
left open. If the task is unclear or you're blocked, say so in that reply instead of guessing.`
    : `[agentbox] Message from ${h.from.name} (${h.from.title}). FYI, no reply is expected.

${h.body}

Take it into account if it affects your work. Your reply here is not sent anywhere; only message
${h.from.name} back (send_message) if they genuinely need to know something.`;
  return enqueueTask({
    agentId: target.id,
    threadId,
    source: h.kind === "task" ? "agent" : "message",
    title: h.title,
    prompt,
    fromAgentId: h.from.id,
    parentTaskId: h.fromTask.id,
    depth: (h.fromTask.depth ?? 0) + 1,
    input: { author: h.from.id, content: h.kind === "task" ? `**${h.title}**\n\n${h.body}` : h.body },
  });
}

/** Called when a delegated task ends: the assignee's report becomes the delegator's next turn. */
export function returnResult(task: any) {
  if (task.source !== "agent" || !task.from_agent_id) return;
  const delegator = listAgents().find((a) => a.id === task.from_agent_id);
  const assignee = listAgents().find((a) => a.id === task.agent_id);
  if (!delegator || !assignee) return;
  const parent = task.parent_task_id ? taskRow(task.parent_task_id) : undefined;
  const threadId = parent?.thread_id ?? get<{ id: string }>(`SELECT id FROM threads WHERE kind = 'dm' AND agent_id = ?`, delegator.id)!.id;
  const outcome = task.status === "done" ? "finished" : task.status === "stopped" ? "was stopped on" : "failed on";
  const report = (task.result ?? "").trim() || (task.error ? `Error: ${task.error}` : "(no report)");
  enqueueTask({
    agentId: delegator.id,
    threadId,
    source: "result",
    title: `Report: ${task.title ?? "task"}`,
    prompt: `[agentbox] ${assignee.name} ${outcome} the task you delegated: "${task.title}" (task ${task.id}).

Their report:

${report}

Continue from here: check the result against what you asked for, follow up or hand off the next
step if needed, and report to the owner as your instructions say.`,
    fromAgentId: null,
    parentTaskId: task.id,
    depth: parent?.depth ?? 0,
    input: { author: assignee.id, content: `${outcome === "finished" ? "Finished" : outcome === "was stopped on" ? "Stopped" : "Failed"} **${task.title}**\n\n${report}` },
  });
}

export function teamServer(agent: Agent, taskId: string) {
  const me = () => taskRow(taskId);
  return createSdkMcpServer({
    name: "team",
    version: "1.0.0",
    instructions: "agentbox team tools: how agents on this team hand work to each other.",
    tools: [
      tool(
        "list_agents",
        "List your teammates (including replicas such as coder#2): role, status, what each is working on and has queued, skills. Pass pool to list just one agent and its replicas.",
        { pool: z.string().optional().describe("e.g. coder → coder and coder#1, coder#2…") },
        async ({ pool }) => {
        const base = pool ? findAgent(pool) : undefined;
        if (pool && !base) return refuse(`No teammate called "${pool}".`);
        const baseId = base ? base.base_agent_id ?? base.id : undefined;
        const rows = listAgents()
          .filter((a) => a.id !== agent.id)
          .filter((a) => !baseId || a.id === baseId || a.base_agent_id === baseId)
          .map((a) => {
          const open = openTasksOf(a.id);
          const running = open.find((t) => t.status === "running");
          const queued = open.filter((t) => t.status === "queued");
          const kind = a.base_agent_id ? ` (replica of ${getAgent(a.base_agent_id)?.name})` : a.max_replicas ? ` (up to ${a.max_replicas} replicas)` : "";
          return `- ${a.name}${kind} — ${a.title}: ${agentStatus(a.id).status}` +
            (running ? `; working on "${running.title}" (${running.id})` : "") +
            (queued.length ? `; queued: ${queued.map((t) => `"${t.title}"`).join(", ")}` : "") +
            (a.base_agent_id ? "" : `. ${a.summary} Skills: ${skillsOf(a.id).join(", ") || "none"}`);
        });
        return text(rows.length ? rows.join("\n") : "No matching teammates.");
      }),

      tool(
        "find_work",
        "Find who is working (or worked) on something: search tasks by issue number (e.g. 124 or #124), branch name or keyword. Cheaper than listing everyone.",
        {
          query: z.string().describe("Issue number, branch name or words from the task, e.g. '#124' or 'epic/2958'"),
          open_only: z.boolean().optional().describe("Only running or queued tasks (default false)"),
        },
        async ({ query, open_only }) => {
          // "issue #902", "#902", "fix/902-cron" → match the number 902; otherwise the text itself.
          const q = query.match(/#?(\d{2,})/)?.[1] ?? query.trim();
          if (!q) return refuse("Give an issue number, branch or keyword.");
          // Match "#124" / "124" as a whole number, anything else as a substring.
          const like = `%${q}%`;
          const rows = all(
            `SELECT id, agent_id, title, prompt, status, created_at, finished_at FROM tasks
             WHERE source IN ('user', 'agent', 'cron', 'group') AND (title LIKE ? OR prompt LIKE ?) AND id != ?
             ${open_only ? "AND status IN ('running', 'queued')" : ""}
             ORDER BY created_at DESC LIMIT 40`,
            like, like, taskId,
          ).filter((t: any) => !/^\d+$/.test(q) || new RegExp(`(^|[^\\d])#?${q}([^\\d]|$)`).test(`${t.title} ${t.prompt}`))
            .slice(0, 10);
          if (!rows.length) return text(`No tasks mention "${query}".`);
          return text(rows.map((t: any) => {
            const who = getAgent(t.agent_id);
            return `- ${who?.name ?? "deleted"}${who?.retired_at ? " (retired)" : ""}: "${t.title}" — ${t.status}, ${t.finished_at ? `finished ${t.finished_at}` : `since ${t.created_at}`} (task ${t.id})`;
          }).join("\n"));
        },
      ),

      tool(
        "spawn_replica",
        "Start a replica of a teammate (e.g. coder → coder#2) to take work in parallel. It shares their job description, skills and memory. Delegate to it by its name. Only for agents the owner allows to scale the team.",
        { of: z.string().describe("Base agent's name, e.g. coder") },
        async ({ of }) => {
          if (!agent.can_scale) return refuse("You're not allowed to spawn replicas; ask the owner.");
          const base = findAgent(of);
          if (!base) return refuse(`No teammate called "${of}".`);
          try {
            const r = spawnReplica(base.id);
            return text(`Started ${r.name}. Delegate to it with to="${r.name}".`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "retire_replica",
        "Retire a replica whose work is done (its report is in and nothing is queued). Its history stays readable.",
        { name: z.string().describe("e.g. coder#2") },
        async ({ name }) => {
          if (!agent.can_scale) return refuse("You're not allowed to retire replicas; ask the owner.");
          const r = findAgent(name);
          if (!r) return refuse(`No active agent called "${name}".`);
          if (!r.base_agent_id) return refuse(`${r.name} isn't a replica.`);
          const open = openTasksOf(r.id);
          if (open.length) return refuse(`${r.name} still has ${open.length} task(s) running or queued ("${open[0].title}"). Wait for its report first.`);
          retireReplica(r.id);
          return text(`Retired ${r.name}.`);
        },
      ),

      tool(
        "delegate_task",
        "Hand a task to a teammate. It joins their queue; when they finish, their report comes back to you automatically as a new message. Don't wait or poll: end your turn after delegating.",
        {
          to: z.string().describe("Teammate's name, e.g. coder"),
          title: z.string().describe("Short imperative title, e.g. 'Fix token refresh on tab blur (#88)'"),
          instructions: z.string().describe("Everything they need: context, links, acceptance criteria, constraints, what to report back"),
        },
        async (args) => {
          try {
            const t = handOff({ kind: "task", from: agent, fromTask: me(), to: args.to, title: args.title, body: args.instructions });
            return text(`Delegated to ${findAgent(args.to)!.name} as task ${t.id}. Their report will arrive as a new message.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "send_message",
        "Send a teammate an FYI (no task, no reply expected). Use delegate_task when you need something done.",
        { to: z.string(), text: z.string() },
        async (args) => {
          try {
            handOff({ kind: "message", from: agent, fromTask: me(), to: args.to, title: `Message from ${agent.name}`, body: args.text });
            return text(`Sent to ${findAgent(args.to)!.name}.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool("get_task", "Check a task's status and report, including any tasks it delegated further.", { task_id: z.string() }, async ({ task_id }) => {
        const t = taskRow(task_id);
        if (!t) return refuse("No task with that id.");
        const who = listAgents().find((a) => a.id === t.agent_id)?.name ?? "deleted agent";
        const kids = all(`SELECT id, title, status, agent_id FROM tasks WHERE parent_task_id = ? AND source = 'agent'`, t.id)
          .map((k: any) => `  - ${k.title} → ${listAgents().find((a) => a.id === k.agent_id)?.name}: ${k.status} (${k.id})`);
        const report = t.result ? `\nReport:\n${String(t.result).slice(0, 4000)}` : t.error ? `\nError: ${t.error}` : "";
        return text(`"${t.title ?? t.prompt.slice(0, 80)}" → ${who}: ${t.status}${kids.length ? `\nDelegated further:\n${kids.join("\n")}` : ""}${report}`);
      }),

      tool(
        "schedule_routine",
        "Create a recurring routine: a prompt an agent (you by default) runs on a cron schedule, e.g. checking open PRs every 2 hours. The owner can see, pause and edit it in agentbox. Runs must be at least 15 minutes apart.",
        {
          name: z.string().describe("Short name, e.g. 'PR review'"),
          cron: z.string().describe("5-field cron in the owner's timezone, e.g. '0 */2 * * *' (every 2 hours) or '30 9 * * 1-5' (weekdays 09:30)"),
          prompt: z.string().describe("What to do each run, self-contained"),
          agent: z.string().optional().describe("Teammate who runs it; defaults to you"),
        },
        async (args) => {
          const target = args.agent ? findAgent(args.agent) : agent;
          if (!target) return refuse(`No teammate called "${args.agent}".`);
          try {
            const r = createRoutine({ agent_id: target.id, name: args.name, cron: args.cron, timezone: defaultTimezone(), prompt: args.prompt, enabled: true }, agent.id);
            return text(`Scheduled "${r.name}" for ${target.name}: ${r.describe} (${r.timezone}). Next run ${r.next_runs[0] ?? "—"}. Routine id ${r.id}.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool("list_routines", "List the routines you run, or that you created for teammates.", {}, async () => {
        const mine = listRoutines().filter((r) => r.agent_id === agent.id || r.created_by === agent.id);
        if (!mine.length) return text("No routines.");
        return text(mine.map((r) => `- ${r.id}: "${r.name}" for ${listAgents().find((a) => a.id === r.agent_id)?.name}, ${describeCron(r.cron)} (${r.timezone})${r.enabled ? "" : " [paused]"}`).join("\n"));
      }),

      tool("cancel_routine", "Delete a routine you created.", { routine_id: z.string() }, async ({ routine_id }) => {
        const r = listRoutines().find((x) => x.id === routine_id);
        if (!r) return refuse("No routine with that id.");
        if (r.created_by !== agent.id) return refuse("Only the owner can remove routines you didn't create; ask them.");
        deleteRoutine(r.id);
        return text(`Deleted "${r.name}".`);
      }),

      tool(
        "propose_skill",
        "Propose a reusable skill (a procedure you or teammates will need again) for the owner to review and add to the skill library.",
        {
          name: z.string().describe("kebab-case, e.g. deploy-staging"),
          description: z.string().describe("One sentence: what it does and when to use it"),
          body: z.string().describe("Markdown instructions: steps, commands, checks. General, not tied to this one task."),
        },
        async (args) => {
          const d = proposeSkill(agent.id, taskId, args);
          return text(`Proposed skill "${d.name}". The owner will review it in agentbox.`);
        },
      ),
    ],
  });
}

export function rosterFor(agent: Agent) {
  const others = listAgents().filter((a) => a.id !== agent.id);
  return others.length
    ? others.map((a) => a.base_agent_id
        ? `- **${a.name}**: replica of ${getAgent(a.base_agent_id)?.name} (same job; takes work in parallel)`
        : `- **${a.name}** (${a.title}): ${a.summary}`).join("\n")
    : "- (no teammates yet)";
}
