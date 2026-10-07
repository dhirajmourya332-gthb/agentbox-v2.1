import { useEffect, useState } from "react";
import { api, type Agent } from "../api.ts";
import { Icon, Markdown, relTime } from "../components/ui.tsx";
import { go } from "../router.ts";

type Tab = "overview" | "instructions" | "memory";

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
        {(["overview", "instructions", "memory"] as Tab[]).map((t) => (
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
        {tab === "memory" && data && <Memory files={data.memory} agent={agent} />}
      </div>
    </aside>
  );
}

function Overview({ agent }: { agent: Agent }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <p>{agent.summary}</p>
      <dl className="kv">
        <dt>Role</dt><dd>{agent.title}</dd>
        <dt>Model</dt>
        <dd>
          <select className="text" style={{ padding: "4px 8px" }} value={agent.model} aria-label="Model"
            onChange={(e) => api.updateAgent(agent.id, { model: e.target.value })}>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
        </dd>
        <dt>Max turns</dt><dd>{agent.max_turns} tool rounds per task</dd>
        <dt>Home</dt><dd className="mono">/agents/{agent.slug}</dd>
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
      <DeleteAgent agent={agent} />
    </>
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
          <span className="hint" style={{ marginRight: "auto" }}>Read by {agent.name} at the start of every task.</span>
          <button className="btn sm" onClick={() => setEditing(true)}>Edit</button>
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
