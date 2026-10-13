import { useEffect, useState } from "react";
import { api, type RepoBinding, type SetupRequest } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Icon, relTime } from "./ui.tsx";
import { rememberReturn } from "./returnTo.ts";

/**
 * A setup request in a conversation (author "setup_request"): an agent lacks an account, login,
 * tool or access. Only the owner's "Set up now" starts the setup agent; the instructions it will get
 * are hidden by default but always inspectable (the setup agent can get temporary sudo).
 */
const STATUS: Record<SetupRequest["status"], string> = {
  pending: "Needs you", in_progress: "Setting up", done: "Done", rejected: "Declined", cancelled: "Cancelled", failed: "Failed",
};

export function SetupRequestCard({ id }: { id: string }) {
  const { onEvent } = useStore();
  const [r, setR] = useState<SetupRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [marking, setMarking] = useState(false);
  useEffect(() => { api.setupRequest(id).then(setR).catch((e) => setError(e.message)); }, [id]);
  useEffect(() => onEvent((e) => { if (e.type === "setup_request.updated" && e.request?.id === id) setR(e.request); }), [id, onEvent]);
  if (!r) return error ? <div className="error-box">{error}</div> : null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const start = () => run(async () => {
    const s = await api.startSetupRequest(r.id);
    setR(s.request);
    // Come back here when the setup is done (the workspace offers "Back to …" and returns on its own).
    rememberReturn(s.instance_id, { hash: location.hash || "#/", label: r.requester_name ?? "where you were", request: r.id });
    go({ name: "setup", id: s.instance_id });
  });
  const open = r.status === "pending" || r.status === "in_progress";
  const others = r.waiters.filter((w) => w.instance_id !== r.requester_id).map((w) => w.name).filter(Boolean);
  return (
    <div className={`approval-card setup-request st-${r.status}`} aria-label={`Setup request: ${r.title}`}>
      <div className="approval-head">
        <span className="approval-kicker">{STATUS[r.status]}{r.status === "pending" ? " · setup request" : ""}</span>
        <strong>{r.title}</strong>
        <span className="hint">
          Asked by {r.requester_name ?? "you"}{others.length ? ` (also waiting: ${others.join(", ")})` : ""} · {relTime(r.created_at)}
          {r.integration && <> · integration <code>{r.integration}</code></>}
          {r.repo && <> · repo <code>{r.repo}</code></>}
        </span>
      </div>
      {r.why && <p className="sr-why">{r.why}</p>}
      <details className="sr-details">
        <summary>What the helper will be told</summary>
        <pre className="sr-instructions">{r.for_setup_agent}</pre>
        {r.check_cmd && <p className="hint">Done when this check passes: <code>{r.check_cmd}</code></p>}
        <p className="hint">Written by {r.requester_name ?? "you"}. The helper gets it quoted as a request, follows your rules, and still asks you before anything it isn't sure is safe.</p>
      </details>
      {r.status === "in_progress" && r.setup_instance_id && (
        <p className="hint">The helper is on it: <a href={`#/helper/${r.setup_instance_id}`}>open its workspace</a>. {r.requester_name ? `${r.requester_name} is called back when it's done.` : ""}</p>
      )}
      {(r.status === "done" || r.status === "rejected" || r.status === "failed") && (
        <p className="hint">{r.result_note ?? ""}{r.completed_at ? ` · ${relTime(r.completed_at)}` : ""}{r.requester_name && r.waiters.some((w) => w.called_back_at) ? " · the agent was told" : ""}</p>
      )}
      {error && <div className="error-box">{error}</div>}
      {open && !rejecting && !marking && (
        <div className="approval-actions">
          {r.status === "pending"
            ? <button className="btn sm primary" disabled={busy} onClick={start}><Icon name="terminal" size={14} />Set up now</button>
            : <button className="btn sm" disabled={busy} onClick={start}>Open setup</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
          {r.status === "in_progress" && <button className="btn sm ghost" disabled={busy} onClick={() => setMarking(true)}>Mark…</button>}
        </div>
      )}
      {rejecting && (
        <div className="sr-reject">
          <input className="text" autoFocus placeholder="Reason (optional), e.g. not for agents" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(async () => { setR(await api.rejectSetupRequest(r.id, reason)); setRejecting(false); }); if (e.key === "Escape") setRejecting(false); }} />
          <button className="btn sm danger" disabled={busy} onClick={() => run(async () => { setR(await api.rejectSetupRequest(r.id, reason)); setRejecting(false); })}>Decline</button>
          <button className="btn sm ghost" onClick={() => setRejecting(false)}>Cancel</button>
        </div>
      )}
      {marking && (
        <div className="sr-reject">
          <input className="text" autoFocus placeholder="Note for the agent (optional)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          <button className="btn sm primary" disabled={busy} onClick={() => run(async () => { setR(await api.markSetupRequest(r.id, "done", reason || "Marked done by the owner.")); setMarking(false); })}>Done</button>
          <button className="btn sm danger" disabled={busy} onClick={() => run(async () => { setR(await api.markSetupRequest(r.id, "failed", reason)); setMarking(false); })}>Failed</button>
          <button className="btn sm ghost" onClick={() => setMarking(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/** The task header's repo + branch chips. */
export function RepoChips({ instanceId }: { instanceId: string }) {
  const { onEvent } = useStore();
  const [repos, setRepos] = useState<RepoBinding[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.taskRepos(instanceId).then((r) => alive && setRepos(r.repos)).catch(() => {});
    load();
    const off = onEvent((e) => { if (e.type === "repo.updated") load(); });
    return () => { alive = false; off(); };
  }, [instanceId, onEvent]);
  const shown = repos.filter((b) => b.status !== "removed" && b.status !== "discarded");
  if (!shown.length) return null;
  return (
    <span className="repo-chips">
      {shown.map((b) => (
        <a key={b.id} className={`repo-chip${b.status === "kept" ? " kept" : ""}`} href={`#/repos/${b.repo}`} title={b.path ?? "created at its next turn"}>
          <Icon name="repo" size={12} />{b.repo}{b.branch && <code>{b.branch}</code>}{b.status === "kept" && <span> · kept</span>}
        </a>
      ))}
    </span>
  );
}
