import { useEffect, useState } from "react";
import { api, type HostedService } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, relTime } from "./ui.tsx";

/** Running hosted services (hosting.ts): one room's, or every room's. Live via hosting.updated. */
export function useHosted(roomId?: string) {
  const { onEvent } = useStore();
  const [list, setList] = useState<HostedService[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => (roomId ? api.hosted(roomId) : api.hostedAll())
      .then((r) => { if (alive) setList(r.services.filter((s) => s.status === "running")); }).catch(() => { if (alive) setList([]); });
    load();
    const off = onEvent((e) => { if (e.type === "hosting.updated" && (!roomId || e.service?.room_id === roomId)) load(); });
    return () => { alive = false; off(); };
  }, [roomId, onEvent]);
  return list;
}

function StopButton({ s }: { s: HostedService }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn sm ghost" disabled={busy} title={`Stop ${s.name}`} aria-label={`Stop ${s.name}`}
      onClick={async (e) => { e.preventDefault(); e.stopPropagation(); setBusy(true); try { await api.stopHosted(s.id); } finally { setBusy(false); } }}>
      <Icon name="stop" size={12} />Stop
    </button>
  );
}

/** What a task room hosts right now: one line each under the room's header, with its link and Stop. */
export function HostedStrip({ roomId }: { roomId: string }) {
  const live = useHosted(roomId) ?? [];
  if (!live.length) return null;
  return (
    <div className="hosted-strip" aria-label="Hosted by this work">
      {live.map((s) => (
        <div key={s.id} className="hosted-line">
          <Icon name="browser" size={14} />
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="hosted-link" title={s.url}>{s.name}</a>
          <span className="hosted-meta">{s.kind === "command" ? s.command : "static files"} · {s.started_by}</span>
          <StopButton s={s} />
        </div>
      ))}
    </div>
  );
}

/**
 * Hosted services as a list: the room panel's Services tab (one room) and the Overview (every room,
 * each linked to its room).
 */
export function HostedList({ roomId, empty }: { roomId?: string; empty?: string }) {
  const { work } = useStore();
  const live = useHosted(roomId);
  if (!live) return <p className="hint">Loading…</p>;
  if (!live.length) return empty ? <p className="hint">{empty}</p> : null;
  const roomOf = (id: string) => [...work.live, ...work.done].find((w) => w.root.id === id);
  return (
    <ul className="doc-list hosted-list">
      {live.map((s) => {
        const room = roomId ? undefined : roomOf(s.room_id);
        return (
          <li key={s.id}>
            <div className="doc-row hosted-row">
              <span className="doc-badge">{s.kind === "command" ? "APP" : "WEB"}</span>
              <span className="doc-text">
                <a className="doc-name hosted-link" href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
                  {s.name} <Icon name="web" size={12} />
                </a>
                <span className="hint hosted-meta" title={s.kind === "command" ? s.command ?? "" : s.dir}>
                  {room && <><a href={room.members.length > 1 ? `#/work/${room.root.id}` : `#/agents/${room.root.id}`}>{room.root.label ?? room.root.name}</a> · </>}
                  {s.started_by} · {s.kind === "command" ? s.command : "static files"} · {relTime(s.created_at)}
                </span>
              </span>
              <StopButton s={s} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
