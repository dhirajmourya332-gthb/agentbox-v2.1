import { useEffect, useState, type ReactNode } from "react";
import { api, type Agent, type Usage, type WorkRoom } from "../api.ts";
import { useStore } from "../store.tsx";
import { href, type Route } from "../router.ts";
import { Avatar, Icon, StatusGlyph } from "./ui.tsx";
import { PauseControl, PausedBar, ScreenPip, ThemeSwitch } from "./Controls.tsx";
import { MarkDot, useRoomMarks, type Mark } from "./Live.tsx";
import { RailRuns } from "./Runs.tsx";

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

function RailLink({ to, current, icon, children, className }: { to: Route; current: Route; icon?: ReactNode; children: ReactNode; className?: string }) {
  const skillsArea = ["skills", "skill", "new-skill", "draft"];
  const active = to.name === "routines"
    ? ["routines", "routine", "new-routine", "routine-run"].includes(current.name)
    : to.name === "group"
    ? (current.name === "group" || current.name === "group-settings") && current.id === to.id
    : to.name === "skills"
    ? skillsArea.includes(current.name)
    : to.name === "room"
    ? current.name === "room" && current.id === to.id
    : to.name === "setup"
    ? current.name === "setup" && (!to.id || to.id === current.id)
    : to.name === current.name && (to.name !== "agent" || (current.name === "agent" && current.id === to.id));
  return (
    <a className={`item${className ? ` ${className}` : ""}`} href={href(to)} aria-current={active ? "page" : undefined}>
      {icon}
      {children}
    </a>
  );
}

/** A collapsible sidebar section whose open/closed state is remembered. */
function Section({ id, label, action, children, defaultOpen = true }: {
  id: string; label: string; action?: ReactNode; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useRemembered(`rail.${id}`, defaultOpen);
  return (
    <>
      <div className="rail-section">
        <button className="rail-label rail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chev"><Icon name="chevron" size={10} /></span>{label}
        </button>
        {action}
      </div>
      {open && children}
    </>
  );
}

function useRemembered(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try { const s = localStorage.getItem(`agentbox.${key}`); return s === null ? initial : s === "1"; } catch { return initial; }
  });
  const set = (next: boolean) => {
    setV(next);
    try { localStorage.setItem(`agentbox.${key}`, next ? "1" : "0"); } catch { /* storage unavailable */ }
  };
  return [v, set];
}

function Glyph({ status }: { status: string }) {
  if (status === "done") return <span className="status" title="Done"><span className="glyph done" /></span>;
  return <StatusGlyph status={status as any} />;
}

/** One top-level task in Work: a single task, or a task room with its tasks folded under it. */
function WorkItem({ room, route, mark }: { room: WorkRoom; route: Route; mark?: { mark: Mark; title: string } }) {
  const isRoom = room.members.length > 1;
  const busy = room.members.some((m) => m.status === "working");
  const [open, setOpen] = useRemembered(`work.${room.root.id}`, true);
  const to: Route = isRoom ? { name: "room", id: room.root.id } : { name: "agent", id: room.root.id };
  const children = room.members.filter((m) => m.id !== room.root.id);
  return (
    <>
      <div className="work-row">
        {isRoom ? (
          <button className="icon-btn tiny" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
            <span className={`chev${open ? " open" : ""}`}><Icon name="chevron" size={10} /></span>
          </button>
        ) : <span className="tiny-spacer" />}
        <RailLink to={to} current={route} className="work-link"
          icon={isRoom ? <span className={`room-dot${busy ? " busy" : ""}`}><Icon name="room" size={12} /></span> : <Glyph status={room.root.status} />}>
          <span className="grow" title={`${room.root.label} · ${room.root.name}`}>{room.root.label ?? room.root.name}</span>
          {mark && <MarkDot mark={mark.mark} title={mark.title} />}
          {isRoom && <span className="count subtle">{children.length + 1}</span>}
        </RailLink>
      </div>
      {isRoom && open && children.map((m) => (
        <RailLink key={m.id} to={{ name: "agent", id: m.id }} current={route} className="work-child" icon={<Glyph status={m.status} />}>
          <span className="grow" title={`${m.label} · ${m.name}`}>{m.label ?? m.name}</span>
          <span className="rail-sub">{m.name}</span>
        </RailLink>
      ))}
    </>
  );
}

