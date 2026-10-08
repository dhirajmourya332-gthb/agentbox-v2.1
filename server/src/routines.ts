import { Cron } from "croner";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { ensureWorkspace, getAgent, instanceTree, retireReplica, spawnInstance, type Agent } from "./agents.ts";
import { currentUsage, enqueueTask, openTasksOf, resetSession } from "./runner.ts";
import { isPaused } from "./control.ts";

/**
 * Routines: an agent's recurring jobs ("review open PRs every 2 hours"). Each run is a normal
 * task in the routine's own thread, started with a fresh session; agents carry state between
 * runs in their memory files. A run is skipped (and the reason logged) when the previous run is
 * still going or the Claude plan is rate-limited.
 */

run(`CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
run(`CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  trigger TEXT NOT NULL,          -- schedule | manual
  outcome TEXT NOT NULL,          -- started | skipped
  reason TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL
)`);
run(`CREATE INDEX IF NOT EXISTS routine_runs_by ON routine_runs(routine_id, at)`);
for (const [col, type] of [
  ["instance_id", "TEXT REFERENCES agents(id) ON DELETE SET NULL"],
  ["context_mode", "TEXT NOT NULL DEFAULT 'continue'"], // continue | fresh
  ["runs_since_compact", "INTEGER NOT NULL DEFAULT 0"],
  ["last_compact_at", "TEXT"],
] as const) {
  if (!all<{ name: string }>(`PRAGMA table_info(routines)`).some((c) => c.name === col)) {
    run(`ALTER TABLE routines ADD COLUMN ${col} ${type}`);
  }
}

export type Routine = {
  id: string; agent_id: string; thread_id: string; name: string; cron: string; timezone: string; prompt: string;
  enabled: boolean; created_by: string; created_at: string;
  next_runs: string[]; describe: string; last_run: any | null;
};

const jobs = new Map<string, Cron>();

// --- reading cron -------------------------------------------------------------

export function validateCron(cron: string, timezone: string) {
  try {
    const c = new Cron(cron.trim(), { timezone, paused: true });
    const next = c.nextRuns(5).map((d) => d.toISOString());
    c.stop();
    return next;
  } catch (e: any) {
    throw new Error(`Invalid schedule: ${String(e.message).replace(/^CronPattern: /, "")}`);
  }
}

const pad = (n: string) => n.padStart(2, "0");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Plain words for the common shapes; the raw expression otherwise. */
export function describeCron(cron: string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = p;
  const at = /^\d+$/.test(hour) && /^\d+$/.test(min) ? `${pad(hour)}:${pad(min)}` : null;
  if (dom === "*" && mon === "*") {
    if (/^\*\/\d+$/.test(min) && hour === "*" && dow === "*") return `Every ${min.slice(2)} minutes`;
    if (/^\d+$/.test(min) && hour === "*" && dow === "*") return min === "0" ? "Every hour, on the hour" : `Every hour at :${pad(min)}`;
    if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && dow === "*") return `Every ${hour.slice(2)} hours${min === "0" ? ", on the hour" : ` at :${pad(min)}`}`;
    if (/^\d+$/.test(min) && /^\d+-\d+\/\d+$/.test(hour) && dow === "*") {
      const [range, step] = hour.split("/");
      return `Every ${step} hours between ${pad(range.split("-")[0])}:00 and ${pad(range.split("-")[1])}:${pad(min)}`;
    }
    if (at && dow === "*") return `Every day at ${at}`;
    if (at && dow === "1-5") return `Weekdays at ${at}`;
    if (at && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${at}`;
  }
  return cron;
}

// --- store ----------------------------------------------------------------------

function view(r: any): Routine {
  let next: string[] = [];
  try { next = r.enabled ? validateCron(r.cron, r.timezone) : []; } catch { /* shown as invalid */ }
  const last = get(`SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY at DESC LIMIT 1`, r.id) ?? null;
  const lastTask = last?.task_id ? get(`SELECT status, error FROM tasks WHERE id = ?`, last.task_id) : null;
  const inst = r.instance_id ? getAgent(r.instance_id) : undefined;
  const group = inst ? instanceTree(inst.id).filter((a) => !a.retired_at) : [];
  return {
    ...r, enabled: !!r.enabled, next_runs: next, describe: describeCron(r.cron),
    last_run: last ? { ...last, task_status: lastTask?.status ?? null } : null,
    group: group.map((a) => ({ id: a.id, name: a.name, label: a.label, role_id: a.base_agent_id, context_tokens: a.context_tokens ?? null })),
    workspace: inst?.workspace ?? null,
    compaction: compactionStatus(r, group),
  };
}

