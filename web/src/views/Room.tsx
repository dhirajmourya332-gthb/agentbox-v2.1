import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type DocumentInfo, type InstanceSummary, type Message, type RoomView, type Step, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, Markdown, Spinner, StatusGlyph, relTime, useEscToStop } from "../components/ui.tsx";
import { WorkLog } from "./AgentChat.tsx";
import { DocumentReader } from "./Documents.tsx";

/**
 * A task room: a task and every task it started, as one timeline. Each entry says which task it
 * belongs to; chips filter by task. The composer talks to the room's lead task.
 */
export function Room({ id }: { id: string }) {
  const { threads, live, loadThread, work, everyone } = useStore();
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [showFilter, setShowFilter] = useState(() => { try { return localStorage.getItem("room.filters") !== "closed"; } catch { return true; } });
  const toggleFilter = () => {
    const next = !showFilter;
    setShowFilter(next);
    try { localStorage.setItem("room.filters", next ? "open" : "closed"); } catch { /* fine without it */ }
  };
  const [panel, setPanel] = useState(true);

  // Membership comes from the server; refetch when the work list changes (tasks started/finished).
  const signature = JSON.stringify([...work.live, ...work.done].find((w) => w.root.id === id)?.members.map((m) => [m.id, m.status]) ?? []);
  useEffect(() => {
    api.room(id).then((v) => { setView(v); setError(null); v.threads.forEach((t) => loadThread(t.id).catch(() => {})); })
      .catch((e) => setError(e.message));
  }, [id, signature]);

  const members = view?.members ?? [];
  const byThread = useMemo(() => new Map((view?.threads ?? []).map((t) => [t.id, t.agent_id])), [view]);
  const member = (instanceId: string | undefined) => members.find((m) => m.id === instanceId);

  // Live data for every thread in the room, merged by time.
  const merged = useMemo(() => {
    const msgs: Message[] = []; const tasks: Task[] = []; const steps: Step[] = [];
    for (const t of view?.threads ?? []) {
      const d = threads[t.id];
      if (!d) continue;
      msgs.push(...d.messages); tasks.push(...d.tasks); steps.push(...d.steps);
    }
    msgs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { msgs, tasks, steps };
  }, [view, threads]);
  const taskById = useMemo(() => new Map(merged.tasks.map((t) => [t.id, t])), [merged]);
  const running = merged.tasks.filter((t) => t.status === "running");
  useEscToStop(running.length > 0, () => running.forEach((t) => api.stop(t.id)));

  if (error) return <div className="page"><div className="page-inner"><div className="error-box">{error}</div></div></div>;
  if (!view) return <div className="page" />;
  const root = view.root;
  const done = !!root.retired_at;
  const rootThread = view.threads.find((t) => t.agent_id === root.id && t.kind === "dm")?.id;
  const replied = new Set(merged.msgs.map((m) => m.task_id).filter(Boolean));
  const pending = merged.tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));
  // An entry belongs to the task whose conversation it's in, and also to the task that wrote it.
  const visible = (...ids: (string | undefined)[]) => !filter || ids.includes(filter);

  return (
    <>
      <section className="chat room" aria-label={`Task room: ${root.label}`}>
        <header className="chat-head">
          <span className="room-mark" aria-hidden="true"><Icon name="room" size={18} /></span>
          <div className="who" style={{ minWidth: 0 }}>
            <strong>{root.label ?? root.name}</strong>
            <span>Task room · {members.length} task{members.length === 1 ? "" : "s"} · led by {root.name}</span>
          </div>
          <div className="actions">
            {running.length > 0 && (
              <button className="btn sm danger" onClick={() => running.forEach((t) => api.stop(t.id))} title="Stop everything running here (Esc)">
                <Icon name="stop" size={14} />Stop
              </button>
            )}
            <RoomLifecycle root={root} />
            <button className="icon-btn" aria-pressed={panel} aria-label="Room details" onClick={() => setPanel(!panel)}><Icon name="panel" /></button>
          </div>
        </header>

        <nav className={`room-filter${showFilter ? "" : " collapsed"}`} aria-label="Show">
          <button className="room-filter-toggle" aria-expanded={showFilter} onClick={toggleFilter}
            title={showFilter ? "Hide the task filter" : "Show the task filter"}>
            <span className={`chev${showFilter ? " open" : ""}`}><Icon name="chevron" size={10} /></span>
            Show{!showFilter && <>: <strong>{filter ? (members.find((m) => m.id === filter)?.label ?? "one task") : "all tasks"}</strong></>}
          </button>
          {!showFilter && filter && (
            <button className="link-button" onClick={() => setFilter(null)}>Show all</button>
          )}
          {showFilter && <button className="pill" aria-pressed={!filter} onClick={() => setFilter(null)}>All</button>}
          {showFilter && members.map((m) => (
            <button key={m.id} className="pill" aria-pressed={filter === m.id} onClick={() => setFilter(filter === m.id ? null : m.id)} title={m.name}>
              <span className={`glyph ${m.status === "done" ? "" : m.status}`} />{m.label ?? m.name}
            </button>
          ))}
        </nav>

        <RoomTimeline>
          {merged.msgs.length === 0 && <p className="hint" style={{ textAlign: "center" }}>Nothing here yet.</p>}
          {merged.msgs.map((m) => {
            const inst = member(byThread.get(m.thread_id));
            const from = m.author !== inst?.id ? member(m.author) : undefined;
            if (!visible(inst?.id, from?.id)) return null;
            if (m.author === "system") return <p key={m.id} className="system-note">{inst ? `${inst.label ?? inst.name}: ` : ""}{m.content}</p>;
            const task = m.task_id ? taskById.get(m.task_id) : undefined;
            const isReply = !!task && task.agent_id === m.author;
            const author = m.author === "user" ? null : everyone.find((a) => a.id === m.author);
            return (
              <div key={m.id} className="msg">
                {m.author === "user"
                  ? <span className="avatar you-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">You</span>
                  : <Avatar name={author?.name ?? "?"} color={author?.color ?? "var(--muted)"} size={28} />}
                <div style={{ minWidth: 0 }}>
                  <div className="msg-meta">
                    <strong>{m.author === "user" ? "You" : author?.name ?? (m.author === "routine" ? "Routine" : "agent")}</strong>
                    {from && <><a className="room-tag" href={`#/agents/${from.id}`} title={`Open ${from.label}`}>{from.label ?? from.name}</a><span className="hint">→</span></>}
                    {inst && <a className="room-tag" href={`#/agents/${inst.id}`} title={`Open ${inst.label}`}>{inst.label ?? inst.name}</a>}
                    {!isReply && task?.source === "agent" && <span className="hint">handed off</span>}
                    {!isReply && task?.source === "result" && <span className="hint">reported back</span>}
                    <time dateTime={m.created_at}>{relTime(m.created_at)}</time>
                  </div>
                  {isReply && task && <WorkLog task={task} steps={merged.steps.filter((s) => s.task_id === task.id)} />}
                  <div className={!isReply && task && task.source !== "user" ? "handoff" : undefined}>
                    <Markdown text={m.content} home={author?.home} />
                  </div>
                </div>
              </div>
            );
          })}
          {pending.map((t) => {
            const inst = member(t.agent_id);
            if (!inst || !visible(inst.id)) return null;
            const a = everyone.find((x) => x.id === t.agent_id);
            return (
              <div key={t.id} className="msg">
                <Avatar name={a?.name ?? "?"} color={a?.color ?? "var(--muted)"} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div className="msg-meta">
                    <strong>{a?.name}</strong>
                    <span className="room-tag">{inst.label ?? inst.name}</span>
                    <span className="hint">{t.status === "queued" ? "up next" : "working…"}</span>
                  </div>
                  {t.status === "running" && <WorkLog task={t} steps={merged.steps.filter((s) => s.task_id === t.id)} />}
                  {t.status === "running" && (live[t.id] ? <Markdown text={live[t.id]} streaming home={a?.home} /> : <p className="msg-note"><Spinner />Thinking…</p>)}
                </div>
              </div>
            );
          })}
        </RoomTimeline>

        {!done && rootThread && <RoomComposer threadId={rootThread} lead={root} />}
        {done && <p className="composer-hint" style={{ padding: "12px 24px 20px", margin: 0, maxWidth: "none", textAlign: "center" }}>This task room is done; its history stays readable.</p>}
      </section>
      {panel && <RoomPanel id={id} members={members} workspace={view.workspace} onClose={() => setPanel(false)} />}
    </>
  );
}

