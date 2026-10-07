import { useEffect, useMemo, useState } from "react";
import { api, type ActivityItem, type Agent } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon } from "../components/ui.tsx";

const VERB: Record<string, string> = {
  asked: "was asked", delegated: "was handed", message: "got a message", routine: "started routine", group: "replied in",
  finished: "finished", failed: "failed", stopped: "was stopped on", github: "", skill: "", skipped: "",
};
const TONE: Record<string, string> = { finished: "ok", failed: "bad", stopped: "warn", skipped: "warn", github: "accent", skill: "accent" };

const TYPES = [
  { key: "all", label: "Everything" },
  { key: "work", label: "Requests & handoffs", kinds: ["asked", "delegated", "message", "group", "routine"] },
  { key: "outcomes", label: "Outcomes", kinds: ["finished", "failed", "stopped", "skipped"] },
  { key: "github", label: "GitHub & AWS", kinds: ["github"] },
];

function day(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

function Actor({ id, agents }: { id: string; agents: Agent[] }) {
  if (id === "user") return <span className="avatar you-avatar" style={{ width: 20, height: 20, fontSize: 9 }}>You</span>;
  if (id === "routine") return <span className="avatar you-avatar" style={{ width: 20, height: 20 }}><Icon name="routine" size={12} /></span>;
  const a = agents.find((x) => x.id === id);
  return a ? <Avatar name={a.name} color={a.color} size={20} /> : <span className="avatar you-avatar" style={{ width: 20, height: 20 }} />;
}

export function Activity() {
  const { agents, everyone, activityVersion } = useStore();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [agent, setAgent] = useState("all");
  const [type, setType] = useState("all");
  const [error, setError] = useState<string | null>(null);

  // Refetch on relevant events, at most every 1.5s.
  useEffect(() => {
    const t = setTimeout(() => {
      api.activity(agent === "all" ? undefined : agent).then(setItems).catch((e) => setError(e.message));
    }, items ? 1500 : 0);
    return () => clearTimeout(t);
  }, [agent, activityVersion]);

  const nameOf = (id: string | null) => (id === "user" ? "You" : everyone.find((a) => a.id === id)?.name ?? "deleted agent");
  const shown = useMemo(() => {
    const kinds = TYPES.find((t) => t.key === type)?.kinds;
    return (items ?? []).filter((i) => !kinds || kinds.includes(i.kind));
  }, [items, type]);

  let lastDay = "";
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 900 }}>
        <h1>Activity</h1>
        <p className="lede">What the team has been doing, newest first. Updates live.</p>
        <div className="toolbar board-filters">
          <label className="hint" htmlFor="a-agent">Agent</label>
          <select id="a-agent" className="text" style={{ width: "auto", padding: "4px 8px" }} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="all">Everyone</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <div className="segmented" role="group" aria-label="Show">
            {TYPES.map((t) => <button key={t.key} aria-pressed={type === t.key} onClick={() => setType(t.key)}>{t.label}</button>)}
          </div>
        </div>
        {error && <div className="error-box">{error}</div>}
        {items && shown.length === 0 && <p className="hint">Nothing yet. Activity appears here as soon as an agent starts work.</p>}
        <ol className="feed">
          {shown.map((i) => {
            const d = day(i.ts);
            const header = d !== lastDay ? (lastDay = d) : null;
            const href = i.link ?? (i.task_id ? `#/tasks/${i.task_id}` : undefined);
            const who = nameOf(i.agent_id);
            const sentence =
              i.kind === "github" || i.kind === "skill" || i.kind === "skipped" ? <><strong>{who}</strong> {i.title}</>
              : i.kind === "delegated" ? <><strong>{nameOf(i.actor)}</strong> handed <strong>{who}</strong> “{i.title}”</>
              : i.kind === "asked" ? <><strong>You</strong> asked <strong>{who}</strong>: “{i.title}”</>
              : i.kind === "message" ? <><strong>{nameOf(i.actor)}</strong> messaged <strong>{who}</strong></>
              : i.kind === "group" ? <><strong>{who}</strong> was brought into {i.detail}</>
              : i.kind === "routine" ? <><strong>{who}</strong> started a routine: {i.title.replace(/^Routine: /, "")}</>
              : <><strong>{who}</strong> {VERB[i.kind]} “{i.title}”</>;
            return (
              <li key={i.id}>
                {header && <h2 className="feed-day">{header}</h2>}
                <a className="feed-row" href={href}>
                  <time dateTime={i.ts}>{new Date(i.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  <Actor id={i.kind === "delegated" || i.kind === "message" || i.kind === "asked" || i.kind === "routine" ? i.actor : i.agent_id ?? "user"} agents={everyone} />
                  <span className={`feed-kind ${TONE[i.kind] ?? ""}`}>{i.kind === "github" ? <Icon name="tool" size={12} /> : null}{i.kind}</span>
                  <span className="feed-text">
                    <span>{sentence}</span>
                    {i.detail && i.kind !== "group" && <span className="feed-detail">{i.detail}</span>}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
