import { useEffect, useState } from "react";
import { api, type Agent } from "../api.ts";
import { Avatar, Icon, Markdown, StatusGlyph, relTime } from "../components/ui.tsx";
import { go } from "../router.ts";
import { useStore } from "../store.tsx";

type Tab = "overview" | "instructions" | "skills" | "memory";

export function AgentPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<{ instructions: string; memory: { file: string; content: string }[] } | null>(null);
  const reload = () => api.agent(agent.id).then((r) => setData({ instructions: r.instructions, memory: r.memory })).catch(() => {});

  useEffect(() => {
    setData(null);
    reload();
  }, [agent.id, tab]);

  return (
    <aside className="panel" aria-label={`${agent.name} details`}>
      <div className="tabs" role="tablist">
        {(["overview", "instructions", "skills", "memory"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <button className="icon-btn" style={{ marginLeft: "auto", alignSelf: "center" }} aria-label="Close details" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === "overview" && <Overview agent={agent} />}
        {tab === "instructions" && data && <Instructions agent={agent} text={data.instructions} onSaved={reload} />}
        {tab === "skills" && <AgentSkills agent={agent} />}
        {tab === "memory" && data && <Memory files={data.memory} agent={agent} />}
      </div>
    </aside>
  );
}

function Overview({ agent }: { agent: Agent }) {
  const { everyone } = useStore();
  const [confirmReset, setConfirmReset] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const base = agent.base_agent_id ? everyone.find((a) => a.id === agent.base_agent_id) : undefined;
  return (
    <>
      {base && (
        <div className="replica-note">
          Replica #{agent.replica_no} of <a href={`#/agents/${base.id}`}>{base.name}</a>. It shares {base.name}'s instructions,
          skills and memory, and takes work in parallel.
        </div>
      )}
      <p>{agent.summary}</p>
      <dl className="kv">
        <dt>Role</dt><dd>{agent.title}</dd>
        <dt>Model</dt>
        <dd>
          {base ? <>{agent.model} <span className="hint">(follows {base.name})</span></> : (
            <select className="text" style={{ padding: "4px 8px" }} value={agent.model} aria-label="Model"
              onChange={(e) => api.updateAgent(agent.id, { model: e.target.value })}>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          )}
        </dd>
        <dt>Max turns</dt><dd>{agent.max_turns} tool rounds per task</dd>
        <dt>Home</dt><dd className="mono">/agents/{base?.slug ?? agent.slug}</dd>
        <dt>Created</dt><dd>{relTime(agent.created_at)}</dd>
      </dl>
      <div className="field">
        <span style={{ fontWeight: 500 }}>Conversation</span>
        <span className="hint">
          {agent.name} remembers this chat across turns. Start fresh when context gets long or off-track; memory files and
          history stay.
        </span>
        {confirmReset ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm danger" onClick={async () => {
              await api.resetSession(agent.id);
              setConfirmReset(false);
              setNote("Next message starts a fresh conversation.");
            }}>Start fresh</button>
            <button className="btn sm ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmReset(true)}>Start a fresh conversation…</button>
        )}
        {note && <span className="hint">{note}</span>}
      </div>
      {!base && <Replicas agent={agent} />}
      {!base && <ScaleSwitch agent={agent} />}
      {base ? <RetireReplica agent={agent} /> : <DeleteAgent agent={agent} />}
    </>
  );
}

function Replicas({ agent }: { agent: Agent }) {
  const { agents, board } = useStore();
  const [error, setError] = useState<string | null>(null);
  const replicas = agents.filter((a) => a.base_agent_id === agent.id);
  const max = agent.max_replicas ?? 0;
  const current = (id: string) => Object.values(board).find((t) => t.agent_id === id && t.status === "running");
  return (
    <div className="field">
      <span style={{ fontWeight: 500 }}>Replicas</span>
      <span className="hint">
        Extra copies of {agent.name} ({agent.name}#1, #2…) that take work in parallel. They share its instructions, skills and
        memory. Each running replica uses VM memory and your Claude plan.
      </span>
      <label className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        At most
        <select className="text" style={{ width: "auto", padding: "2px 6px" }} value={max} aria-label="Maximum replicas"
          onChange={(e) => api.updateAgent(agent.id, { max_replicas: Number(e.target.value) }).catch((er) => setError(er.message))}>
          {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        at a time{max === 0 && " (replicas off)"}
      </label>
      {replicas.length > 0 && (
        <div className="rows">
          {replicas.map((r) => {
            const t = current(r.id);
            return (
              <div key={r.id} className="row" style={{ fontSize: 13, gap: 8 }}>
                <StatusGlyph status={r.status} />
                <a href={`#/agents/${r.id}`} style={{ minWidth: 70 }}>{r.name}</a>
                <span className="hint" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t ? t.title : "idle"}
                </span>
                <button className="btn sm ghost" disabled={r.status === "working"} title={r.status === "working" ? "Busy: wait or stop its task first" : "Retire"}
                  onClick={() => api.retireReplica(r.id).catch((er) => setError(er.message))}>Retire</button>
              </div>
            );
          })}
        </div>
      )}
      <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={replicas.length >= max}
        onClick={() => { setError(null); api.spawnReplica(agent.id).catch((er) => setError(er.message)); }}>
        <Icon name="plus" size={14} />Add replica
      </button>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

function ScaleSwitch({ agent }: { agent: Agent }) {
  return (
    <label className="field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
      <input type="checkbox" checked={!!agent.can_scale} style={{ marginTop: 3 }}
        onChange={(e) => api.updateAgent(agent.id, { can_scale: e.target.checked })} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontWeight: 500 }}>Can scale the team</span>
        <span className="hint">{agent.name} may spawn and retire replicas of agents that allow them (within their limits).</span>
      </span>
    </label>
  );
}

function RetireReplica({ agent }: { agent: Agent }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="field" style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--line)" }}>
      <span className="hint">Retiring removes {agent.name} from the team. Its conversations and tasks stay in the history.</span>
      <button className="btn sm danger" style={{ alignSelf: "flex-start" }} disabled={agent.status === "working"}
        onClick={async () => {
          try { await api.retireReplica(agent.id); go({ name: "agent", id: agent.base_agent_id! }); } catch (e: any) { setError(e.message); }
        }}>Retire {agent.name}</button>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

function DeleteAgent({ agent }: { agent: Agent }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="field" style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--line)" }}>
      {confirm ? (
        <>
          <span className="hint">
            Deletes {agent.name}, its chat history, memory and home folder. Work it pushed to GitHub or elsewhere stays.
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm danger" onClick={async () => {
              try {
                await api.deleteAgent(agent.id);
                go({ name: "home" });
              } catch (e: any) {
                setError(e.message);
              }
            }}>Delete {agent.name}</button>
            <button className="btn sm ghost" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
          {error && <div className="error-box">{error}</div>}
        </>
      ) : (
        <button className="btn sm ghost danger" style={{ alignSelf: "flex-start" }} onClick={() => setConfirm(true)}>Delete agent…</button>
      )}
    </div>
  );
}

