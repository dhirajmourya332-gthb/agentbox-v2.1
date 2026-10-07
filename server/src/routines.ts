import { Cron } from "croner";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { getAgent } from "./agents.ts";
import { currentUsage, enqueueTask, resetSession } from "./runner.ts";

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
  return {
    ...r, enabled: !!r.enabled, next_runs: next, describe: describeCron(r.cron),
    last_run: last ? { ...last, task_status: lastTask?.status ?? null } : null,
  };
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

type Input = { agent_id: string; name: string; cron: string; timezone: string; prompt: string; enabled: boolean };

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
  const threadId = newId();
  run(`INSERT INTO threads (id, kind, agent_id, name, created_at) VALUES (?, 'routine', ?, ?, ?)`, threadId, i.agent_id, i.name.trim(), now());
  run(
    `INSERT INTO routines (id, agent_id, thread_id, name, cron, timezone, prompt, enabled, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, i.agent_id, threadId, i.name.trim(), i.cron.trim(), i.timezone, i.prompt.trim(), i.enabled ? 1 : 0, createdBy, now(),
  );
  publish({ type: "thread.created", thread: { id: threadId, kind: "routine", agent_id: i.agent_id } });
  schedule(id);
  const r = getRoutine(id)!;
  publish({ type: "routine.updated", routine: r });
  return r;
}

export function updateRoutine(id: string, i: Input) {
  const r = get(`SELECT * FROM routines WHERE id = ?`, id);
  if (!r) throw new Error("No such routine");
  if (i.agent_id !== r.agent_id) throw new Error("A routine can't move to another agent; create a new one");
  check(i);
  run(
    `UPDATE routines SET name = ?, cron = ?, timezone = ?, prompt = ?, enabled = ? WHERE id = ?`,
    i.name.trim(), i.cron.trim(), i.timezone, i.prompt.trim(), i.enabled ? 1 : 0, id,
  );
  run(`UPDATE threads SET name = ? WHERE id = ?`, i.name.trim(), r.thread_id);
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
  // Keep the thread (and its history) unless nothing ever ran in it.
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
  const agent = getAgent(r.agent_id);
  if (!agent) return;

  const previous = get(
    `SELECT tasks.status FROM routine_runs JOIN tasks ON tasks.id = routine_runs.task_id
     WHERE routine_id = ? ORDER BY at DESC LIMIT 1`, id,
  );
  if (previous && (previous.status === "queued" || previous.status === "running")) {
    return logRun(id, trigger, "skipped", "The previous run is still going", null);
  }
  const usage = currentUsage();
  if (usage?.status === "rejected" && usage.resetsAt && usage.resetsAt * 1000 > Date.now()) {
    const until = new Date(usage.resetsAt * 1000).toISOString();
    return logRun(id, trigger, "skipped", `Claude plan rate-limited until ${until}`, null);
  }

  // Fresh context each run; the agent keeps what matters in its memory files.
  resetSession(agent.id, r.thread_id);
  const when = new Date().toLocaleString("en-GB", { timeZone: r.timezone, dateStyle: "medium", timeStyle: "short" });
  const task = enqueueTask({
    agentId: agent.id,
    threadId: r.thread_id,
    source: "cron",
    title: `Routine: ${r.name}`,
    prompt: `[agentbox routine "${r.name}" · ${trigger === "manual" ? "run now by the owner" : "scheduled run"} · ${when} ${r.timezone}]
Schedule: ${describeCron(r.cron)}.

${r.prompt}

This runs on a schedule and starts with a fresh conversation each time. Before you start, check
your memory for notes from earlier runs (e.g. what you've already handled), and before you finish,
update them so the next run doesn't redo work. End with a short summary of what you did this run;
if there was nothing to do, say so in one line.`,
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
