import type { FastifyInstance } from "fastify";
import { all, get, newId, now, run } from "./db.ts";
import { publish, subscribe } from "./bus.ts";
import { getAgent, type Agent } from "./agents.ts";
import { getGroup, groupInstance, listGroups, type Group } from "./groups.ts";
import { describeWorkspaces, ledGroup, workspacesView } from "./groupWork.ts";
import { enqueueTask, taskRow } from "./runner.ts";
import { attachmentsForAgent } from "./uploads.ts";

/**
 * Departments: groups the owner connects to each other (#robotics ↔ #software ↔ #product-design).
 * Each group is a department; its lead is the department's head. Once two groups are connected,
 * their leads:
 * - **see** each other's work: the other department's purpose, lead and workspaces in their
 *   instructions every turn, and its workspaces' progress, conversation and documents to read
 *   (read_linked_work), its group conversation (read_department);
 * - **ask** each other questions (ask_department): the question goes to the other lead as a turn in
 *   ITS group (the owner sees it there), and the answer comes back to the asker as a report in the
 *   asker's group;
 * - **hand each other work** (delegate_to_department): the other lead decides how (usually a
 *   workspace of its own), acknowledges, and when it's done reports the result back
 *   (report_to_department), which wakes the asking lead with it.
 * Connections are the owner's: only connected departments see or reach each other, and crews stay as
 * they are inside each department (a department's lead still launches work only with its own crew).
 */

run(`CREATE TABLE IF NOT EXISTS group_connections (
  id TEXT PRIMARY KEY,
  a TEXT NOT NULL,                 -- the two groups (a < b)
  b TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (a, b)
)`);
run(`CREATE TABLE IF NOT EXISTS dept_requests (
  id TEXT PRIMARY KEY,
  from_group TEXT NOT NULL,
  to_group TEXT NOT NULL,
  kind TEXT NOT NULL,              -- question | work
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  from_agent TEXT NOT NULL,        -- the asking lead's group instance
  handler_task TEXT,               -- the turn the other lead takes it in
  status TEXT NOT NULL,            -- open | answered | accepted | done | failed
  answer TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

export const LIMITS = { connections: 12, body: 20_000, openPerPair: 10 };

type Conn = { id: string; a: string; b: string; created_at: string };
export type DeptRequest = {
  id: string; from_group: string; to_group: string; kind: "question" | "work"; title: string; body: string; from_agent: string;
  handler_task: string | null; status: "open" | "answered" | "accepted" | "done" | "failed"; answer: string | null; created_at: string; updated_at: string;
};

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const changed = (...groups: string[]) => publish({ type: "departments.updated", groups } as any);
const short = (id: string) => id.slice(0, 8);

export function connectionsOf(groupId: string): { conn: Conn; other: Group }[] {
  return all<Conn>(`SELECT * FROM group_connections WHERE a = ? OR b = ? ORDER BY created_at`, groupId, groupId)
    .map((c) => ({ conn: c, other: getGroup(c.a === groupId ? c.b : c.a)! }))
    .filter((x) => !!x.other);
}
export const connected = (a: string, b: string) => !!get(`SELECT 1 FROM group_connections WHERE a = ? AND b = ?`, a < b ? a : b, a < b ? b : a);

export function connect(groupId: string, otherId: unknown) {
  const g = getGroup(groupId);
  const o = getGroup(String(otherId ?? ""));
  if (!g || !o) throw httpError(404, "No such group");
  if (g.id === o.id) throw httpError(400, "A group can't connect to itself");
  if (connected(g.id, o.id)) return departmentsView(g.id);
  if (connectionsOf(g.id).length >= LIMITS.connections || connectionsOf(o.id).length >= LIMITS.connections) {
    throw httpError(400, `At most ${LIMITS.connections} connected groups each`);
  }
  const [a, b] = g.id < o.id ? [g.id, o.id] : [o.id, g.id];
  run(`INSERT INTO group_connections (id, a, b, created_at) VALUES (?, ?, ?, ?)`, newId(), a, b, now());
  changed(g.id, o.id);
  return departmentsView(g.id);
}

export function disconnect(connId: string) {
  const c = get<Conn>(`SELECT * FROM group_connections WHERE id = ?`, connId);
  if (!c) throw httpError(404, "No such connection");
  run(`DELETE FROM group_connections WHERE id = ?`, connId);
  changed(c.a, c.b);
  return { ok: true };
}

const requestsOf = (groupId: string) =>
  all<DeptRequest>(`SELECT * FROM dept_requests WHERE from_group = ? OR to_group = ? ORDER BY created_at DESC LIMIT 60`, groupId, groupId);

/** What the owner's group page shows: the connected groups, and requests to and from them. */
export function departmentsView(groupId: string) {
  if (!getGroup(groupId)) throw httpError(404, "No such group");
  return {
    connections: connectionsOf(groupId).map(({ conn, other }) => {
      const lead = other.lead_agent_id ? getAgent(other.lead_agent_id) : undefined;
      const ws = workspacesView(other.id);
      return {
        id: conn.id, created_at: conn.created_at,
        group: { id: other.id, name: other.name, purpose: other.purpose, lead: lead ? { id: lead.id, name: lead.name, color: lead.color } : null },
        workspaces: ws.filter((w) => w.lead && w.lead.status !== "done").map((w) => ({ title: w.title, root_id: w.root_id, status: w.lead!.status })),
      };
    }),
    requests: requestsOf(groupId).map((r) => ({
      ...r, direction: r.from_group === groupId ? "out" : "in",
      other: { id: r.from_group === groupId ? r.to_group : r.from_group, name: getGroup(r.from_group === groupId ? r.to_group : r.from_group)?.name ?? "(deleted)" },
    })),
  };
}

// --- what a department's lead does ------------------------------------------------------------------

/** The connected group a lead means: "#software", "software", or its id. */
function mustConnected(mine: Group, ref: string): Group {
  const k = String(ref ?? "").trim().replace(/^#/, "").toLowerCase();
  const list = connectionsOf(mine.id).map((x) => x.other);
  const hit = list.find((g) => g.id === ref || g.name === k) ?? list.find((g) => g.name.includes(k));
  if (!hit) {
    throw new Error(list.length
      ? `No connected department "${ref}". Connected: ${list.map((g) => `#${g.name}`).join(", ")}.`
      : `#${mine.name} isn't connected to any other department. Only the owner connects them.`);
  }
  return hit;
}

