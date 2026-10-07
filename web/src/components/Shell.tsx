import { useEffect, useState, type ReactNode } from "react";
import { api, type Usage } from "../api.ts";
import { useStore } from "../store.tsx";
import { href, type Route } from "../router.ts";
import { Avatar, Icon, StatusGlyph } from "./ui.tsx";
import { PauseControl, PausedBar, ScreenPip } from "./Controls.tsx";

function UsageChip({ usage }: { usage: Usage | null }) {
  if (!usage) return null;
  const w = usage.unifiedWindows ?? {};
  const five = w.five_hour?.utilization;
  const week = w.seven_day?.utilization;
  const pct = (n?: number) => (n === undefined ? "–" : `${Math.round(n * 100)}%`);
  const resets = (t?: number) => (t ? new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const rejected = usage.status === "rejected";
  const high = Math.max(five ?? 0, week ?? 0) >= 0.8;
  const tone = rejected ? "bad" : high ? "warn" : "";
  const title = [
    `5-hour window: ${pct(five)}${w.five_hour ? ` · resets ${resets(w.five_hour.resetsAt)}` : ""}`,
    `7-day window: ${pct(week)}${w.seven_day ? ` · resets ${resets(w.seven_day.resetsAt)}` : ""}`,
  ].join("\n");
  return (
    <span className={`chip ${tone}`} title={title}>
      <span className={`dot ${tone || "ok"}`} />
      {rejected ? (
        <>Claude limited · resumes {resets(usage.resetsAt)}</>
      ) : (
        <>Claude {pct(five)}<span className="long">&nbsp;· week {pct(week)}</span></>
      )}
    </span>
  );
}

function VmChip() {
  const { connected } = useStore();
  const [issues, setIssues] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api.health()
        .then((h) => {
          const down = Object.values(h.services).filter((s) => s !== "active").length + (h.browser.ok ? 0 : 1);
          if (alive) setIssues(down);
        })
        .catch(() => alive && setIssues(-1));
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const bad = !connected || issues === -1;
  const warn = !bad && (issues ?? 0) > 0;
  const label = bad ? "VM unreachable" : issues === null ? "VM…" : warn ? `VM ${issues} issue${issues > 1 ? "s" : ""}` : "VM ok";
  return (
    <a className={`chip ${bad ? "bad" : warn ? "warn" : ""}`} href="#/system" style={{ textDecoration: "none" }}>
      <span className={`dot ${bad ? "bad" : warn ? "warn" : "ok"}`} />
      {label}
    </a>
  );
}

function RailLink({ to, current, icon, children, replica }: { to: Route; current: Route; icon?: ReactNode; children: ReactNode; replica?: boolean }) {
  const skillsArea = ["skills", "skill", "new-skill", "draft"];
  const active = to.name === "routines"
    ? ["routines", "routine", "new-routine"].includes(current.name)
    : to.name === "group"
    ? (current.name === "group" || current.name === "group-settings") && current.id === to.id
    : to.name === "skills"
    ? skillsArea.includes(current.name)
    : to.name === current.name && (to.name !== "agent" || (current.name === "agent" && current.id === to.id));
  return (
    <a className={replica ? "item replica" : "item"} href={href(to)} aria-current={active ? "page" : undefined}>
      {icon}
      {children}
    </a>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { agents, usage, drafts, board, groups } = useStore();
  const running = Object.values(board).filter((t) => t.status === "running" || t.status === "queued").length;
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">a</span>agentbox
        </a>
        <UsageChip usage={usage} />
        <VmChip />
        <PauseControl />
      </header>
      <div className="bar-slot"><PausedBar /></div>

      <nav className="rail" aria-label="Main">
        <RailLink to={{ name: "home" }} current={route} icon={<Icon name="team" />}>Team</RailLink>
        <RailLink to={{ name: "activity" }} current={route} icon={<Icon name="activity" />}>Activity</RailLink>
        <RailLink to={{ name: "tasks" }} current={route} icon={<Icon name="board" />}>
          <span className="grow">Tasks</span>
          {running > 0 && <span className="count" title={`${running} running or queued`}>{running}</span>}
        </RailLink>

        <RailLink to={{ name: "routines" }} current={route} icon={<Icon name="routine" />}>Routines</RailLink>

        <div className="rail-section">
          <span className="rail-label">Agents</span>
          <a className="icon-btn" href="#/agents/new" aria-label="New agent" title="New agent"><Icon name="plus" /></a>
        </div>
        {agents.map((a) => (
          <RailLink key={a.id} to={{ name: "agent", id: a.id }} current={route} replica={!!a.base_agent_id}
            icon={a.base_agent_id
              ? <span className="replica-mark" style={{ borderColor: a.color }}>{a.replica_no}</span>
              : <Avatar name={a.name} color={a.color} size={20} />}>
            <span className="grow">{a.name}</span>
            <StatusGlyph status={a.status} />
          </RailLink>
        ))}
        {agents.length === 0 && <p className="empty">No agents yet.</p>}

        <div className="rail-section">
          <span className="rail-label">Groups</span>
          <a className="icon-btn" href="#/groups/new" aria-label="New group" title="New group"><Icon name="plus" /></a>
        </div>
        {groups.map((g) => (
          <RailLink key={g.id} to={{ name: "group", id: g.id }} current={route} icon={<span className="hash" aria-hidden="true">#</span>}>
            <span className="grow">{g.name}</span>
            {g.paused && <span className="badge" title="Paused, waiting for you">!</span>}
          </RailLink>
        ))}
        {groups.length === 0 && <p className="empty">No groups yet.</p>}

        <div className="rail-section"><span className="rail-label">Library</span></div>
        <RailLink to={{ name: "skills" }} current={route} icon={<Icon name="skill" />}>
          <span className="grow">Skills</span>
          {drafts.length > 0 && <span className="badge" title={`${drafts.length} proposed skill${drafts.length > 1 ? "s" : ""} to review`}>{drafts.length}</span>}
        </RailLink>

        <div className="rail-section"><span className="rail-label">Computer</span></div>
        <RailLink to={{ name: "screen" }} current={route} icon={<Icon name="screen" />}>Screen</RailLink>
        <RailLink to={{ name: "terminal" }} current={route} icon={<Icon name="terminal" />}>Terminal</RailLink>
        <RailLink to={{ name: "system" }} current={route} icon={<Icon name="pulse" />}>System</RailLink>
      </nav>

      <main className="main">{children}</main>
      {route.name !== "screen" && <ScreenPip />}
    </div>
  );
}