// --- context between runs (backlog #8) -------------------------------------------------------

/** Compact at whichever comes first: this many runs, this long, or a conversation this large. */
export const COMPACT_EVERY_RUNS = 5;
export const COMPACT_EVERY_MS = 24 * 3600_000;
export const COMPACT_AT_TOKENS = 100_000; // about half a 200k context window

const COMPACT_INSTRUCTIONS = `Keep what this routine needs next run: open PRs and issues and their state; alerts or items
already fixed or deliberately skipped, and why; decisions taken and anything waiting on the owner;
how the repo and its tests are run (commands, paths) as discovered; scripts saved in the shared
folder and what they do. Drop step-by-step tool output and anything already finished and recorded.`;

/** The routine's agent and its lead: the members whose conversations carry across runs. */
function carriers(group: Agent[]) {
  return group.filter((a) => a.created_by?.startsWith("routine:") || a.created_by?.startsWith("lead:"));
}

function compactionStatus(r: any, group: Agent[]) {
  const since = r.last_compact_at ?? r.created_at;
  const biggest = Math.max(0, ...carriers(group).map((a) => a.context_tokens ?? 0));
  const reasons: string[] = [];
  if (r.runs_since_compact >= COMPACT_EVERY_RUNS) reasons.push(`${r.runs_since_compact} runs`);
  if (Date.now() - new Date(since).getTime() >= COMPACT_EVERY_MS) reasons.push("24 hours");
  if (biggest >= COMPACT_AT_TOKENS) reasons.push(`${Math.round(biggest / 1000)}k tokens`);
  return { runs_since: r.runs_since_compact, last_at: r.last_compact_at, context_tokens: biggest, due: reasons };
}

/** Queue a compaction for each carrier with a conversation; they run before anything queued after. */
function queueCompaction(r: any, group: Agent[]) {
  for (const a of carriers(group)) {
    if (!get(`SELECT 1 FROM agent_sessions WHERE agent_id = ?`, a.id)) continue;
    const thread = get<{ id: string }>(`SELECT id FROM threads WHERE agent_id = ? AND kind IN ('routine', 'dm') ORDER BY kind = 'routine' DESC`, a.id);
    if (!thread) continue;
    enqueueTask({
      agentId: a.id, threadId: thread.id, source: "compact", title: `Compact context · ${r.name}`,
      prompt: `/compact ${COMPACT_INSTRUCTIONS}`, input: null,
    });
  }
  run(`UPDATE routines SET runs_since_compact = 0, last_compact_at = ? WHERE id = ?`, now(), r.id);
}

/** Compact now (owner): refused while the routine's group is working. */
export function compactRoutine(id: string) {
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  if (!r?.instance_id) throw new Error("No such routine");
  const group = instanceTree(r.instance_id).filter((a) => !a.retired_at);
  if (group.some((a) => openTasksOf(a.id).length)) throw new Error("The routine's agents are working; try again when they're done");
  queueCompaction(r, group);
  publish({ type: "routine.updated", routine: getRoutine(id)! });
}

/** Start fresh (owner): the next run begins with new conversations; shared folder and memory stay. */
export function freshRoutine(id: string) {
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  if (!r?.instance_id) throw new Error("No such routine");
  const group = instanceTree(r.instance_id).filter((a) => !a.retired_at);
  if (group.some((a) => openTasksOf(a.id).length)) throw new Error("The routine's agents are working; try again when they're done");
  for (const a of carriers(group)) run(`DELETE FROM agent_sessions WHERE agent_id = ?`, a.id);
  for (const a of carriers(group)) run(`UPDATE agents SET context_tokens = NULL WHERE id = ?`, a.id);
  run(`UPDATE routines SET runs_since_compact = 0, last_compact_at = ? WHERE id = ?`, now(), id);
  publish({ type: "routine.updated", routine: getRoutine(id)! });
}

export const getRoutine = (id: string) => {
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  return r ? view(r) : undefined;
};
export const listRoutines = (agentId?: string) =>
  (agentId
    ? all(`SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at`, agentId)
    : all(`SELECT * FROM routines ORDER BY created_at`)
  ).map(view);
export const routineRuns = (id: string, limit = 30) =>
  all(
    `SELECT routine_runs.*, tasks.status AS task_status, tasks.error AS task_error
     FROM routine_runs LEFT JOIN tasks ON tasks.id = routine_runs.task_id
     WHERE routine_id = ? ORDER BY at DESC LIMIT ?`,
    id, limit,
  );

