import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type Agent, type Group, type Message, type Step, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Avatar, Icon, Markdown, Spinner, relTime, useEscToStop } from "../components/ui.tsx";
import { AgentPicker } from "./Skills.tsx";
import { WorkLog } from "./AgentChat.tsx";

const MENTION = /@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

function mentioned(text: string, members: Agent[]) {
  const out: Agent[] = [];
  for (const m of text.matchAll(MENTION)) {
    const a = members.find((x) => x.slug === m[1].toLowerCase() || x.name.toLowerCase() === m[1].toLowerCase());
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function GroupChat({ id }: { id: string }) {
  const { groups, agents, everyone, threads, live, loadThread } = useStore();
  const group = groups.find((g) => g.id === id);
  const thread = threads[id];
  useEffect(() => {
    loadThread(id).catch(() => {});
  }, [id, loadThread]);

  const running = thread?.tasks.filter((t) => t.status === "running") ?? [];
  useEscToStop(running.length > 0, () => running.forEach((t) => api.stop(t.id)));

  if (!group) return <div className="page"><div className="page-inner"><p className="lede">No such group.</p></div></div>;
  const members = group.members.map((m) => everyone.find((a) => a.id === m)).filter(Boolean) as Agent[];
  const lead = everyone.find((a) => a.id === group.lead_agent_id) ?? members[0];

  return (
    <section className="chat" aria-label={`Group ${group.name}`}>
      <header className="chat-head">
        <span className="avatar you-avatar" style={{ width: 32, height: 32, fontSize: 16 }} aria-hidden="true">#</span>
        <div className="who">
          <strong>{group.name}</strong>
          <span>{group.purpose || `${members.length} member${members.length === 1 ? "" : "s"}`}</span>
        </div>
        <div className="actions">
          <span className="member-stack" aria-label="Members">
            {members.map((a) => (
              <span key={a.id} className="member" title={`${a.name}${a.id === lead?.id ? " (lead)" : ""}`}>
                <Avatar name={a.name} color={a.color} size={24} />
                {a.id === lead?.id && <span className="lead-star" aria-hidden="true">★</span>}
              </span>
            ))}
          </span>
          {running.length > 0 && (
            <button className="btn sm danger" onClick={() => running.forEach((t) => api.stop(t.id))} title="Stop (Esc)">
              <Icon name="stop" size={14} />Stop
            </button>
          )}
          <a className="icon-btn" href={`#/groups/${id}/settings`} aria-label="Group settings" title="Group settings"><Icon name="panel" /></a>
        </div>
      </header>

      {thread ? <GroupTimeline group={group} members={members} lead={lead} data={thread} live={live} /> : <div className="timeline" />}

      {group.paused && (
        <div className="paused-bar" role="status">
          Paused after 12 agent replies since your last message, so agents can't loop without you.
          <button className="btn sm" onClick={() => api.continueGroup(id)}>Continue</button>
          <span className="hint">or send a message</span>
        </div>
      )}
      <GroupComposer group={group} members={members} lead={lead} />
    </section>
  );
}

function GroupTimeline({ group, members, lead, data, live }: {
  group: Group; members: Agent[]; lead?: Agent;
  data: { messages: Message[]; tasks: Task[]; steps: Step[] }; live: Record<string, string>;
}) {
  const { agents, everyone } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const tasks = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  const stepsOf = (taskId: string) => data.steps.filter((s) => s.task_id === taskId);
  const replied = new Set(data.messages.map((m) => m.task_id).filter(Boolean));
  const pending = data.tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="timeline" ref={ref} aria-live="polite" aria-relevant="additions"
      onScroll={() => { const el = ref.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="timeline-inner">
        {data.messages.length === 0 && (
          <div className="group-intro">
            <p><strong>#{group.name}</strong>{group.purpose && <> — {group.purpose}</>}</p>
            <p className="hint">
              @mention members to bring them in; a message without a mention goes to the lead
              {lead && <> (<strong>{lead.name}</strong>)</>}. Agents reply here and can @mention each other to pass the next step.
            </p>
          </div>
        )}
        {data.messages.map((m) => {
          if (m.author === "system") return <p key={m.id} className="system-note">{m.content}</p>;
          if (m.author === "user") {
            return (
              <div key={m.id} className="msg">
                <span className="avatar you-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">You</span>
                <div>
                  <div className="msg-meta"><strong>You</strong><time dateTime={m.created_at}>{relTime(m.created_at)}</time></div>
                  <div className="prose" style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              </div>
            );
          }
          const a = everyone.find((x) => x.id === m.author);
          const task = m.task_id ? tasks.get(m.task_id) : undefined;
          return (
            <div key={m.id} className="msg">
              {a ? <Avatar name={a.name} color={a.color} size={28} /> : <span className="avatar you-avatar" style={{ width: 28, height: 28 }} />}
              <div style={{ minWidth: 0 }}>
                <div className="msg-meta">
                  <strong>{a?.name ?? "Deleted agent"}</strong>
                  {a?.id === group.lead_agent_id && <span className="hint">lead</span>}
                  <time dateTime={m.created_at}>{relTime(m.created_at)}</time>
                </div>
                {task && <WorkLog task={task} steps={stepsOf(task.id)} />}
                <Markdown text={m.content} home={a?.home} />
                {task?.status === "failed" && <p className="msg-note bad"><Icon name="x" size={14} />{task.error}</p>}
              </div>
            </div>
          );
        })}
        {pending.map((t) => {
          const a = everyone.find((x) => x.id === t.agent_id);
          if (!a) return null;
          if (t.status === "queued") {
            return <p key={t.id} className="system-note"><Avatar name={a.name} color={a.color} size={16} /> {a.name} is up next</p>;
          }
          const text = live[t.id];
          return (
            <div key={t.id} className="msg">
              <Avatar name={a.name} color={a.color} size={28} />
              <div style={{ minWidth: 0 }}>
                <div className="msg-meta"><strong>{a.name}</strong><span className="hint">replying…</span></div>
                <WorkLog task={t} steps={stepsOf(t.id)} />
                {text ? <Markdown text={text} streaming home={a.home} /> : <p className="msg-note"><Spinner />Thinking…</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupComposer({ group, members, lead }: { group: Group; members: Agent[]; lead?: Agent }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), [group.id]);
  useEffect(() => setDismissed(false), [text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const partial = text.match(/@([A-Za-z0-9_-]*)$/)?.[1];
  const suggestions = partial === undefined || dismissed ? [] : members.filter((a) => a.slug.startsWith(partial.toLowerCase()));
  const targets = mentioned(text, members);

  function insert(a: Agent) {
    setText(text.replace(/@([A-Za-z0-9_-]*)$/, `@${a.slug} `));
    ref.current?.focus();
  }
  async function send() {
    const v = text.trim();
    if (!v) return;
    setError(null);
    setText("");
    try {
      await api.send(group.id, v);
    } catch (e: any) {
      setError(e.message);
      setText(v);
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (suggestions.length && e.key === "Escape") {
      e.preventDefault(); // closes the suggestions instead of stopping agents
      setDismissed(true);
      return;
    }
    if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      insert(suggestions[0]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer-wrap">
      {suggestions.length > 0 && (
        <div className="choices" style={{ maxWidth: 820, margin: "0 auto 8px" }} role="listbox" aria-label="Mention a member" data-esc-owner="">
          {suggestions.map((a) => (
            <button key={a.id} className="pill" onClick={() => insert(a)}>
              <Avatar name={a.name} color={a.color} size={16} />@{a.slug}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea ref={ref} rows={1} value={text} placeholder={`Message #${group.name} — @ to mention`} aria-label={`Message #${group.name}`}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <button className="btn primary sm" style={{ minHeight: 34 }} disabled={!text.trim()} onClick={send} aria-label="Send">
          <Icon name="send" size={14} />
        </button>
      </div>
      <p className="composer-hint">
        {error ? <span style={{ color: "var(--bad)" }}>{error}</span>
          : targets.length ? <>→ {targets.map((a) => a.name).join(", ")} will reply</>
          : <>→ goes to the lead{lead && <> ({lead.name})</>} · ⏎ send · ⇧⏎ new line</>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function GroupEditor({ id }: { id?: string }) {
  const { groups, agents, everyone } = useStore();
  const existing = id ? groups.find((g) => g.id === id) : undefined;
  const [form, setForm] = useState({
    name: existing?.name ?? "", purpose: existing?.purpose ?? "",
    members: existing?.members ?? ([] as string[]), lead: existing?.lead_agent_id ?? (null as string | null),
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const lead = form.lead && form.members.includes(form.lead) ? form.lead : form.members[0] ?? null;

  async function save() {
    setError(null);
    try {
      const g = existing ? await api.updateGroup(existing.id, { ...form, lead }) : await api.createGroup({ ...form, lead });
      go({ name: "group", id: g.id });
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (id && !existing) return <div className="page"><div className="page-inner"><p className="lede">No such group.</p></div></div>;
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 680, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          {existing && <a className="btn ghost sm" href={`#/groups/${existing.id}`} style={{ marginLeft: -10 }}><Icon name="back" />#{existing.name}</a>}
          <h1 style={{ marginTop: existing ? 8 : 0 }}>{existing ? "Group settings" : "New group"}</h1>
          {!existing && <p className="lede" style={{ marginBottom: 0 }}>A shared conversation with several agents. They see each other's replies and @mention each other to pass work along.</p>}
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="g-name">Name</label>
          <input id="g-name" className="text" value={form.name} placeholder="release" maxLength={40}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <span className="hint">Lowercase with dashes, like a channel: #release, #bug-triage.</span>
        </div>
        <div className="field">
          <label htmlFor="g-purpose">Purpose</label>
          <input id="g-purpose" className="text" value={form.purpose} placeholder="Plan, build and ship the next digital_risk release"
            onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
          <span className="hint">Every member sees this with each message, so make it the shared goal.</span>
        </div>
        <div className="field">
          <span style={{ fontWeight: 500 }}>Members</span>
          <AgentPicker agents={agents} value={form.members} onChange={(members) => setForm({ ...form, members })} />
        </div>
        {form.members.length > 0 && (
          <div className="field">
            <span style={{ fontWeight: 500 }} id="g-lead">Lead</span>
            <div className="choices" role="radiogroup" aria-labelledby="g-lead">
              {form.members.map((mid) => {
                const a = everyone.find((x) => x.id === mid);
                if (!a) return null;
                return (
                  <button key={a.id} className="pill" role="radio" aria-checked={lead === a.id} aria-pressed={lead === a.id}
                    onClick={() => setForm({ ...form, lead: a.id })}>
                    <Avatar name={a.name} color={a.color} size={18} />{a.name}{lead === a.id && " ★"}
                  </button>
                );
              })}
            </div>
            <span className="hint">The lead answers messages that don't @mention anyone, and usually coordinates the rest.</span>
          </div>
        )}
        <div className="wizard-nav">
          {existing && (confirmDelete ? (
            <>
              <button className="btn danger" onClick={async () => {
                try { await api.deleteGroup(existing.id); go({ name: "home" }); } catch (e: any) { setError(e.message); }
              }}>Delete #{existing.name}</button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn ghost danger" onClick={() => setConfirmDelete(true)}>Delete group…</button>
          ))}
          <span className="grow" />
          <a className="btn ghost" href={existing ? `#/groups/${existing.id}` : "#/"}>Cancel</a>
          <button className="btn primary" disabled={!form.name.trim() || form.members.length === 0} onClick={save}>
            {existing ? "Save" : "Create group"}
          </button>
        </div>
      </div>
    </div>
  );
}
