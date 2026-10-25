import { useEffect, useMemo, useState } from "react";
import { api, type WorkLink, type WorkRoom } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon } from "./ui.tsx";

/** Other work linked to this one (linkedWork.ts): any task in the work gives the same links. Live via links.updated. */
export function useLinks(instanceId: string) {
  const { onEvent } = useStore();
  const [state, setState] = useState<{ room: string; links: WorkLink[]; from: WorkLink[] } | null>(null);
  useEffect(() => {
    let alive = true;
    let room = "";
    const load = () => api.links(instanceId)
      .then((r) => { room = r.room_id; if (alive) setState({ room: r.room_id, links: r.links, from: r.linked_from }); })
      .catch(() => { if (alive) setState((s) => s ?? { room: "", links: [], from: [] }); });
    load();
    const off = onEvent((e) => { if (e.type === "links.updated") load(); });
    return () => { alive = false; off(); };
  }, [instanceId, onEvent]);
  return state;
}

/** Work you could link: every task and task room, newest activity first (the helper's own excluded). */
export function useLinkableWork(exclude: string[] = []) {
  const { work, agents, crews } = useStore();
  return useMemo(() => {
    const helper = agents.find((a) => !a.base_agent_id && a.builtin === "setup");
    const crewOfRole = (roleId: string | null) => {
      const role = agents.find((a) => a.id === roleId);
      return crews.find((c) => c.id === role?.crew_id)?.name ?? null;
    };
    return [...work.live, ...work.done]
      .filter((w) => w.root.role_id !== helper?.id && !exclude.includes(w.root.id))
      .map((w) => ({ room: w, crew: crewOfRole(w.root.role_id) }));
  }, [work, agents, crews, exclude.join(",")]);
}

const workHref = (id: string) => `#/work/${id}`;

/** A header button: link other work to this one, so its agents can read it. */
export function LinkWorkButton({ instanceId }: { instanceId: string }) {
  const links = useLinks(instanceId);
  const [open, setOpen] = useState(false);
  return (
    <div className="popover-anchor">
      <button className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}
        title="Link other work (e.g. another crew's) so the agents here can read its progress, conversation and documents">
        <Icon name="web" size={14} />Link{links?.links.length ? <span className="tab-count">{links.links.length}</span> : null}
      </button>
      {open && links && <LinkPicker instanceId={instanceId} room={links.room} linked={links.links} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LinkPicker({ instanceId, room, linked, onClose }: { instanceId: string; room: string; linked: WorkLink[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = useLinkableWork([room, ...linked.map((l) => l.work.id)])
    .filter(({ room: w, crew }) => !q.trim() || `${w.root.label} ${w.root.name} ${crew ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 30);
  return (
    <div className="popover link-picker" role="dialog" aria-label="Link other work" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <strong>Link other work</strong>
      <p className="hint" style={{ margin: 0 }}>Agents here can then read it (progress, roadmap, conversation, documents, links), but not hand it work.</p>
      <input className="text" autoFocus placeholder="Search work…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search work" />
      {error && <div className="error-box">{error}</div>}
      <ul className="link-options">
        {options.map(({ room: w, crew }) => (
          <li key={w.root.id}>
            <button className="menu-item" onClick={async () => {
              setError(null);
              try { await api.addLink(instanceId, w.root.id); onClose(); } catch (e: any) { setError(e.message); }
            }}>
              <span className="link-option-text">
                <span>{w.root.label ?? w.root.name}</span>
                <span className="hint">{crew ? `${crew} · ` : ""}{w.root.name}{w.root.status === "done" ? " · done" : ""}</span>
              </span>
            </button>
          </li>
        ))}
        {!options.length && <li className="hint" style={{ padding: "6px 10px" }}>No other work{q ? " matches" : ""}.</li>}
      </ul>
    </div>
  );
}

/** Under a task's or room's header: the work linked to it (each opens it; × unlinks), and who reads this one. */
export function LinkedStrip({ instanceId }: { instanceId: string }) {
  const links = useLinks(instanceId);
  if (!links || (!links.links.length && !links.from.length)) return null;
  return (
    <div className="linked-strip" aria-label="Linked work">
      {links.links.length > 0 && <span className="linked-label"><Icon name="web" size={12} />Reads</span>}
      {links.links.map((l) => (
        <span key={l.id} className="linked-chip" title={`${l.work.label} · ${l.work.crew_name} crew · led by ${l.work.name}. The agents here can read it.`}>
          <a href={workHref(l.work.id)}>{l.work.label}</a>
          <span className="hint">{l.work.crew_name}{l.work.status === "done" ? " · done" : ""}</span>
          <button className="linked-x" aria-label={`Unlink ${l.work.label}`} title="Unlink" onClick={() => api.removeLink(l.id)}><Icon name="x" size={10} /></button>
        </span>
      ))}
      {links.from.length > 0 && (
        <span className="hint linked-from">
          Read by {links.from.map((l, i) => <span key={l.id}>{i ? ", " : ""}<a href={workHref(l.work.id)}>{l.work.label}</a></span>)}
        </span>
      )}
    </div>
  );
}

/** New task: pick other work for the new task to read from the start. */
export function LinkChoices({ picked, setPicked }: { picked: string[]; setPicked: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const all = useLinkableWork();
  const shown = all.filter(({ room: w, crew }) => picked.includes(w.root.id)
    || (q.trim() ? `${w.root.label} ${w.root.name} ${crew ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()) : w.root.status !== "done"))
    .slice(0, 12);
  if (!all.length) return null;
  return (
    <div className="field">
      <span style={{ fontWeight: 500 }} id="nt-links">Link other work <span className="hint">(optional; this task can read its progress, conversation and documents)</span></span>
      {all.length > 6 && <input className="text" placeholder="Search work…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search work to link" />}
      <div className="choices" role="group" aria-labelledby="nt-links">
        {shown.map(({ room: w, crew }: { room: WorkRoom; crew: string | null }) => (
          <button key={w.root.id} className="pill" aria-pressed={picked.includes(w.root.id)} title={`${w.root.name}${crew ? ` · ${crew} crew` : ""}`}
            onClick={() => setPicked(picked.includes(w.root.id) ? picked.filter((x) => x !== w.root.id) : [...picked, w.root.id])}>
            <Icon name="web" size={12} /> {w.root.label ?? w.root.name}{crew ? <span className="hint"> · {crew}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