type Input = { agent_id: string; name: string; cron: string; timezone: string; prompt: string; enabled: boolean; context_mode?: string };

function check(i: Input) {
  if (!getAgent(i.agent_id)) throw new Error("Pick an agent");
  if (!i.name.trim()) throw new Error("Give the routine a name");
  if (!i.prompt.trim()) throw new Error("Say what the agent should do each run");
  try { new Intl.DateTimeFormat("en", { timeZone: i.timezone }); } catch { throw new Error(`Unknown timezone ${i.timezone}`); }
  const next = validateCron(i.cron, i.timezone);
  // Guard against schedules that would burn through the plan.
  if (next.length >= 2 && new Date(next[1]).getTime() - new Date(next[0]).getTime() < 15 * 60_000) {
    throw new Error("Runs must be at least 15 minutes apart");
  }
}

/** The owner's timezone, remembered from the routines they create in the UI. */
export const defaultTimezone = () =>
  get<{ value: string }>(`SELECT value FROM meta WHERE key = 'timezone'`)?.value ?? "UTC";

export function createRoutine(i: Input, createdBy: string) {
  check(i);
  if (createdBy === "owner") {
    run(`INSERT INTO meta (key, value) VALUES ('timezone', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, i.timezone);
  }
  const id = newId();
  // Routines belong to an agent (role); each runs on its own instance, made once and kept for
  // the routine's whole life.
  const roleId = getAgent(i.agent_id)!.base_agent_id ?? i.agent_id;
  const instance = spawnInstance(roleId, { label: i.name.trim(), createdBy: `routine:${id}` });
  const threadId = get<{ id: string }>(`SELECT id FROM threads WHERE agent_id = ? AND kind = 'dm'`, instance.id)!.id;
  run(`UPDATE threads SET kind = 'routine', name = ? WHERE id = ?`, i.name.trim(), threadId);
  run(
    `INSERT INTO routines (id, agent_id, thread_id, name, cron, timezone, prompt, enabled, created_by, created_at, instance_id, context_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, roleId, threadId, i.name.trim(), i.cron.trim(), i.timezone, i.prompt.trim(), i.enabled ? 1 : 0, createdBy, now(), instance.id,
    i.context_mode === "fresh" ? "fresh" : "continue",
  );
  publish({ type: "thread.created", thread: { id: threadId, kind: "routine", agent_id: instance.id } });
  schedule(id);
  const r = getRoutine(id)!;
  publish({ type: "routine.updated", routine: r });
  return r;
}

export function updateRoutine(id: string, i: Input) {
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  if (!r) throw new Error("No such routine");
  if ((getAgent(i.agent_id)?.base_agent_id ?? i.agent_id) !== r.agent_id) throw new Error("A routine can't move to another agent; create a new one");
  check(i);
  run(
    `UPDATE routines SET name = ?, cron = ?, timezone = ?, prompt = ?, enabled = ?, context_mode = ? WHERE id = ?`,
    i.name.trim(), i.cron.trim(), i.timezone, i.prompt.trim(), i.enabled ? 1 : 0,
    i.context_mode === "fresh" ? "fresh" : i.context_mode === "continue" ? "continue" : r.context_mode, id,
  );
  run(`UPDATE threads SET name = ? WHERE id = ?`, i.name.trim(), r.thread_id);
  if (r.instance_id) run(`UPDATE agents SET label = ? WHERE id = ?`, i.name.trim(), r.instance_id);
  schedule(id);
  const v = getRoutine(id)!;
  publish({ type: "routine.updated", routine: v });
  return v;
}

export function deleteRoutine(id: string) {
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  if (!r) throw new Error("No such routine");
  jobs.get(id)?.stop();
  jobs.delete(id);
  run(`DELETE FROM routines WHERE id = ?`, id);
  // The routine's group (its agent, its lead, anything they started) goes with it; history stays.
  if (r.instance_id) {
    for (const a of instanceTree(r.instance_id).reverse()) {
      if (!a.retired_at && !openTasksOf(a.id).length) retireReplica(a.id);
    }
  }
  if (!get(`SELECT 1 FROM tasks WHERE thread_id = ?`, r.thread_id)) run(`DELETE FROM threads WHERE id = ?`, r.thread_id);
  publish({ type: "routine.deleted", id });
}

// --- running ----------------------------------------------------------------------

function logRun(routineId: string, trigger: string, outcome: string, reason: string | null, taskId: string | null) {
  run(
    `INSERT INTO routine_runs (id, routine_id, at, trigger, outcome, reason, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(), routineId, now(), trigger, outcome, reason, taskId,
  );
  const r = getRoutine(routineId);
  if (r) publish({ type: "routine.updated", routine: r });
}

export function runRoutine(id: string, trigger: "schedule" | "manual") {
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  if (!r) return;
  let agent = r.instance_id ? getAgent(r.instance_id) : undefined;
  if (!agent || agent.retired_at) {
    // Its instance was retired by hand: give the routine a new one.
    if (!getAgent(r.agent_id)) return;
    agent = spawnInstance(r.agent_id, { label: r.name, createdBy: `routine:${r.id}` });
    const dm = get<{ id: string }>(`SELECT id FROM threads WHERE agent_id = ? AND kind = 'dm'`, agent.id)!.id;
    run(`DELETE FROM threads WHERE id = ?`, dm);
    run(`UPDATE threads SET agent_id = ? WHERE id = ?`, agent.id, r.thread_id);
    run(`UPDATE routines SET instance_id = ? WHERE id = ?`, agent.id, r.id);
  }

  // The previous cycle includes whatever the routine's lead is still doing (review, merge, deploy).
  const group = instanceTree(agent.id).filter((a) => !a.retired_at);
  const busy = group.find((a) => openTasksOf(a.id).length);
  if (busy) {
    return logRun(id, trigger, "skipped", busy.id === agent.id ? "The previous run is still going" : `The previous cycle is still going (${busy.name}: ${busy.label})`, null);
  }
  if (isPaused()) return logRun(id, trigger, "skipped", "All agents are paused", null);
  const usage = currentUsage();
  if (usage?.status === "rejected" && usage.resetsAt && usage.resetsAt * 1000 > Date.now()) {
    const until = new Date(usage.resetsAt * 1000).toISOString();
    return logRun(id, trigger, "skipped", `Claude plan rate-limited until ${until}`, null);
  }

  ensureWorkspace(agent);
  const fresh = r.context_mode === "fresh";
  if (fresh) {
    for (const a of carriers(group)) run(`DELETE FROM agent_sessions WHERE agent_id = ?`, a.id);
  } else if (compactionStatus(r, group).due.length) {
    queueCompaction(r, group); // runs first, in each agent's queue
  }
  run(`UPDATE routines SET runs_since_compact = runs_since_compact + 1 WHERE id = ?`, r.id);
  const when = new Date().toLocaleString("en-GB", { timeZone: r.timezone, dateStyle: "medium", timeStyle: "short" });
  const task = enqueueTask({
    agentId: agent.id,
    threadId: r.thread_id,
    source: "cron",
    title: `Routine: ${r.name}`,
    prompt: `[agentbox routine "${r.name}" · ${trigger === "manual" ? "run now by the owner" : "scheduled run"} · ${when} ${r.timezone}]
Schedule: ${describeCron(r.cron)}.

${r.prompt}

${fresh
  ? `This run starts with a fresh conversation. Read this work's shared state.md and your memory for what
earlier runs did, so you don't redo work.`
  : `This routine continues the same conversation across runs (compacted now and then), so you already know
earlier runs; still check this work's shared state.md for anything others changed.`}
Reuse the scripts in the shared folder; save new ones for steps you repeat. If this needs review, merging,
testing or deployment, hand it to tech-lead (it joins this routine as its lead). Before you finish, update
state.md. End with a short summary of this run; if there was nothing to do, say so in one line.`,
    input: { author: "routine", content: `**${r.name}** · ${trigger === "manual" ? "run now" : "scheduled"} · ${when}` },
  });
  logRun(id, trigger, "started", null, task.id);
  return task;
}

function schedule(id: string) {
  jobs.get(id)?.stop();
  jobs.delete(id);
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  if (!r || !r.enabled) return;
  try {
    jobs.set(id, new Cron(r.cron, { timezone: r.timezone, protect: true }, () => {
      try { runRoutine(id, "schedule"); } catch (e) { console.error("routine run failed", id, e); }
    }));
  } catch (e) {
    console.error("bad routine schedule", id, e);
  }
}

export function startRoutines() {
  for (const r of all<{ id: string }>(`SELECT id FROM routines WHERE enabled = 1`)) schedule(r.id);
}

/** Stop jobs for routines whose agent was deleted (rows go by cascade). */
export function forgetAgentRoutines(agentId: string) {
  for (const [id, job] of jobs) {
    if (!get(`SELECT 1 FROM routines WHERE id = ?`, id)) { job.stop(); jobs.delete(id); }
  }
  void agentId;
}
