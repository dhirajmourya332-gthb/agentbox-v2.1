import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, type Approval, type Integration, type IntegrationGate, type IntegrationJob, type IntegrationState, type StepState } from "../api.ts";
import { fmtDuration, heartbeat, runningLabel, waitNotice } from "./progress.ts";
import { useStore } from "../store.tsx";
import { Icon, Markdown, relTime } from "./ui.tsx";
import { TERMINAL_URL } from "./Controls.tsx";
import { InsertCtx } from "./insert.ts";

/**
 * The setup agent's chat pieces (docs/V2-ARCHITECTURE.md §10.4): a steps card per integration being
 * connected (the guide's visuals: ○ ● ⏸ ✔ ✖ ─) with live output, elapsed time and a heartbeat during
 * long runs, "your turn" cards from the CLI's gates with copy buttons, the revoke text after a
 * disconnect, approval cards, and the embedded terminal for logins.
 */

export const STEP_ICON: Record<StepState, string> = { pending: "○", running: "●", human: "⏸", done: "✔", failed: "✖", skipped: "─" };
const STEP_LABEL: Record<StepState, string> = { pending: "pending", running: "working", human: "your turn", done: "done", failed: "failed", skipped: "not needed here" };
export const STATE_STEP: Record<IntegrationState, StepState> = {
  available: "pending", connecting: "running", connected: "done", error: "failed", disconnected: "skipped", unavailable: "skipped",
};
export const STATE_LABEL: Record<IntegrationState, string> = {
  available: "Not connected", connecting: "Connecting", connected: "Connected", error: "Needs attention", disconnected: "Disconnected",
  unavailable: "Coming soon",
};

/** Lets a "your turn" card open the terminal panel next to the chat. */
export const TerminalCtx = createContext<(() => void) | null>(null);

async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); return true; } catch {
    const t = document.createElement("textarea"); t.value = s; document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy"); t.remove(); return ok;
  }
}

export function CopyRow({ text, terminal = true }: { text: string; terminal?: boolean }) {
  const [done, setDone] = useState(false);
  const openTerminal = useContext(TerminalCtx);
  const insert = useContext(InsertCtx);
  return (
    <div className="sc-copy">
      <code>{text}</code>
      <button className="btn sm" onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } }}>
        {done ? "Copied" : "Copy"}
      </button>
      {terminal && insert
        ? <button className="btn sm primary" title="Type it into your terminal without pressing Enter" onClick={() => insert(text)}><Icon name="insert" size={14} />Insert in terminal</button>
        : terminal && openTerminal && <button className="btn sm" onClick={openTerminal}><Icon name="terminal" size={14} />Terminal</button>}
    </div>
  );
}

/** A "your turn" card: one of the CLI's gates (a login / config step, or a setting to give). */
function YourTurn({ gate }: { gate: IntegrationGate }) {
  if (gate.kind === "setting") {
    return (
      <div className="sc-your-turn">
        <div className="sc-yt-head">Your turn · setting</div>
        <p>{gate.title} <span className="hint">({gate.key})</span></p>
        <div className="hint">Tell the setup agent in the chat (never a token or password), or set it yourself in the terminal:</div>
        {gate.command && <CopyRow text={gate.command} />}
      </div>
    );
  }
  return (
    <div className="sc-your-turn">
      <div className="sc-yt-head">Your turn</div>
      {gate.instructions && <Markdown text={gate.instructions} />}
      {gate.copy && <CopyRow text={gate.copy} />}
      <div className="hint">When you're done, tell the setup agent; it checks and continues.</div>
    </div>
  );
}

/** The browser's clock, corrected to the server's (from the last answer's `now`), ticking every second. */
function useServerNow(offset: number, on: boolean) {
  const [t, setT] = useState(() => Date.now() + offset);
  useEffect(() => {
    setT(Date.now() + offset);
    if (!on) return;
    const timer = setInterval(() => setT(Date.now() + offset), 1000);
    return () => clearInterval(timer);
  }, [offset, on]);
  return t;
}

/** A running connect / verify / disconnect: spinner, elapsed time, live output, a heartbeat when quiet. */
function JobProgress({ job, lines, offset }: { job: IntegrationJob; lines: string[]; offset: number }) {
  const now = useServerNow(offset, true);
  const box = useRef<HTMLPreElement>(null);
  const shown = lines.filter((l) => waitNotice(l) === null).slice(-12);
  const wait = lines.length ? waitNotice(lines[lines.length - 1]) : null;
  const hb = wait ? null : heartbeat(Date.parse(job.last_output_at), now);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown.length, shown[shown.length - 1]]);
  return (
    <div className="sc-progress" aria-live="polite">
      <div className="sc-pg-head">
        <span className="sc-spinner" aria-hidden="true" />
        <span>{runningLabel(job.action, Date.parse(job.started_at), now)}</span>
      </div>
      {wait && <div className="sc-wait"><span className="tag">Waiting for Ubuntu updates</span> {wait}</div>}
      {shown.length > 0 && <pre className="sc-output" ref={box}>{shown.join("\n")}</pre>}
      {hb && <div className="sc-heartbeat">{hb}</div>}
    </div>
  );
}

