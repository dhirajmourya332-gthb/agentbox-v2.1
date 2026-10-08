import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type Agent, type Message, type Step, type Task, type Thread } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, Markdown, Spinner, StatusGlyph, duration, relTime } from "../components/ui.tsx";
import { AgentPanel } from "./AgentPanel.tsx";

const STARTERS = [
  "Introduce yourself: what's your job, and what do you need from me to start?",
  "Check your access: GitHub (gh), AWS, and the shared browser. Report what works.",
  "Read your instructions and tell me what's unclear or missing.",
];

export function AgentChat({ agentId, threadParam }: { agentId: string; threadParam?: string }) {
  const { agents, everyone, threads, live, loadThread, threadsVersion } = useStore();
  const agent = everyone.find((a) => a.id === agentId);
  const [threadList, setThreadList] = useState<Thread[]>([]);
  useEffect(() => {
    api.agentThreads(agentId).then(setThreadList).catch(() => {});
  }, [agentId, threadsVersion]);
  const threadId = threadParam ?? agent?.dm_thread_id;
  const isDm = !threadParam || threadParam === agent?.dm_thread_id;
  const thread = threadId ? threads[threadId] : undefined;
  const [panel, setPanel] = useState(() => {
    try { return localStorage.getItem("agentbox.panel") !== "closed"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("agentbox.panel", panel ? "open" : "closed"); } catch { /* storage unavailable */ }
  }, [panel]);

  useEffect(() => {
    if (threadId) loadThread(threadId).catch(() => {});
  }, [threadId, loadThread]);

  if (!agent) return <div className="page"><div className="page-inner"><p className="lede">No such agent.</p></div></div>;

  const running = thread?.tasks.find((t) => t.status === "running");

  return (
    <>
      <section className="chat" aria-label={`Chat with ${agent.name}`}>
        <header className="chat-head">
          <Avatar name={agent.name} color={agent.color} size={32} />
          <div className="who">
            <strong>{agent.name}</strong>
            <span>{agent.title} · {agent.model}</span>
          </div>
          <div className="actions">
            <StatusGlyph status={agent.status} withLabel />
            {running && (
              <button className="btn sm danger" onClick={() => api.stop(running.id)}>
                <Icon name="stop" size={14} />Stop
              </button>
            )}
            <button className="icon-btn" aria-pressed={panel} aria-label="Agent details" title="Agent details" onClick={() => setPanel(!panel)}>
              <Icon name="panel" />
            </button>
          </div>
        </header>

        {threadList.length > 1 && <ThreadTabs agent={agent} threads={threadList} current={threadId} />}
        {thread ? <Timeline agent={agent} thread={thread} live={live} /> : <div className="timeline" />}
        {threadId && isDm && <Composer agent={agent} threadId={threadId} empty={!thread || thread.messages.length === 0} />}
        {threadId && !isDm && (
          <p className="composer-hint" style={{ padding: "10px 24px 18px", margin: 0, maxWidth: "none", textAlign: "center" }}>
            This thread is read-only. To talk to {agent.name}, use the <a href={`#/agents/${agent.id}`}>You</a> thread.
          </p>
        )}
      </section>
      {panel && <AgentPanel agent={agent} onClose={() => setPanel(false)} />}
    </>
  );
}

function ThreadTabs({ agent, threads, current }: { agent: Agent; threads: Thread[]; current?: string }) {
  const { agents, everyone } = useStore();
  return (
    <nav className="tabs thread-tabs" aria-label="Conversations">
      {threads.map((t) => {
        const peer = everyone.find((a) => a.id === t.peer_agent_id);
        const label = t.kind === "dm" ? "You" : t.kind === "routine" ? (t.name ?? "Routine") : `From ${peer?.name ?? "deleted agent"}`;
        return (
          <a key={t.id} role="tab" aria-selected={t.id === current}
            href={t.kind === "dm" ? `#/agents/${agent.id}` : `#/agents/${agent.id}/threads/${t.id}`}>
            {peer && <Avatar name={peer.name} color={peer.color} size={16} />}
            {t.kind === "routine" && <Icon name="routine" size={14} />}
            {label}
          </a>
        );
      })}
    </nav>
  );
}

