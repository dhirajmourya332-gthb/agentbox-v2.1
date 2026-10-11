import { useEffect, useMemo, useState } from "react";
import { api, type DocumentInfo } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, relTime } from "../components/ui.tsx";
import { DocumentReader } from "./Documents.tsx";

const TYPES: { key: string; label: string; ext: string[] }[] = [
  { key: "all", label: "All", ext: [] },
  { key: "docs", label: "Docs", ext: ["md", "markdown", "mdx", "txt", "rst", "adoc", "docx", "odt", "rtf", "html", "htm"] },
  { key: "pdf", label: "PDF", ext: ["pdf"] },
  { key: "data", label: "Data", ext: ["csv", "tsv", "xlsx"] },
  { key: "images", label: "Images", ext: ["png", "jpg", "jpeg", "svg"] },
];

/** Every document any agent wrote, newest first (backlog #6). */
export function DocumentsPage() {
  const { agents } = useStore();
  const [docs, setDocs] = useState<(DocumentInfo & { role: string })[] | null>(null);
  const [role, setRole] = useState("all");
  const [type, setType] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<DocumentInfo | null>(null);
  // The setup agent only appears as a filter when it has written something.
  const roles = agents.filter((a) => !a.base_agent_id && (!a.builtin || docs?.some((d) => d.role === a.id)));

  useEffect(() => {
    const load = () => api.allDocuments().then(setDocs).catch(() => setDocs([]));
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const shown = useMemo(() => {
    const ext = TYPES.find((t) => t.key === type)!.ext;
    const needle = q.trim().toLowerCase();
    return (docs ?? []).filter((d) =>
      (role === "all" || d.role === role) &&
      (!ext.length || ext.includes(d.name.split(".").pop()!.toLowerCase())) &&
      (!needle || d.name.toLowerCase().includes(needle) || d.folder.toLowerCase().includes(needle)));
  }, [docs, role, type, q]);

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 980 }}>
        <h1>Documents</h1>
        <p className="lede">Everything your agents have written — plans, requirements, reports — newest first.</p>
        <div className="toolbar board-filters">
          <input className="text" style={{ maxWidth: 260 }} placeholder="Search by name or folder" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
          <select className="text" style={{ width: "auto", padding: "4px 8px" }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Agent">
            <option value="all">Every agent</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div className="segmented" role="group" aria-label="Type">
            {TYPES.map((t) => <button key={t.key} aria-pressed={type === t.key} onClick={() => setType(t.key)}>{t.label}</button>)}
          </div>
        </div>
        {!docs ? <p className="hint">Loading…</p> : shown.length === 0 ? (
          <p className="hint">{docs.length ? "No documents match." : "No documents yet. Agents save what they write for you in their docs/ folder, and it shows up here."}</p>
        ) : (
          <div className="rows">
            {shown.map((d) => {
              const r = roles.find((x) => x.id === d.role);
              return (
                <button key={d.path} className="row doc-table-row" onClick={() => setOpen(d)} title={d.path}>
                  <span className="doc-badge">{d.name.split(".").pop()?.slice(0, 4)}</span>
                  <span className="doc-text" style={{ flex: 1 }}>
                    <span className="doc-name">{d.name}</span>
                    <span className="hint">{d.location}{d.task_title ? ` · from “${d.task_title}”` : ""}</span>
                  </span>
                  {r && <span className="hint doc-author"><Avatar name={r.name} color={r.color} size={18} />{r.name}</span>}
                  <span className="hint" style={{ whiteSpace: "nowrap", minWidth: 80, textAlign: "right" }}>{relTime(d.modified)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {open && <DocumentReader doc={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
