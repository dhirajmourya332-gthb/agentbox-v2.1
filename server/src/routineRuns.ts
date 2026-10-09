import { all, get, now, run } from "./db.ts";
import { publish, subscribe } from "./bus.ts";
import { getAgent, instanceTree, rootOf, type Agent } from "./agents.ts";
import { capStep, instanceSummary, RECENT_TASKS } from "./work.ts";

/**
 * Routine runs, active vs. archive (docs/CONTRACTS-v2.md § G). A run starts at a `routine_runs`
 * row with outcome 'started' and stays active while its own task, or any task in the routine's
 * instance tree created inside its window, is queued or running. The window runs from the run's
 * start to the next run's start (a run can't start while the previous cycle is busy), so the
 * routine's lead merging after the routine agent finished still counts. When nothing is open any
 * more the row is settled: finished_at, status and a one-line summary. Settling runs a moment
 * after every task change in a routine tree, and every minute as a safety net.
 *
 * The table and its columns live in routines.ts (additive migration); this module only reads and
 * settles rows, so it has no top-level database code.
 */

export type RunStatus = "running" | "done" | "failed" | "stopped" | "skipped";
export type RoutineRun = {
  id: string; routine_id: string; routine_name: string; role_id: string; instance_id: string | null;
  trigger: "schedule" | "manual"; started_at: string; finished_at: string | null;
  status: RunStatus; reason: string | null;
  summary: string | null; duration_s: number | null; tasks: number;
  members: { id: string; name: string; label: string | null; status: string }[];
};

type Row = {
  id: string; routine_id: string; at: string; trigger: string; outcome: string; reason: string | null; task_id: string | null;
  finished_at: string | null; status: string | null; summary: string | null;
  routine_name: string; role_id: string; routine_instance: string | null;
};
type WinTask = { id: string; agent_id: string; status: string; created_at: string; finished_at: string | null };

const SUMMARY_MAX = 300;
const SETTLE_DELAY_MS = 250;   // after a task change: lets a finished task's report-back get queued first
const SAFETY_EVERY_MS = 60_000;
const OPEN = new Set(["queued", "running"]);

const ROW_SQL = `SELECT rr.*, r.name AS routine_name, r.agent_id AS role_id, r.instance_id AS routine_instance
  FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id`;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const minIso = (a: string, b: string | null | undefined) => (b && b < a ? b : a);

// ---------------------------------------------------------------------------------------------
// A run's window and the tasks in it.

type Ctx = { from: string; to: string | null; root: string | null; tree: Agent[]; own: WinTask | undefined; tasks: WinTask[] };

/** The run's instance tree, window and the tasks inside it (cheap: indexed by agent and time). */
function context(r: Row, trees = new Map<string, Agent[]>()): Ctx {
  const own = r.task_id ? get<WinTask>(`SELECT id, agent_id, status, created_at, finished_at FROM tasks WHERE id = ?`, r.task_id) : undefined;
  // Older rows were logged just after their task was queued; the window starts at whichever came first.
  const from = minIso(r.at, own?.created_at);
  const next = get<{ at: string; t_at: string | null }>(
    `SELECT rr.at, t.created_at AS t_at FROM routine_runs rr LEFT JOIN tasks t ON t.id = rr.task_id
     WHERE rr.routine_id = ? AND rr.outcome = 'started' AND rr.at > ? ORDER BY rr.at LIMIT 1`, r.routine_id, r.at,
  );
  const to = next ? minIso(next.at, next.t_at) : null;
  const ownAgent = own ? getAgent(own.agent_id) : undefined;
  const root = ownAgent ? rootOf(ownAgent).id : r.routine_instance;
  if (r.outcome !== "started" || !root) return { from, to, root, tree: [], own, tasks: [] };
  let tree = trees.get(root);
  if (!tree) { tree = instanceTree(root); trees.set(root, tree); }
  const ids = tree.map((a) => a.id);
  const tasks = all<WinTask>(
    `SELECT id, agent_id, status, created_at, finished_at FROM tasks
     WHERE agent_id IN (${marks(ids.length)}) AND created_at >= ? ${to ? "AND created_at < ?" : ""} ORDER BY created_at`,
    ...ids, from, ...(to ? [to] : []),
  );
  if (own && !tasks.some((t) => t.id === own.id)) tasks.unshift(own);
  return { from, to, root, tree, own, tasks };
}