function Timeline({ agent, thread, live }: {
  agent: Agent;
  thread: { messages: Message[]; tasks: Task[]; steps: Step[] };
  live: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const tasks = useMemo(() => new Map(thread.tasks.map((t) => [t.id, t])), [thread.tasks]);
  const replies = useMemo(
    () => new Map(thread.messages.filter((m) => m.author !== "user" && m.task_id).map((m) => [m.task_id!, m])),
    [thread.messages],
  );
  const stepsByTask = useMemo(() => {
    const m = new Map<string, Step[]>();
    for (const s of thread.steps) m.set(s.task_id, [...(m.get(s.task_id) ?? []), s]);
    return m;
  }, [thread.steps]);

  // Follow new output while the reader is at the bottom; leave them alone if they scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // An input is what a turn responds to: your message, a teammate's handoff, or a report coming back.
  const inputs = thread.messages.filter((m) => !(m.task_id && tasks.get(m.task_id)?.agent_id === m.author));

  return (
    <div className="timeline" ref={ref} onScroll={onScroll} aria-live="polite" aria-relevant="additions">
      <div className="timeline-inner">
        {inputs.length === 0 && (
          <div className="msg">
            <Avatar name={agent.name} color={agent.color} size={28} />
            <div>
              <div className="msg-meta"><strong>{agent.name}</strong></div>
              <p style={{ color: "var(--muted)" }}>{agent.summary || "Ready when you are."}</p>
            </div>
          </div>
        )}
        {inputs.map((m) => {
          const task = m.task_id ? tasks.get(m.task_id) : undefined;
          return (
            <div key={m.id} style={{ display: "contents" }}>
              <Input message={m} task={task} />
              {task && (
                <Turn agent={agent} task={task} steps={stepsByTask.get(task.id) ?? []} reply={replies.get(task.id)} live={live[task.id]} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { agent: "handed off a task", message: "sent a message", result: "reported back" };

function Input({ message, task }: { message: Message; task?: Task }) {
  const { agents, everyone } = useStore();
  const [open, setOpen] = useState(task?.source !== "result");
  if (message.author === "user") {
    return (
      <div className="msg">
        <span className="avatar you-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">You</span>
        <div>
          <div className="msg-meta"><strong>You</strong><time dateTime={message.created_at}>{relTime(message.created_at)}</time></div>
          <div className="prose" style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
        </div>
      </div>
    );
  }
  if (message.author === "routine") {
    return (
      <div className="msg">
        <span className="avatar you-avatar" style={{ width: 28, height: 28 }} aria-hidden="true"><Icon name="routine" size={14} /></span>
        <div>
          <div className="msg-meta">
            <strong>Routine</strong>
            <time dateTime={message.created_at}>{relTime(message.created_at)}</time>
            {task && <a className="hint" href={`#/tasks/${task.id}`}>task</a>}
          </div>
          <Markdown text={message.content} />
        </div>
      </div>
    );
  }
  const from = everyone.find((a) => a.id === message.author);
  return (
    <div className="msg">
      {from ? <Avatar name={from.name} color={from.color} size={28} /> : <span className="avatar you-avatar" style={{ width: 28, height: 28 }} />}
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta">
          <strong>{from?.name ?? "Deleted agent"}</strong>
          <span className="hint">{SOURCE_LABEL[task?.source ?? ""] ?? ""}</span>
          <time dateTime={message.created_at}>{relTime(message.created_at)}</time>
          {task && <a className="hint" href={`#/tasks/${task.id}`}>task</a>}
        </div>
        <div className={`handoff ${task?.source ?? ""}`}>
          {task?.source === "result" && (
            <button className="worklog-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span className="chev"><Icon name="chevron" size={14} /></span>
              {open ? "Hide report" : "Show report"}
            </button>
          )}
          {open && <Markdown text={message.content} home={from?.home} />}
          {!open && <p className="hint">{message.content.split("\n")[0].replace(/\*\*/g, "")}</p>}
        </div>
      </div>
    </div>
  );
}

function Turn({ agent, task, steps, reply, live }: { agent: Agent; task: Task; steps: Step[]; reply?: Message; live?: string }) {
  const running = task.status === "running";
  const content = reply?.content ?? live ?? "";
  return (
    <div className="msg">
      <Avatar name={agent.name} color={agent.color} size={28} />
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta">
          <strong>{agent.name}</strong>
          <time dateTime={task.started_at ?? task.created_at}>{relTime(task.started_at ?? task.created_at)}</time>
        </div>

        {task.status === "queued" && (
          <p className="msg-note">
            Queued — starts when {agent.name} finishes the current task.
            <button className="btn ghost sm" onClick={() => api.stop(task.id)}>Cancel</button>
          </p>
        )}

        {(steps.length > 0 || running) && <WorkLog task={task} steps={steps} />}

        {content ? (
          <Markdown text={content} streaming={running} home={agent.home} />
        ) : running ? (
          <p className="msg-note"><Spinner />{steps.length ? "Working…" : "Thinking…"}</p>
        ) : null}

        {task.status === "failed" && (
          <p className="msg-note bad" style={{ marginTop: 8 }}>
            <Icon name="x" size={14} />This turn failed: {task.error ?? "unknown error"}
          </p>
        )}
        {task.status === "stopped" && <p className="msg-note" style={{ marginTop: 8 }}><Icon name="stop" size={14} />Stopped.</p>}
      </div>
    </div>
  );
}

export function WorkLog({ task, steps }: { task: Task; steps: Step[] }) {
  const running = task.status === "running";
  const visible = steps.filter((s) => s.kind !== "meta");
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? running;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const counts = visible.reduce<Record<string, number>>((m, s) => ((m[s.name] = (m[s.name] ?? 0) + 1), m), {});
  const breakdown = Object.entries(counts).map(([k, n]) => `${k} ×${n}`).join(" · ");
  const started = task.started_at ?? task.created_at;
  const label = running
    ? `Working for ${duration(started)} · ${visible.length} step${visible.length === 1 ? "" : "s"}`
    : `Worked for ${duration(started, task.finished_at)} · ${visible.length} step${visible.length === 1 ? "" : "s"}`;

  if (!running && visible.length === 0) return null;
  return (
    <div className="worklog">
      <button className="worklog-toggle" aria-expanded={open} onClick={() => setManual(!open)}>
        <span className="chev"><Icon name="chevron" size={14} /></span>
        {running && <Spinner />}
        {label}
        {breakdown && <span style={{ opacity: 0.8 }}>({breakdown})</span>}
      </button>
      {open && visible.length > 0 && (
        <ol className="steps">
          {visible.map((s) => <StepRow key={s.id} step={s} />)}
        </ol>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="step">
      <button className="step-row" aria-expanded={open} onClick={() => setOpen(!open)} title={step.summary}>
        <span className="step-kind"><Icon name={step.kind} size={14} /></span>
        <span className="step-label">{step.name}</span>
        <span className="step-summary">{step.summary || "—"}</span>
        <span className={`step-state ${step.status}`}>
          {step.status === "running" ? <Spinner /> : step.status === "done" ? <Icon name="check" size={14} /> : <Icon name="x" size={14} />}
        </span>
      </button>
      {open && (
        <div className="step-detail">
          {step.input && step.input !== "{}" && (<><span className="lbl">Input</span><pre>{step.input}</pre></>)}
          <span className="lbl">Output</span>
          <pre>{step.output ?? (step.status === "running" ? "Running…" : "(none)")}</pre>
        </div>
      )}
    </li>
  );
}

function Composer({ agent, threadId, empty }: { agent: Agent; threadId: string; empty: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => ref.current?.focus(), [agent.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  async function send(value = text) {
    const v = value.trim();
    if (!v) return;
    setError(null);
    setText("");
    try {
      await api.send(threadId, v);
    } catch (e: any) {
      setError(e.message);
      setText(v);
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer-wrap">
      {empty && (
        <div className="choices" style={{ maxWidth: 820, margin: "0 auto 10px" }}>
          {STARTERS.map((s) => <button key={s} className="pill" onClick={() => send(s)}>{s}</button>)}
        </div>
      )}
      <div className="composer">
        <textarea ref={ref} rows={1} value={text} placeholder={`Message ${agent.name}…`} aria-label={`Message ${agent.name}`}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <button className="btn primary sm" style={{ minHeight: 34 }} disabled={!text.trim()} onClick={() => send()} aria-label="Send">
          <Icon name="send" size={14} />
        </button>
      </div>
      <p className="composer-hint">
        {error ? <span style={{ color: "var(--bad)" }}>{error}</span>
          : agent.status === "working" ? `${agent.name} is working — new messages queue up and run next.`
          : "⏎ send · ⇧⏎ new line"}
      </p>
    </div>
  );
}
