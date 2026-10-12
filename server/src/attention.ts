import { all, get, newId, now, run } from "./db.ts";
import { publish, subscribe } from "./bus.ts";
import { getAgent, rootOf } from "./agents.ts";
import { getGroup, isNoReply, mentions } from "./groups.ts";
import { onProgressState } from "./progress.ts";

/**
 * "Needs you" (docs/CONTRACTS-v2.md § B): things the owner should look at.
 * - reply: an owner-started task (top-level instance, created_by "owner") posts a reply in its own
 *   conversation, or a group turn posts a reply that hands the turn to nobody (back to the owner).
 *   One unseen reply per room: a newer reply refreshes it (new title, task and time). Replies are
 *   "unread", not "needs you": the portal lists them apart, they don't count in the badge or push.
 * - question: the agent asks the owner (ask_owner), a plan waits for them, or a setup request.
 * - failed: a turn of an owner-started task's lead fails, or one in a group. A helper's failure goes
 *   to its lead as a report instead.
 * - stalled: a running task is flagged by progress.ts. A helper's stall goes to its lead (who checks on
 *   it, stops it or re-delegates); only the lead's own stall reaches the owner. Marked seen
 *   automatically when it resumes or its turn ends.
 * Opening a room or group in the portal marks its items seen (POST /api/attention/seen-room/:id).
 */

export type Attention = {
  id: string; kind: "reply" | "failed" | "stalled" | "question";
  agent_id: string; task_id: string | null; room_id: string | null;
  title: string;
  created_at: string; seen_at: string | null;
};

const listeners: ((item: Attention) => void)[] = [];
/** Called for each new (or refreshed) unseen item: the push workstream sends notifications from it. */
export function onAttention(cb: (item: Attention) => void) {
  listeners.push(cb);
}

const row = (id: string) => get<Attention>(`SELECT * FROM attention WHERE id = ?`, id);
const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function announce(item: Attention, fresh: boolean) {
  publish({ type: "attention.updated", item });
  if (!fresh) return;
  for (const cb of listeners) {
    try { cb(item); } catch (e) { console.error("onAttention listener failed", e); }
  }
}