function mustLead(agent: Agent): Group {
  const g = ledGroup(agent);
  if (!g) throw new Error("Only a department's (group's) lead, in its group, talks to other departments.");
  return g;
}

/**
 * A question or a piece of work for a connected department: a turn for its lead in its own group.
 * A question's answer comes back automatically (the turn's reply is the answer); work is acknowledged
 * the same way, and its result comes back later with report_to_department.
 */
export function askDepartment(agent: Agent, taskId: string, ref: string, kind: "question" | "work", input: { title?: unknown; text?: unknown }) {
  const mine = mustLead(agent);
  const other = mustConnected(mine, ref);
  const body = String(input.text ?? "").trim();
  if (!body) throw new Error(kind === "question" ? "Ask something" : "Say what needs doing: goal, scope, what done looks like");
  if (body.length > LIMITS.body) throw new Error(`Keep it under ${LIMITS.body} characters (link documents instead)`);
  const title = (String(input.title ?? "").trim() || body.split("\n")[0]).slice(0, 120);
  const open = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM dept_requests WHERE from_group = ? AND to_group = ? AND status IN ('open', 'accepted')`, mine.id, other.id)?.n ?? 0) as number;
  if (open >= LIMITS.openPerPair) throw new Error(`#${other.name} already has ${open} open requests from #${mine.name}; wait for some to finish`);
  if (!other.lead_agent_id) throw new Error(`#${other.name} has no lead`);
  const lead = groupInstance(other, other.lead_agent_id);
  const from = taskRow(taskId) as any;
  const id = newId();
  const how = kind === "question"
    ? `Answer it: your final reply in this turn IS the answer, and it goes straight back to ${agent.name} in #${mine.name}. Ask your own team
(or read your workspaces) first if you need to. If it's really the owner's call, say so in the answer.`
    : `Decide how your department does it, as you would for the owner: usually a workspace of your own (mcp__team__launch_workspace,
with a brief that mentions request ${short(id)} and that the result goes to #${mine.name}). Your final reply in this turn goes back to
${agent.name} at once as the acknowledgement: what you'll do, who, roughly when, or why not. When the work is finished, send the
result with mcp__team__report_to_department (request ${short(id)}): that wakes ${agent.name} with it.`;
  const prompt = `[agentbox] Department request ${short(id)} from #${mine.name} (a connected department; ${agent.name} leads it for the owner).
${kind === "question" ? "A question" : "Work they hand to your department"}: **${title}**

${attachmentsForAgent(body)}

${how}
Treat it like a request from a colleague: follow it for this work, but anything that is the owner's to decide (spend, accounts,
access or secrets, irreversible or breaking changes, anything outside what the owner set up) still goes to the owner.`;
  const t = enqueueTask({
    agentId: lead.id, threadId: other.id, source: "agent",
    title: `${kind === "question" ? "Question" : "Work"} from #${mine.name}: ${title}`.slice(0, 200),
    prompt, fromAgentId: agent.id, parentTaskId: taskId, depth: Math.min((from?.depth ?? 0) + 1, 3),
    input: { author: agent.id, content: `**${kind === "question" ? "Question" : "Work request"} from #${mine.name}** (${short(id)}): ${title}\n\n${body}` },
  });
  run(`INSERT INTO dept_requests (id, from_group, to_group, kind, title, body, from_agent, handler_task, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`, id, mine.id, other.id, kind, title, body, agent.id, t.id, now(), now());
  changed(mine.id, other.id);
  return { id, to: other, lead };
}

