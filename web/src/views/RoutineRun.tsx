import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Message, type RunDetail, type Step, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, StatusGlyph, useEscToStop } from "../components/ui.tsx";
import { LiveBar } from "../components/Live.tsx";
import { RunBadge, secs, useRunProgress, useTick } from "../components/Runs.tsx";
import { RoomTimeline, TimelineEntries } from "./Room.tsx";

const OPEN = (t: Task) => t.status === "running" || t.status === "queued";
const upsert = <T extends { id: string }>(list: T[], item: T) => {
  const i = list.findIndex((x) => x.id === item.id);
  return i === -1 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x));
};

/**
 * One routine run (CONTRACTS-v2 § G): only what happened in the run's window, across the routine's
 * agent, its lead and anything they started. Live while it runs: messages, tasks and steps from
 * store events; membership and the header from routine-run.updated (which refetches the window).
 */
export function RoutineRunPage({ routineId, runId }: { routineId: string; runId: string }) {
  const { onEvent, routines } = useStore();
  const [view, setView] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState(true);
  const [stopping, setStopping] = useState(false);
  const viewRef = useRef<RunDetail | null>(null);
  viewRef.current = view;

  const load = useMemo(() => () => api.routineRun(runId).then((v) => { setView(v); setError(null); }).catch((e) => setError(e.message)), [runId]);
  useEffect(() => { load(); }, [load]);

  // Live: incremental for messages, tasks and steps; a debounced refetch when the run changes shape.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetch = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
    const off = onEvent((e) => {
      const v = viewRef.current;
      if (!v) return;
      if (e.type === "routine-run.updated" && e.run.id === runId) {
        setView((cur) => (cur ? { ...cur, run: e.run } : cur));
        if (e.run.tasks !== v.run.tasks || e.run.members.length !== v.run.members.length || e.run.status !== v.run.status) refetch();
        return;
      }
      if (v.run.status !== "running") return;
      const threadIds = new Set(v.threads.map((t) => t.id));
      if (e.type === "message.created" && threadIds.has(e.message.thread_id) && e.message.created_at >= v.run.started_at) {
        setView((cur) => (cur ? { ...cur, messages: upsert<Message>(cur.messages, e.message) } : cur));
      } else if (e.type === "task.updated" && v.tasks.some((t) => t.id === e.task.id)) {
        setView((cur) => (cur ? { ...cur, tasks: upsert<Task>(cur.tasks, e.task) } : cur));
      } else if (e.type === "step.updated" && v.tasks.some((t) => t.id === e.step.task_id)) {
        setView((cur) => (cur ? { ...cur, steps: upsert<Step>(cur.steps, e.step).sort((a, b) => a.seq - b.seq) } : cur));
      }
    });
    return () => { off(); clearTimeout(timer); };
  }, [runId, onEvent, load]);

  const progress = useRunProgress(runId);
  const running = view?.run.status === "running";
  useTick(!!running);
  const openTasks = (view?.tasks ?? []).filter(OPEN);
  const stop = async () => {
    setStopping(true);
    try {
      await Promise.all(openTasks.map((t) => api.stop(t.id).catch(() => {})));
      // A stopped helper reports back to whoever delegated to it; stop what that queued, once.
      setTimeout(async () => {
        try {
          const v = await api.routineRun(runId);
          await Promise.all(v.tasks.filter(OPEN).map((t) => api.stop(t.id).catch(() => {})));
        } finally { setStopping(false); }
      }, 1500);
    } catch { setStopping(false); }
  };
  useEscToStop(!!running && openTasks.length > 0, stop);

  const byThread = useMemo(() => new Map((view?.threads ?? []).map((t) => [t.id, t.agent_id])), [view?.threads]);
  const taskById = useMemo(() => new Map((view?.tasks ?? []).map((t) => [t.id, t])), [view?.tasks]);

  if (error) return <div className="page"><div className="page-inner"><div className="error-box">{error}</div></div></div>;
  if (!view) return <div className="page" />;
  const { run, members } = view;
  const msgs = [...view.messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const replied = new Set(msgs.map((m) => m.task_id).filter(Boolean));
  const pending = view.tasks.filter((t) => OPEN(t) && !replied.has(t.id));
  const when = new Date(run.started_at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const length = running ? `running ${secs(Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000))}` : run.status === "skipped" ? null : secs(run.duration_s);
  const routineExists = routines.some((r) => r.id === routineId);

  return (
    <>
      <section className="chat room run-page" aria-label={`Routine run: ${run.routine_name}`}>
        <header className="chat-head">
          <span className="room-mark" aria-hidden="true"><Icon name="routine" size={18} /></span>
          <div className="who" style={{ minWidth: 0 }}>
            <strong>{routineExists ? <a className="plain-link" href={`#/routines/${routineId}`}>{run.routine_name}</a> : run.routine_name}</strong>
            <span>Run · {when} · {run.trigger === "manual" ? "run now" : "scheduled"}{length ? ` · ${length}` : ""}</span>
          </div>
          <div className="actions">
            <RunBadge status={run.status} />
            {running && openTasks.length > 0 && (
              <button className="btn sm danger" disabled={stopping} onClick={stop} title="Stop everything this run is doing (Esc)">
                <Icon name="stop" size={14} />{stopping ? "Stopping…" : "Stop"}
              </button>
            )}
            <button className="icon-btn" aria-pressed={panel} aria-label="Run details" onClick={() => setPanel(!panel)}><Icon name="panel" /></button>
          </div>
        </header>

        {run.status === "skipped" && <p className="system-note" style={{ padding: "16px 24px" }}>Skipped: {run.reason ?? "no reason given"}</p>}
        <RoomTimeline>
          <TimelineEntries msgs={msgs} pending={pending} steps={view.steps} members={members} byThread={byThread} taskById={taskById}
            empty={run.status === "skipped" ? "Nothing ran." : "Nothing here yet."} />
        </RoomTimeline>

        <LiveBar
          items={progress}
          taskOf={(tid) => taskById.get(tid)}
          stepsOf={(tid) => view.steps.filter((s) => s.task_id === tid)}
          labelOf={members.length > 1 ? (aid) => members.find((m) => m.id === aid)?.label : undefined}
        />
        {!running && run.summary && <p className="composer-hint run-summary-foot">{run.summary}</p>}
      </section>
      {panel && (
        <aside className="panel" aria-label="Run details">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected="true">Who worked</button>
            <button className="icon-btn" style={{ marginLeft: "auto", alignSelf: "center" }} aria-label="Close details" onClick={() => setPanel(false)}><Icon name="close" /></button>
          </div>
          <div className="panel-body" role="tabpanel">
            {members.length === 0 ? <p className="hint">No one worked in this run.</p> : (
              <div className="rows">
                {members.map((m) => {
                  const inRun = run.members.find((x) => x.id === m.id)?.status ?? m.status;
                  const n = view.tasks.filter((t) => t.agent_id === m.id).length;
                  return (
                    <a key={m.id} className="row task-line" href={`#/agents/${m.id}`} style={{ paddingLeft: m.parent_instance_id ? 24 : 14 }}>
                      {inRun === "working" ? <StatusGlyph status="working" />
                        : <span className="status"><span className={`glyph ${inRun === "done" ? "done" : inRun === "failed" ? "error" : ""}`} /></span>}
                      <span className="task-line-main">
                        <span>{m.label ?? m.name}</span>
                        <span className="hint">{m.name} · {n} turn{n === 1 ? "" : "s"} · {inRun}</span>
                      </span>
                    </a>
                  );
                })}
              </div>
            )}
            <dl className="kv run-facts">
              <dt>Started</dt><dd>{new Date(run.started_at).toLocaleString()}</dd>
              {run.finished_at && run.status !== "skipped" && <><dt>Finished</dt><dd>{new Date(run.finished_at).toLocaleString()}</dd></>}
              <dt>Trigger</dt><dd>{run.trigger === "manual" ? "Run now" : "Schedule"}</dd>
            </dl>
            <span className="hint" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {routineExists && <a href={`#/routines/${routineId}`}>Routine settings and recent runs</a>}
              {run.instance_id && <a href={`#/work/${run.instance_id}`}>The routine's whole history (room)</a>}
            </span>
          </div>
        </aside>
      )}
    </>
  );
}
