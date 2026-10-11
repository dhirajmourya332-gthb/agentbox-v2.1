import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Agent, type DiffLine, type FileChange, type RepoChanges, type Review, type ReviewComment } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, Spinner, relTime } from "../components/ui.tsx";

/**
 * Diff review (docs/V2.1-PLAN.md §2): everything a task (and the tasks it handed out) changed in its
 * repo worktrees, against where each branch left the default branch. Click a line to comment; the
 * review goes to the task as one message with every comment, and starts its next turn.
 */

type Draft = Omit<ReviewComment, "repo">;
const keyOf = (c: { worktree_id: string; path: string; side: string; line: number }) => `${c.worktree_id}\u0000${c.path}\u0000${c.side}\u0000${c.line}`;
const STORE = (root: string) => `agentbox.review.${root}`;

export function Changes({ instanceId }: { instanceId: string }) {
  const { agents, everyone, onEvent } = useStore();
  const agent = (agents.find((a) => a.id === instanceId) ?? everyone.find((a) => a.id === instanceId)) as Agent | undefined;
  const [data, setData] = useState<{ root_id: string; repos: RepoChanges[]; review: Review | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.taskChanges(instanceId).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [instanceId]);
  useEffect(load, [load]);

  // Unsent comments survive a reload (this browser only).
  const root = data?.root_id;
  useEffect(() => {
    if (!root) return;
    try { const s = JSON.parse(localStorage.getItem(STORE(root)) ?? "null"); if (s) { setDrafts(s.drafts ?? {}); setNote(s.note ?? ""); } } catch { /* storage unavailable */ }
  }, [root]);
  useEffect(() => {
    if (!root) return;
    try {
      if (Object.keys(drafts).length || note) localStorage.setItem(STORE(root), JSON.stringify({ drafts, note }));
      else localStorage.removeItem(STORE(root));
    } catch { /* storage unavailable */ }
  }, [root, drafts, note]);

  // A turn in this work ended: its files may have changed.
  const ids = useMemo(() => new Set([instanceId, data?.root_id, ...(data?.repos.map((r) => r.instance?.id) ?? [])].filter(Boolean) as string[]), [instanceId, data]);
  const timer = useRef<number | null>(null);
  useEffect(() => onEvent((e) => {
    if (e.type === "task.updated" && ids.has(e.task?.agent_id) && ["done", "failed", "stopped"].includes(e.task?.status)) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 800);
    }
    if (e.type === "review.updated" && e.rootId === data?.root_id) setData((d) => (d ? { ...d, review: e.review } : d));
  }), [onEvent, ids, load, data?.root_id]);

  const totals = useMemo(() => {
    const repos = data?.repos ?? [];
    return { files: repos.reduce((n, r) => n + r.files.length, 0), add: repos.reduce((n, r) => n + r.additions, 0), del: repos.reduce((n, r) => n + r.deletions, 0) };
  }, [data]);
  const count = Object.keys(drafts).length;
  const review = data?.review;
  const movedSince = review && data ? data.repos.some((r) => r.head && review.heads[r.worktree_id] && review.heads[r.worktree_id] !== r.head) : false;

  const submit = async (verdict: Review["verdict"]) => {
    setBusy(true); setError(null);
    try {
      const r = await api.submitReview(instanceId, { verdict, note, comments: Object.values(drafts) });
      setDrafts({}); setNote(""); setEditing(null);
      setData((d) => (d ? { ...d, review: r } : d));
      setSent({ approve: "Approved: the agent carries on.", changes: "Sent back with your comments: the agent is working on them.", reject: "Rejected: the agent stops and reports." }[verdict]);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  const title = agent?.label ?? agent?.name ?? "Task";
  return (
    <section className="changes" aria-label={`Changes: ${title}`}>
      <header className="chat-head changes-head">
        <a className="icon-btn" href={`#/agents/${instanceId}`} aria-label="Back to the task" title="Back to the task"><Icon name="back" /></a>
        <div className="who" style={{ minWidth: 0 }}>
          <strong className="changes-title">Changes · {title}</strong>
          <span className="hint">
            {data ? <>{totals.files} file{totals.files === 1 ? "" : "s"} · <span className="add">+{totals.add}</span> <span className="del">−{totals.del}</span></> : "Loading…"}
            {review && <> · last review: <strong>{review.verdict === "approve" ? "approved" : review.verdict === "changes" ? "changes requested" : "rejected"}</strong> {relTime(review.created_at)}{movedSince ? " (changed since)" : ""}</>}
          </span>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={load} disabled={loading}>{loading ? <Spinner /> : <Icon name="refresh" size={14} />}Refresh</button>
        </div>
      </header>

      <div className="changes-body">
        {error && <div className="error-box" role="alert">{error}</div>}
        {sent && <div className="note-box" role="status">{sent} <a href={`#/agents/${instanceId}`}>Back to the task</a></div>}
        {data && data.repos.length === 0 && (
          <div className="empty-state">
            <p>This task hasn't worked in a registered repo yet, so there's nothing to review here.</p>
            <p className="hint">Pick repos when you start a task, or the agent calls <code>use_repo</code>; its worktree's changes then show up here.</p>
          </div>
        )}
        {data?.repos.map((r) => (
          <RepoSection key={r.worktree_id} r={r} drafts={drafts} editing={editing} setEditing={setEditing}
            onSave={(d) => { setDrafts((x) => ({ ...x, [keyOf(d)]: d })); setEditing(null); }}
            onDelete={(k) => setDrafts((x) => { const y = { ...x }; delete y[k]; return y; })} />
        ))}
      </div>

      {data && data.repos.length > 0 && (
        <footer className="review-bar">
          <textarea className="text" rows={1} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)}
            placeholder={count ? `Overall note (optional) · ${count} line comment${count === 1 ? "" : "s"} ready` : "Overall note, or click a line to comment on it"} />
          <div className="review-actions">
            <span className="hint">{count ? `${count} comment${count === 1 ? "" : "s"}` : ""}</span>
            <button className="btn sm ghost" disabled={busy} onClick={() => submit("reject")}>Reject</button>
            <button className="btn sm" disabled={busy || (!count && !note.trim())} title={!count && !note.trim() ? "Add a comment or a note first" : undefined} onClick={() => submit("changes")}>Request changes</button>
            <button className="btn sm primary" disabled={busy} onClick={() => submit("approve")}><Icon name="check" size={14} />Approve</button>
          </div>
        </footer>
      )}
    </section>
  );
}

