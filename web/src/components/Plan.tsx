import { useEffect, useState } from "react";
import { api, type Plan, type PlanGate } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, Markdown, relTime } from "./ui.tsx";
import { PlanDiagram } from "./PlanDiagram.tsx";

/**
 * A plan in a conversation (author "plan"): the diagram first and largest, then a few short lists;
 * the full text stays collapsed. A plan the work waits for ("plan first") gets Approve / Request
 * changes / Reject. A shared plan (the default: the agent carried on) gets Looks good / Redirect /
 * Stop, for when the owner happens to look and wants another direction.
 */
const STATUS: Record<Plan["status"], string> = {
  shared: "Plan · shared, the agent carried on", pending: "Plan · needs you", approved: "Plan approved", changes: "Plan sent back",
  rejected: "Plan rejected", superseded: "Replaced by a newer version",
};

export function PlanCard({ id }: { id: string }) {
  const { onEvent } = useStore();
  const [p, setP] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<null | "approve" | "changes" | "reject">(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(true);
  const [showOwner, setShowOwner] = useState(false);
  useEffect(() => { api.plan(id).then(setP).catch((e) => setError(e.message)); }, [id]);
  useEffect(() => onEvent((e) => { if (e.type === "plan.updated" && e.plan?.id === id) setP(e.plan); }), [id, onEvent]);
  useEffect(() => { if (p && p.status === "superseded") setOpen(false); }, [p?.status]);
  if (!p) return error ? <div className="error-box">{error}</div> : null;
  const b = p.body;
  const decide = async (verdict: "approve" | "changes" | "reject") => {
    setBusy(true); setError(null);
    try { setP(await api.decidePlan(p.id, verdict, note)); setMode(null); setNote(""); } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const shared = p.status === "shared";
  const pending = p.status === "pending" || shared;
  // A helper's plan: its lead decides; the owner may step in but isn't asked.
  const lead = !!p.reviewer_id;
  const stepIn = showOwner || mode !== null;
  return (
    <div className={`approval-card plan-card pl-${p.status}`} aria-label={`Plan: ${p.title}`}>
      <div className="approval-head">
        <span className="approval-kicker">{lead && p.status === "pending" ? `Plan · ${p.reviewer_name ?? "its lead"} decides` : STATUS[p.status]}{p.version > 1 ? ` · v${p.version}` : ""}</span>
        <button className="plan-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          <strong>{b.title}</strong>
          {!open && <Icon name="chevron" size={12} />}
        </button>
        <span className="hint">From {p.instance_name ?? "an agent"} · {relTime(p.created_at)}{p.decided_at && !pending ? ` · decided ${relTime(p.decided_at)}` : ""}</span>
      </div>
      {open && (
        <>
          <PlanDiagram before={b.diagram.before} after={b.diagram.after} />
          <p className="plan-summary">{b.summary}</p>
          <div className="plan-lists">
            <PlanList title="What changes" items={b.changes} />
            {b.checks.length > 0 && <PlanList title="How we'll know it works" items={b.checks} />}
            {b.risks.length > 0 && <PlanList title="Risks" items={b.risks} tone="warn" />}
          </div>
          {b.details && (
            <details className="sr-details">
              <summary>Full plan</summary>
              <div className="plan-details"><Markdown text={b.details} /></div>
            </details>
          )}
        </>
      )}
      {p.feedback && !pending && <p className="hint">{p.status === "approved" ? "Note" : "Feedback"}{lead ? ` from ${p.reviewer_name ?? "its lead"}` : ""}: {p.feedback}</p>}
      {lead && pending && !stepIn && (
        <div className="approval-actions">
          <span className="hint">{p.reviewer_name ?? "Its lead"} decides this one; nothing waits on you.</span>
          <button className="btn sm ghost" onClick={() => setShowOwner(true)}>Step in…</button>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {shared && !mode && (!lead || stepIn) && (
        <div className="approval-actions">
          <button className="btn sm" disabled={busy} onClick={() => decide("approve")}><Icon name="check" size={14} />Looks good</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => setMode("changes")}>Redirect…</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => setMode("reject")}>Stop…</button>
          <span className="hint">Nothing waits on you; use these only to change course.</span>
        </div>
      )}
      {pending && !shared && !mode && (!lead || stepIn) && (
        <div className="approval-actions">
          <button className="btn sm primary" disabled={busy} onClick={() => decide("approve")}><Icon name="check" size={14} />Approve</button>
          <button className="btn sm" disabled={busy} onClick={() => setMode("changes")}>Request changes</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => setMode("approve")}>Approve with a note…</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => setMode("reject")}>Reject</button>
        </div>
      )}
      {pending && mode && (
        <div className="sr-reject">
          <textarea className="text" autoFocus rows={2} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)}
            placeholder={mode === "changes" ? (shared ? "Which direction instead? e.g. keep logging in-process, no new service" : "What should change? e.g. keep logging in-process, no new service") : mode === "reject" ? "Why (optional)" : "Note for the agent (optional)"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) decide(mode); if (e.key === "Escape") setMode(null); }} />
          <button className={`btn sm ${mode === "reject" ? "danger" : "primary"}`} disabled={busy || (mode === "changes" && !note.trim())} onClick={() => decide(mode)}>
            {mode === "changes" ? (shared ? "Redirect" : "Send back") : mode === "reject" ? (shared ? "Stop the work" : "Reject") : "Approve"}
          </button>
          <button className="btn sm ghost" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function PlanList({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  return (
    <div className={`plan-list${tone ? ` ${tone}` : ""}`}>
      <span className="plan-list-title">{title}</span>
      <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

/** The task header's plan chip: the gate, and where the plan stands. */
export function PlanChip({ instanceId }: { instanceId: string }) {
  const { onEvent } = useStore();
  const [s, setS] = useState<{ gate: PlanGate; pending: Plan | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.taskPlans(instanceId).then((r) => alive && setS({ gate: r.gate, pending: r.plans.find((p) => p.status === "pending" && !p.reviewer_id) ?? null })).catch(() => {});
    load();
    const off = onEvent((e) => { if (e.type === "plan.updated" || e.type === "plan_gate.updated") load(); });
    return () => { alive = false; off(); };
  }, [instanceId, onEvent]);
  if (!s) return null;
  const { gate, pending } = s;
  if (pending) return <span className="chip warn" title={pending.title}><Icon name="flow" size={13} />Plan waiting for you</span>;
  // (helper plans wait for their lead, not for you: they don't count here)
  if (gate.approved) return <span className="chip ok" title={gate.approved.title}><Icon name="flow" size={13} />Plan approved{gate.approved.version > 1 ? ` (v${gate.approved.version})` : ""}</span>;
  if (gate.required) return <span className="chip" title="Edits and commits are held until you approve a plan"><Icon name="flow" size={13} />Plan first</span>;
  return null;
}

/** The task panel's switch: hold edits until a plan is approved. */
export function PlanGateSwitch({ instanceId }: { instanceId: string }) {
  const { onEvent } = useStore();
  const [gate, setGate] = useState<PlanGate | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.taskPlans(instanceId).then((r) => alive && setGate(r.gate)).catch(() => {});
    load();
    const off = onEvent((e) => { if (e.type === "plan_gate.updated" || e.type === "plan.updated") load(); });
    return () => { alive = false; off(); };
  }, [instanceId, onEvent]);
  if (!gate) return null;
  return (
    <label className="field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
      <input type="checkbox" checked={gate.required} style={{ marginTop: 3 }} onChange={async (e) => {
        setError(null);
        try { setGate(await api.setPlanGate(instanceId, e.target.checked)); } catch (err: any) { setError(err.message); }
      }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontWeight: 500 }}>Approve a plan first</span>
        <span className="hint">{gate.approved ? `Approved: ${gate.approved.title}` : "The agent shows you a before/after diagram; edits and commits wait for your OK."}</span>
        {error && <span className="hint" style={{ color: "var(--bad)" }}>{error}</span>}
      </span>
    </label>
  );
}
