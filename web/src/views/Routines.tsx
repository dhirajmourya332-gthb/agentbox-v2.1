import { useEffect, useMemo, useState } from "react";
import { api, type Routine, type RoutineInput, type RoutineRun } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Avatar, Icon, relTime } from "../components/ui.tsx";

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 2 hours", cron: "0 */2 * * *" },
  { label: "Every 4 hours", cron: "0 */4 * * *" },
  { label: "Weekdays 09:30", cron: "30 9 * * 1-5" },
  { label: "Every day 18:00", cron: "0 18 * * *" },
  { label: "Mondays 10:00", cron: "0 10 * * 1" },
];

function fmt(iso: string, tz: string) {
  return new Date(iso).toLocaleString([], { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function untilText(iso?: string) {
  if (!iso) return "—";
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (m < 1) return "in under a minute";
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `in ${h} h ${m % 60} min` : `in ${Math.floor(h / 24)} d ${h % 24} h`;
}

function RunState({ run }: { run: RoutineRun | null }) {
  if (!run) return <span className="hint">Never run</span>;
  if (run.outcome === "skipped") return <span className="status"><span className="dot warn" />Skipped · {relTime(run.at)}</span>;
  const s = run.task_status;
  const tone = s === "done" ? "ok" : s === "running" || s === "queued" ? "" : "bad";
  const word = s === "done" ? "Done" : s === "running" ? "Running" : s === "queued" ? "Queued" : s === "stopped" ? "Stopped" : "Failed";
  return <span className="status"><span className={`dot ${tone}`} />{word} · {relTime(run.at)}</span>;
}

// ---------------------------------------------------------------------------

export function RoutinesList() {
  const { routines, agents, loaded } = useStore();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  if (!loaded) return <div className="page" />;
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1000 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h1>Routines</h1>
            <p className="lede">
              Jobs agents run on a schedule, like reviewing open PRs every 2 hours. Each run starts fresh; agents keep notes between runs in their memory.
            </p>
          </div>
          <a className="btn primary" href="#/routines/new"><Icon name="plus" />New routine</a>
        </div>
        {routines.length === 0 ? (
          <div className="group-intro">
            <p>No routines yet.</p>
            <p className="hint">Create one here, or ask an agent ("check open PRs every 2 hours") and it can schedule it itself.</p>
          </div>
        ) : (
          <div className="rows">
            {routines.map((r) => {
              const a = agents.find((x) => x.id === r.agent_id);
              return (
                <div key={r.id} className="row routine-row">
                  <a className="routine-main" href={`#/routines/${r.id}`}>
                    {a && <Avatar name={a.name} color={a.color} size={24} />}
                    <span className="routine-text">
                      <strong>{r.name}</strong>
                      <span className="hint">{a?.name ?? "deleted"} · {r.describe}{r.describe !== r.cron && <> · <span className="mono">{r.cron}</span></>}</span>
                    </span>
                  </a>
                  <span className="routine-next">
                    {r.enabled ? <>Next {untilText(r.next_runs[0])}</> : <span className="hint">Paused</span>}
                    <RunState run={r.last_run} />
                  </span>
                  <label className="switch" title={r.enabled ? "Pause" : "Resume"}>
                    <input type="checkbox" checked={r.enabled} aria-label={`${r.name} enabled`}
                      onChange={(e) => api.updateRoutine(r.id, { ...r, enabled: e.target.checked })} />
                    <span />
                  </label>
                  <button className="btn sm" onClick={() => api.runRoutine(r.id)}>Run now</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RoutineEditor({ id, agentId }: { id?: string; agentId?: string }) {
  const { agents, routines } = useStore();
  const existing = id ? routines.find((r) => r.id === id) : undefined;
  const [form, setForm] = useState<RoutineInput>(() => ({
    agent_id: existing?.agent_id ?? agentId ?? agents.find((a) => !a.base_agent_id)?.id ?? "",
    name: existing?.name ?? "",
    cron: existing?.cron ?? "0 */2 * * *",
    timezone: existing?.timezone ?? BROWSER_TZ,
    prompt: existing?.prompt ?? "",
    enabled: existing?.enabled ?? true,
  }));
  const [preview, setPreview] = useState<{ next_runs: string[]; describe: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (existing) setForm({ agent_id: existing.agent_id, name: existing.name, cron: existing.cron, timezone: existing.timezone, prompt: existing.prompt, enabled: existing.enabled });
  }, [existing?.id]);
  useEffect(() => {
    if (!id) return;
    api.routine(id).then((r) => setRuns(r.runs)).catch(() => {});
  }, [id, existing?.last_run?.id, existing?.last_run?.task_status]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.previewCron(form.cron, form.timezone)
        .then((p) => { setPreview(p); setPreviewError(null); })
        .catch((e) => { setPreview(null); setPreviewError(e.message); });
    }, 300);
    return () => clearTimeout(t);
  }, [form.cron, form.timezone]);

  // Browsers list canonical names (e.g. Asia/Calcutta); keep the routine's and the browser's own
  // zone names in the list so the select shows what's actually saved.
  const zones = useMemo(() => {
    let list: string[] = [];
    try { list = (Intl as any).supportedValuesOf("timeZone") as string[]; } catch { /* old browser */ }
    return [...new Set([form.timezone, BROWSER_TZ, "UTC", ...list])].filter(Boolean).sort();
  }, [form.timezone]);
  const agent = agents.find((a) => a.id === form.agent_id);

  async function save() {
    setError(null);
    try {
      if (existing) {
        await api.updateRoutine(existing.id, form);
        setNote("Saved");
        setTimeout(() => setNote(null), 2000);
      } else {
        const r = await api.createRoutine(form);
        go({ name: "routine", id: r.id });
      }
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function runNow() {
    if (!existing) return;
    const r = await api.runRoutine(existing.id);
    setNote(r.started ? "Started — it's on the task board" : `Skipped: ${r.routine.last_run?.reason ?? "see history"}`);
    setTimeout(() => setNote(null), 4000);
  }

  if (id && !existing) return <div className="page"><div className="page-inner"><p className="lede">No such routine.</p></div></div>;
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <a className="btn ghost sm" href="#/routines" style={{ marginLeft: -10 }}><Icon name="back" />Routines</a>
          <h1 style={{ marginTop: 8 }}>{existing ? existing.name : "New routine"}</h1>
          {existing && existing.created_by !== "owner" && (
            <p className="hint">Created by {agents.find((a) => a.id === existing.created_by)?.name ?? "an agent"}.</p>
          )}
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}

        <div className="draft-grid">
          <div className="field">
            <label htmlFor="r-agent">Agent</label>
            <select id="r-agent" className="text" value={form.agent_id} disabled={!!existing}
              onChange={(e) => setForm({ ...form, agent_id: e.target.value })}>
              {agents.filter((a) => !a.base_agent_id || a.id === form.agent_id).map((a) => <option key={a.id} value={a.id}>{a.name} — {a.title}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-name">Name</label>
            <input id="r-name" className="text" value={form.name} placeholder="PR review" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
        </div>

        <div className="field">
          <span style={{ fontWeight: 500 }}>Schedule</span>
          <div className="choices">
            {PRESETS.map((p) => (
              <button key={p.cron} className="pill" aria-pressed={form.cron === p.cron} onClick={() => setForm({ ...form, cron: p.cron })}>{p.label}</button>
            ))}
          </div>
          <div className="draft-grid">
            <div className="field">
              <label htmlFor="r-cron" className="hint">Cron expression</label>
              <input id="r-cron" className="text mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="r-tz" className="hint">Timezone</label>
              <select id="r-tz" className="text" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </div>
          </div>
          {previewError ? (
            <span className="hint" style={{ color: "var(--bad)" }}>{previewError}</span>
          ) : preview && (
            <div className="cron-preview">
              <strong>{preview.describe}</strong>
              <span className="hint">Next: {preview.next_runs.map((n) => fmt(n, form.timezone)).join(" · ")}</span>
            </div>
          )}
          <span className="hint">Minute hour day-of-month month day-of-week. Runs must be at least 15 minutes apart.</span>
        </div>

        <div className="field">
          <label htmlFor="r-prompt">What {agent?.name ?? "the agent"} does each run</label>
          <textarea id="r-prompt" className="text" rows={7} value={form.prompt}
            placeholder={"Review open PRs in Brandsek/digital_risk that you haven't reviewed at their latest commit, using the review-pr skill. Skip drafts. Post a short summary of what you reviewed in Teams only if something is blocking."}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <span className="hint">Write it as a standalone instruction: each run starts a fresh conversation. The agent's job description and skills still apply.</span>
        </div>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Enabled
        </label>

        <div className="wizard-nav">
          {existing && (confirmDelete ? (
            <>
              <button className="btn danger" onClick={async () => {
                try { await api.deleteRoutine(existing.id); go({ name: "routines" }); } catch (e: any) { setError(e.message); }
              }}>Delete routine</button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn ghost danger" onClick={() => setConfirmDelete(true)}>Delete…</button>
          ))}
          <span className="grow" />
          {note && <span className="hint" role="status">{note}</span>}
          {existing && <button className="btn" onClick={runNow}>Run now</button>}
          <button className="btn primary" onClick={save}>{existing ? "Save" : "Create routine"}</button>
        </div>

        {existing && (
          <div className="field">
            <span style={{ fontWeight: 500 }}>Recent runs</span>
            {runs.length === 0 ? <span className="hint">No runs yet.</span> : (
              <div className="rows">
                {runs.map((r) => (
                  <div key={r.id} className="row" style={{ fontSize: 13 }}>
                    <RunState run={r} />
                    <span className="hint">{r.trigger === "manual" ? "Run now" : "Scheduled"}</span>
                    <span className="hint" style={{ flex: 1, minWidth: 0 }}>{r.reason ?? r.task_error ?? ""}</span>
                    {r.task_id && <a href={`#/tasks/${r.task_id}`}>details</a>}
                  </div>
                ))}
              </div>
            )}
            <a href={`#/agents/${existing.agent_id}/threads/${existing.thread_id}`} style={{ fontSize: 13 }}>Open the routine's conversation</a>
          </div>
        )}
      </div>
    </div>
  );
}
