import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Attention, type Progress, type Step, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, Spinner, duration, relTime } from "./ui.tsx";
import { WorkLog } from "../views/AgentChat.tsx";

/**
 * Live progress (backlog 11) and "needs you": the status bar pinned under a room's or group's
 * timeline, the sidebar markers, and the Overview's Needs you list.
 */

/** Re-render every second while `on`. */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** "17 min", "1h 5m": coarse, for how long something has been stuck. */
function minutes(fromIso: string) {
  const m = Math.max(1, Math.round((Date.now() - new Date(fromIso).getTime()) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The live status of every working agent here, pinned under the timeline. */
export function LiveBar({ items, taskOf, stepsOf, labelOf, log = true }: {
  items: Progress[];
  taskOf?: (taskId: string) => Task | undefined;
  stepsOf?: (taskId: string) => Step[];
  /** The task's name, shown after the agent's (rooms with several tasks). */
  labelOf?: (agentId: string) => string | null | undefined;
  /** Rows expand to the work log (off where the timeline already shows it). */
  log?: boolean;
}) {
  useTick(items.length > 0);
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.started_at.localeCompare(b.started_at));
  return (
    <section className="live-bar" aria-label="Working now">
      <div className="live-bar-inner">
        {sorted.map((p) => (
          <LiveRow key={p.task_id} p={p} task={taskOf?.(p.task_id)} steps={stepsOf?.(p.task_id)} label={labelOf?.(p.agent_id)} log={log} />
        ))}
      </div>
    </section>
  );
}

function LiveRow({ p, task, steps, label, log }: { p: Progress; task?: Task; steps?: Step[]; label?: string | null; log: boolean }) {
  const { everyone } = useStore();
  const a = everyone.find((x) => x.id === p.agent_id);
  const [open, setOpen] = useState(false);
  const [noting, setNoting] = useState(false);
  const stalled = p.state === "stalled";
  const since = p.step?.started_at ?? p.last_step_at;
  const what = stalled ? `Possibly stuck: ${lowerFirst(p.activity)} for ${minutes(since)}` : p.activity;

  // Steps for the log: from the loaded conversation, or fetched (e.g. a task a group member started).
  const [fetched, setFetched] = useState<Step[] | null>(null);
  const need = log && open && !steps?.length;
  useEffect(() => {
    if (!need) return;
    api.task(p.task_id).then((r) => setFetched(r.steps)).catch(() => {});
  }, [need, p.task_id, p.last_step_at, p.activity]);
  const fallback: Task = task ?? {
    id: p.task_id, agent_id: p.agent_id, thread_id: "", source: "user", title: null, from_agent_id: null, parent_task_id: null,
    depth: 0, status: "running", error: null, created_at: p.started_at, started_at: p.started_at, finished_at: null,
  };

  const Main = log ? "button" : "div";
  return (
    <div className={`live-row${stalled ? " stalled" : ""}`}>
      <Main className="live-main" {...(log ? { "aria-expanded": open, onClick: () => setOpen(!open), title: open ? "Hide the work log" : "Show the work log" } : {})}>
        <Avatar name={a?.name ?? "?"} color={a?.color ?? "var(--muted)"} size={20} />
        <span className="live-who">{a?.name ?? "Agent"}{label && <span className="live-task"> · {label}</span>}</span>
        <span className="live-what" title={p.step ? `${p.step.name}: ${p.step.summary}` : undefined}>
          {stalled && <Icon name="pause" size={12} />}
          {what}
          {!stalled && <span className="live-since"> · {duration(since)}</span>}
        </span>
        <span className="live-time" title={`Working for ${duration(p.started_at)} in total`}>
          {!stalled && <Spinner />}{duration(p.started_at)}
        </span>
        {log ? <span className={`chev${open ? " open" : ""}`}><Icon name="chevron" size={10} /></span> : <span />}
      </Main>
      {p.summary && <p className="live-summary">{p.summary}</p>}
      {stalled && !noting && (
        <div className="live-actions">
          <button className="btn sm danger" onClick={() => api.stop(p.task_id).catch(() => {})}><Icon name="stop" size={12} />Stop</button>
          <button className="btn sm" onClick={() => setNoting(true)}><Icon name="send" size={12} />Send a note</button>
        </div>
      )}
      {noting && <NoteForm p={p} task={task} onClose={() => setNoting(false)} />}
      {log && open && <div className="live-log"><WorkLog task={fallback} steps={steps?.length ? steps : fetched ?? []} /></div>}
    </div>
  );
}

/**
 * A note to a working agent, in that task's own conversation: its task's thread, or the group
 * (addressed with an @mention). It's read on the agent's next turn; "Stop and send" ends the
 * current one first.
 */
function NoteForm({ p, task, onClose }: { p: Progress; task?: Task; onClose: () => void }) {
  const { everyone, groups } = useStore();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const a = everyone.find((x) => x.id === p.agent_id);
  const group = groups.find((g) => g.id === (task?.thread_id || p.group_id));
  const inGroup = !!group && (task ? task.thread_id === group.id : true);
  const role = everyone.find((x) => x.id === a?.base_agent_id);
  const threadId = inGroup ? group!.id : a?.dm_thread_id;

  const send = async (stopFirst: boolean) => {
    const v = text.trim();
    if (!v || !threadId || busy) return;
    setBusy(true); setError(null);
    try {
      if (stopFirst) await api.stop(p.task_id);
      await api.send(threadId, inGroup && role ? `@${role.slug} ${v}` : v);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="live-note" data-esc-owner="">
      <textarea ref={ref} className="text" rows={2} value={text} placeholder={`Note for ${a?.name ?? "the agent"}, e.g. "The pending checks are stuck; rerun them or skip"`}
        aria-label={`Note for ${a?.name ?? "the agent"}`} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(false); }
        }} />
      <div className="live-note-actions">
        <span className="hint">
          {error ? <span style={{ color: "var(--bad)" }}>{error}</span>
            : !threadId ? "This task has no conversation to post to."
            : `Goes to ${inGroup ? `#${group!.name} for ` : ""}${a?.name ?? "the agent"}, read after its current turn.`}
        </span>
        <button className="btn sm ghost" onClick={onClose}>Cancel</button>
        <button className="btn sm" disabled={!text.trim() || !threadId || busy} onClick={() => send(true)} title="Stop the current turn, then send">Stop and send</button>
        <button className="btn sm primary" disabled={!text.trim() || !threadId || busy} onClick={() => send(false)}>Send</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Needs you

/** Opening a room, group or task marks its "needs you" items seen (while the page is visible). */
export function useSeenRoom(roomId: string | null | undefined) {
  const { attention } = useStore();
  const unseen = !!roomId && attention.some((i) => i.room_id === roomId && !i.seen_at);
  useEffect(() => {
    if (!roomId || !unseen) return;
    const mark = () => { if (document.visibilityState === "visible") api.attentionSeenRoom(roomId).catch(() => {}); };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [roomId, unseen]);
}

export type Mark = "bad" | "warn" | "info";
const RANK: Record<Mark, number> = { info: 1, warn: 2, bad: 3 };
const markOf = (kind: Attention["kind"]): Mark => (kind === "failed" ? "bad" : kind === "stalled" ? "warn" : "info");

/** Per room (task-room root or group id): the most serious thing that needs the owner. */
export function useRoomMarks() {
  const { attention, progress } = useStore();
  const marks = new Map<string, { mark: Mark; title: string }>();
  const add = (room: string | null, mark: Mark, title: string) => {
    if (!room) return;
    const cur = marks.get(room);
    if (!cur || RANK[mark] > RANK[cur.mark]) marks.set(room, { mark, title });
  };
  for (const i of attention) if (!i.seen_at) add(i.room_id, markOf(i.kind), i.title);
  // A stall stays marked while it lasts, even once seen.
  for (const p of Object.values(progress)) if (p.state === "stalled") add(p.root_id, "warn", `Possibly stuck: ${lowerFirst(p.activity)}`);
  return marks;
}

export function MarkDot({ mark, title }: { mark: Mark; title: string }) {
  const label = mark === "info" ? "Unread" : "Needs you";
  return <span className={`attn-dot ${mark}`} title={`${label}: ${title}`} aria-label={label} role="img" />;
}

const KIND_LABEL: Record<Attention["kind"], string> = { reply: "Replied", failed: "Failed", stalled: "Possibly stuck", question: "Asks you" };

/** What actually needs the owner: everything but plain replies (those are just unread). */
export const needsOwner = (i: Attention) => !i.seen_at && i.kind !== "reply";

/** The Overview's "Needs you": unseen asks, failures and stalls, newest first; then unread replies, quieter. */
export function NeedsYou() {
  const { attention, groups, work } = useStore();
  const unseen = attention.filter(needsOwner);
  const unread = attention.filter((i) => !i.seen_at && i.kind === "reply");
  if (!unseen.length && !unread.length) return null;
  const hrefOf = (i: Attention) => {
    if (i.room_id && groups.some((g) => g.id === i.room_id)) return `#/groups/${i.room_id}`;
    const room = i.room_id ? [...work.live, ...work.done].find((w) => w.root.id === i.room_id) : undefined;
    if (room && room.members.length > 1) return `#/work/${room.root.id}`;
    return `#/agents/${i.room_id ?? i.agent_id}`;
  };
  const shown = unseen.slice(0, 12);
  return (
    <>
      {unseen.length > 0 && <>
      <div className="section-head">
        <h2>Needs you <span className="count">{unseen.length}</span></h2>
        <button className="btn sm ghost" onClick={() => api.attentionSeenAll().catch(() => {})}>Mark all seen</button>
      </div>
      <div className="rows needs-you">
        {shown.map((i) => (
          <div key={i.id} className="row attn-row">
            <span className={`attn-dot ${markOf(i.kind)}`} aria-hidden="true" />
            <a className="attn-main" href={hrefOf(i)} onClick={() => api.attentionSeen(i.id).catch(() => {})}>
              <span className="attn-title">{i.title}</span>
              <span className="hint">{KIND_LABEL[i.kind]} · {relTime(i.created_at)}</span>
            </a>
            <button className="icon-btn" aria-label={`Mark seen: ${i.title}`} title="Mark seen" onClick={() => api.attentionSeen(i.id).catch(() => {})}>
              <Icon name="check" size={14} />
            </button>
          </div>
        ))}
      </div>
      {unseen.length > shown.length && <p className="hint" style={{ marginTop: 6 }}>And {unseen.length - shown.length} more.</p>}
      </>}
      {unread.length > 0 && (
        <details className="unread-replies" style={{ marginTop: unseen.length ? 12 : 0 }}>
          <summary className="hint">{unread.length} unread repl{unread.length > 1 ? "ies" : "y"} · nothing waits on you</summary>
          <div className="rows">
            {unread.slice(0, 20).map((i) => (
              <div key={i.id} className="row attn-row">
                <span className="attn-dot info" aria-hidden="true" />
                <a className="attn-main" href={hrefOf(i)} onClick={() => api.attentionSeen(i.id).catch(() => {})}>
                  <span className="attn-title">{i.title}</span>
                  <span className="hint">{relTime(i.created_at)}</span>
                </a>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
