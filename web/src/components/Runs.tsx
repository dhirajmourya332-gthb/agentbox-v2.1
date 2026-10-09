import { useEffect, useState } from "react";
import { api, type Progress, type RoutineRun, type RunStatus } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, duration } from "./ui.tsx";

/**
 * Routine runs (CONTRACTS-v2 § G): what's running now and the run history, for the Routines page
 * and the sidebar. Live through store events; no polling.
 */

/** Re-render every `ms` while `on`. */
export function useTick(on: boolean, ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [on, ms]);
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 d ago", then a date. */
export function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A duration in seconds as "45s", "12m", "1h 5m". */
export function secs(s: number | null) {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const WORD: Record<RunStatus, string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped", skipped: "Skipped" };
export function RunBadge({ status }: { status: RunStatus }) {
  return <span className={`run-badge ${status}`}>{status === "running" && <span className="run-pulse" aria-hidden="true" />}{WORD[status]}</span>;
}

/** The live progress records of a run's agents, oldest first. */
export function useRunProgress(runId: string): Progress[] {
  const { progress } = useStore();
  return Object.values(progress).filter((p) => p.run_id === runId).sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** One line for what a run is doing now: "tech-lead#3: Waiting on CI for PR #4984". */
export function useRunActivity(run: RoutineRun) {
  const { everyone } = useStore();
  const items = useRunProgress(run.id);
  const latest = [...items].sort((a, b) => b.last_step_at.localeCompare(a.last_step_at))[0];
  if (latest) {
    const who = everyone.find((a) => a.id === latest.agent_id)?.name ?? "An agent";
    return { text: `${who}: ${latest.state === "stalled" ? `possibly stuck (${latest.activity})` : latest.activity}`, stalled: latest.state === "stalled" };
  }
  const queued = run.members.find((m) => m.status === "queued");
  return { text: queued ? `${queued.name}: up next` : "Starting…", stalled: false };
}

const runHref = (r: RoutineRun) => `#/routines/${r.routine_id}/runs/${r.id}`;

// ---------------------------------------------------------------------------------------------

/** Routines page, top: one card per active run. Hidden when nothing is running. */
export function RunningNow() {
  const { activeRuns } = useStore();
  useTick(activeRuns.length > 0);
  if (!activeRuns.length) return null;
  return (
    <section aria-label="Running now">
      <div className="section-head"><h2>Running now <span className="count">{activeRuns.length}</span></h2></div>
      <div className="run-cards">
        {activeRuns.map((r) => <RunCard key={r.id} run={r} />)}
      </div>
    </section>
  );
}

function RunCard({ run }: { run: RoutineRun }) {
  const { everyone } = useStore();
  const act = useRunActivity(run);
  const working = run.members.filter((m) => m.status === "working" || m.status === "queued");
  const shown = working.length ? working : run.members;
  return (
    <div className="card run-card">
      <div className="run-card-head">
        <span className="run-pulse" aria-hidden="true" />
        <strong className="run-card-name">{run.routine_name}</strong>
        <span className="hint" title={`Started ${new Date(run.started_at).toLocaleString()}`}>{duration(run.started_at)}</span>
      </div>
      <div className="run-who">
        {shown.map((m) => {
          const a = everyone.find((x) => x.id === m.id);
          return (
            <span key={m.id} className="run-member" title={`${m.name}${m.label ? ` · ${m.label}` : ""} · ${m.status}`}>
              <Avatar name={m.name} color={a?.color ?? "var(--muted)"} size={18} />{m.name}
            </span>
          );
        })}
      </div>
      <p className={`run-activity${act.stalled ? " stalled" : ""}`} title={act.text}>{act.text}</p>
      <div className="run-card-foot">
        <span className="hint">{run.trigger === "manual" ? "Run now" : "Scheduled"} · {run.tasks} task{run.tasks === 1 ? "" : "s"}</span>
        <a className="btn sm" href={runHref(run)}>Open</a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const PAGE = 30;

/** Routines page, bottom: finished runs (the archive), newest first, with a routine filter. */
export function RunHistory() {
  const { routines, onEvent } = useStore();
  const [routineId, setRoutineId] = useState("");
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRuns(null); setError(null);
    api.routineRuns({ state: "archive", routine_id: routineId || undefined, limit: PAGE })
      .then((r) => { if (alive) { setRuns(r.runs); setMore(r.runs.length === PAGE); } })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [routineId]);

  // A run that finishes (or is skipped) joins the top; one that's reopened leaves.
  useEffect(() => onEvent((e) => {
    if (e.type !== "routine-run.updated") return;
    const r = e.run as RoutineRun;
    if (routineId && r.routine_id !== routineId) return;
    setRuns((list) => {
      if (!list) return list;
      const rest = list.filter((x) => x.id !== r.id);
      if (r.status === "running") return rest;
      return [...rest, r].sort((a, b) => b.started_at.localeCompare(a.started_at));
    });
  }), [routineId, onEvent]);

  const loadMore = async () => {
    if (!runs?.length) return;
    setBusy(true);
    try {
      const r = await api.routineRuns({ state: "archive", routine_id: routineId || undefined, before: runs[runs.length - 1].started_at, limit: PAGE });
      setRuns([...runs, ...r.runs.filter((x) => !runs.some((y) => y.id === x.id))]);
      setMore(r.runs.length === PAGE);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Run history">
      <div className="section-head">
        <h2>Run history</h2>
        <select className="text run-filter" value={routineId} aria-label="Show runs of" onChange={(e) => setRoutineId(e.target.value)}>
          <option value="">All routines</option>
          {routines.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!runs ? <p className="hint">Loading…</p> : runs.length === 0 ? <p className="hint">No finished runs yet.</p> : (
        <div className="rows">
          {runs.map((r) => <HistoryRow key={r.id} run={r} showRoutine={!routineId} />)}
        </div>
      )}
      {more && (
        <div style={{ marginTop: 10, textAlign: "center" }}>
          <button className="btn sm" disabled={busy} onClick={loadMore}>{busy ? "Loading…" : "Load more"}</button>
        </div>
      )}
    </section>
  );
}

function HistoryRow({ run, showRoutine }: { run: RoutineRun; showRoutine: boolean }) {
  const skipped = run.status === "skipped";
  const line = skipped ? run.reason : run.summary;
  return (
    <div className={`row run-row${skipped ? " skipped" : ""}`}>
      <RunBadge status={run.status} />
      <span className="run-row-main">
        <span className="run-row-top">
          {showRoutine && <strong>{run.routine_name}</strong>}
          <span className="hint" title={new Date(run.started_at).toLocaleString()}>{ago(run.started_at)}</span>
          {!skipped && <span className="hint">· {secs(run.duration_s)}</span>}
          {run.trigger === "manual" && <span className="hint">· run now</span>}
        </span>
        {line && <span className="run-row-summary" title={line}>{line}</span>}
      </span>
      {!skipped && <a className="btn sm ghost" href={runHref(run)}>Open</a>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** Sidebar → Work: a compact group of the routines running now (hidden when none). */
export function RailRuns({ currentRunId }: { currentRunId?: string }) {
  const { activeRuns } = useStore();
  if (!activeRuns.length) return null;
  return (
    <>
      <p className="rail-group">Routines running</p>
      {activeRuns.map((r) => <RailRun key={r.id} run={r} current={r.id === currentRunId} />)}
    </>
  );
}

function RailRun({ run, current }: { run: RoutineRun; current: boolean }) {
  const act = useRunActivity(run);
  return (
    <div className="work-row">
      <span className="tiny-spacer" />
      <a className="item work-link" href={runHref(run)} aria-current={current ? "page" : undefined} title={`${run.routine_name} · ${act.text}`}>
        <span className={`run-pulse${act.stalled ? " warn" : ""}`} aria-hidden="true" />
        <span className="grow">{run.routine_name}</span>
        <Icon name="routine" size={12} />
      </a>
    </div>
  );
}
