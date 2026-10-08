import { useEffect, useState } from "react";
import { api, type Agent } from "../api.ts";
import { Avatar, Icon, Markdown, StatusGlyph, relTime } from "../components/ui.tsx";
import { go } from "../router.ts";
import { useStore } from "../store.tsx";
import { AgentDocuments } from "./Documents.tsx";

type Tab = "overview" | "documents" | "instructions" | "skills" | "memory";




export function ScaleSwitch({ agent }: { agent: Agent }) {
  return (
    <label className="field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
      <input type="checkbox" checked={!!agent.can_scale} style={{ marginTop: 3 }}
        onChange={(e) => api.updateAgent(agent.id, { can_scale: e.target.checked })} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontWeight: 500 }}>Plans and delegates</span>
        <span className="hint">{agent.name} splits work and starts tasks for other agents (several at once), and finishes them when they're done. Only you start {agent.name} tasks.</span>
      </span>
    </label>
  );
}


export function DeleteAgent({ agent }: { agent: Agent }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="field" style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--line)" }}>
      {confirm ? (
        <>
          <span className="hint">
            Deletes {agent.name} with all its tasks and their history, its memory and home folder. Work it pushed to GitHub or elsewhere stays.
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

export function Instructions({ agent, text, onSaved }: { agent: Agent; text: string; onSaved: () => void }) {
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
        <Markdown text={text} home={agent.home} />
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

export function AgentSkills({ agent }: { agent: Agent }) {
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

export function Memory({ files, agent }: { files: { file: string; content: string }[]; agent: Agent }) {
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

// ---------------------------------------------------------------------------
// A task's (instance's) side panel: what it is and what it produced.

export function TaskPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "documents">("overview");
  return (
    <aside className="panel" aria-label="Task details">
      <div className="tabs" role="tablist">
        {(["overview", "documents"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : "Documents"}
          </button>
        ))}
        <button className="icon-btn" style={{ marginLeft: "auto", alignSelf: "center" }} aria-label="Close details" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === "overview" && <TaskOverview agent={agent} />}
        {tab === "documents" && <AgentDocuments agent={agent} />}
      </div>
    </aside>
  );
}

function TaskOverview({ agent }: { agent: Agent }) {
  const { agents, everyone, board } = useStore();
  const role = everyone.find((a) => a.id === agent.base_agent_id);
  const children = agents.filter((a) => a.parent_instance_id === agent.id);
  const current = Object.values(board).find((t) => t.agent_id === agent.id && t.status === "running");
  const [note, setNote] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <>
      <dl className="kv">
        <dt>Agent</dt><dd>{role ? <a href={`#/agents/${role.id}`}>{role.name}</a> : "—"} <span className="hint">({agent.name})</span></dd>
        <dt>Status</dt><dd>{agent.retired_at ? `Done ${relTime(agent.retired_at)}` : current ? `Working: ${current.title}` : agent.status === "idle" ? "Idle, waiting for you" : agent.status}</dd>
        <dt>Started</dt><dd>{relTime(agent.created_at)}</dd>
        <dt>Model</dt><dd>{agent.model} <span className="hint">(set on the agent)</span></dd>
      </dl>
      {children.length > 0 && (
        <div className="field">
          <span style={{ fontWeight: 500 }}>Tasks it started</span>
          <div className="rows">
            {children.map((c) => (
              <a key={c.id} className="row skill-row" href={`#/agents/${c.id}`} style={{ fontSize: 13 }}>
                <StatusGlyph status={c.status} />
                <span className="desc" style={{ color: "var(--text)" }}>{c.label ?? c.name}</span>
                <span className="hint">{c.name}</span>
              </a>
            ))}
          </div>
          <a href={`#/work/${agent.id}`} style={{ fontSize: 13 }}>Open the task room</a>
        </div>
      )}
      <p className="hint">
        Instructions, skills and memory belong to {role ? <a href={`#/agents/${role.id}`}>{role.name}</a> : "the agent"} and are shared by all its tasks.
      </p>
      {!agent.retired_at && (
        <div className="field">
          <span style={{ fontWeight: 500 }}>Conversation</span>
          <span className="hint">If the context gets long or off-track, start this task's conversation fresh. History and memory stay.</span>
          {confirmReset ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn sm danger" onClick={async () => { await api.resetSession(agent.id); setConfirmReset(false); setNote("The next message starts fresh."); }}>Start fresh</button>
              <button className="btn sm ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
            </div>
          ) : (
            <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmReset(true)}>Start the conversation fresh…</button>
          )}
          {note && <span className="hint">{note}</span>}
        </div>
      )}
    </>
  );
}
