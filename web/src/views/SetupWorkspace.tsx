import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type Agent, type PlanStep, type SetupPlan, type SetupSession } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Icon, Markdown, Spinner, StatusGlyph, relTime } from "../components/ui.tsx";
import { LiveBar, useSeenRoom } from "../components/Live.tsx";
import { AttachButton, AttachmentStrip, useAttachments } from "../components/Attachments.tsx";
import { MicButton, VoiceStatus, useVoice } from "../components/Voice.tsx";
import { OwnerTerminal, type TerminalHandle, type TermStatus } from "../components/OwnerTerminal.tsx";
import { InsertCtx, insertable } from "../components/insert.ts";
import { TerminalCtx } from "../components/Setup.tsx";
import { fmtDuration } from "../components/progress.ts";
import { Composer, FinishButton, TaskTitle, Timeline } from "./AgentChat.tsx";
import { clearReturn, returnFor, type SetupReturn } from "../components/returnTo.ts";

/**
 * The helper workspace (#/helper/<session>): the helper (setup) agent's own screen, in the spirit of the
 * first-run guide. One screen with the chat, the owner's terminal and a checklist the agent writes
 * (set_plan) with a "current step" pointer that moves by itself when a step's check passes.
 *
 * Panels have resizable splits and can each be expanded to fill the screen (button, Esc restores);
 * the layout is remembered. On narrow screens the panels become tabs. Every panel stays mounted, so
 * the terminal keeps its connection whichever one is showing.
 */