function RoomTimeline({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div className="timeline" ref={ref} aria-live="polite" aria-relevant="additions"
      onScroll={() => { const el = ref.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="timeline-inner">{children}</div>
    </div>
  );
}

function RoomComposer({ threadId, lead }: { threadId: string; lead: InstanceSummary }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const send = async () => {
    const v = text.trim();
    if (!v) return;
    setText(""); setError(null);
    try { await api.send(threadId, v); } catch (e: any) { setError(e.message); setText(v); }
  };
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea ref={ref} rows={1} value={text} placeholder={`Message the room's lead (${lead.name})…`} aria-label="Message the room's lead"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="btn primary sm" style={{ minHeight: 34 }} disabled={!text.trim()} onClick={send} aria-label="Send"><Icon name="send" size={14} /></button>
      </div>
      <p className="composer-hint">{error ? <span style={{ color: "var(--bad)" }}>{error}</span> : <>Goes to {lead.name} ({lead.label}), who coordinates the room · ⏎ send · Esc stops</>}</p>
    </div>
  );
}

/** Done (finish the whole room) while live; "hidden in 24 h — Keep" once done. */
function RoomLifecycle({ root }: { root: InstanceSummary }) {
  const { work } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (root.retired_at) {
    const hides = work.done.find((w) => w.root.id === root.id)?.hides_at;
    return (
      <span className="hint" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        {root.kept ? "Kept" : hides ? `Hidden from Work ${relTime(hides)}` : "Done"}
        <button className="btn sm" onClick={() => api.setTaskMeta(root.id, { kept: !root.kept })}>{root.kept ? "Stop keeping" : "Keep"}</button>
      </span>
    );
  }
  return (
    <div className="popover-anchor">
      <button className="btn sm" onClick={() => { setError(null); setConfirm(!confirm); }}><Icon name="check" size={14} />Done</button>
      {confirm && (
        <div className="popover" role="dialog" aria-label="Finish task room">
          <strong>Mark the whole room done?</strong>
          <p className="hint">Finishes {root.label} and every task in it. They leave Work after 24 hours unless you keep them; history stays.</p>
          {error && <div className="error-box">{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm primary" onClick={async () => { try { await api.finishTask(root.id); setConfirm(false); } catch (e: any) { setError(e.message); } }}>Mark done</button>
            <button className="btn sm ghost" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoomPanel({ id, members, workspace, onClose }: { id: string; members: InstanceSummary[]; workspace: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<"tasks" | "documents">("tasks");
  return (
    <aside className="panel" aria-label="Room details">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</button>
        <button role="tab" aria-selected={tab === "documents"} onClick={() => setTab("documents")}>Documents</button>
        <button className="icon-btn" style={{ marginLeft: "auto", alignSelf: "center" }} aria-label="Close details" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === "tasks" && workspace && (
          <p className="hint" style={{ margin: 0 }}>Shared folder: <span className="mono">{workspace}</span><br />State, scripts and notes for this work (also in Documents).</p>
        )}
        {tab === "tasks" && (
          <div className="rows">
            {members.map((m) => (
              <a key={m.id} className="row task-line" href={`#/agents/${m.id}`} style={{ paddingLeft: m.parent_instance_id ? 24 : 14 }}>
                {m.status === "done" ? <span className="status"><span className="glyph" style={{ borderColor: "var(--ok)", background: "var(--ok)" }} /></span> : <StatusGlyph status={m.status} />}
                <span className="task-line-main">
                  <span>{m.label ?? m.name}</span>
                  <span className="hint">{m.name}{m.current ? ` · ${m.current}` : m.status === "done" ? " · done" : ""}</span>
                </span>
              </a>
            ))}
          </div>
        )}
        {tab === "documents" && <WorkDocuments load={() => api.roomDocuments(id)} empty="No documents from this room yet." />}
      </div>
    </aside>
  );
}

/** Documents produced by a piece of work (room or group), newest first, with who wrote each. */
export function WorkDocuments({ load, empty }: { load: () => Promise<(DocumentInfo & { author: string | null })[]>; empty: string }) {
  const { everyone } = useStore();
  const [docs, setDocs] = useState<(DocumentInfo & { author: string | null })[] | null>(null);
  const [open, setOpen] = useState<DocumentInfo | null>(null);
  useEffect(() => {
    const go = () => load().then(setDocs).catch(() => setDocs([]));
    go();
    const t = setInterval(go, 15000);
    return () => clearInterval(t);
  }, []);
  if (!docs) return <p className="hint">Loading…</p>;
  if (!docs.length) return <p className="hint">{empty}</p>;
  return (
    <>
      <ul className="doc-list">
        {docs.map((d) => {
          const who = everyone.find((a) => a.id === d.author);
          return (
            <li key={d.path}>
              <button className="doc-row" onClick={() => setOpen(d)} title={d.path}>
                <span className="doc-badge">{d.name.split(".").pop()?.slice(0, 4)}</span>
                <span className="doc-text">
                  <span className="doc-name">{d.name}</span>
                  <span className="hint">{who ? `${who.name} · ` : ""}{relTime(d.modified)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && <DocumentReader doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}
