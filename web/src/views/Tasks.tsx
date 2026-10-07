import { useEffect, useMemo, useState } from "react";
import { api, type Agent, type GraphEdge, type Step, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, Markdown, Spinner, duration, relTime } from "../components/ui.tsx";

const COLUMNS: { key: string; label: string; match: (t: Task) => boolean }[] = [
  { key: "queued", label: "Queued", match: (t) => t.status === "queued" },
  { key: "running", label: "Running", match: (t) => t.status === "running" },
  { key: "done", label: "Done", match: (t) => t.status === "done" },
  { key: "failed", label: "Failed / stopped", match: (t) => t.status === "failed" || t.status === "stopped" },
];

const SOURCE: Record<string, string> = { user: "From you", agent: "Delegated", message: "Message", result: "Report", cron: "Scheduled" };

const titleOf = (t: Task) => t.title || "(untitled)";

function Who({ agent }: { agent?: Agent }) {
  return agent ? <Avatar name={agent.name} color={agent.color} size={20} /> : <span className="avatar you-avatar" style={{ width: 20, height: 20 }} />;
}

export function TaskBoard({ selected }: { selected?: string }) {
  const { board, agents, everyone, loaded } = useStore();
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [showReports, setShowReports] = useState(false);
  const [view, setView] = useState<"board" | "graph">("board");
  const byId = (id: string | null) => everyone.find((a) => a.id === id);

  const tasks = useMemo(
    () => Object.values(board)
      .filter((t) => showReports || (t.source !== "result" && t.source !== "message"))
      .filter((t) => agentFilter === "all" || t.agent_id === agentFilter)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [board, agentFilter, showReports],
  );

  if (!loaded) return <div className="page" />;
  return (
    <>
      <div className="page" style={{ minWidth: 0 }}>
        <div className="page-inner" style={{ maxWidth: 1240 }}>
          <h1>Tasks</h1>
          <p className="lede">Everything agents are working on: your requests, handoffs between agents, and scheduled runs.</p>
          <div className="toolbar board-filters">
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
              <button aria-pressed={view === "graph"} onClick={() => setView("graph")}>Graph</button>
            </div>
            <label className="hint" htmlFor="tf-agent">Agent</label>
            <select id="tf-agent" className="text" style={{ width: "auto", padding: "4px 8px" }} value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}>
              <option value="all">Everyone</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <label className="hint" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={showReports} onChange={(e) => setShowReports(e.target.checked)} />
              Show reports and messages
            </label>
          </div>
          {view === "graph" && <DelegationGraph onPick={(id) => { setAgentFilter(id); setView("board"); }} />}
          {view === "board" && <div className="board">
            {COLUMNS.map((c) => {
              const list = tasks.filter(c.match);
              return (
                <section key={c.key} className="board-col" aria-label={c.label}>
                  <h2>{c.label} <span className="hint">{list.length}</span></h2>
                  {list.length === 0 && <p className="hint" style={{ padding: "4px 2px" }}>Nothing here.</p>}
                  {list.slice(0, 60).map((t) => {
                    const agent = byId(t.agent_id);
                    const from = byId(t.from_agent_id);
                    return (
                      <a key={t.id} href={`#/tasks/${t.id}`} className="task-card" aria-current={selected === t.id ? "true" : undefined}>
                        <span className="task-title">{titleOf(t)}</span>
                        <span className="task-meta">
                          <Who agent={agent} />
                          <span className="task-who">{agent?.name ?? "deleted"}</span>
                          {t.status === "running" ? <Spinner /> : null}
                          <time dateTime={t.created_at}>{relTime(t.created_at)}</time>
                        </span>
                        <span className="task-source">
                          {from ? `from ${from.name}` : SOURCE[t.source] ?? t.source}
                          {(t.children ?? 0) > 0 && <> · <Icon name="delegate" size={12} /> {t.children} handed off</>}
                        </span>
                      </a>
                    );
                  })}
                </section>
              );
            })}
          </div>}
        </div>
      </div>
      {selected && <TaskDetail key={selected} id={selected} />}
    </>
  );
}