/** One integration's steps with live states, polled while the setup task runs. */
export function IntegrationStepsCard({ id, active }: { id: string; active: boolean }) {
  const { onEvent } = useStore();
  const [it, setIt] = useState<Integration | null>(null);
  const [job, setJob] = useState<IntegrationJob | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const load = () => api.integration(id).then((x) => {
    setIt(x); setError(null);
    if (x.now) setOffset(Date.parse(x.now) - Date.now());
    if (x.job !== undefined) setJob(x.job ?? null);
    if (x.output) setLines(x.output.map((o) => o.line));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  const running = !!job?.running;
  useEffect(() => {
    if (!active && !running) return;
    const t = setInterval(load, running ? 5000 : 3000);
    return () => clearInterval(t);
  }, [id, active, running]);
  useEffect(() => onEvent((e) => {
    if (e.integrationId !== id) return;
    if (e.type === "integration.output") {
      setLines((l) => [...l.slice(-199), e.line]);
      setJob((j) => (j ? { ...j, last_output_at: new Date(Date.now() + offset).toISOString() } : j));
    }
    if (e.type === "integration.job") {
      setJob(e.job);
      if (e.job?.running) setLines([]);
      load();
    }
    if (e.type === "integration.updated") load();
  }), [id, onEvent, offset]);

  if (!it) {
    return (
      <div className="sc-card">
        <div className="sc-head"><span className="sc-icon">○</span><strong>{id}</strong></div>
        {error ? <p className="hint">Status unavailable: {error}</p> : <p className="hint">Loading…</p>}
      </div>
    );
  }
  if (!it.available) {
    return (
      <div className="sc-card st-skipped" aria-label={`${it.title}: coming soon`}>
        <div className="sc-head"><span className="sc-icon">─</span><strong>{it.title}</strong><span className="tag">Coming soon</span></div>
        <p className="hint">This integration can't be connected yet.</p>
      </div>
    );
  }
  const head: StepState = running ? "running" : STATE_STEP[it.state];
  // While a run is going, the first step that isn't done (and isn't the owner's) is the one working.
  const workingId = running ? it.steps.find((s) => s.state !== "done" && s.state !== "skipped" && s.state !== "human")?.id : undefined;
  const steps = it.steps.map((s) => (s.id === workingId ? { ...s, state: "running" as StepState } : s));
  const live = steps.filter((s) => s.state !== "skipped");
  const done = live.filter((s) => s.state === "done").length;
  const stepGates = new Map(it.gates.flatMap((g) => (g.kind === "step" ? [[g.id, g] as const] : [])));
  const settingGates = it.gates.filter((g) => g.kind === "setting");
  const disconnected = !running && job?.action === "disconnect" && job.ok && it.state === "disconnected";
  const lastFailed = !running && it.last?.ok === false && it.last.error && it.state !== "connected";
  return (
    <div className={`sc-card st-${head}`} aria-label={`${it.title} setup steps`}>
      <div className="sc-head">
        <span className="sc-icon" title={STATE_LABEL[it.state]}>{STEP_ICON[head]}</span>
        <strong>{it.title}</strong>
        <span className="tag">{running ? "Working" : STATE_LABEL[it.state]}{it.account ? ` · ${it.account}` : ""}</span>
        {live.length > 0 && <span className="sc-count">{done}/{live.length}</span>}
      </div>
      {settingGates.map((g) => <YourTurn key={`s-${g.key}`} gate={g} />)}
      {steps.length > 0 && (
        <ul className="sc-steps">
          {steps.map((s) => (
            <li key={s.id} className={`sc-step st-${s.state}`}>
              <div className="sc-line">
                <span className="sc-icon" aria-label={STEP_LABEL[s.state]} title={STEP_LABEL[s.state]}>{STEP_ICON[s.state]}</span>
                <span className="sc-title">{s.title}</span>
                {s.state === "running" && <span className="tag">working…</span>}
                {s.state === "skipped" && <span className="hint">not needed here</span>}
              </div>
              {stepGates.has(s.id) && !running && <YourTurn gate={stepGates.get(s.id)!} />}
              {s.state === "failed" && s.last_error && <pre className="sc-error">{s.last_error}</pre>}
            </li>
          ))}
        </ul>
      )}
      {running && job && <JobProgress job={job} lines={lines} offset={offset} />}
      {lastFailed && <pre className="sc-error" style={{ marginLeft: 0 }}>Last {it.last!.action} failed: {it.last!.error}</pre>}
      {disconnected && (
        <div className="sc-revoke">
          <strong>Disconnected.</strong> Its instructions and skills are gone; credentials were left alone.
          {it.revoke ? <><div className="hint">To revoke them:</div><Markdown text={it.revoke} /></> : null}
        </div>
      )}
      {!running && lines.length > 0 && (
        <div className="sc-output-wrap">
          <button className="worklog-toggle" aria-expanded={showOutput} onClick={() => setShowOutput(!showOutput)}>
            <span className="chev"><Icon name="chevron" size={14} /></span>
            Output of the last {job?.action ?? "run"} ({lines.length} line{lines.length === 1 ? "" : "s"}{job?.ended_at ? `, ${fmtDuration(Date.parse(job.ended_at) - Date.parse(job.started_at))}` : ""})
          </button>
          {showOutput && <pre className="sc-output">{lines.join("\n")}</pre>}
        </div>
      )}
      {error && <p className="hint">Status may be stale: {error}</p>}
    </div>
  );
}

/** A proposal from the setup agent: applied only when the owner approves here. */
export function ApprovalCard({ id }: { id: string }) {
  const { onEvent, everyone } = useStore();
  const [a, setA] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.approval(id).then(setA).catch((e) => setError(e.message)); }, [id]);
  useEffect(() => onEvent((e) => { if (e.type === "approval.updated" && e.approval.id === id) setA((x) => ({ ...x, ...e.approval })); }), [id, onEvent]);
  if (!a) return error ? <div className="error-box">{error}</div> : null;
  const name = (rid: string) => everyone.find((x) => x.id === rid)?.name ?? "deleted agent";
  const decide = async (approve: boolean) => {
    setBusy(true); setError(null);
    try { setA(await (approve ? api.approve(id) : api.reject(id))); } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const p = a.payload;
  return (
    <div className={`approval-card ${a.status}`} aria-label={a.title}>
      <div className="approval-head">
        <span className="approval-kicker">{a.status === "pending" ? "Needs your approval" : a.status === "approved" ? "Approved" : a.status === "rejected" ? "Rejected" : "Failed"}</span>
        <strong>{a.title}</strong>
      </div>
      {a.kind === "mapping" && (
        <div className="approval-body">
          <div className="role-chips">
            {(p.roles ?? []).length === 0 && <span className="hint">No agents</span>}
            {(p.roles ?? []).map((r) => (
              <span key={r} className={`role-chip${p.added?.includes(r) ? " added" : ""}`}>{p.added?.includes(r) ? "+ " : ""}{name(r)}</span>
            ))}
            {(p.removed ?? []).map((r) => <span key={r} className="role-chip removed">− {name(r)}</span>)}
          </div>
          <p className="hint">These agents get {p.integration_title ?? p.integration_id}'s instructions and skills; others don't see it.</p>
        </div>
      )}
      {a.kind === "team_rule" && (
        <div className="approval-body">
          {p.reason && <p className="hint">{p.reason}</p>}
          <div className="diff" role="region" aria-label={`Changes to ${p.relative}`}>
            <div className="diff-file">{p.created ? "new file · " : ""}{p.file}</div>
            {compactDiff(p.diff ?? []).map((d, i) => (
              d === null ? <div key={i} className="diff-gap">⋯</div>
                : <div key={i} className={`diff-line ${d.op === "+" ? "add" : d.op === "-" ? "del" : ""}`}><span aria-hidden="true">{d.op}</span>{d.text || " "}</div>
            ))}
          </div>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {a.status === "pending" ? (
        <div className="approval-actions">
          <button className="btn sm primary" disabled={busy} onClick={() => decide(true)}><Icon name="check" size={14} />Approve</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => decide(false)}>Reject</button>
        </div>
      ) : (
        <p className="hint">{a.status === "approved" ? "Applied" : a.status === "rejected" ? "Discarded" : a.error ?? "Failed"} {a.decided_at ? relTime(a.decided_at) : ""}</p>
      )}
    </div>
  );
}

/** Changed lines with 2 lines of context; long unchanged runs fold into ⋯. */
function compactDiff(diff: { op: " " | "-" | "+"; text: string }[]) {
  const keep = diff.map((d, i) => d.op !== " " || diff.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== " "));
  const out: ({ op: " " | "-" | "+"; text: string } | null)[] = [];
  diff.forEach((d, i) => {
    if (keep[i]) out.push(d);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}

/** The portal's terminal (/term/), next to the chat, for logins. */
export function TerminalPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="panel term-panel" aria-label="Terminal">
      <div className="term-panel-head">
        <strong>Terminal</strong>
        <span className="hint">Logins happen here, never in the chat.</span>
        <a className="hint" href={TERMINAL_URL} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto" }}>New tab ↗</a>
        <button className="icon-btn" aria-label="Close terminal" title="Close terminal" onClick={onClose}><Icon name="close" /></button>
      </div>
      <iframe src={TERMINAL_URL} title="Terminal on the agentbox computer" />
    </aside>
  );
}
