import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Icon, Markdown, Spinner, relTime, setPathRoots } from "../components/ui.tsx";
import { ThemeSwitch } from "../components/ThemeSwitch.tsx";

/**
 * Shared work, as a guest sees it: one task room's conversation (live), its agents' progress, the
 * roadmap, documents, notes and hosted services; with an edit link, a message box too. Everything
 * comes from the guest server (server/src/shareServer.ts), scoped to the link's work.
 *
 * A group's link opens several places (the group's conversation, its workspaces, work linked to it):
 * a bar on top switches between them, and every request names the place (?room=).
 */

type Author =
  | { kind: "owner" } | { kind: "guest"; name: string } | { kind: "system" } | { kind: "card"; card: string }
  | { kind: "agent"; id: string; name: string; color: string };
type Msg = { id: string; thread_id: string; task_id: string | null; created_at: string; author: Author; content: string };
type Task = {
  id: string; agent_id: string; thread_id: string; source: string; status: string; title: string;
  from: { id: string; name: string; color: string } | null; created_at: string; started_at: string | null; finished_at: string | null; error: string | null;
};
type Member = { id: string; name: string; label: string | null; color: string; status: string; current: string | null };
type Progress = { agent_id: string; task_id: string; activity: string; state: "working" | "stalled"; started_at: string; stalled_for_s: number | null };
type Place = { id: string; kind: "work" | "group" | "workspace" | "linked"; title: string; edit: boolean; done: boolean };
type Room = {
  share: { perm: "read" | "edit"; label: string; expires_at: string; kind?: "work" | "group" };
  scope?: Place[]; place?: Place;
  root: { id: string; name: string; label: string | null; color: string; done: boolean; group?: boolean; purpose?: string };
  members: Member[]; lead_thread: string | null; messages: Msg[]; tasks: Task[]; progress: Progress[]; roots: string[];
};
type Roadmap = { id: string; title: string; status: string; counts: { done: number; total: number; blocked: number }; items: { id: string; title: string; status: string; phase: string | null; owner: string | null; note: string | null }[] };
type Doc = { path: string; name: string; location: string; size: number; modified: string; task_title: string | null };
type Note = { id: string; quote: string | null; body: string; created_at: string };
type Service = { id: string; name: string; status: string; started_by: string; created_at: string };

class Gone extends Error {}
const ENDED = "ended";
const INCOMPLETE = "incomplete";
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: "same-origin",
    // ngrok's free domains show a browser warning page; API calls skip it.
    headers: { "ngrok-skip-browser-warning": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Gone((data as any).error ?? "This link has expired");
  if (!res.ok) throw new Error((data as any).error ?? `${res.status}`);
  return data as T;
}

const until = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expired";
  const h = ms / 3600_000;
  return h < 1 ? `${Math.ceil(ms / 60_000)} minutes left` : h < 48 ? `${Math.round(h)} hours left` : `${Math.round(h / 24)} days left`;
};
const upsert = <T extends { id: string }>(list: T[], item: T) => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice(); next[i] = item; return next;
};
const CARD: Record<string, string> = {
  plan: "A plan was shared with the owner", review: "The owner reviewed the changes", roadmap: "The roadmap was updated",
  approval: "A team change was proposed to the owner", setup_request: "An agent asked the owner to set something up", integration: "An integration step",
};

