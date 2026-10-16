import { useEffect, useState } from "react";
import { api, type HostedService } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon } from "./ui.tsx";

/** What a task room hosts right now (hosting.ts): one line each, with its link and Stop. */
export function HostedStrip({ roomId }: { roomId: string }) {
  const { onEvent } = useStore();
  const [list, setList] = useState<HostedService[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.hosted(roomId).then((r) => { if (alive) setList(r.services); }).catch(() => {});
    load();
    const off = onEvent((e) => { if (e.type === "hosting.updated" && e.service?.room_id === roomId) load(); });
    return () => { alive = false; off(); };
  }, [roomId, onEvent]);
  const live = list.filter((s) => s.status === "running");
  if (!live.length) return null;
  return (
    <div className="hosted-strip" aria-label="Hosted by this work">
      {live.map((s) => (
        <div key={s.id} className="hosted-line">
          <Icon name="browser" size={14} />
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="hosted-link" title={s.url}>{s.name}</a>
          <span className="hosted-meta">{s.kind === "command" ? s.command : "static files"} · {s.started_by}</span>
          <button className="btn sm ghost" disabled={busy === s.id} title="Stop this service"
            onClick={async () => { setBusy(s.id); try { await api.stopHosted(s.id); } finally { setBusy(null); } }}>
            <Icon name="stop" size={12} />Stop
          </button>
        </div>
      ))}
    </div>
  );
}