/** The routine agent's last reply in the window, as one line of about 300 characters. */
function summaryOf(root: string, from: string, until: string) {
  const threads = all<{ id: string }>(`SELECT id FROM threads WHERE agent_id = ?`, root).map((t) => t.id);
  if (!threads.length) return null;
  const m = get<{ content: string }>(
    `SELECT content FROM messages WHERE thread_id IN (${marks(threads.length)}) AND author = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`, ...threads, root, from, until,
  );
  const text = m?.content.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX - 1).trimEnd() + "…" : text;
}

/** What the row should say now. */
function settled(r: Row, c: Ctx): { status: RunStatus; finished_at: string | null; summary: string | null } {
  if (r.outcome === "skipped") return { status: "skipped", finished_at: r.at, summary: null };
  if (c.tasks.some((t) => OPEN.has(t.status))) return { status: "running", finished_at: null, summary: null };
  const finished = c.tasks.reduce<string | null>((m, t) => (t.finished_at && (!m || t.finished_at > m) ? t.finished_at : m), null) ?? r.at;
  const status: RunStatus = c.own?.status === "failed" ? "failed" : c.own?.status === "stopped" ? "stopped" : "done";
  return { status, finished_at: finished, summary: c.root ? summaryOf(c.root, c.from, finished) : null };
}

const memberStatus = (ts: WinTask[]) =>
  ts.some((t) => t.status === "running") ? "working" : ts.some((t) => t.status === "queued") ? "queued" : ts.at(-1)?.status ?? "idle";

function viewOf(r: Row, c: Ctx): RoutineRun {
  const status = (r.status ?? "running") as RunStatus;
  const byAgent = new Map<string, WinTask[]>();
  for (const t of c.tasks) byAgent.set(t.agent_id, [...(byAgent.get(t.agent_id) ?? []), t]);
  const members = c.tree
    .filter((a) => byAgent.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, label: a.label ?? null, status: memberStatus(byAgent.get(a.id)!) }));
  const duration = status !== "running" && status !== "skipped" && r.finished_at
    ? Math.max(0, Math.round((new Date(r.finished_at).getTime() - new Date(r.at).getTime()) / 1000)) : null;
  return {
    id: r.id, routine_id: r.routine_id, routine_name: r.routine_name, role_id: r.role_id, instance_id: c.root,
    trigger: r.trigger === "manual" ? "manual" : "schedule", started_at: r.at, finished_at: r.finished_at,
    status, reason: r.reason, summary: r.summary, duration_s: duration, tasks: c.tasks.length, members,
  };
}

const rowOf = (id: string) => get<Row>(`${ROW_SQL} WHERE rr.id = ?`, id);

// ---------------------------------------------------------------------------------------------
// Settling and events.

const lastSent = new Map<string, string>(); // run id → last published JSON (only changes go out)

/** Recompute one run from the database, save it if it changed, and publish when what clients see changed. */
export function settleRun(id: string, opts: { publish?: boolean } = {}) {
  let r = rowOf(id);
  if (!r) { lastSent.delete(id); return null; }
  const c = context(r);
  const next = settled(r, c);
  if (next.status !== r.status || next.finished_at !== r.finished_at || next.summary !== r.summary) {
    run(`UPDATE routine_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?`, next.status, next.finished_at, next.summary, id);
    r = { ...r, ...next };
  }
  const v = viewOf(r, c);
  if (opts.publish !== false) {
    const json = JSON.stringify(v);
    if (lastSent.get(id) !== json) {
      lastSent.set(id, json);
      publish({ type: "routine-run.updated", run: v });
    }
    if (v.status !== "running") lastSent.delete(id); // finished runs only change again if reopened
  }
  return v;
}

/** routines.ts calls this right after logging a run (started or skipped). */
export function runLogged(id: string) {
  settleRun(id);
}

/** Fill in status, finished_at and summary for rows written before run tracking existed. */
export function backfillRuns() {
  const rows = all<{ id: string }>(`SELECT id FROM routine_runs WHERE status IS NULL`);
  for (const { id } of rows) {
    try { settleRun(id, { publish: false }); } catch (e) { console.error("routine run backfill failed", id, e); }
  }
  return rows.length;
}

/** Re-check every run still marked running (catches anything an event missed, e.g. a restart). */
export function settleOpenRuns() {
  for (const { id } of all<{ id: string }>(`SELECT id FROM routine_runs WHERE status = 'running' OR status IS NULL`)) {
    try { settleRun(id); } catch (e) { console.error("routine run settle failed", id, e); }
  }
}

/** The routine an instance works for, if it's in a routine's tree. */
export function routineOfAgent(agentId: string): string | null {
  const a = getAgent(agentId);
  if (!a?.base_agent_id) return null;
  const by = rootOf(a).created_by ?? "";
  return by.startsWith("routine:") ? by.slice(8) : null;
}