type PanelId = "steps" | "chat" | "terminal";
type Layout = { col: number; row: number; expanded: PanelId | null; tab: PanelId };
const LAYOUT_KEY = "agentbox.setup.layout";
const DEFAULT_LAYOUT: Layout = { col: 0.42, row: 0.5, expanded: null, tab: "steps" };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function useLayout(): [Layout, (patch: Partial<Layout>) => void] {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
      if (v && typeof v === "object") {
        return {
          col: clamp(Number(v.col) || DEFAULT_LAYOUT.col, 0.2, 0.8), row: clamp(Number(v.row) || DEFAULT_LAYOUT.row, 0.15, 0.85),
          expanded: ["steps", "chat", "terminal"].includes(v.expanded) ? v.expanded : null,
          tab: ["steps", "chat", "terminal"].includes(v.tab) ? v.tab : "steps",
        };
      }
    } catch { /* storage unavailable or bad JSON */ }
    return DEFAULT_LAYOUT;
  });
  const update = useCallback((patch: Partial<Layout>) => {
    setLayout((l) => {
      const next = { ...l, ...patch };
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);
  return [layout, update];
}

function useNarrow(px = 900) {
  const [narrow, setNarrow] = useState(() => matchMedia(`(max-width: ${px}px)`).matches);
  useEffect(() => {
    const mq = matchMedia(`(max-width: ${px}px)`);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return narrow;
}

/** The server's clock, ticking every second (elapsed times and heartbeats). */
function useNow(on = true) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const i = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(i);
  }, [on]);
  return t;
}

// --- the page --------------------------------------------------------------------------------------------

export function SetupWorkspace({ instanceId }: { instanceId?: string }) {
  const { agents, everyone, loaded } = useStore();
  const setupRole = agents.find((a) => a.builtin === "setup" && !a.base_agent_id);
  const [sessions, setSessions] = useState<SetupSession[] | null>(null);
  const loadSessions = useCallback(() => api.setupSessions().then((r) => setSessions(r.sessions)).catch(() => setSessions([])), []);
  useEffect(() => { loadSessions(); }, [loadSessions, instanceId, agents.length]);

  // #/helper: the latest live session, or a fresh start.
  const fresh = instanceId === "new";
  useEffect(() => {
    if (instanceId || !sessions) return;
    const live = sessions.find((s) => !s.retired_at);
    location.replace(live ? `#/helper/${live.id}` : "#/helper/new");
  }, [instanceId, sessions]);

  const session = instanceId && !fresh ? (agents.find((a) => a.id === instanceId) ?? (everyone.find((a) => a.id === instanceId) as Agent | undefined)) : undefined;
  const [loadedSession, setLoadedSession] = useState<Agent | null>(null);
  useEffect(() => {
    if (instanceId && !fresh && !session) api.agent(instanceId).then((r) => setLoadedSession(r.agent)).catch(() => setLoadedSession(null));
  }, [instanceId, !!session]);
  const agent = session ?? loadedSession ?? undefined;

  if (!loaded) return <div className="page" />;
  if (!setupRole) {
    return <div className="page"><div className="page-inner"><h1>Helper</h1><p className="lede">The helper agent is missing. Restart agentbox to restore it.</p></div></div>;
  }
  if (!instanceId) return <div className="page" />;
  if (!fresh && !agent) return <div className="page"><div className="page-inner"><p className="lede">Loading…</p></div></div>;
  return <Workspace key={instanceId} role={setupRole} agent={fresh ? null : agent!} sessions={sessions ?? []} />;
}

function Workspace({ role, agent, sessions }: { role: Agent; agent: Agent | null; sessions: SetupSession[] }) {
  const { threads, live, loadThread, progress } = useStore();
  const [layout, setLayout] = useLayout();
  const narrow = useNarrow();
  const term = useRef<TerminalHandle | null>(null);
  const [termStatus, setTermStatus] = useState<TermStatus>("connecting");
  const [toast, setToast] = useState<string | null>(null);
  const plan = usePlan(agent?.id ?? null);
  useSeenRoom(agent && agent.created_by === "owner" ? agent.id : null);

  const threadId = agent?.dm_thread_id ?? undefined;
  const thread = threadId ? threads[threadId] : undefined;
  useEffect(() => { if (threadId) loadThread(threadId).catch(() => {}); }, [threadId, loadThread]);
  const running = thread?.tasks.find((t) => t.status === "running");
  const done = !!agent?.retired_at;

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };
  const insert = useCallback((text: string) => {
    const t = insertable(text);
    if (term.current?.insert(t)) {
      if (narrow) setLayout({ tab: "terminal" });
      flash("Inserted. Read it, then press Enter in the terminal.");
    } else {
      navigator.clipboard?.writeText(t).catch(() => {});
      flash("The terminal isn't connected: copied instead.");
    }
  }, [narrow, setLayout]);
  const showTerminal = useCallback(() => {
    if (narrow) setLayout({ tab: "terminal" });
    else if (layout.expanded && layout.expanded !== "terminal") setLayout({ expanded: null });
    setTimeout(() => term.current?.focus(), 50);
  }, [narrow, layout.expanded, setLayout]);

  // Esc restores an expanded panel (inside the terminal, Esc belongs to the shell: use the button).
  useEffect(() => {
    if (!layout.expanded) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as Element | null)?.closest?.(".xterm")) return;
      if (document.querySelector(".reader-backdrop, .popover")) return;
      e.preventDefault();
      setLayout({ expanded: null });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [layout.expanded, setLayout]);

  // Esc in the chat stops the agent's turn (never from the terminal or the checklist).
  const onChatKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && running && !layout.expanded && !e.defaultPrevented) { e.preventDefault(); api.stop(running.id); }
  };

  const panelProps = (id: PanelId) => ({
    id, layout, narrow,
    onExpand: () => setLayout({ expanded: layout.expanded === id ? null : id }),
  });

  const current = plan?.steps.find((s) => s.id === plan.current);
  const stepsBadge = plan ? `${plan.done_count}/${plan.total}` : undefined;

  const chatPanel = (
    <Panel {...panelProps("chat")} title="Helper" onKeyDown={onChatKey}
      actions={agent && <>
        {done ? <span className="chip">Done</span> : <StatusGlyph status={agent.status} withLabel />}
        {running && <button className="btn sm danger" onClick={() => api.stop(running.id)} title="Stop (Esc in the chat)"><Icon name="stop" size={14} />Stop</button>}
      </>}>
      {agent ? (
        <>
          {thread ? <Timeline agent={agent} thread={thread} live={live} /> : <div className="timeline" />}
          <LiveBar items={Object.values(progress).filter((p) => p.agent_id === agent.id)} log={false} />
          {threadId && !done && (
            <Composer agent={agent} threadId={threadId} empty={!thread || thread.messages.length === 0}
              starters={STARTERS} placeholder="Ask the helper: change an agent, add a skill, set something up, or ask about a step…" />
          )}
          {done && (
            <p className="composer-hint ws-done-hint">This conversation is done; its history stays here. <a href="#/helper/new">Start a new one</a></p>
          )}
        </>
      ) : <StartChat role={role} />}
    </Panel>
  );

  return (
    <InsertCtx.Provider value={agent && !done ? insert : null}>
      <TerminalCtx.Provider value={showTerminal}>
        <section className="setup-ws" aria-label="Helper workspace">
          <header className="ws-head">
            <span className="ws-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
            <div className="ws-title">
              {agent ? <TaskTitle agent={agent} /> : <strong>New conversation</strong>}
              <span className="hint">
                Helper · team changes come as cards you approve; setups get a checklist and your terminal
                {current ? <> · now: <strong>{current.title}</strong></> : null}
              </span>
            </div>
            <div className="ws-actions">
              <SessionPicker current={agent?.id ?? null} sessions={sessions} />
              <a className="btn sm" href="#/helper/new" title="Start a new conversation with the helper"><Icon name="plus" size={14} />New</a>
              {agent && !done && <FinishButton agent={agent} />}
              <a className="icon-btn" href={`#/agents/${role.id}`} title="About the helper and your notes for it" aria-label="Helper settings"><Icon name="agent" /></a>
            </div>
          </header>
          {agent && <ReturnBar sessionId={agent.id} />}

          {narrow && (
            <nav className="tabs ws-tabs" role="tablist" aria-label="Helper panels">
              {(["steps", "chat", "terminal"] as PanelId[]).map((p) => (
                <button key={p} role="tab" aria-selected={layout.tab === p} onClick={() => setLayout({ tab: p })}>
                  {p === "steps" ? "Steps" : p === "chat" ? "Chat" : "Terminal"}
                  {p === "steps" && stepsBadge && <span className="count subtle">{stepsBadge}</span>}
                  {p === "chat" && running && <Spinner />}
                </button>
              ))}
            </nav>
          )}

          <Body layout={layout} narrow={narrow} setLayout={setLayout}
            steps={
              <Panel {...panelProps("steps")} title={plan ? plan.title : "Checklist"}
                actions={plan && <span className="ws-count" title="Done / total">{stepsBadge}</span>}>
                <PlanPanel plan={plan} agent={agent} onInsert={insert} terminalUp={termStatus === "open"} />
              </Panel>
            }
            chat={chatPanel}
            terminal={
              <Panel {...panelProps("terminal")} title="Terminal"
                actions={<span className={`conn ${termStatus}`}>{termStatus === "open" ? "connected" : termStatus === "closed" ? "reconnecting…" : termStatus === "fallback" ? "not readable by the agent" : "connecting…"}</span>}
                note="Your shell on this computer. Logins happen here, never in the chat. The helper can read it (secrets hidden) but never types.">
                <OwnerTerminal onHandle={(h) => { term.current = h; }} onStatus={setTermStatus} />
              </Panel>
            } />
          {toast && <div className="ws-toast" role="status">{toast}</div>}
        </section>
      </TerminalCtx.Provider>
    </InsertCtx.Provider>
  );
}

