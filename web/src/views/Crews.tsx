import { useState } from "react";
import { api, type Agent, type Crew } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon } from "../components/ui.tsx";

/** Who a crew's new tasks go to by default (mirrors crews.ts crewLead). */
export function crewLead(crewId: string | null, roles: Agent[], crews: Crew[]) {
  const members = roles.filter((r) => (r.crew_id ?? null) === crewId);
  const chosen = crewId ? crews.find((c) => c.id === crewId)?.lead_role_id : null;
  return members.find((r) => r.id === chosen) ?? members.find((r) => r.can_scale) ?? members[0];
}

/**
 * Crews: separate teams on one agentbox (robotics, software…). Make crews, choose each one's lead, and
 * move agents between them. Agents only see, delegate to and message their own crew.
 */
export function Crews() {
  const { agents, crews, loaded } = useStore();
  const roles = agents.filter((a) => !a.base_agent_id && !a.builtin);
  const loose = roles.filter((r) => !r.crew_id || !crews.some((c) => c.id === r.crew_id));
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    try { await api.createCrew({ name: name.trim(), summary: summary.trim() }); setName(""); setSummary(""); } catch (e: any) { setError(e.message); }
  };
  if (!loaded) return <div className="page" />;
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1>Crews</h1>
          <p className="lede" style={{ marginBottom: 0 }}>
            Separate teams for separate kinds of work. Agents only see, hand work to and message agents in their own crew,
            so a software lead never delegates to the CAD agent. A new task picks a crew first, then who in it (its lead by default).
          </p>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}

        <div className="crew-card">
          <strong>New crew</strong>
          <div className="crew-new">
            <input className="text" placeholder="Name, e.g. Software engineering" value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") create(); }} aria-label="Crew name" />
            <input className="text" placeholder="What it works on (optional)" value={summary} maxLength={300} onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") create(); }} aria-label="What the crew works on" />
            <button className="btn primary" disabled={!name.trim()} onClick={create}><Icon name="plus" size={14} />Create</button>
          </div>
          <span className="hint">Then move agents into it below, or create new ones for it (<a href="#/agents/new">New agent</a> asks which crew).</span>
        </div>

        {crews.map((c) => <CrewCard key={c.id} crew={c} roles={roles} />)}

        {(loose.length > 0 || !crews.length) && (
          <div className="crew-card">
            <div className="crew-head">
              <strong>{crews.length ? "In no crew" : "Your agents"}</strong>
              <span className="hint">{crews.length ? "These work only with each other until you move them into a crew." : "With no crews, every agent works with every other."}</span>
            </div>
            <Members members={loose} crews={crews} />
          </div>
        )}
      </div>
    </div>
  );
}

function CrewCard({ crew, roles }: { crew: Crew; roles: Agent[] }) {
  const { crews } = useStore();
  const members = roles.filter((r) => r.crew_id === crew.id);
  const lead = crewLead(crew.id, roles, crews);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(crew.name);
  const [summary, setSummary] = useState(crew.summary);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); return true; } catch (e: any) { setError(e.message); return false; } };
  return (
    <div className="crew-card">
      {editing ? (
        <div className="crew-new">
          <input className="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Crew name" autoFocus />
          <input className="text" value={summary} maxLength={300} placeholder="What it works on" onChange={(e) => setSummary(e.target.value)} aria-label="What the crew works on" />
          <button className="btn sm ghost" onClick={() => { setEditing(false); setName(crew.name); setSummary(crew.summary); }}>Cancel</button>
          <button className="btn sm primary" onClick={async () => { if (await act(() => api.updateCrew(crew.id, { name, summary }))) setEditing(false); }}>Save</button>
        </div>
      ) : (
        <div className="crew-head">
          <strong>{crew.name}</strong>
          <span className="hint">{crew.summary || `${members.length} agent${members.length === 1 ? "" : "s"}`}</span>
          <span className="grow" />
          <a className="btn sm ghost" href={`#/new/crew:${crew.id}`} title={`New task for ${crew.name}`}>
            <Icon name="plus" size={12} />Task
          </a>
          <button className="icon-btn note-btn" title="Rename" aria-label={`Rename ${crew.name}`} onClick={() => setEditing(true)}><Icon name="edit" size={14} /></button>
          {confirm ? (
            <>
              <button className="btn sm danger" onClick={() => act(() => api.deleteCrew(crew.id))}>Delete crew</button>
              <button className="btn sm ghost" onClick={() => setConfirm(false)}>Keep</button>
            </>
          ) : <button className="icon-btn note-btn" title="Delete crew (its agents stay, in no crew)" aria-label={`Delete ${crew.name}`} onClick={() => setConfirm(true)}><Icon name="x" size={14} /></button>}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {members.length > 0 && (
        <label className="crew-lead">
          <span>Lead <span className="hint">(new tasks go here by default)</span></span>
          <select className="text" value={lead?.id ?? ""} onChange={(e) => act(() => api.updateCrew(crew.id, { lead_role_id: e.target.value || null }))}>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.title}</option>)}
          </select>
        </label>
      )}
      {members.length ? <Members members={members} crews={crews} leadId={lead?.id} /> : <p className="hint" style={{ margin: 0 }}>No agents yet: move some in from another crew, or create one.</p>}
    </div>
  );
}

function Members({ members, crews, leadId }: { members: Agent[]; crews: Crew[]; leadId?: string }) {
  const { agents } = useStore();
  const [error, setError] = useState<string | null>(null);
  if (!members.length) return null;
  return (
    <>
      {error && <div className="error-box">{error}</div>}
      <ul className="crew-members">
        {members.map((m) => {
          const live = agents.filter((a) => a.base_agent_id === m.id).length;
          return (
            <li key={m.id}>
              <Avatar name={m.name} color={m.color} size={24} />
              <a className="crew-member" href={`#/agents/${m.id}`}>
                <strong>{m.name}</strong>
                <span className="hint">{m.title}{m.id === leadId ? " · lead" : ""}{live ? ` · ${live} live task${live === 1 ? "" : "s"}` : ""}</span>
              </a>
              {crews.length > 0 && (
                <select className="text crew-move" aria-label={`Crew for ${m.name}`} value={m.crew_id ?? ""}
                  onChange={(e) => { setError(null); api.setAgentCrew(m.id, e.target.value || null).catch((x) => setError(x.message)); }}>
                  {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="">No crew</option>
                </select>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