/** The run a task belongs to: its own run, or the latest run that started before it. */
function runOfTask(task: { id: string; agent_id: string; created_at?: string }): string | null {
  const own = get<{ id: string }>(`SELECT id FROM routine_runs WHERE task_id = ?`, task.id);
  if (own) return own.id;
  const routineId = routineOfAgent(task.agent_id);
  if (!routineId) return null;
  const created = task.created_at ?? get<{ c: string }>(`SELECT created_at AS c FROM tasks WHERE id = ?`, task.id)?.c ?? now();
  return get<{ id: string }>(
    `SELECT id FROM routine_runs WHERE routine_id = ? AND outcome = 'started' AND at <= ? ORDER BY at DESC LIMIT 1`, routineId, created,
  )?.id ?? null;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
function settleSoon(id: string) {
  if (pending.has(id)) return;
  pending.set(id, setTimeout(() => {
    pending.delete(id);
    try { settleRun(id); } catch (e) { console.error("routine run settle failed", id, e); }
  }, SETTLE_DELAY_MS));
}

let started = false;
export function startRoutineRuns() {
  if (started) return;
  started = true;
  backfillRuns();
  settleOpenRuns();
  subscribe((e) => {
    if (e.type !== "task.updated" || !e.task?.id || !e.task.agent_id) return;
    try {
      const id = runOfTask(e.task);
      if (id) settleSoon(id);
    } catch (err) { console.error("routine run lookup failed", err); }
  });
  const timer = setInterval(settleOpenRuns, SAFETY_EVERY_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------------------------
// Reading.

export function listRuns(q: { state?: "active" | "archive"; routine_id?: string; before?: string; limit?: number }): RoutineRun[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.state === "active") where.push(`rr.status = 'running'`);
  else if (q.state === "archive") where.push(`rr.status IS NOT NULL AND rr.status != 'running'`);
  if (q.routine_id) { where.push(`rr.routine_id = ?`); params.push(q.routine_id); }
  if (q.before && q.state !== "active") { where.push(`rr.at < ?`); params.push(q.before); }
  const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 30)));
  const rows = all<Row>(
    `${ROW_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rr.at DESC ${q.state === "active" ? "" : "LIMIT ?"}`,
    ...params, ...(q.state === "active" ? [] : [limit]),
  );
  const trees = new Map<string, Agent[]>();
  return rows.map((r) => viewOf(r, context(r, trees)));
}

export function getRun(id: string): RoutineRun | null {
  const r = rowOf(id);
  return r ? viewOf(r, context(r)) : null;
}

/**
 * One run as a room view: only what happened inside [started_at, finished_at ?? now] across the
 * routine's instance tree. Steps only for running and the most recent tasks, each capped.
 */
export function runDetail(id: string) {
  const r = rowOf(id);
  if (!r) return null;
  const c = context(r);
  const runView = viewOf(r, c);
  const ids = c.tree.map((a) => a.id);
  const threads = ids.length
    ? all<{ id: string; agent_id: string; kind: string }>(
      `SELECT id, agent_id, kind FROM threads WHERE agent_id IN (${marks(ids.length)}) AND kind IN ('dm', 'handoff', 'routine')`, ...ids)
    : [];
  const until = r.finished_at ?? now();
  const tIds = threads.map((t) => t.id);
  const messages = tIds.length && r.outcome === "started"
    ? all(`SELECT * FROM messages WHERE thread_id IN (${marks(tIds.length)}) AND created_at >= ? AND created_at <= ? ORDER BY created_at, rowid`,
      ...tIds, c.from, until)
    : [];
  const taskIds = c.tasks.map((t) => t.id);
  const tasks = taskIds.length ? all(`SELECT * FROM tasks WHERE id IN (${marks(taskIds.length)}) ORDER BY created_at`, ...taskIds) : [];
  const recent = new Set(c.tasks.slice(-RECENT_TASKS).map((t) => t.id));
  for (const t of c.tasks) if (OPEN.has(t.status)) recent.add(t.id);
  const stepIds = [...recent];
  const steps = stepIds.length
    ? all(`SELECT * FROM steps WHERE task_id IN (${marks(stepIds.length)}) ORDER BY seq`, ...stepIds).map(capStep)
    : [];
  const memberIds = new Set(runView.members.map((m) => m.id));
  const members = c.tree.filter((a) => memberIds.has(a.id)).map(instanceSummary);
  return { run: runView, messages, tasks, steps, threads, members };
}