const STARTERS = [
  "Guide me through setting up agentbox, step by step",
  "Set up the phone app",
  "Make the tech-lead only orchestrate and delegate",
  "Create a sales agent for me",
  "Add a skill and give it to an agent",
  "What's connected, and what needs attention?",
];

/** A new conversation: the first message starts the helper's task and lands here. */
function StartChat({ role }: { role: Agent }) {
  // Another page can hand over a prefilled request ("agentbox.setup.prefill", read once).
  const [text, setText] = useState(() => {
    try { const v = sessionStorage.getItem("agentbox.setup.prefill") ?? ""; sessionStorage.removeItem("agentbox.setup.prefill"); return v; } catch { return ""; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const att = useAttachments();
  const voice = useVoice({ input: ref, text, setText, purpose: "task", agentId: role.id });
  useEffect(() => ref.current?.focus(), []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  const start = async (value = text) => {
    const v = value.trim();
    if ((!v && !att.paths.length) || att.uploading || busy) return;
    setBusy(true); setError(null);
    try {
      const inst = await api.newTask(role.id, v, undefined, att.paths);
      att.clear();
      go({ name: "setup", id: inst.id });
    } catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <div className="ws-start">
      <div className="ws-start-intro">
        <strong>What can the helper do for you?</strong>
        <p className="hint">
          Say it in your own words. Team changes (a new agent, how an agent works, skills and who has them) come
          back as cards you approve, edit or undo. Setups ("set up gh and aws") get a checklist; the helper installs
          what it can and walks you through the logins in your terminal. Real work goes to the right agent.
        </p>
        <div className="choices">{STARTERS.map((s) => <button key={s} className="pill" disabled={busy} onClick={() => start(s)}>{s}</button>)}</div>
      </div>
      <div className="composer-wrap">
        <AttachmentStrip a={att} />
        <VoiceStatus v={voice} />
        <div className={`composer${att.dragging ? " dropping" : ""}`} {...att.dropProps}>
          <textarea ref={ref} rows={1} value={text} placeholder="e.g. Create a marketing agent that drafts our release notes" aria-label="What do you want?"
            onChange={(e) => setText(e.target.value)} onPaste={att.onPaste}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); start(); } }} />
          <AttachButton a={att} />
          <MicButton v={voice} />
          <button className="btn primary sm" style={{ minHeight: 34 }} disabled={(!text.trim() && !att.paths.length) || att.uploading || busy} onClick={() => start()}>
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
        <p className="composer-hint">{error ? <span style={{ color: "var(--bad)" }}>{error}</span> : "⏎ start · ⇧⏎ new line · never paste tokens or passwords here"}</p>
      </div>
    </div>
  );
}