export function ShareApp() {
  const [room, setRoom] = useState<Room | null>(null);
  // Which place of a group's link is open (none: the server's first, i.e. the group itself).
  const [placeId, setPlaceId] = useState<string | null>(null);
  const placeRef = useRef<string | null>(null);
  placeRef.current = placeId;
  const q = (id: string | null) => (id ? `?room=${encodeURIComponent(id)}` : "");
  const [gone, setGone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, { agent_id: string; text: string }>>({});
  const [bump, setBump] = useState({ roadmaps: 0, notes: 0, services: 0 });
  const refetch = useRef<number | null>(null);

  const tokenInUrl = () => { const t = location.hash.replace(/^#/, ""); return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; };
  const [offline, setOffline] = useState(false);

  /**
   * The room, or why not. Only the server says a link has ended (a 401 to a fresh session); a page
   * that lost its connection (the server restarting, the tunnel reconnecting) keeps trying instead.
   */
  const load = useCallback(async () => {
    try {
      const r = await call<Room>("GET", `/api/room${q(placeRef.current)}`).catch(async (e) => {
        // The place left the link (unlinked): back to the link's first place.
        if (placeRef.current && !(e instanceof Gone)) { placeRef.current = null; setPlaceId(null); return call<Room>("GET", "/api/room"); }
        throw e;
      });
      setPathRoots(r.roots);
      setRoom(r);
      setOffline(false);
      setError(null);
    } catch (e: any) {
      if (!(e instanceof Gone)) { setOffline(true); setError(e.message); return; }
      const token = tokenInUrl();
      if (!token) { setGone(INCOMPLETE); return; }
      // The cookie may be gone (another browser, cleared data): the link itself opens it again.
      try { await call("POST", "/api/session", { token }); } catch (e2: any) { setGone(e2 instanceof Gone ? ENDED : e2.message); return; }
      try { const r = await call<Room>("GET", `/api/room${q(placeRef.current)}`); setPathRoots(r.roots); setRoom(r); setOffline(false); } catch { setGone(ENDED); }
    }
  }, []);

  // The link's token is in the #fragment, which browsers never send to a server (ngrok included): it's
  // traded for a cookie, and stays in the address bar so the link can be reloaded, bookmarked and passed on.
  useEffect(() => {
    const token = tokenInUrl();
    (async () => {
      if (token) {
        try { await call("POST", "/api/session", { token }); } catch (e: any) { setGone(e instanceof Gone ? ENDED : e.message); return; }
      }
      await load();
    })();
    // Another link opened in this tab: start over with it.
    const onHash = () => { if (tokenInUrl()) location.reload(); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [load]);

  // Live updates for this work only.
  useEffect(() => {
    if (!room || gone) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | null = null;
    const soon = () => {
      if (refetch.current) return;
      refetch.current = window.setTimeout(() => { refetch.current = null; void load(); }, 600);
    };
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events${q(room.place?.id ?? null)}`);
      ws.onmessage = (ev) => {
        let e: any;
        try { e = JSON.parse(ev.data); } catch { return; }
        if (e.type === "message") {
          setRoom((r) => (r ? { ...r, messages: upsert(r.messages, e.message) } : r));
          if (e.message.task_id) setLive((l) => { if (!l[e.message.task_id]) return l; const n = { ...l }; delete n[e.message.task_id]; return n; });
        } else if (e.type === "task") {
          setRoom((r) => (r ? { ...r, tasks: upsert(r.tasks, e.task) } : r));
          if (!["running", "queued"].includes(e.task.status)) setLive((l) => { if (!l[e.task.id]) return l; const n = { ...l }; delete n[e.task.id]; return n; });
        } else if (e.type === "turn.text") {
          setLive((l) => ({ ...l, [e.task_id]: { agent_id: e.agent_id, text: e.text } }));
        } else if (e.type === "progress") {
          setRoom((r) => (r ? { ...r, progress: [...r.progress.filter((p) => p.task_id !== e.progress.task_id), e.progress] } : r));
        } else if (e.type === "progress.cleared") {
          setRoom((r) => (r ? { ...r, progress: r.progress.filter((p) => p.task_id !== e.task_id) } : r));
        } else if (e.type === "roadmaps" || e.type === "notes" || e.type === "services") {
          setBump((b) => ({ ...b, [e.type]: b[e.type as keyof typeof b] + 1 }));
        } else if (e.type === "room" || e.type === "scope") soon();
        else if (e.type === "expired") void load(); // the server confirms it
      };
      ws.onopen = () => setOffline(false);
      // Whatever closed it (a restart, the tunnel, the link ending), reload: the room call decides.
      ws.onclose = () => {
        if (closed) return;
        setOffline(true);
        retry = window.setTimeout(() => { void load(); connect(); }, 3000);
      };
    };
    connect();
    return () => { closed = true; if (retry) clearTimeout(retry); ws?.close(); };
  }, [room?.root.id, gone, load]);

  // Switching place: its conversation, panels and live feed.
  const go = (id: string) => {
    if (id === room?.place?.id) return;
    placeRef.current = id;
    setPlaceId(id);
    setLive({});
    void load();
  };

  if (gone === INCOMPLETE) return <Notice title="This link is incomplete" text="Open the whole link you were sent: it ends with # and a long code." />;
  if (gone) return <Notice title="This link isn't open any more" text={gone === ENDED ? "It has expired or was turned off. Ask whoever shared it for a new one." : gone} />;
  if (error && !room) return <Notice title="Couldn't open the shared work" text={error} />;
  if (!room) return <div className="share-loading"><div className="share-corner"><ThemeSwitch /></div><Spinner /></div>;
  return <Shared key={room.root.id} room={room} live={live} bump={bump} offline={offline} onPlace={go} />;
}

const KIND_LABEL: Record<Place["kind"], string> = { group: "Group", workspace: "Workspaces", linked: "Linked (read-only)", work: "Work" };

/** A group's link: the group, its workspaces and the work linked to it, one tap apart. */
function Places({ scope, current, onPlace }: { scope: Place[]; current: string; onPlace: (id: string) => void }) {
  const kinds = (["group", "workspace", "linked"] as const).filter((k) => scope.some((p) => p.kind === k));
  return (
    <nav className="share-places" aria-label="Shared places">
      {kinds.map((k) => (
        <span key={k} className="share-places-group">
          {k !== "group" && <span className="hint share-places-label">{KIND_LABEL[k]}</span>}
          {scope.filter((p) => p.kind === k).map((p) => (
            <button key={p.id} className="pill" aria-pressed={p.id === current} onClick={() => onPlace(p.id)}
              title={p.kind === "linked" ? "Linked to the group: read-only" : p.done ? "Finished" : undefined}>
              {p.kind === "group" ? <span aria-hidden="true">#</span> : <Icon name={p.kind === "linked" ? "web" : "room"} size={12} />}
              {p.kind === "group" ? p.title.replace(/^#/, "") : p.title}{p.done ? <span className="hint"> · done</span> : null}
            </button>
          ))}
        </span>
      ))}
    </nav>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <main className="share-notice">
      <div className="share-corner"><ThemeSwitch /></div>
      <h1>{title}</h1>
      <p className="hint">{text}</p>
    </main>
  );
}

function Shared({ room, live, bump, offline, onPlace }: { room: Room; live: Record<string, { agent_id: string; text: string }>; bump: { roadmaps: number; notes: number; services: number }; offline: boolean; onPlace: (id: string) => void }) {
  const [panel, setPanel] = useState<"roadmap" | "documents" | "notes" | "services" | null>(() => (window.innerWidth > 1000 ? "roadmap" : null));
  const [reader, setReader] = useState<{ path: string; name: string; text: string | null } | null>(null);
  const place = room.place;
  const edit = place ? place.edit && !place.done : room.share.perm === "edit" && !room.root.done;
  const linkedOnly = room.share.perm === "edit" && place?.kind === "linked";
  const rq = place ? `?room=${encodeURIComponent(place.id)}` : "";
  const member = (id: string) => room.members.find((m) => m.id === id);
  const running = room.tasks.filter((t) => t.status === "running");
  const replied = new Set(room.messages.map((m) => m.task_id).filter(Boolean));
  const waiting = room.tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));
  const end = useRef<HTMLDivElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [room.messages.length, live]);

  // File links in messages open in the reader (Markdown and text) or a new tab (everything else).
  const onClick = async (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.file-link");
    if (!a?.dataset.filePath) return;
    e.preventDefault();
    openFile(a.dataset.filePath);
  };
  const openFile = async (p: string) => {
    const name = p.split("/").pop() ?? p;
    if (!/\.(md|markdown|txt|log|csv|json|ya?ml|py|ts|tsx|js|sh|toml|ini|cfg|xml|rst)$/i.test(name)) {
      window.open(`/api/file?path=${encodeURIComponent(p)}`, "_blank", "noopener");
      return;
    }
    setReader({ path: p, name, text: null });
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(p)}`, { headers: { "ngrok-skip-browser-warning": "1" } });
      const text = res.ok ? await res.text() : ((await res.json().catch(() => ({}))) as any).error ?? "Couldn't open it";
      setReader({ path: p, name, text });
    } catch { setReader({ path: p, name, text: "Couldn't open it" }); }
  };

  return (
    <div className={`share-app${panel ? " with-panel" : ""}`}>
      <section className="share-main" aria-label={room.root.label ?? room.root.name}>
        {room.scope && room.scope.length > 1 && place && <Places scope={room.scope} current={place.id} onPlace={onPlace} />}
        <header className="share-head">
          <div className="share-title">
            <strong>{room.root.label ?? room.root.name}</strong>
            {room.root.purpose ? <span className="hint">{room.root.purpose}</span> : null}
            <span className="hint">
              Shared with {room.share.label} · {edit ? "you can chat with the agents" : room.root.done ? "finished" : linkedOnly ? "linked to the group, read-only" : "read-only"} · {until(room.share.expires_at)}
              {offline && <span className="share-offline"> · reconnecting…</span>}
            </span>
          </div>
          <div className="share-actions">
            {edit && running.length > 0 && (
              <button className="btn sm danger" onClick={() => running.forEach((t) => void call("POST", "/api/stop", { task_id: t.id }).catch(() => {}))}>
                <Icon name="stop" size={14} />Stop
              </button>
            )}
            <ThemeSwitch />
            <nav className="segmented" aria-label="Details">
              {(["roadmap", "documents", "notes", "services"] as const).map((k) => (
                <button key={k} aria-pressed={panel === k} onClick={() => setPanel(panel === k ? null : k)}>{k[0].toUpperCase() + k.slice(1)}</button>
              ))}
            </nav>
          </div>
        </header>
        <div className="share-members">
          {room.members.map((m) => (
            <span key={m.id} className="share-member" title={m.current ?? m.status}>
              <span className={`glyph ${m.status === "working" ? "working" : ""}`} />{m.label ?? m.name} <span className="hint">{m.name}</span>
            </span>
          ))}
        </div>

        <div className="timeline share-timeline" ref={timeline} onClick={onClick}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="timeline-inner">
            {room.messages.map((m) => <Message key={m.id} m={m} task={room.tasks.find((t) => t.id === m.task_id)} />)}
            {waiting.map((t) => {
              const who = member(t.agent_id);
              const text = live[t.id]?.text;
              return (
                <div key={t.id} className="msg">
                  <Avatar name={who?.name ?? "?"} color={who?.color ?? "var(--muted)"} size={28} />
                  <div style={{ minWidth: 0 }}>
                    <div className="msg-meta"><strong>{who?.name ?? "agent"}</strong><span className="hint">{t.status === "queued" ? "queued" : "working"}</span></div>
                    {text ? <Markdown text={text} streaming /> : <p className="hint">{t.status === "queued" ? "Starts when it's free." : <>Thinking… <Spinner /></>}</p>}
                  </div>
                </div>
              );
            })}
            <div ref={end} />
          </div>
        </div>

        {room.progress.length > 0 && (
          <div className="share-progress">
            {room.progress.map((p) => (
              <div key={p.task_id} className={`share-progress-line${p.state === "stalled" ? " stalled" : ""}`}>
                <span className="glyph working" />
                <strong>{member(p.agent_id)?.name ?? "agent"}</strong>
                <span className="share-progress-text">{p.activity}</span>
                <span className="hint">{relTime(p.started_at)}</span>
              </div>
            ))}
          </div>
        )}

        {edit ? <Composer room={place?.id} group={place?.kind === "group"} />
          : <p className="hint share-readonly">{room.root.done ? "This work is finished."
            : linkedOnly ? "This work is linked to the group for reading: you can follow it, not message it."
            : "You're following this work live. This link can't send messages."}</p>}
      </section>

      {panel && (
        <aside className="share-panel" aria-label={panel}>
          <div className="share-panel-head">
            <strong>{panel[0].toUpperCase() + panel.slice(1)}</strong>
            <button className="icon-btn" aria-label="Close" onClick={() => setPanel(null)}><Icon name="close" /></button>
          </div>
          {panel === "roadmap" && <Roadmaps bump={bump.roadmaps} rq={rq} />}
          {panel === "documents" && <Documents onOpen={openFile} rq={rq} />}
          {panel === "notes" && <Notes bump={bump.notes} rq={rq} />}
          {panel === "services" && <Services bump={bump.services} rq={rq} />}
        </aside>
      )}

      {reader && (
        <div className="share-reader" role="dialog" aria-label={reader.name} onKeyDown={(e) => { if (e.key === "Escape") setReader(null); }}>
          <div className="share-reader-box">
            <div className="share-panel-head">
              <strong>{reader.name}</strong>
              <span className="row" style={{ gap: 6 }}>
                <a className="btn sm" href={`/api/file?path=${encodeURIComponent(reader.path)}&download=1`}><Icon name="download" size={14} />Download</a>
                <button className="icon-btn" aria-label="Close" autoFocus onClick={() => setReader(null)}><Icon name="close" /></button>
              </span>
            </div>
            <div className="share-reader-body">
              {reader.text === null ? <Spinner />
                : /\.(md|markdown)$/i.test(reader.name) ? <Markdown text={reader.text} base={reader.path.slice(0, reader.path.lastIndexOf("/"))} />
                : <pre>{reader.text}</pre>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Message({ m, task }: { m: Msg; task?: Task }) {
  const a = m.author;
  if (a.kind === "system") return <p className="system-note">{m.content}</p>;
  if (a.kind === "card") return <p className="system-note">{CARD[a.card] ?? "An update for the owner"}</p>;
  const handoff = a.kind === "agent" && task && task.agent_id !== a.id && task.source !== "user";
  const name = a.kind === "owner" ? "Owner" : a.kind === "guest" ? a.name : a.name;
  return (
    <div className="msg" data-msg-id={m.id}>
      {a.kind === "agent" ? <Avatar name={a.name} color={a.color} size={28} />
        : <span className="avatar you-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta">
          <strong>{name}</strong>
          {a.kind === "guest" && <span className="tag">guest</span>}
          {handoff && <span className="hint">{task!.source === "result" ? "reported back" : "handed off"}</span>}
          <time dateTime={m.created_at}>{relTime(m.created_at)}</time>
        </div>
        <div className={handoff ? "handoff" : undefined}><Markdown text={m.content} /></div>
      </div>
    </div>
  );
}

function useList<T>(url: string, key: string, bump = 0) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    call<any>("GET", url).then((d) => { if (alive) setItems(d[key]); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [url, key, bump]);
  return { items, error };
}

const MARK: Record<string, string> = { done: "✔", doing: "▶", blocked: "■", todo: "○", skipped: "–" };
function Roadmaps({ bump, rq }: { bump: number; rq: string }) {
  const { items, error } = useList<Roadmap>(`/api/roadmaps${rq}`, "roadmaps", bump);
  if (error) return <div className="error-box">{error}</div>;
  if (!items) return <Spinner />;
  if (!items.length) return <p className="hint">No roadmap yet. Leads draw one for bigger work.</p>;
  return (
    <div className="share-list-col">
      {items.map((r) => (
        <div key={r.id} className="share-roadmap">
          <strong>{r.title}</strong> <span className="hint">{r.counts.done}/{r.counts.total} done{r.counts.blocked ? `, ${r.counts.blocked} blocked` : ""}</span>
          <ul>
            {r.items.map((i) => (
              <li key={i.id} className={`rm-${i.status}`}>
                <span className="rm-mark" aria-label={i.status}>{MARK[i.status] ?? "?"}</span>
                <span>{i.phase ? <span className="hint">{i.phase} · </span> : null}{i.title}{i.owner ? <span className="hint"> ({i.owner})</span> : null}
                  {i.note ? <span className="hint rm-note">{i.note}</span> : null}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Documents({ onOpen, rq }: { onOpen: (p: string) => void; rq: string }) {
  const { items, error } = useList<Doc>(`/api/documents${rq}`, "documents");
  const [q, setQ] = useState("");
  const shown = useMemo(() => (items ?? []).filter((d) => !q.trim() || `${d.name} ${d.location}`.toLowerCase().includes(q.trim().toLowerCase())), [items, q]);
  if (error) return <div className="error-box">{error}</div>;
  if (!items) return <Spinner />;
  if (!items.length) return <p className="hint">No documents yet.</p>;
  return (
    <div className="share-list-col">
      <input className="text" placeholder="Search documents…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
      <ul className="share-docs">
        {shown.map((d) => (
          <li key={d.path}>
            <button className="menu-item" onClick={() => onOpen(d.path)}>
              <Icon name="doc" size={14} />
              <span className="share-doc-text"><span>{d.name}</span><span className="hint">{d.location} · {relTime(d.modified)}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notes({ bump, rq }: { bump: number; rq: string }) {
  const { items, error } = useList<Note>(`/api/notes${rq}`, "notes", bump);
  if (error) return <div className="error-box">{error}</div>;
  if (!items) return <Spinner />;
  if (!items.length) return <p className="hint">No notes yet.</p>;
  return (
    <ul className="share-notes">
      {items.map((n) => (
        <li key={n.id} className="card">
          {n.quote && <blockquote>{n.quote}</blockquote>}
          {n.body && <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{n.body}</p>}
          <span className="hint">{relTime(n.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Services({ bump, rq }: { bump: number; rq: string }) {
  const { items, error } = useList<Service>(`/api/services${rq}`, "services", bump);
  if (error) return <div className="error-box">{error}</div>;
  if (!items) return <Spinner />;
  return (
    <div className="share-list-col">
      <p className="hint" style={{ margin: 0 }}>What the agents host for this work. They run on the owner's private network, so they open only there.</p>
      {!items.length ? <p className="hint">Nothing hosted.</p> : (
        <ul className="share-docs">
          {items.map((s) => (
            <li key={s.id} className="share-service">
              <span className={`glyph ${s.status === "running" ? "working" : ""}`} />
              <span className="share-doc-text"><span>{s.name}</span><span className="hint">{s.status} · by {s.started_by} · {relTime(s.created_at)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

function Composer({ room, group }: { room?: string; group?: boolean }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const attach = async (list: FileList | null) => {
    if (!list) return;
    setError(null);
    for (const f of Array.from(list).slice(0, 10 - files.length)) {
      if (f.size > 20 * 1024 * 1024) { setError(`${f.name} is over 20 MB`); continue; }
      try {
        const r = await call<{ path: string; name: string }>("POST", "/api/uploads", { name: f.name, type: f.type, data: await toBase64(f) });
        setFiles((x) => [...x, { path: r.path, name: f.name }]);
      } catch (e: any) { setError(e.message); }
    }
  };
  const send = async () => {
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true); setError(null);
    try {
      await call("POST", "/api/messages", { text, files: files.map((f) => f.path), ...(room ? { room } : {}) });
      setText(""); setFiles([]);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  return (
    <div className="share-composer">
      {error && <div className="error-box">{error}</div>}
      {files.length > 0 && (
        <div className="share-files">
          {files.map((f) => (
            <span key={f.path} className="tag">{f.name}
              <button className="linked-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.path !== f.path))}><Icon name="x" size={10} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="composer share-compose-row">
        <button className="icon-btn" aria-label="Attach files" onClick={() => input.current?.click()}><Icon name="clip" /></button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ""; }} />
        <textarea className="text" rows={2} placeholder={group ? "Message the group (@name to bring someone in)…" : "Message the agents…"} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} aria-label="Message" />
        <button className="btn primary" disabled={busy || (!text.trim() && !files.length)} onClick={send}><Icon name="send" size={14} />Send</button>
      </div>
    </div>
  );
}
