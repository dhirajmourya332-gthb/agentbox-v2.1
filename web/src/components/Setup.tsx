import { createContext, useContext, useEffect, useState } from "react";
import { api, type Approval, type Integration, type IntegrationState, type StepState } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, Markdown, relTime } from "./ui.tsx";
import { TERMINAL_URL } from "./Controls.tsx";

/**
 * The setup agent's chat pieces (docs/V2-ARCHITECTURE.md §10.4): a steps card per integration being
 * connected (the guide's visuals: ○ ● ⏸ ✔ ✖ ─), "your turn" cards with copy buttons, approval cards,
 * and the embedded terminal for logins.
 */

export const STEP_ICON: Record<StepState, string> = { pending: "○", running: "●", human: "⏸", done: "✔", failed: "✖", disabled: "─" };
const STEP_LABEL: Record<StepState, string> = { pending: "pending", running: "working", human: "your turn", done: "done", failed: "failed", disabled: "off" };
export const STATE_STEP: Record<IntegrationState, StepState> = {
  available: "pending", connecting: "running", connected: "done", error: "failed", disconnected: "disabled",
};
export const STATE_LABEL: Record<IntegrationState, string> = {
  available: "Not connected", connecting: "Connecting", connected: "Connected", error: "Needs attention", disconnected: "Disconnected",
};

/** Lets a "your turn" card open the terminal panel next to the chat. */
export const TerminalCtx = createContext<(() => void) | null>(null);

async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); return true; } catch {
    const t = document.createElement("textarea"); t.value = s; document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy"); t.remove(); return ok;
  }
}

export function CopyRow({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const openTerminal = useContext(TerminalCtx);
  return (
    <div className="sc-copy">
      <code>{text}</code>
      <button className="btn sm" onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } }}>
        {done ? "Copied" : "Copy"}
      </button>
      {openTerminal && <button className="btn sm" onClick={openTerminal}><Icon name="terminal" size={14} />Terminal</button>}
    </div>
  );
}

function YourTurn({ step }: { step: Integration["steps"][number] }) {
  return (
    <div className="sc-your-turn">
      <div className="sc-yt-head">Your turn</div>
      {step.instructions && <Markdown text={step.instructions} />}
      {step.copy && <CopyRow text={step.copy} />}
      <div className="hint">When you're done, tell the setup agent; it checks and continues.</div>
    </div>
  );
}

/** One integration's steps with live states, polled while the setup task runs. */
export function IntegrationStepsCard({ id, active }: { id: string; active: boolean }) {
  const { onEvent } = useStore();
  const [it, setIt] = useState<Integration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const load = () => api.integration(id).then((x) => {
    setIt(x); setError(null);
    if (x.output) setLines(x.output.map((o) => o.line));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [id, active]);
  useEffect(() => onEvent((e) => {
    if (e.integrationId !== id) return;
    if (e.type === "integration.output") setLines((l) => [...l.slice(-199), e.line]);
    if (e.type === "integration.updated") load();
  }), [id, onEvent]);

  if (!it) {
    return (
      <div className="sc-card">
        <div className="sc-head"><span className="sc-icon">○</span><strong>{id}</strong></div>
        {error ? <p className="hint">Status unavailable: {error}</p> : <p className="hint">Loading…</p>}
      </div>
    );
  }
  const head = STATE_STEP[it.state];
  const done = it.steps.filter((s) => s.state === "done").length;
  return (
    <div className={`sc-card st-${head}`} aria-label={`${it.title} setup steps`}>
      <div className="sc-head">
        <span className="sc-icon" title={STATE_LABEL[it.state]}>{STEP_ICON[head]}</span>
        <strong>{it.title}</strong>
        <span className="tag">{STATE_LABEL[it.state]}{it.account ? ` · ${it.account}` : ""}</span>
        {it.steps.length > 0 && <span className="sc-count">{done}/{it.steps.length}</span>}
      </div>
      {it.steps.length > 0 && (
        <ul className="sc-steps">
          {it.steps.map((s) => (
            <li key={s.id} className={`sc-step st-${s.state}`}>
              <div className="sc-line">
                <span className="sc-icon" aria-label={STEP_LABEL[s.state]} title={STEP_LABEL[s.state]}>{STEP_ICON[s.state]}</span>
                <span className="sc-title">{s.title}</span>
                {s.state === "running" && <span className="tag">working…</span>}
              </div>
              {s.state === "human" && <YourTurn step={s} />}
              {s.state === "failed" && s.last_error && <pre className="sc-error">{s.last_error}</pre>}
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <div className="sc-output-wrap">
          <button className="worklog-toggle" aria-expanded={showOutput || active} onClick={() => setShowOutput(!showOutput)}>
            <span className="chev"><Icon name="chevron" size={14} /></span>Output ({lines.length} line{lines.length === 1 ? "" : "s"})
          </button>
          {(showOutput || active) && <pre className="sc-output">{(showOutput ? lines : lines.slice(-8)).join("\n")}</pre>}
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