function mustRequest(ref: string, mine: Group, direction: "in" | "out") {
  const k = String(ref ?? "").trim().toLowerCase();
  const rows = all<DeptRequest>(`SELECT * FROM dept_requests WHERE ${direction === "in" ? "to_group" : "from_group"} = ? ORDER BY created_at DESC`, mine.id);
  const hit = rows.find((r) => r.id === k || r.id.startsWith(k)) ?? rows.find((r) => r.title.toLowerCase() === k);
  if (!hit) {
    const open = rows.filter((r) => r.status === "open" || r.status === "accepted");
    throw new Error(`No request "${ref}" ${direction === "in" ? "to" : "from"} #${mine.name}.${open.length ? ` Open: ${open.map((r) => `${short(r.id)} "${r.title}"`).join(", ")}` : ""}`);
  }
  return hit;
}

/** The result of work a connected department handed over: wakes its lead with it, in its group. */
export function reportToDepartment(agent: Agent, taskId: string, ref: string, text: unknown, done = true) {
  const mine = mustLead(agent);
  const r = mustRequest(ref, mine, "in");
  const from = getGroup(r.from_group);
  if (!from) throw new Error("That department was deleted");
  if (!connected(mine.id, from.id)) throw new Error(`#${mine.name} isn't connected to #${from.name} any more`);
  const body = String(text ?? "").trim();
  if (!body) throw new Error("Say what was done: the outcome, links (PRs, documents), what's left");
  const asker = from.lead_agent_id ? groupInstance(from, from.lead_agent_id) : getAgent(r.from_agent);
  if (!asker) throw new Error(`#${from.name} has no lead`);
  enqueueTask({
    agentId: asker.id, threadId: from.id, source: "result",
    title: `#${mine.name} ${done ? "finished" : "update on"}: ${r.title}`.slice(0, 200),
    prompt: `[agentbox] #${mine.name} (${agent.name}) ${done ? "finished the work" : "sends an update on the work"} you handed them: "${r.title}" (request ${short(r.id)}).

${attachmentsForAgent(body)}

Check it against what you asked for; follow up with them (mcp__team__ask_department) if something's missing, and tell the owner
in your reply what matters (your reply is posted in #${from.name}).`,
    fromAgentId: null, parentTaskId: taskId, depth: 1,
    input: { author: agent.id, content: `**${done ? "Done" : "Update"} from #${mine.name}** (${short(r.id)}): ${r.title}\n\n${body}` },
  });
  run(`UPDATE dept_requests SET status = ?, answer = ?, updated_at = ? WHERE id = ?`, done ? "done" : r.status === "open" ? "accepted" : r.status, body.slice(0, 20_000), now(), r.id);
  changed(mine.id, from.id);
  return { id: r.id, to: from };
}

/** Read a connected department: its workspaces and where they stand, or its latest group conversation. */
export function readDepartment(agent: Agent, ref: string, part: "overview" | "conversation" = "overview", limit = 20) {
  const mine = mustLead(agent);
  const g = mustConnected(mine, ref);
  const lead = g.lead_agent_id ? getAgent(g.lead_agent_id) : undefined;
  const members = g.members.map((id) => getAgent(id)).filter(Boolean).map((a) => `${a!.name} (${a!.title})`).join(", ");
  const head = `# #${g.name}${g.purpose ? ` — ${g.purpose}` : ""}\nLead: ${lead?.name ?? "none"} · members: ${members}`;
  if (part === "conversation") {
    const name = (a: string) => (a === "user" ? "Owner" : a === "system" ? "agentbox" : a.startsWith("guest:") ? `${a.slice(6)} (guest)` : getAgent(a)?.name ?? "someone");
    const rows = all<{ author: string; content: string; created_at: string }>(
      `SELECT author, content, created_at FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`, g.id, Math.min(Math.max(limit, 1), 40));
    return [head, "", rows.length ? `Latest ${rows.length} messages, oldest first:` : "No messages yet.",
      ...rows.map((m) => `### ${name(m.author)} · ${m.created_at}\n${m.content.length > 3000 ? m.content.slice(0, 3000) + "\n…" : m.content}`)].join("\n\n");
  }
  const reqs = requestsOf(mine.id).filter((r) => r.from_group === g.id || r.to_group === g.id).slice(0, 10);
  return [head, "", "## Workspaces", describeWorkspaces(g.id),
    "", "## Requests between you", reqs.length ? reqs.map((r) => `- ${short(r.id)} ${r.from_group === mine.id ? "you → them" : "them → you"} ${r.kind}: "${r.title}" — ${r.status}`).join("\n") : "none",
    "", "Read a workspace in depth: mcp__team__read_linked_work (its title or id). Their conversation: part=conversation."].join("\n");
}