function TaskDetail({ id }: { id: string }) {
  const { agents, everyone, board } = useStore();
  const [data, setData] = useState<{ task: Task; tree: Task[]; steps: Step[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = board[id];
  useEffect(() => {
    api.task(id).then(setData).catch((e) => setError(e.message));
  }, [id, live?.status]);

  const byId = (aid: string | null) => everyone.find((a) => a.id === aid);
  if (error) return <aside className="panel"><div className="panel-body"><div className="error-box">{error}</div></div></aside>;
  if (!data) return <aside className="panel" />;
  const { task, tree, steps } = data;
  const agent = byId(task.agent_id);
  const roots = tree.filter((t) => !t.parent_task_id || !tree.some((x) => x.id === t.parent_task_id));

  return (
    <aside className="panel" aria-label="Task details">
      <div className="tabs" style={{ alignItems: "center" }}>
        <span style={{ padding: "10px 0", fontWeight: 600, fontSize: 13 }}>Task</span>
        <a className="icon-btn" style={{ marginLeft: "auto" }} href="#/tasks" aria-label="Close task"><Icon name="close" /></a>
      </div>
      <div className="panel-body">
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{titleOf(task)}</h2>
          <p className="hint" style={{ marginTop: 4 }}>{SOURCE[task.source] ?? task.source} · {task.status}</p>
        </div>
        <dl className="kv">
          <dt>Assignee</dt>
          <dd style={{ display: "flex", gap: 6, alignItems: "center" }}><Who agent={agent} />{agent?.name ?? "deleted"}</dd>
          {task.from_agent_id && (<><dt>From</dt><dd>{byId(task.from_agent_id)?.name ?? "deleted"}</dd></>)}
          <dt>Created</dt><dd>{relTime(task.created_at)}</dd>
          {task.started_at && (<><dt>Ran for</dt><dd>{duration(task.started_at, task.finished_at)}</dd></>)}
          <dt>Steps</dt><dd>{steps.filter((s) => s.kind !== "meta").length}</dd>
        </dl>
        <a className="btn sm" style={{ alignSelf: "flex-start" }}
          href={agent ? (agent.dm_thread_id === task.thread_id ? `#/agents/${agent.id}` : `#/agents/${agent.id}/threads/${task.thread_id}`) : "#/tasks"}>
          Open the conversation
        </a>

        {tree.length > 1 && (
          <div className="field">
            <span style={{ fontWeight: 500 }}>Delegation chain</span>
            <ul className="tree">{roots.map((r) => <TreeNode key={r.id} task={r} tree={tree} current={task.id} />)}</ul>
          </div>
        )}

        {task.error && <div className="error-box">{task.error}</div>}
        {task.result && (
          <div className="field">
            <span style={{ fontWeight: 500 }}>{task.source === "agent" ? "Report" : "Reply"}</span>
            <div className="preview-box" style={{ maxHeight: 360 }}><Markdown text={task.result} /></div>
          </div>
        )}
        {task.prompt && (
          <details className="memory-file">
            <summary>What the agent was asked</summary>
            <pre>{task.prompt}</pre>
          </details>
        )}
        {(task.status === "running" || task.status === "queued") && (
          <button className="btn sm danger" style={{ alignSelf: "flex-start" }} onClick={() => api.stop(task.id)}>
            <Icon name="stop" size={14} />{task.status === "queued" ? "Cancel" : "Stop"}
          </button>
        )}
      </div>
    </aside>
  );
}

function TreeNode({ task, tree, current }: { task: Task; tree: Task[]; current: string }) {
  const { agents, everyone } = useStore();
  const kids = tree.filter((t) => t.parent_task_id === task.id);
  const agent = everyone.find((a) => a.id === task.agent_id);
  const state = task.status === "done" ? "✓" : task.status === "running" ? "…" : task.status === "queued" ? "○" : "✕";
  return (
    <li>
      <a href={`#/tasks/${task.id}`} aria-current={task.id === current ? "true" : undefined}>
        <span className={`tree-state ${task.status}`} aria-label={task.status}>{state}</span>
        <Who agent={agent} />
        <span className="tree-title">{titleOf(task)}</span>
      </a>
      {kids.length > 0 && <ul>{kids.map((k) => <TreeNode key={k.id} task={k} tree={tree} current={current} />)}</ul>}
    </li>
  );
}

// ---------------------------------------------------------------------------

const WINDOWS = [
  { key: "24h", label: "24 hours", ms: 86400000 },
  { key: "7d", label: "7 days", ms: 7 * 86400000 },
  { key: "30d", label: "30 days", ms: 30 * 86400000 },
  { key: "all", label: "All time", ms: 0 },
];

/** Who hands work to whom: you, routines and agents as nodes; edge width is the number of tasks. */
function DelegationGraph({ onPick }: { onPick: (agentId: string) => void }) {
  const { agents, everyone, activityVersion } = useStore();
  const [win, setWin] = useState("7d");
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  useEffect(() => {
    const ms = WINDOWS.find((w) => w.key === win)!.ms;
    const since = ms ? new Date(Date.now() - ms).toISOString() : "";
    api.graph(since).then((g) => setEdges(g.edges)).catch(() => {});
  }, [win, activityVersion]);

  const W = 760, H = 460, cx = W / 2, cy = H / 2 + 10, R = 165;
  const usesRoutine = edges.some((e) => e.from === "routine");
  const ids = ["user", ...(usesRoutine ? ["routine"] : []), ...agents.map((a) => a.id)];
  const pos = new Map(ids.map((id, i) => {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / ids.length;
    return [id, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) }];
  }));
  const label = (id: string) => (id === "user" ? "You" : id === "routine" ? "Routines" : everyone.find((a) => a.id === id)?.name ?? "?");
  const color = (id: string) => (id === "user" ? "var(--line-strong)" : id === "routine" ? "var(--line-strong)" : everyone.find((a) => a.id === id)?.color ?? "var(--muted)");
  const max = Math.max(1, ...edges.map((e) => e.n));
  const visible = edges.filter((e) => pos.has(e.from) && pos.has(e.to) && e.from !== e.to);

  return (
    <div className="graph">
      <div className="toolbar" style={{ border: 0, background: "none", padding: "0 0 8px" }}>
        <span className="hint">Window</span>
        <div className="segmented" role="group" aria-label="Time window">
          {WINDOWS.map((w) => <button key={w.key} aria-pressed={win === w.key} onClick={() => setWin(w.key)}>{w.label}</button>)}
        </div>
        <span className="hint spacer">Arrow width = number of tasks. Click an agent to see its tasks.</span>
      </div>
      {visible.length === 0 ? (
        <p className="hint" style={{ padding: 24 }}>No requests or handoffs in this window.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Delegation graph" style={{ width: "100%", maxWidth: W }}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--muted)" />
            </marker>
          </defs>
          {visible.map((e) => {
            const a = pos.get(e.from)!, b = pos.get(e.to)!;
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
            // Curve each edge a little so A→B and B→A don't overlap.
            const nx = -dy / len, ny = dx / len, bend = 24;
            const sx = a.x + (dx / len) * 30, sy = a.y + (dy / len) * 30;
            const ex = b.x - (dx / len) * 34, ey = b.y - (dy / len) * 34;
            const mx = (sx + ex) / 2 + nx * bend, my = (sy + ey) / 2 + ny * bend;
            const w = 1.5 + (5 * e.n) / max;
            return (
              <g key={`${e.from}-${e.to}-${e.kind}`}>
                <path d={`M${sx},${sy} Q${mx},${my} ${ex},${ey}`} fill="none" stroke={e.kind === "delegated" ? "var(--accent)" : "var(--muted)"}
                  strokeOpacity={0.75} strokeWidth={w} strokeDasharray={e.kind === "message" ? "4 4" : undefined} markerEnd="url(#arrow)" />
                <text x={mx} y={my - 6} textAnchor="middle" fontSize="12" fill="var(--text)">{e.n}</text>
                <title>{`${label(e.from)} → ${label(e.to)}: ${e.n} ${e.kind}`}</title>
              </g>
            );
          })}
          {ids.map((id) => {
            const p = pos.get(id)!;
            const isAgent = id !== "user" && id !== "routine";
            return (
              <g key={id} className={isAgent ? "graph-node clickable" : "graph-node"} transform={`translate(${p.x},${p.y})`}
                onClick={isAgent ? () => onPick(id) : undefined} role={isAgent ? "button" : undefined}
                tabIndex={isAgent ? 0 : undefined} aria-label={isAgent ? `Show ${label(id)}'s tasks` : undefined}
                onKeyDown={isAgent ? (ev) => { if (ev.key === "Enter") onPick(id); } : undefined}>
                <circle r="24" fill={color(id)} stroke="var(--bg)" strokeWidth="3" />
                <text y="5" textAnchor="middle" fontSize="13" fontWeight="600" fill={isAgent ? "#0E0F12" : "var(--text)"}>
                  {id === "user" ? "You" : id === "routine" ? "⏱" : label(id).slice(0, 1).toUpperCase()}
                </text>
                {id !== "user" && <text y="44" textAnchor="middle" fontSize="12.5" fill="var(--text)">{label(id)}</text>}
              </g>
            );
          })}
        </svg>
      )}
      <ul className="sr-only">
        {visible.map((e) => <li key={`${e.from}-${e.to}-${e.kind}`}>{label(e.from)} → {label(e.to)}: {e.n} {e.kind}</li>)}
      </ul>
      <p className="hint" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span><span className="legend-line accent" /> delegated</span>
        <span><span className="legend-line" /> asked by you / routine</span>
        <span><span className="legend-line dashed" /> message</span>
      </p>
    </div>
  );
}
