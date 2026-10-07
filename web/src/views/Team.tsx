import { useStore } from "../store.tsx";
import { Avatar, Icon, StatusGlyph } from "../components/ui.tsx";

export function Team() {
  const { agents, loaded } = useStore();
  if (!loaded) return <div className="page" />;
  return (
    <div className="page">
      <div className="page-inner">
        <h1>Team</h1>
        <p className="lede">
          {agents.length
            ? "Your agents and what they're doing. Open one to chat, or hire another."
            : "No agents yet. Each agent gets a role, its own memory and chat history, and full use of the shared computer."}
        </p>
        <div className="cards">
          {agents.map((a) => (
            <a key={a.id} className="card" href={`#/agents/${a.id}`}>
              <div className="who">
                <Avatar name={a.name} color={a.color} size={32} />
                <div style={{ minWidth: 0 }}>
                  <strong>{a.name}</strong>
                  <div className="sub">{a.base_agent_id ? `Replica of ${agents.find((x) => x.id === a.base_agent_id)?.name ?? "?"}` : a.title}</div>
                </div>
              </div>
              <div className="sub">{a.summary}</div>
              <StatusGlyph status={a.status} withLabel />
            </a>
          ))}
          <a className="card new" href="#/agents/new">
            <Icon name="plus" size={20} />
            <strong style={{ color: "var(--text)" }}>New agent</strong>
            <span className="sub">Answer a few questions and Claude drafts its job description.</span>
          </a>
        </div>
      </div>
    </div>
  );
}