function RepoSection({ r, drafts, editing, setEditing, onSave, onDelete }: {
  r: RepoChanges; drafts: Record<string, Draft>; editing: string | null; setEditing: (k: string | null) => void;
  onSave: (d: Draft) => void; onDelete: (k: string) => void;
}) {
  return (
    <div className="changes-repo">
      <div className="changes-repo-head">
        <Icon name="repo" size={14} />
        <strong>{r.repo}</strong>
        {r.branch && <code>{r.branch}</code>}
        <span className="hint">vs {r.base}</span>
        {r.commits.length > 0 && <span className="hint">· {r.commits.length} commit{r.commits.length === 1 ? "" : "s"}</span>}
        {r.instance && <span className="hint">· <a href={`#/agents/${r.instance.id}`}>{r.instance.name}</a></span>}
        <span className="grow" />
        <span className="hint"><span className="add">+{r.additions}</span> <span className="del">−{r.deletions}</span></span>
      </div>
      {r.error && <p className="hint" style={{ padding: "8px 12px" }}>{r.error}</p>}
      {!r.error && r.files.length === 0 && <p className="hint" style={{ padding: "8px 12px" }}>No changes yet.</p>}
      {r.commits.length > 0 && (
        <details className="changes-commits">
          <summary>Commits</summary>
          <ul>{r.commits.map((c) => <li key={c.sha}><code>{c.sha}</code> {c.subject}</li>)}</ul>
        </details>
      )}
      {r.files.length > 1 && (
        <nav className="changes-files" aria-label={`Files in ${r.repo}`}>
          {r.files.map((f) => (
            <a key={f.path} href={`#file-${r.worktree_id}-${encodeURIComponent(f.path)}`} onClick={(e) => { e.preventDefault(); document.getElementById(`file-${r.worktree_id}-${f.path}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>
              <span className={`fstat ${f.status}`}>{f.status === "untracked" ? "new" : f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"}</span>
              <span className="fpath">{f.path}</span>
              <span className="hint"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
            </a>
          ))}
        </nav>
      )}
      {r.truncated && <p className="hint" style={{ padding: "0 12px" }}>Some files or lines aren't shown (too many). Open the worktree for the rest: <code>{r.path}</code></p>}
      {r.files.map((f) => (
        <FileDiff key={f.path} wt={r.worktree_id} f={f} drafts={drafts} editing={editing} setEditing={setEditing} onSave={onSave} onDelete={onDelete} />
      ))}
    </div>
  );
}

function FileDiff({ wt, f, drafts, editing, setEditing, onSave, onDelete }: {
  wt: string; f: FileChange; drafts: Record<string, Draft>; editing: string | null; setEditing: (k: string | null) => void;
  onSave: (d: Draft) => void; onDelete: (k: string) => void;
}) {
  const [open, setOpen] = useState(f.lines.length < 600);
  const anchor = (l: DiffLine) => (l.t === "del" ? { side: "old" as const, line: l.o! } : { side: "new" as const, line: l.n! });
  return (
    <div className="fdiff" id={`file-${wt}-${f.path}`}>
      <button className="fdiff-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={12} />
        <span className="fpath">{f.path}</span>
        <span className={`fstat ${f.status}`}>{f.status === "untracked" ? "new, not committed" : f.status}</span>
        <span className="grow" />
        <span className="hint"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
      </button>
      {open && (f.binary ? <p className="hint fdiff-note">Binary file: not shown.</p> : (
        <table className="fdiff-table">
          <colgroup><col className="num" /><col className="num" /><col /></colgroup>
          <tbody>
            {f.lines.map((l, i) => {
              if (l.t === "hunk") return <tr key={i} className="hunk"><td colSpan={3}>{l.s}</td></tr>;
              const a = anchor(l);
              const k = keyOf({ worktree_id: wt, path: f.path, ...a });
              const d = drafts[k];
              return (
                <Fragment key={i}>
                  <tr className={`ln ${l.t}${d ? " has-comment" : ""}`} onClick={() => setEditing(editing === k ? null : k)} title="Click to comment on this line">
                    <td className="num">{l.o ?? ""}</td>
                    <td className="num">{l.n ?? ""}</td>
                    <td className="code"><span className="mark">{l.t === "add" ? "+" : l.t === "del" ? "−" : " "}</span>{l.s}</td>
                  </tr>
                  {(editing === k || d) && (
                    <tr className="comment-row"><td colSpan={3}>
                      {editing === k
                        ? <CommentBox initial={d?.text ?? ""} onCancel={() => setEditing(null)} onDelete={d ? () => { onDelete(k); setEditing(null); } : undefined}
                            onSave={(text) => onSave({ worktree_id: wt, path: f.path, ...a, text })} />
                        : <div className="comment-view" onClick={() => setEditing(k)}><Icon name="edit" size={12} /> {d!.text}</div>}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ))}
      {open && f.truncated && <p className="hint fdiff-note">The rest of this file's diff isn't shown (too long).</p>}
    </div>
  );
}

function CommentBox({ initial, onSave, onCancel, onDelete }: { initial: string; onSave: (t: string) => void; onCancel: () => void; onDelete?: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="comment-box" onClick={(e) => e.stopPropagation()}>
      <textarea className="text" autoFocus rows={2} value={text} maxLength={4000} placeholder="What should change here?" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) onSave(text.trim()); if (e.key === "Escape") onCancel(); }} />
      <div className="approval-actions">
        <button className="btn sm primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>Save comment</button>
        <button className="btn sm ghost" onClick={onCancel}>Cancel</button>
        {onDelete && <button className="btn sm ghost" onClick={onDelete}>Delete</button>}
      </div>
    </div>
  );
}

/** The review in the conversation (author "review"). */
export function ReviewCard({ id }: { id: string }) {
  const [r, setR] = useState<Review | null>(null);
  useEffect(() => { api.review(id).then(setR).catch(() => {}); }, [id]);
  if (!r) return null;
  const label = { approve: "You approved the changes", changes: "You requested changes", reject: "You rejected the changes" }[r.verdict];
  return (
    <div className={`approval-card review-card rv-${r.verdict}`}>
      <div className="approval-head">
        <span className="approval-kicker">Review</span>
        <strong>{label}</strong>
        <span className="hint">{relTime(r.created_at)} · <a href={`#/agents/${r.root_id}/changes`}>Open changes</a></span>
      </div>
      {r.note && <p className="sr-why" style={{ whiteSpace: "pre-wrap" }}>{r.note}</p>}
      {r.comments.length > 0 && (
        <details className="sr-details" open={r.comments.length <= 3}>
          <summary>{r.comments.length} line comment{r.comments.length === 1 ? "" : "s"}</summary>
          <ul className="review-comments">
            {r.comments.map((c, i) => <li key={i}><code>{c.repo}/{c.path}:{c.line}</code>{c.side === "old" ? <span className="hint"> (removed line)</span> : null} {c.text}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The task header's way in: "Changes", with the file count once known. */
export function ChangesButton({ instanceId }: { instanceId: string }) {
  const { onEvent } = useStore();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.changesSummary(instanceId).then((r) => alive && setN(r.worktrees)).catch(() => {});
    load();
    const off = onEvent((e) => { if (e.type === "repo.updated") load(); });
    return () => { alive = false; off(); };
  }, [instanceId, onEvent]);
  if (!n) return null;
  return <a className="btn sm" href={`#/agents/${instanceId}/changes`} title="Review what this task changed"><Icon name="diff" size={14} />Changes</a>;
}
