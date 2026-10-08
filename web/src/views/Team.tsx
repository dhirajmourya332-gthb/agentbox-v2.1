import { useStore } from "../store.tsx";
import { Avatar, Icon, StatusGlyph, relTime } from "../components/ui.tsx";

/** Overview: what's in progress, and who's on the team. */
export function Team() {
  const { agents, loaded, work } = useStore();
  if (!loaded) return <div className="page" />;
  const roles = agents.filter((a) => !a.base_agent_id);
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1000 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h1>Overview</h1>
            <p className="lede">What your team is working on. Each task has its own conversation; bigger ones grow into task rooms.</p>
          </div>
          {roles.length > 0 && <a className="btn primary" href="#/new"><Icon name="plus" />New task</a>}
        </div>

        <h2>In progress</h2>
        {work.live.length === 0 ? (
          <div className="group-intro">
            <p>Nothing in progress.</p>
            <p className="hint">{roles.length ? <>Start one with <a href="#/new">New task</a>.</> : <>First, <a href="#/agents/new">create an agent</a>.</>}</p>
          </div>
        ) : (
          <div className="cards">
            {work.live.map((w) => {
              const isRoom = w.members.length > 1;
              const working = w.members.filter((m) => m.status === "working").length;
              return (
                <a key={w.root.id} className={`card${isRoom ? " room-card" : ""}`} href={isRoom ? `#/work/${w.root.id}` : `#/agents/${w.root.id}`}>
                  <div className="who">
                    {isRoom ? <span className="room-mark"><Icon name="room" size={16} /></span> : <StatusGlyph status={w.root.status as any} />}
                    <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.root.label ?? w.root.name}</strong>
                  </div>
                  <div className="sub">
                    {isRoom ? `${w.members.length} tasks · ${working} working` : `${w.root.name}${w.root.current ? ` · ${w.root.current}` : ""}`}
                  </div>
                  {isRoom && (
                    <div className="member-strip">
                      {w.members.map((m) => (
                        <span key={m.id} className="member-pill" title={`${m.label} · ${m.name} · ${m.status}`}>
                          <span className={`glyph ${m.status === "done" ? "done" : m.status}`} />{m.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="hint">Last activity {w.last_activity ? relTime(w.last_activity) : "—"}</span>
                </a>
              );
            })}
          </div>
        )}

        <h2>Team</h2>
        <div className="cards">
          {roles.map((a) => {
            const live = agents.filter((x) => x.base_agent_id === a.id);
            const working = live.filter((x) => x.status === "working").length;
            return (
              <div key={a.id} className="card">
                <a className="who" href={`#/agents/${a.id}`} style={{ color: "var(--text)", textDecoration: "none" }}>
                  <Avatar name={a.name} color={a.color} size={32} />
                  <div style={{ minWidth: 0 }}>
                    <strong>{a.name}</strong>
                    <div className="sub">{a.title}</div>
                  </div>
                </a>
                <div className="sub">{a.summary}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="hint" style={{ marginRight: "auto" }}>
                    {live.length ? `${live.length} live task${live.length > 1 ? "s" : ""}${working ? ` · ${working} working` : ""}` : "No live tasks"}
                  </span>
                  <a className="btn sm" href={`#/new/${a.id}`}>New task</a>
                </div>
              </div>
            );
          })}
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
