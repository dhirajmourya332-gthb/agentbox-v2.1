import { useEffect, useState } from "react";
import { api, type DepartmentsView } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, StatusGlyph, relTime } from "./ui.tsx";

/**
 * A group's connected departments (server/src/departments.ts): connect other groups so their leads
 * know each other's work, ask each other and hand each other work; and the requests between them.
 */

export function useDepartments(groupId: string) {
  const { onEvent } = useStore();
  const [data, setData] = useState<DepartmentsView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.departments(groupId).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData((x) => x ?? { connections: [], requests: [] }); });
    load();
    const off = onEvent((e: any) => {
      if ((e.type === "departments.updated" && e.groups?.includes(groupId)) || e.type === "group.workspaces" || e.type === "group.updated" || e.type === "group.deleted") load();
    });
    return () => { alive = false; off(); };
  }, [groupId, onEvent]);
  return data;
}

const STATUS: Record<string, string> = { open: "waiting for their lead", answered: "answered", accepted: "accepted, in progress", done: "done", failed: "failed" };

export function DepartmentsPanel({ groupId, data }: { groupId: string; data: DepartmentsView | null }) {
  const { groups } = useStore();
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <p className="hint">Loading…</p>;
  const linked = new Set(data.connections.map((c) => c.group.id));
  const others = groups.filter((g) => g.id !== groupId && !linked.has(g.id));
  const connect = async () => {
    if (!pick) return;
    setError(null);
    try { await api.connectDepartment(groupId, pick); setPick(""); } catch (e: any) { setError(e.message); }
  };
  return (
    <div className="departments">
      <p className="hint" style={{ margin: 0 }}>
        Each group is a department, and its lead is the department's head. Connected departments see each other's work, ask each other questions and hand each other work. Each department still works with its own team.
      </p>
      {error && <div className="error-box">{error}</div>}
      {data.connections.length === 0 && <p className="hint">Not connected to any other group yet.</p>}
      <ul className="dept-list">
        {data.connections.map((c) => (
          <li key={c.id} className="dept-card">
            <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
              <a href={`#/groups/${c.group.id}`}><strong>#{c.group.name}</strong></a>
              <span className="hint">{c.group.lead ? `led by ${c.group.lead.name}` : "no lead"}</span>
              <button className="icon-btn" style={{ marginLeft: "auto" }} aria-label={`Disconnect #${c.group.name}`} title="Disconnect"
                onClick={() => api.disconnectDepartment(c.id).catch((e) => setError(e.message))}><Icon name="x" size={12} /></button>
            </div>
            {c.group.purpose && <span className="hint">{c.group.purpose}</span>}
            {c.workspaces.length > 0 ? (
              <ul className="dept-ws">
                {c.workspaces.map((w) => (
                  <li key={w.root_id}><a className="row task-line" href={`#/work/${w.root_id}`}><StatusGlyph status={w.status as any} /><span>{w.title}</span></a></li>
                ))}
              </ul>
            ) : <span className="hint">No live workspaces.</span>}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div className="row" style={{ gap: 8 }}>
          <select className="text" style={{ flex: 1 }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Group to connect">
            <option value="">Connect another group…</option>
            {others.map((g) => <option key={g.id} value={g.id}>#{g.name}</option>)}
          </select>
          <button className="btn sm primary" disabled={!pick} onClick={connect}>Connect</button>
        </div>
      )}
      {data.requests.length > 0 && (
        <>
          <strong style={{ fontSize: 13 }}>Requests between departments</strong>
          <ul className="dept-requests">
            {data.requests.map((r) => (
              <li key={r.id}>
                <button className="menu-item" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <span className={`tag dept-${r.status}`}>{r.kind === "question" ? "question" : "work"}</span>
                  <span className="dept-req-text">
                    <span>{r.direction === "out" ? `To #${r.other.name}` : `From #${r.other.name}`}: {r.title}</span>
                    <span className="hint">{STATUS[r.status] ?? r.status} · {relTime(r.updated_at)}</span>
                  </span>
                </button>
                {open === r.id && (
                  <div className="dept-req-body">
                    <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.body}</p>
                    {r.answer && <><span className="hint">{r.kind === "question" ? "Answer" : r.status === "done" ? "Result" : "Reply"}</span><p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.answer}</p></>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
