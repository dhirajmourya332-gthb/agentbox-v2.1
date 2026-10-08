import { all, get, newId, now, run } from "./db.ts";
import { publish, subscribe } from "./bus.ts";
import { getAgent, rootOf } from "./agents.ts";
import { getGroup, isNoReply, mentions } from "./groups.ts";
import { onProgressState } from "./progress.ts";

/**
 * "Needs you" (docs/CONTRACTS-v2.md § B): things the owner should look at.
 * - reply: an owner-started task (top-level instance, created_by "owner") posts a reply in its own
 *   conversation, or a group turn posts a reply that hands the turn to nobody (back to the owner).
 *   One unseen reply per room: a newer reply refreshes it (new title, task and time).
 * - failed: a turn fails in an owner-started task room (any of its tasks) or in a group.
 * - stalled: a running task is flagged by progress.ts. Marked seen automatically when it resumes
 *   or its turn ends.
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
    if (get(`SELECT 1 FROM attention WHERE kind = 'failed' AND task_id = ?`, task.id)) return;
    const why = task.error ? ` (${short(String(task.error), 60)})` : "";
    create("failed", place.agent.id, task.id, place.roomId, `${place.agent.name} failed: ${place.label}${why}`);
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
  onProgressState(({ task_id, agent_id, state, progress }) => {
    if (state === "stalled" && progress) {
      if (get(`SELECT 1 FROM attention WHERE kind = 'stalled' AND task_id = ? AND seen_at IS NULL`, task_id)) return;
      const name = getAgent(agent_id)?.name ?? "An agent";
      create("stalled", agent_id, task_id, progress.root_id, `${name} may be stuck: ${progress.activity}`);
    } else {
      // Resumed, or the turn ended: the stall is over.
      markWhere("kind = 'stalled' AND task_id = ?", task_id);
    }
  });
}