/** An agent (role) in Team: live-task count, expandable to its live tasks. */
function TeamItem({ role, route }: { role: Agent; route: Route }) {
  const { agents } = useStore();
  const live = agents.filter((a) => a.base_agent_id === role.id);
  const working = live.filter((a) => a.status === "working").length;
  const [open, setOpen] = useRemembered(`team.${role.id}`, false);
  return (
    <>
      <div className="work-row">
        {live.length ? (
          <button className="icon-btn tiny" aria-expanded={open} aria-label={open ? "Hide tasks" : "Show tasks"} onClick={() => setOpen(!open)}>
            <span className={`chev${open ? " open" : ""}`}><Icon name="chevron" size={10} /></span>
          </button>
        ) : <span className="tiny-spacer" />}
        <RailLink to={role.builtin === "setup" ? { name: "setup" } : { name: "agent", id: role.id }} current={route} className="work-link" icon={<Avatar name={role.name} color={role.color} size={18} />}>
          <span className="grow">{role.name}</span>
          <span className="rail-sub">{working ? `${working} working` : live.length ? `${live.length} idle` : role.builtin ? "built-in" : ""}</span>
        </RailLink>
      </div>
      {open && live.map((a) => (
        <RailLink key={a.id} to={role.builtin === "setup" ? { name: "setup", id: a.id } : { name: "agent", id: a.id }} current={route} className="work-child" icon={<StatusGlyph status={a.status} />}>
          <span className="grow" title={`${a.label} · ${a.name}`}>{a.label ?? a.name}</span>
          <span className="rail-sub">{a.name}</span>
        </RailLink>
      ))}
    </>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { agents, usage, drafts, board, groups, work, attention, activeRuns } = useStore();
  const marks = useRoomMarks();
  const needsYou = attention.filter((i) => !i.seen_at).length;
  const running = Object.values(board).filter((t) => t.status === "running" || t.status === "queued").length;
  const roles = agents.filter((a) => !a.base_agent_id);
  const [showDone, setShowDone] = useRemembered("work.done", false);
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">a</span>agentbox
        </a>
        <UsageChip usage={usage} />
        <VmChip />
        <ThemeSwitch />
        <PauseControl />
      </header>
      <div className="bar-slot"><PausedBar /></div>

      <nav className="rail" aria-label="Main">
        <a className="btn primary new-task-btn" href="#/new"><Icon name="plus" />New task</a>

        <div className="rail-nav">
          <RailLink to={{ name: "home" }} current={route} icon={<Icon name="team" />}>
            <span className="grow">Overview</span>
            {needsYou > 0 && <span className="badge" title={`${needsYou} thing${needsYou > 1 ? "s" : ""} need${needsYou > 1 ? "" : "s"} you`}>{needsYou}</span>}
          </RailLink>
          <RailLink to={{ name: "activity" }} current={route} icon={<Icon name="activity" />}>Activity</RailLink>
          <RailLink to={{ name: "tasks" }} current={route} icon={<Icon name="board" />}>
            <span className="grow">Tasks</span>
            {running > 0 && <span className="count" title={`${running} running or queued`}>{running}</span>}
          </RailLink>
          <RailLink to={{ name: "routines" }} current={route} icon={<Icon name="routine" />}>Routines</RailLink>
          <RailLink to={{ name: "documents" }} current={route} icon={<Icon name="doc" />}>Documents</RailLink>
          <RailLink to={{ name: "skills" }} current={route} icon={<Icon name="skill" />}>
            <span className="grow">Skills</span>
            {drafts.length > 0 && <span className="badge" title={`${drafts.length} proposed skill${drafts.length > 1 ? "s" : ""} to review`}>{drafts.length}</span>}
          </RailLink>
          <RailLink to={{ name: "integrations" }} current={route} icon={<Icon name="plug" />}>Integrations</RailLink>
          <RailLink to={{ name: "repos" }} current={route} icon={<Icon name="repo" />}>Repos</RailLink>
          <RailLink to={{ name: "setup" }} current={route} icon={<Icon name="terminal" />}>Setup</RailLink>
        </div>

        <Section id="work" label="Work">
          {work.live.map((w) => <WorkItem key={w.root.id} room={w} route={route} mark={marks.get(w.root.id)} />)}
          {work.live.length === 0 && activeRuns.length === 0 && <p className="empty">Nothing in progress. <a href="#/new">Start a task</a></p>}
          <RailRuns currentRunId={route.name === "routine-run" ? route.runId : undefined} />
          {work.done.length > 0 && (
            <>
              <button className="rail-more" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                <span className={`chev${showDone ? " open" : ""}`}><Icon name="chevron" size={10} /></span>Done ({work.done.length})
              </button>
              {showDone && work.done.map((w) => <WorkItem key={w.root.id} room={w} route={route} mark={marks.get(w.root.id)} />)}
            </>
          )}
        </Section>

        <Section id="team" label="Team"
          action={<a className="icon-btn" href="#/agents/new" aria-label="New agent" title="New agent"><Icon name="plus" /></a>}>
          {roles.map((r) => <TeamItem key={r.id} role={r} route={route} />)}
          {roles.length === 0 && <p className="empty">No agents yet.</p>}
        </Section>

        <Section id="groups" label="Groups" defaultOpen={groups.length > 0}
          action={<a className="icon-btn" href="#/groups/new" aria-label="New group" title="New group"><Icon name="plus" /></a>}>
          {groups.map((g) => (
            <RailLink key={g.id} to={{ name: "group", id: g.id }} current={route} icon={<span className="hash" aria-hidden="true">#</span>}>
              <span className="grow">{g.name}</span>
              {marks.get(g.id) && <MarkDot mark={marks.get(g.id)!.mark} title={marks.get(g.id)!.title} />}
              {g.paused && <span className="badge" title="Paused, waiting for you">!</span>}
            </RailLink>
          ))}
          {groups.length === 0 && <p className="empty">No groups yet.</p>}
        </Section>

        <Section id="computer" label="Computer" defaultOpen={false}>
          <RailLink to={{ name: "screen" }} current={route} icon={<Icon name="screen" />}>Screen</RailLink>
          <RailLink to={{ name: "terminal" }} current={route} icon={<Icon name="terminal" />}>Terminal</RailLink>
          <RailLink to={{ name: "system" }} current={route} icon={<Icon name="pulse" />}>System</RailLink>
          <RailLink to={{ name: "devices" }} current={route} icon={<Icon name="phone" />}>Devices</RailLink>
        </Section>
      </nav>

      <main className="main">{children}</main>
      {route.name !== "screen" && <ScreenPip />}
    </div>
  );
}