function SessionPicker({ current, sessions }: { current: string | null; sessions: SetupSession[] }) {
  const list = sessions.filter((s) => !s.retired_at || s.id === current);
  if (list.length < 2 && current) return null;
  if (!list.length) return null;
  return (
    <select className="ws-picker" aria-label="Setup sessions" value={current ?? ""} onChange={(e) => e.target.value && go({ name: "setup", id: e.target.value })}>
      {!current && <option value="">New session</option>}
      {list.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label ?? s.name}{s.plan ? ` (${s.plan.done}/${s.plan.total})` : ""}{s.retired_at ? " · done" : ""}
        </option>
      ))}
    </select>
  );
}

// --- layout -------------------------------------------------------------------------------------------------

function Body({ layout, narrow, setLayout, steps, chat, terminal }: {
  layout: Layout; narrow: boolean; setLayout: (p: Partial<Layout>) => void; steps: ReactNode; chat: ReactNode; terminal: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  return (
    <div className={`ws-body${narrow ? " tabs" : ""}`} ref={box}
      style={{ ["--ws-col" as any]: `${layout.col * 100}%`, ["--ws-row" as any]: `${layout.row * 100}%` }}>
      <div className="ws-left" ref={left}>
        {steps}
        {!narrow && <Splitter dir="row" value={layout.row} onChange={(v) => setLayout({ row: v })} within={left} min={0.15} max={0.85} label="Resize the checklist and the chat" />}
        {chat}
      </div>
      {!narrow && <Splitter dir="col" value={layout.col} onChange={(v) => setLayout({ col: v })} within={box} min={0.22} max={0.75} label="Resize the left panels and the terminal" />}
      {terminal}
    </div>
  );
}

/** A draggable divider (also arrow keys); value is the first pane's share (0–1). */
function Splitter({ dir, value, onChange, within, min, max, label }: {
  dir: "col" | "row"; value: number; onChange: (v: number) => void; within: React.RefObject<HTMLDivElement | null>; min: number; max: number; label: string;
}) {
  const [drag, setDrag] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !within.current) return;
    const r = within.current.getBoundingClientRect();
    const v = dir === "col" ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    onChange(clamp(v, min, max));
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    const dec = dir === "col" ? "ArrowLeft" : "ArrowUp";
    const inc = dir === "col" ? "ArrowRight" : "ArrowDown";
    if (e.key === dec) { e.preventDefault(); onChange(clamp(value - step, min, max)); }
    if (e.key === inc) { e.preventDefault(); onChange(clamp(value + step, min, max)); }
  };
  return (
    <div className={`ws-split ws-split-${dir}${drag ? " dragging" : ""}`} role="separator" tabIndex={0} aria-label={label}
      aria-orientation={dir === "col" ? "vertical" : "horizontal"} aria-valuenow={Math.round(value * 100)} aria-valuemin={Math.round(min * 100)} aria-valuemax={Math.round(max * 100)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => setDrag(false)} onPointerCancel={() => setDrag(false)}
      onDoubleClick={() => onChange(dir === "col" ? DEFAULT_LAYOUT.col : DEFAULT_LAYOUT.row)} onKeyDown={onKey} />
  );
}

const PANEL_NAME: Record<PanelId, string> = { steps: "checklist", chat: "chat", terminal: "terminal" };