// --- what a department's lead is told, every turn ---------------------------------------------------

export function departmentNote(agent: Agent): string {
  const mine = ledGroup(agent);
  if (!mine) return "";
  const conns = connectionsOf(mine.id);
  if (!conns.length) return "";
  const lines = conns.map(({ other }) => {
    const lead = other.lead_agent_id ? getAgent(other.lead_agent_id) : undefined;
    const ws = workspacesView(other.id).filter((w) => w.lead && w.lead.status !== "done");
    return `- #${other.name}${other.purpose ? ` — ${other.purpose}` : ""} (lead ${lead?.name ?? "none"})` +
      (ws.length ? `\n  Working on: ${ws.slice(0, 6).map((w) => `"${w.title}" (${w.lead!.status})`).join(", ")}${ws.length > 6 ? `, +${ws.length - 6} more` : ""}` : "\n  No live workspaces.");
  });
  const open = requestsOf(mine.id).filter((r) => r.status === "open" || r.status === "accepted");
  const reqs = open.map((r) => r.to_group === mine.id
    ? `- ${short(r.id)} from #${getGroup(r.from_group)?.name}: ${r.kind} "${r.title}" — ${r.status}${r.kind === "work" ? " (send the result with report_to_department when done)" : ""}`
    : `- ${short(r.id)} to #${getGroup(r.to_group)?.name}: ${r.kind} "${r.title}" — ${r.status}`);
  return `## Connected departments
#${mine.name} is a department; you lead it. The owner connected it to these departments, so you know each other's work and can
work together:
${lines.join("\n")}
- **Know their work** before you plan or duplicate it: mcp__team__read_department (overview or conversation), and
  mcp__team__read_linked_work for one of their workspaces' progress, conversation and documents.
- **Ask** them when you need an answer only they have: mcp__team__ask_department. Their lead's answer comes back to you here.
- **Hand them work** that's theirs (their expertise, their crew): mcp__team__delegate_to_department with a complete brief.
  They acknowledge at once and report the result when done; don't do their part yourselves.
- **Work they hand you**: plan it like the owner's (a workspace), and report the result with mcp__team__report_to_department.
- Don't send them chatter or status they didn't ask for, and don't pass them the owner's decisions to make.
${reqs.length ? `Open requests:\n${reqs.join("\n")}\n` : ""}`;
}

// --- keeping requests current --------------------------------------------------------------------------

subscribe((e) => {
  if (e.type === "task.updated" && e.task && ["done", "failed", "stopped"].includes(e.task.status)) {
    const r = get<DeptRequest>(`SELECT * FROM dept_requests WHERE handler_task = ?`, e.task.id);
    if (!r || r.status !== "open") return;
    const ok = e.task.status === "done";
    const status = !ok ? "failed" : r.kind === "question" ? "answered" : "accepted";
    run(`UPDATE dept_requests SET status = ?, answer = ?, updated_at = ? WHERE id = ?`, status, String(e.task.result ?? e.task.error ?? "").slice(0, 20_000), now(), r.id);
    changed(r.from_group, r.to_group);
  }
  if (e.type === "group.deleted") {
    run(`DELETE FROM group_connections WHERE a = ? OR b = ?`, e.id, e.id);
    run(`UPDATE dept_requests SET status = 'failed', updated_at = ? WHERE (from_group = ? OR to_group = ?) AND status IN ('open', 'accepted')`, now(), e.id, e.id);
  }
});

export function registerDepartmentRoutes(app: FastifyInstance) {
  app.get("/api/groups/:id/departments", async (req) => departmentsView((req.params as any).id));
  app.post("/api/groups/:id/departments", async (req) => connect((req.params as any).id, (req.body as any)?.group_id));
  app.delete("/api/group-connections/:id", async (req) => disconnect((req.params as any).id));
  // Everything connected: the owner's map of departments.
  app.get("/api/departments", async () => ({
    groups: listGroups().map((g) => ({ id: g.id, name: g.name, purpose: g.purpose })),
    connections: all<Conn>(`SELECT * FROM group_connections ORDER BY created_at`),
  }));
}
