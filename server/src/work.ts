import { all, now } from "./db.ts";
import { getAgent, instanceTree, listAgents, retireReplica, type Agent } from "./agents.ts";
import { agentStatus, openTasksOf } from "./runner.ts";
import { documentsInFolder, documentsForWork } from "./documents.ts";

/**
 * Work: top-level tasks (instances started by the owner) and the task rooms they grow into
 * (every instance started under them). Routine and group instances live with their routine or
 * group, not here. A finished room stays listed for 24 hours, or until un-kept.
 */

const KEEP_DONE_MS = 24 * 3600_000;

const isTopLevel = (a: Agent) =>
  !!a.base_agent_id && !a.parent_instance_id && !a.created_by?.startsWith("routine:") && !a.created_by?.startsWith("group:");

export function instanceSummary(a: Agent) {
  const open = a.retired_at ? [] : openTasksOf(a.id);
  const running = open.find((t) => t.status === "running");
  return {
    id: a.id, name: a.name, label: a.label, role_id: a.base_agent_id, color: a.color, parent_instance_id: a.parent_instance_id,
    created_by: a.created_by, created_at: a.created_at, retired_at: a.retired_at, kept: !!a.kept,
    status: a.retired_at ? "done" : agentStatus(a.id).status, current: running?.title ?? null, queued: open.length - (running ? 1 : 0),
  };
}

function lastActivity(ids: string[]) {
  if (!ids.length) return null;
  return all<{ at: string }>(
    `SELECT MAX(m.created_at) AS at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.agent_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  )[0]?.at ?? null;
}

function room(root: Agent) {
  const tree = instanceTree(root.id);
  return {
    root: instanceSummary(root),
    members: tree.map(instanceSummary),
    last_activity: lastActivity(tree.map((a) => a.id)) ?? root.created_at,
  };
}

export function workList() {
  const live = listAgents().filter(isTopLevel).map(room);
  const cutoff = new Date(Date.now() - KEEP_DONE_MS).toISOString();
  const done = all<Agent>(
    `SELECT * FROM agents WHERE base_agent_id IS NOT NULL AND parent_instance_id IS NULL AND retired_at IS NOT NULL
       AND (created_by IS NULL OR (created_by NOT LIKE 'routine:%' AND created_by NOT LIKE 'group:%'))
       AND (retired_at >= ? OR kept = 1)
     ORDER BY retired_at DESC LIMIT 50`,
    cutoff,
  ).map((a) => ({ ...room(a), hides_at: a.kept ? null : new Date(new Date(a.retired_at!).getTime() + KEEP_DONE_MS).toISOString() }));
  live.sort((a, b) => (b.last_activity ?? "").localeCompare(a.last_activity ?? ""));
  return { live, done };
}

const RECENT_TASKS = 30;
const STEP_FIELD_MAX = 4000;
/** A step with its input and output cut to a readable size (the end of output is what matters). */
export function capStep(s: any) {
  const cut = (v: unknown, tail: boolean) => {
    if (typeof v !== "string" || v.length <= STEP_FIELD_MAX) return v;
    return tail ? `… (${v.length - STEP_FIELD_MAX} chars cut)\n` + v.slice(-STEP_FIELD_MAX) : v.slice(0, STEP_FIELD_MAX) + `\n… (${v.length - STEP_FIELD_MAX} chars cut)`;
  };
  return { ...s, input: cut(s.input, false), output: cut(s.output, true) };
}

/** Everything that happened in a task room: all its instances' conversations, merged by time. */
export function roomView(rootId: string) {
  const root = getAgent(rootId);
  if (!root || !root.base_agent_id) throw new Error("No such task");
  const tree = instanceTree(rootId);
  const ids = tree.map((a) => a.id);
  const marks = ids.map(() => "?").join(",");
  const threads = all<{ id: string; agent_id: string; kind: string }>(
    `SELECT id, agent_id, kind FROM threads WHERE agent_id IN (${marks}) AND kind IN ('dm', 'handoff', 'routine')`, ...ids,
  );
  const tIds = threads.map((t) => t.id);
  const tMarks = tIds.map(() => "?").join(",") || "''";
  const messages = tIds.length ? all(`SELECT * FROM messages WHERE thread_id IN (${tMarks}) ORDER BY created_at, rowid`, ...tIds) : [];
  const tasks = tIds.length ? all(`SELECT * FROM tasks WHERE thread_id IN (${tMarks}) ORDER BY created_at`, ...tIds) : [];
  // Step logs only for running tasks and the most recent ones, each field capped: a long-lived
  // room has thousands of steps (MBs of tool output) and building that froze the whole server.
  const recent = new Set((tasks as any[]).slice(-RECENT_TASKS).map((t) => t.id));
  for (const t of tasks as any[]) if (t.status === "running" || t.status === "queued") recent.add(t.id);
  const stepIds = [...recent];
  const steps = stepIds.length
    ? all(`SELECT * FROM steps WHERE task_id IN (${stepIds.map(() => "?").join(",")}) ORDER BY seq`, ...stepIds).map(capStep)
    : [];
  return {
    root: instanceSummary(root),
    members: tree.map(instanceSummary),
    workspace: root.workspace ?? null,
    threads,
    messages, tasks, steps,
  };
}

export function roomDocuments(rootId: string) {
  const v = roomView(rootId);
  const docs = documentsForWork((v.tasks as any[]).map((t) => t.id), v.threads.map((t) => t.id));
  // Plus everything in the room's shared folder (state, scripts, notes).
  const seen = new Set(docs.map((d) => d.path));
  const shared = v.workspace ? documentsInFolder(v.workspace).filter((d) => !seen.has(d.path)) : [];
  return [...docs, ...shared].sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Finish a task and everything started under it. Refuses while any of it is still working. */
export function finishTree(rootId: string) {
  const tree = instanceTree(rootId).filter((a) => !a.retired_at);
  const busy = tree.filter((a) => openTasksOf(a.id).length);
  if (busy.length) throw new Error(`Still working: ${busy.map((a) => `${a.name} (${a.label})`).join(", ")}. Stop them first.`);
  for (const a of tree.reverse()) retireReplica(a.id);
  return { finished: tree.length, at: now() };
}