function Panel({ id, layout, narrow, onExpand, title, actions, note, children, onKeyDown }: {
  id: PanelId; layout: Layout; narrow: boolean; onExpand: () => void; title: ReactNode; actions?: ReactNode; note?: string;
  children: ReactNode; onKeyDown?: (e: KeyboardEvent) => void;
}) {
  const expanded = layout.expanded === id;
  const hidden = narrow ? layout.tab !== id && !expanded : !!layout.expanded && !expanded;
  return (
    <section className={`ws-panel p-${id}${expanded ? " expanded" : ""}${hidden ? " hidden" : ""}`} aria-label={PANEL_NAME[id]}
      data-esc-owner={expanded ? "" : undefined} onKeyDown={onKeyDown}>
      <div className="ws-panel-head">
        <span className="ws-panel-title">{title}</span>
        {note && <span className="hint ws-panel-note" title={note}>{note}</span>}
        <span className="ws-panel-actions">
          {actions}
          <button className="icon-btn" onClick={onExpand}
            aria-label={expanded ? `Restore the ${PANEL_NAME[id]}` : `Expand the ${PANEL_NAME[id]} to fill the screen`}
            title={expanded ? (id === "terminal" ? "Restore (Esc outside the terminal)" : "Restore (Esc)") : "Expand to fill the screen"}>
            <Icon name={expanded ? "collapse" : "expand"} size={14} />
          </button>
        </span>
      </div>
      <div className="ws-panel-body">{children}</div>
    </section>
  );
}

// --- the checklist -------------------------------------------------------------------------------------------

const visible = (p: SetupPlan) => JSON.stringify([p.title, p.steps.map(({ nudged: _n, ...s }: any) => s), p.current, p.checking]);
function sameSteps(a: SetupPlan, b: SetupPlan) { return visible(a) === visible(b); }

function usePlan(instanceId: string | null) {
  const { onEvent } = useStore();
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  useEffect(() => {
    setPlan(null);
    if (!instanceId) return;
    api.setupPlan(instanceId).then((r) => setPlan(r.plan)).catch(() => {});
  }, [instanceId]);
  useEffect(() => onEvent((e) => {
    if (!instanceId || e.instanceId !== instanceId) return;
    // Replace the plan only when something visible changed, so an unchanged update never re-renders.
    if (e.type === "setup.plan") setPlan((p) => (p && sameSteps(p, e.plan) ? p : e.plan));
    if (e.type === "setup.check") {
      setPlan((p) => {
        if (!p) return p;
        const checking = { ...p.checking };
        const checked_at = { ...p.checked_at };
        if (e.running) checking[e.stepId] = e.at;
        else { delete checking[e.stepId]; checked_at[e.stepId] = e.at; }
        return { ...p, checking, checked_at };
      });
    }
  }), [instanceId, onEvent]);
  return plan;
}

const STEP_ICON: Record<string, string> = { pending: "○", checking: "●", done: "✔", failed: "✖", skipped: "─" };

