import { useEffect, useState } from "react";
import { api, type Agent } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, StatusGlyph, relTime } from "../components/ui.tsx";
import { AgentSkills, DeleteAgent, Instructions, Memory, ScaleSwitch } from "./AgentPanel.tsx";
import { AgentDocuments } from "./Documents.tsx";

type Tab = "tasks" | "instructions" | "skills" | "memory" | "documents" | "settings";
const TABS: { key: Tab; label: string }[] = [
  { key: "tasks", label: "Tasks" },
  { key: "instructions", label: "Instructions" },
  { key: "skills", label: "Skills" },
  { key: "memory", label: "Memory" },
  { key: "documents", label: "Documents" },
  { key: "settings", label: "Settings" },
];

/** An agent (role): what it is, its live tasks, and everything its tasks share. */
export function RolePage({ role }: { role: Agent }) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [data, setData] = useState<{ instructions: string; memory: { file: string; content: string }[] } | null>(null);
  const reload = () => api.agent(role.id).then((r) => setData({ instructions: r.instructions, memory: r.memory })).catch(() => {});
  useEffect(() => { reload(); }, [role.id, tab]);

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 920 }}>
        <div className="role-head">
          <Avatar name={role.name} color={role.color} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0 }}>{role.name}</h1>
            <p className="hint" style={{ marginTop: 2 }}>{role.title} · {role.model}</p>
          </div>
          <a className="btn primary" href={`#/new/${role.id}`}><Icon name="plus" />New task</a>
        </div>
        <p className="lede" style={{ marginTop: 12 }}>{role.summary}</p>

        <nav className="tabs page-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </nav>
        <div className="role-body" role="tabpanel">
          {tab === "tasks" && <RoleTasks role={role} />}
          {tab === "instructions" && data && <Instructions agent={role} text={data.instructions} onSaved={reload} />}
          {tab === "skills" && <AgentSkills agent={role} />}
          {tab === "memory" && data && <Memory files={data.memory} agent={role} />}
          {tab === "documents" && <AgentDocuments agent={role} />}
          {tab === "settings" && <RoleSettings role={role} />}
        </div>
      </div>
    </div>
  );
}

function RoleTasks({ role }: { role: Agent }) {
  const { agents, everyone, board, work } = useStore();
  const live = agents.filter((a) => a.base_agent_id === role.id);
  const current = (id: string) => Object.values(board).find((t) => t.agent_id === id && t.status === "running")?.title;
  const starter = (a: Agent) => {
    const by = a.created_by ?? "";
    if (by === "owner") return "you";
    if (by.startsWith("routine:")) return "a routine";
    if (by.startsWith("group:")) return "a group";
    return everyone.find((x) => x.id === by)?.name ?? "—";
  };
  const done = work.done.flatMap((w) => w.members).filter((m) => m.role_id === role.id);
  return (
    <>
      {live.length === 0 ? (
        <div className="group-intro">
          <p>No live tasks.</p>
          <p className="hint">Start one with <strong>New task</strong>, or let tech-lead hand {role.name} work. Each task gets its own conversation.</p>
        </div>
      ) : (
        <div className="rows">
          {live.map((a) => (
            <a key={a.id} className="row task-line" href={`#/agents/${a.id}`}>
              <StatusGlyph status={a.status} />
              <span className="task-line-main">
                <span>{a.label ?? a.name}</span>
                <span className="hint">{current(a.id) ?? (a.status === "idle" ? "idle" : a.status)}</span>
              </span>
              <span className="hint task-line-meta">{a.name} · by {starter(a)} · {relTime(a.created_at)}</span>
            </a>
          ))}
        </div>
      )}
      {done.length > 0 && (
        <>
          <h2>Done recently</h2>
          <div className="rows">
            {done.map((m) => (
              <a key={m.id} className="row task-line" href={`#/agents/${m.id}`}>
                <span className="status"><span className="glyph" style={{ borderColor: "var(--ok)", background: "var(--ok)" }} /></span>
                <span className="task-line-main"><span>{m.label ?? m.name}</span></span>
                <span className="hint task-line-meta">{m.name} · done {m.retired_at ? relTime(m.retired_at) : ""}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function RoleSettings({ role }: { role: Agent }) {
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Parameters<typeof api.updateAgent>[1]) => api.updateAgent(role.id, p).catch((e) => setError(e.message));
  return (
    <div style={{ display: "grid", gap: 20, maxWidth: 560 }}>
      {error && <div className="error-box">{error}</div>}
      <div className="field">
        <label htmlFor="rs-model">Model</label>
        <select id="rs-model" className="text" style={{ maxWidth: 240 }} value={role.model} onChange={(e) => patch({ model: e.target.value })}>
          <option value="opus">Opus — best judgement</option>
          <option value="sonnet">Sonnet — strong all-rounder</option>
          <option value="haiku">Haiku — fast, light</option>
        </select>
        <span className="hint">Used by every {role.name} task from its next turn.</span>
      </div>
      <div className="field">
        <label htmlFor="rs-cap">Tasks another agent may run at once</label>
        <select id="rs-cap" className="text" style={{ maxWidth: 120 }} value={role.max_replicas || 5}
          onChange={(e) => patch({ max_replicas: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="hint">For example, how many {role.name} tasks one tech-lead task can have going in parallel. Your own tasks aren't limited.</span>
      </div>
      <ScaleSwitch agent={role} />
      <DeleteAgent agent={role} />
    </div>
  );
}
