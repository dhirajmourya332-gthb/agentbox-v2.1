import type { FastifyInstance } from "fastify";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { dmThreadOf, getAgent, reviveInstance, type Agent } from "./agents.ts";
import { enqueueTask } from "./runner.ts";

/**
 * One-time wake-ups (schedule_wakeup): an agent asks to be woken later, e.g. to check CI in 20 minutes or
 * to finish after a rate limit resets, instead of polling in a shell loop. Each fires once, as a new turn
 * for the agent that set it (revived if it was retired). A wake-up set during a delegated task wakes the
 * agent as part of that handoff, so its reply goes back to the delegator as a report. They survive a
 * restart (an overdue one fires right away) and show on the Routines page apart from the schedules.
 */

run(`CREATE TABLE IF NOT EXISTS wakeups (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,              -- the instance to wake
  task_id TEXT,                        -- the turn that set it
  note TEXT NOT NULL,                  -- what to do when woken (the agent's own words)
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | fired | cancelled
  created_at TEXT NOT NULL,
  done_at TEXT
)`);
run(`CREATE INDEX IF NOT EXISTS wakeups_status ON wakeups(status, due_at)`);

export const LIMITS = { minMinutes: 1, maxMinutes: 24 * 60, pendingPerAgent: 5, note: 1000 };

export type Wakeup = {
  id: string; agent_id: string; task_id: string | null; note: string; due_at: string; status: "pending" | "fired" | "cancelled";
  created_at: string; done_at: string | null;
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const view = (w: Wakeup) => ({ ...w, agent_name: getAgent(w.agent_id)?.name ?? null });
const announce = (id: string) => {
  const w = get<Wakeup>(`SELECT * FROM wakeups WHERE id = ?`, id);
  if (w) publish({ type: "wakeup.updated", wakeup: view(w) });
  return w;
};

export const pendingFor = (agentId: string) =>
  all<Wakeup>(`SELECT * FROM wakeups WHERE agent_id = ? AND status = 'pending' ORDER BY due_at`, agentId);

/** Pending ones, then the last day's fired or cancelled ones (newest first). */
export function listWakeups() {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  return all<Wakeup>(
    `SELECT * FROM wakeups WHERE status = 'pending' OR created_at >= ? ORDER BY status != 'pending', CASE WHEN status = 'pending' THEN due_at END, created_at DESC LIMIT 100`,
    since,
  ).map(view);
}

export function scheduleWakeup(agent: Agent, taskId: string | null, input: { in_minutes: unknown; note: unknown }): Wakeup {
  if (!agent.base_agent_id) throw new Error("Wake-ups are for tasks (instances).");
  const minutes = Math.round(Number(input.in_minutes));
  if (!Number.isFinite(minutes) || minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) {
    throw new Error(`in_minutes: ${LIMITS.minMinutes}–${LIMITS.maxMinutes} (up to a day)`);
  }
  const note = String(input.note ?? "").trim().slice(0, LIMITS.note);
  if (!note) throw new Error("Say what to do when you wake (note)");
  if (pendingFor(agent.id).length >= LIMITS.pendingPerAgent) {
    throw new Error(`You already have ${LIMITS.pendingPerAgent} wake-ups waiting; cancel one (cancel_wakeup) or fold this into one of them.`);
  }
  const id = newId();
  run(`INSERT INTO wakeups (id, agent_id, task_id, note, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    id, agent.id, taskId, note, new Date(Date.now() + minutes * 60_000).toISOString(), now());
  arm(id);
  return announce(id)!;
}

/** Cancel a pending wake-up: the owner from the portal, or the agent that set it (by). */
export function cancelWakeup(id: string, by?: Agent) {
  const w = get<Wakeup>(`SELECT * FROM wakeups WHERE id = ?`, id);
  if (!w) throw Object.assign(new Error("No such wake-up"), { statusCode: 404 });
  if (by && w.agent_id !== by.id) throw new Error("That wake-up isn't yours.");
  if (w.status !== "pending") return w;
  clearTimeout(timers.get(id));
  timers.delete(id);
  run(`UPDATE wakeups SET status = 'cancelled', done_at = ? WHERE id = ?`, now(), id);
  return announce(id)!;
}

function arm(id: string) {
  const w = get<Wakeup>(`SELECT * FROM wakeups WHERE id = ?`, id);
  if (!w || w.status !== "pending") return;
  clearTimeout(timers.get(id));
  // setTimeout caps at ~24.8 days; wake-ups are at most a day out.
  const t = setTimeout(() => { timers.delete(id); try { fire(id); } catch (e) { console.error("wakeup failed", id, e); } }, Math.max(0, Date.parse(w.due_at) - Date.now()));
  t.unref?.();
  timers.set(id, t);
}

export function fire(id: string) {
  const w = get<Wakeup>(`SELECT * FROM wakeups WHERE id = ?`, id);
  if (!w || w.status !== "pending") return;
  run(`UPDATE wakeups SET status = 'fired', done_at = ? WHERE id = ?`, now(), id);
  announce(id);
  let a = getAgent(w.agent_id);
  if (!a) return;
  if (a.retired_at) a = reviveInstance(a.id, a.created_by ?? "owner") ?? a;
  const threadId = dmThreadOf(a.id);
  if (!threadId) return;
  const origin = w.task_id ? get<any>(`SELECT * FROM tasks WHERE id = ?`, w.task_id) : undefined;
  const delegated = origin?.source === "agent" && origin.from_agent_id && getAgent(origin.from_agent_id);
  const set = `${Math.max(1, Math.round((Date.parse(w.done_at ?? now()) - Date.parse(w.created_at)) / 60_000))} min ago`;
  enqueueTask({
    agentId: a.id, threadId: origin?.thread_id ?? threadId, source: delegated ? "agent" : "message", title: `Wake-up: ${w.note.split("\n")[0]}`.slice(0, 120),
    prompt: `[agentbox] Your wake-up is due (you set it ${set}). Your note: ${w.note}

Check where things stand and carry on. If you need to wait again, set another wake-up rather than polling.${delegated ? `\nYour final reply goes back to ${delegated.name} as your report.` : ""}`,
    fromAgentId: delegated ? delegated.id : undefined, parentTaskId: delegated ? origin.parent_task_id ?? undefined : undefined,
    depth: delegated ? origin.depth ?? 0 : undefined,
    input: { author: "system", content: `Wake-up: ${w.note}` },
  });
}

/** Arm the pending ones (an overdue one fires right away). */
export function startWakeups() {
  for (const w of all<{ id: string }>(`SELECT id FROM wakeups WHERE status = 'pending'`)) arm(w.id);
}

export function registerWakeupRoutes(app: FastifyInstance) {
  app.get("/api/wakeups", async () => ({ wakeups: listWakeups() }));
  app.post("/api/wakeups/:id/cancel", async (req) => cancelWakeup((req.params as any).id));
}