function Instructions({ agent, text, onSaved }: { agent: Agent; text: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(text), [text]);
  if (!editing) {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center" }}>
          {agent.base_agent_id ? (
            <span className="hint" style={{ marginRight: "auto" }}>
              Shared with its base agent; edit them on <a href={`#/agents/${agent.base_agent_id}`}>the base agent</a>.
            </span>
          ) : (
            <>
              <span className="hint" style={{ marginRight: "auto" }}>Read by {agent.name}{(agent.max_replicas ?? 0) > 0 && " and its replicas"} at the start of every task.</span>
              <button className="btn sm" onClick={() => setEditing(true)}>Edit</button>
            </>
          )}
        </div>
        <Markdown text={text} />
      </>
    );
  }
  return (
    <>
      <textarea className="text mono" style={{ minHeight: 420 }} value={draft} aria-label="Instructions" onChange={(e) => setDraft(e.target.value)} />
      {error && <div className="error-box">{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary sm" onClick={async () => {
          try {
            await api.saveInstructions(agent.id, draft);
            setEditing(false);
            onSaved();
          } catch (e: any) {
            setError(e.message);
          }
        }}>Save</button>
        <button className="btn ghost sm" onClick={() => { setDraft(text); setEditing(false); }}>Cancel</button>
      </div>
    </>
  );
}

function AgentSkills({ agent }: { agent: Agent }) {
  const { skills } = useStore();
  const [error, setError] = useState<string | null>(null);
  if (agent.base_agent_id) {
    return (
      <>
        <span className="hint">Replicas use their base agent's skills: <a href={`#/agents/${agent.base_agent_id}`}>change them there</a>.</span>
        <div className="rows">{agent.skills.map((n) => <div key={n} className="row"><span className="mono">{n}</span></div>)}</div>
      </>
    );
  }
  const toggle = async (name: string) => {
    setError(null);
    const next = agent.skills.includes(name) ? agent.skills.filter((s) => s !== name) : [...agent.skills, name];
    try { await api.setAgentSkills(agent.id, next); } catch (e: any) { setError(e.message); }
  };
  return (
    <>
      <span className="hint">{agent.name} sees only the skills switched on here, and uses one when a task matches it.</span>
      {error && <div className="error-box">{error}</div>}
      {skills.length === 0 && <span className="hint">The library is empty. <a href="#/skills/new">Create a skill</a>.</span>}
      <div className="rows">
        {skills.map((s) => (
          <label key={s.name} className="row" style={{ alignItems: "flex-start", cursor: "pointer" }}>
            <input type="checkbox" checked={agent.skills.includes(s.name)} onChange={() => toggle(s.name)} style={{ marginTop: 3 }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span className="mono">{s.name}</span>
              <span className="hint">{s.description}</span>
            </span>
          </label>
        ))}
      </div>
      <a href="#/skills" style={{ fontSize: 13 }}>Open the skill library</a>
    </>
  );
}

function Memory({ files, agent }: { files: { file: string; content: string }[]; agent: Agent }) {
  return (
    <>
      <span className="hint">
        What {agent.name} has chosen to remember, in <span className="mono">/agents/{agent.slug}/memory</span>.
      </span>
      {files.map((f) => (
        <details key={f.file} className="memory-file" open={f.file === "MEMORY.md"}>
          <summary>{f.file}</summary>
          <pre>{f.content}</pre>
        </details>
      ))}
    </>
  );
}