function create(kind: Attention["kind"], agentId: string, taskId: string | null, roomId: string | null, title: string) {
  const item: Attention = { id: newId(), kind, agent_id: agentId, task_id: taskId, room_id: roomId, title: short(title, 140), created_at: now(), seen_at: null };
  run(
    `INSERT INTO attention (id, kind, agent_id, task_id, room_id, title, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    item.id, item.kind, item.agent_id, item.task_id, item.room_id, item.title, item.created_at,
  );
  announce(item, true);
  return item;
}

/** Raise an item from elsewhere (setup requests): announced, and pushed to paired phones like the rest. */
export function raiseAttention(kind: Attention["kind"], agentId: string, taskId: string | null, roomId: string | null, title: string) {
  return create(kind, agentId, taskId, roomId, title);
}

/** Items, unseen first (newest first within each), at most 100. */
export function listAttention(): Attention[] {
  return all<Attention>(
    `SELECT * FROM attention ORDER BY seen_at IS NOT NULL, CASE WHEN seen_at IS NULL THEN created_at ELSE seen_at END DESC LIMIT 100`,
  );
}

export function markSeen(id: string): Attention | null {
  const item = row(id);
  if (!item) return null;
  if (item.seen_at) return item;
  run(`UPDATE attention SET seen_at = ? WHERE id = ?`, now(), id);
  const next = row(id)!;
  announce(next, false);
  return next;
}

function markWhere(where: string, ...params: any[]) {
  const ids = all<{ id: string }>(`SELECT id FROM attention WHERE seen_at IS NULL AND ${where}`, ...params).map((r) => r.id);
  for (const id of ids) markSeen(id);
  return ids.length;
}
export const markAllSeen = () => markWhere("1 = 1");
/** Opening a room (task-room root id) or a group marks its items seen. */
export const markRoomSeen = (roomId: string) => markWhere("room_id = ?", roomId);

// ---------------------------------------------------------------------------------------------

/** Where a task belongs for the owner: an owner-started room or a group (null: neither). */
function placeOf(task: any) {
  const thread = task.thread_id ? get<{ kind: string; name: string | null }>(`SELECT kind, name FROM threads WHERE id = ?`, task.thread_id) : undefined;
  const agent = getAgent(task.agent_id);
  if (!agent) return null;
  if (thread?.kind === "group") return { agent, roomId: task.thread_id as string, label: `#${thread.name ?? "group"}`, group: true, ownerDm: false };
  if (!agent.base_agent_id) return null;
  const root = rootOf(agent);
  if (root.created_by !== "owner") return null;
  const ownerDm = agent.id === root.id && thread?.kind === "dm";
  return { agent, roomId: root.id, label: root.label ?? root.name, group: false, ownerDm };
}

function onTaskEnd(task: any) {
  if (!task || task.source === "compact") return;
  if (task.status === "done") {
    const content = String(task.result ?? "").trim();
    if (!content || isNoReply(content)) return;
    const place = placeOf(task);
    if (!place) return;
    let title: string;
    if (place.group) {
      const group = getGroup(task.thread_id);
      // A group reply that @mentions another member passes the turn on; it isn't for the owner yet.
      if (!group || mentions(group, content, task.agent_id).length) return;
      title = `${place.agent.name} replied in ${place.label}`;
    } else if (place.ownerDm) {
      title = `${place.agent.name} replied: ${place.label}`;
    } else return;
    const open = get<Attention>(`SELECT * FROM attention WHERE kind = 'reply' AND room_id = ? AND seen_at IS NULL`, place.roomId);
    if (open) {
      run(`UPDATE attention SET agent_id = ?, task_id = ?, title = ?, created_at = ? WHERE id = ?`,
        place.agent.id, task.id, short(title, 140), now(), open.id);
      announce(row(open.id)!, true);
    } else {
      create("reply", place.agent.id, task.id, place.roomId, title);
    }
    return;
  }
  if (task.status === "failed") {
    const place = placeOf(task);
    if (!place) return;
    // A helper's failure reaches its lead as a report (team.ts returnResult); the lead deals with it.
    if (!place.group && leadFor(task)) return;
    if (get(`SELECT 1 FROM attention WHERE kind = 'failed' AND task_id = ?`, task.id)) return;
    const why = task.error ? ` (${short(String(task.error), 60)})` : "";
    create("failed", place.agent.id, task.id, place.roomId, `${place.agent.name} failed: ${place.label}${why}`);
  }
}

/**
 * The agent that handed this task out and should deal with it: the delegator of a delegated task, or
 * the instance that spawned a helper. Null for the owner's own conversations and for groups.
 */
export function leadFor(task: any) {
  const from = task?.source === "agent" && task.from_agent_id ? getAgent(task.from_agent_id) : undefined;
  if (from && from.id !== task.agent_id) return from;
  const a = getAgent(task?.agent_id);
  if (a?.parent_instance_id && a.parent_instance_id !== a.id) return getAgent(a.parent_instance_id) ?? null;
  return null;
}

/** One notice per stalled task per half hour: the lead checks on it, stops it or re-delegates. */
const toldLead = new Map<string, number>();
const RETELL_MS = 30 * 60_000;
function tellLead(lead: any, task: any, activity: string) {
  const at = toldLead.get(task.id);
  if (at && Date.now() - at < RETELL_MS) return;
  toldLead.set(task.id, Date.now());
  const helper = getAgent(task.agent_id);
  import("./runner.ts").then(({ enqueueTask }) => {
    const threadId = get<{ id: string }>(`SELECT id FROM threads WHERE agent_id = ? AND kind = 'dm'`, lead.id)?.id;
    if (!threadId) return;
    enqueueTask({
      agentId: lead.id, threadId, source: "message", title: `${helper?.name ?? "A helper"} may be stuck`,
      prompt: `[agentbox] ${helper?.name ?? "A helper"} may be stuck on "${task.title}" (task ${task.id}): no progress for a while, last doing: ${activity}.

Unblock it yourself; don't hand this to the owner. Look at what it's doing (get_task), then pick one:
- it's legitimately waiting (a long build or test): leave it, and set a wake-up (schedule_wakeup) to check again;
- it's going in circles or waiting on something that won't come: stop it (stop_task) and re-delegate with
  clearer instructions or a different approach, or send the missing piece (send_message);
- it needs access or a decision only the owner can give: ask them (ask_owner), saying exactly what.`,
      fromAgentId: helper?.id, input: { author: "system", content: `${helper?.name ?? "A helper"} may be stuck: ${activity}` },
    });
  }).catch((e) => console.error("attention: telling the lead failed", e));
}

/** A task became stalled, resumed, or its turn ended (progress.ts). */
export function onTaskState({ task_id, agent_id, state, progress }: Parameters<Parameters<typeof onProgressState>[0]>[0]) {
  if (state === "stalled" && progress) {
    const task = get<any>(`SELECT * FROM tasks WHERE id = ?`, task_id);
    const lead = task ? leadFor(task) : null;
    if (lead) { tellLead(lead, task, progress.activity); return; }
    if (get(`SELECT 1 FROM attention WHERE kind = 'stalled' AND task_id = ? AND seen_at IS NULL`, task_id)) return;
    const name = getAgent(agent_id)?.name ?? "An agent";
    create("stalled", agent_id, task_id, progress.root_id, `${name} may be stuck: ${progress.activity}`);
  } else {
    // Resumed, or the turn ended: the stall is over.
    markWhere("kind = 'stalled' AND task_id = ?", task_id);
  }
}

let started = false;
export function startAttention() {
  if (started) return;
  started = true;
  subscribe((e) => {
    if (e.type !== "task.updated") return;
    if (e.task?.status !== "done" && e.task?.status !== "failed") return;
    try { onTaskEnd(e.task); } catch (err) { console.error("attention: task end failed", err); }
  });
  onProgressState(onTaskState);
}