function PlanPanel({ plan, agent, onInsert, terminalUp }: { plan: SetupPlan | null; agent: Agent | null; onInsert: (t: string) => void; terminalUp: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  // Keep the pointer in view when it moves.
  useEffect(() => {
    const el = list.current?.querySelector(".ws-step.current");
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [plan?.current]);
  if (!plan) {
    return (
      <div className="ws-empty">
        <p><strong>No checklist yet.</strong></p>
        <p className="hint">
          {agent
            ? "Only setups need one (installs, logins, connections); team changes are cards in the chat. When something needs setting up, the helper writes the steps here, each with its commands and a check that ticks it off by itself."
            : "When you ask for a setup, the helper writes the steps here; the pointer moves on by itself when a step's check passes."}
        </p>
      </div>
    );
  }
  const pct = plan.total ? Math.round((plan.done_count / plan.total) * 100) : 0;
  return (
    <div className="ws-plan">
      <div className="ws-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Checklist progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      {!plan.current && <div className="ws-all-done"><Icon name="check" size={14} />Every step is done.</div>}
      <ol className="ws-steps" ref={list}>
        {plan.steps.map((s, i) => (
          <StepItem key={s.id} n={i + 1} step={s} plan={plan} current={plan.current === s.id} onInsert={onInsert} terminalUp={terminalUp}
            instanceId={plan.instance_id} canAct={!!agent && !agent.retired_at} />
        ))}
      </ol>
    </div>
  );
}

function StepItem({ n, step, plan, current, onInsert, terminalUp, instanceId, canAct }: {
  n: number; step: PlanStep; plan: SetupPlan; current: boolean; onInsert: (t: string) => void; terminalUp: boolean; instanceId: string; canAct: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checking = plan.checking[step.id];
  const shown = open ?? current;
  const state = checking && (step.status === "pending" || step.status === "failed") ? "checking" : step.status;
  const checkable = !!step.check || !!step.integration;
  const now = useNow(!!checking); // ticks only while an owner-requested check runs
  const act = async (action: "check" | "skip" | "done" | "reopen") => {
    setBusy(action); setError(null);
    try { await api.setupStep(instanceId, step.id, action); } catch (e: any) { setError(e.message); }
    setBusy(null);
  };
  const waiting = (step.status === "pending" || step.status === "failed") && checkable;
  const failedOutput = step.last_check && !step.last_check.ok ? step.last_check.output : "";
  return (
    <li className={`ws-step st-${state}${current ? " current" : ""}`} aria-current={current ? "step" : undefined}>
      <button className="ws-step-line" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="ws-pointer" aria-hidden="true">{current ? "▶" : ""}</span>
        <span className={`ws-icon st-${state}`} title={state}>{state === "checking" ? <span className="ws-pulse" /> : STEP_ICON[state]}</span>
        <span className="ws-step-title"><span className="ws-n">{n}.</span> {step.title}</span>
        <span className={`ws-who ${step.human ? "you" : "agent"}`}>{step.human ? "You" : "Agent"}</span>
      </button>
      {shown && (
        <div className="ws-step-body">
          {step.why && <p className="ws-why">{step.why}</p>}
          {step.instructions && <Markdown text={step.instructions} />}
          {step.note && <p className="ws-note"><Icon name="sparkle" size={12} /> {step.note}</p>}
          {step.commands.length > 0 && (
            <div className="ws-cmds">
              {step.commands.map((c, i) => <CommandRow key={i} cmd={c} onInsert={canAct ? onInsert : null} terminalUp={terminalUp} />)}
            </div>
          )}
          {checkable && (
            <div className="ws-check" aria-live="polite">
              {step.status === "done" ? (
                <span className="ok-text"><Icon name="check" size={12} /> Done{step.done_by === "check" ? ": its check passed" : step.done_by === "owner" ? ": marked by you" : step.done_by === "agent" ? ": marked by the agent" : ""}{step.done_at ? ` ${relTime(step.done_at)}` : ""}</span>
              ) : step.status === "skipped" ? (
                <span className="hint">Skipped</span>
              ) : (
                <>
                  <span className={`ws-beat${checking ? " on" : current ? " watch" : ""}`} aria-hidden="true" />
                  <span>
                    {checking
                      ? <>Checking… {fmtDuration(now - Date.parse(checking))}</>
                      : current ? <>Watching: ticks itself when done (checked every {Math.round(plan.interval_ms / 1000)} s)</> : "Checked when it's the current step"}
                  </span>
                  <code className="ws-check-cmd" title={step.check ?? ""}>
                    {step.check ?? `agentbox integration status ${step.integration!.id}${step.integration!.step ? ` (${step.integration!.step})` : ""}`}
                  </code>
                </>
              )}
              {checking && now - Date.parse(checking) > 8000 && <div className="hint">Still checking: the check is slow to answer (it gives up after 10 s).</div>}
            </div>
          )}
          {!checkable && step.status !== "done" && step.status !== "skipped" && (
            <div className="ws-check hint">No automatic check: {step.human ? "mark it done when you've finished" : "the agent marks it done"}.</div>
          )}
          {failedOutput && waiting && (
            <details className="ws-output" open={step.status === "failed"}>
              <summary>{step.status === "failed" ? "The check failed" : "Not done yet"}: last output{step.last_check?.code !== null && step.last_check?.code !== undefined ? ` (exit ${step.last_check.code})` : ""}</summary>
              <pre>{failedOutput || "(no output)"}</pre>
            </details>
          )}
          {error && <div className="error-box">{error}</div>}
          {canAct && (
            <div className="ws-step-actions">
              {waiting && <button className="btn sm" disabled={!!busy || !!checking} onClick={() => act("check")}>{busy === "check" ? "Checking…" : "Check now"}</button>}
              {(step.status === "pending" || step.status === "failed") && <>
                <button className="btn sm" disabled={!!busy} onClick={() => act("done")}><Icon name="check" size={12} />Mark done</button>
                <button className="btn sm ghost" disabled={!!busy} onClick={() => act("skip")}>Skip</button>
              </>}
              {(step.status === "done" || step.status === "skipped") && <button className="btn sm ghost" disabled={!!busy} onClick={() => act("reopen")}>Reopen</button>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); return true; } catch {
    const t = document.createElement("textarea"); t.value = s; document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy"); t.remove(); return ok;
  }
}

function CommandRow({ cmd, onInsert, terminalUp }: { cmd: string; onInsert: ((t: string) => void) | null; terminalUp: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ws-cmd">
      <code>{cmd}</code>
      <span className="ws-cmd-btns">
        <button className="btn sm" onClick={async () => { if (await copyText(cmd)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
          <Icon name="copy" size={12} />{copied ? "Copied" : "Copy"}
        </button>
        {onInsert && (
          <button className="btn sm primary" onClick={() => onInsert(cmd)} title={terminalUp ? "Type it into your terminal without pressing Enter" : "The terminal isn't connected: this copies it instead"}>
            <Icon name="insert" size={12} />Insert in terminal
          </button>
        )}
      </span>
    </div>
  );
}

// --- back to where the owner came from ------------------------------------------------------------

const RETURN_AFTER_S = 5;
type Outcome = "open" | "done" | "stopped";

/**
 * Opened from an agent's setup-request card: "Back to tech-lead#3" while it runs, and once every
 * request it was opened for is finished, a short countdown back to that page (or "Stay here").
 * Finishing while the owner watches returns them; arriving at an already finished one just offers the link.
 */
function ReturnBar({ sessionId }: { sessionId: string }) {
  const { onEvent } = useStore();
  const [back] = useState<SetupReturn | null>(() => returnFor(sessionId));
  const [status, setStatus] = useState<Record<string, string>>({});
  const [seenOpen, setSeenOpen] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [stay, setStay] = useState(false);

  useEffect(() => {
    if (!back) return;
    for (const id of back.requests) api.setupRequest(id).then((r) => setStatus((s) => ({ ...s, [id]: r.status }))).catch(() => {});
  }, [back]);
  useEffect(() => onEvent((e) => {
    if (e.type === "setup_request.updated" && back?.requests.includes(e.request?.id)) setStatus((s) => ({ ...s, [e.request.id]: e.request.status }));
  }), [onEvent, back]);

  const states = back ? back.requests.map((id) => status[id]) : [];
  const known = states.length > 0 && states.every(Boolean);
  const outcome: Outcome = !known ? "open" : states.some((s) => s === "pending" || s === "in_progress") ? "open"
    : states.every((s) => s === "done") ? "done" : "stopped";
  useEffect(() => { if (known && outcome === "open") setSeenOpen(true); }, [known, outcome]);

  const goBack = () => { if (!back) return; clearReturn(sessionId); location.hash = back.hash; };
  // Count down only when it finished while the owner was here (not on a later visit).
  useEffect(() => {
    if (outcome !== "done" || !seenOpen || stay) { setLeft(null); return; }
    setLeft(RETURN_AFTER_S);
    const t = setInterval(() => setLeft((n) => (n === null ? null : n - 1)), 1000);
    return () => clearInterval(t);
  }, [outcome, seenOpen, stay]);
  useEffect(() => { if (left !== null && left <= 0) goBack(); }, [left]);

  if (!back) return null;
  const who = back.label;
  return (
    <div className={`ws-return ${outcome}`} role="status">
      {outcome === "open" && <span>Opened from {who}'s setup request. {who} is called back when it's done.</span>}
      {outcome === "done" && <span><Icon name="check" size={14} /> Setup done: {who} has been told and is carrying on.{left !== null ? ` Taking you back in ${left}s…` : ""}</span>}
      {outcome === "stopped" && <span>This setup didn't finish ({states.filter((s) => s !== "done").join(", ")}). {who} has been told.</span>}
      <span className="grow" />
      {left !== null && <button className="btn sm ghost" onClick={() => setStay(true)}>Stay here</button>}
      <button className={`btn sm${outcome === "open" ? " ghost" : " primary"}`} onClick={goBack}><Icon name="back" size={14} />Back to {who}</button>
    </div>
  );
}

