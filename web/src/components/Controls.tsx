import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, relTime } from "./ui.tsx";

export const SCREEN_URL = `http://${location.hostname}:7701/vnc.html?autoconnect=1&resize=scale&reconnect=1&show_dot=1`;

/** "coder · since 14:01 · Fix token refresh" — or that the screen is free. */
export function ScreenHolder({ compact = false }: { compact?: boolean }) {
  const { display, agents } = useStore();
  if (!display) return <span className="hint">{compact ? "Screen free" : "Nobody is using the screen"}</span>;
  if (display.holder === "owner") return <span className="holder you">You have control{!compact && ` · since ${relTime(display.since)}`}</span>;
  const a = agents.find((x) => x.id === display.holder);
  return (
    <span className="holder" title={display.reason}>
      {a && <Avatar name={a.name} color={a.color} size={16} />}
      <strong>{a?.name ?? "An agent"}</strong>
      {!compact && <> is using the screen · since {relTime(display.since)}{display.reason && <> · {display.reason}</>}</>}
      {compact && " is on screen"}
    </span>
  );
}

/** Take control from agents / give it back. */
export function TakeControl() {
  const { display } = useStore();
  const mine = display?.holder === "owner";
  return mine ? (
    <button className="btn sm" onClick={() => api.releaseDisplay()}>Release control</button>
  ) : (
    <button className="btn sm" onClick={() => api.takeDisplay()} title="Agents are refused the screen until you release it">Take control</button>
  );
}

export function PauseControl() {
  const { paused } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirm) return;
    api.control().then((c) => setRunning(c.running)).catch(() => {});
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setConfirm(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirm(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [confirm]);

  if (paused) {
    return <button className="btn sm" onClick={() => api.resumeAll()}><Icon name="play" size={14} />Resume</button>;
  }
  return (
    <div className="popover-anchor" ref={ref}>
      <button className="btn sm danger" aria-expanded={confirm} onClick={() => setConfirm(!confirm)}>
        <Icon name="pause" size={14} />Pause all
      </button>
      {confirm && (
        <div className="popover" role="dialog" aria-label="Pause all agents">
          <strong>Pause every agent?</strong>
          <p className="hint">
            Nothing new starts until you resume: queued work waits and routines skip.
            {running > 0 ? ` ${running} turn${running > 1 ? "s are" : " is"} running right now.` : " Nothing is running right now."}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm danger" onClick={() => { api.pauseAll(true); setConfirm(false); }}>
              {running > 0 ? "Stop running turns and pause" : "Pause"}
            </button>
            {running > 0 && (
              <button className="btn sm" onClick={() => { api.pauseAll(false); setConfirm(false); }}>Let them finish, then pause</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PausedBar() {
  const { paused } = useStore();
  if (!paused) return null;
  return (
    <div className="paused-bar global" role="status">
      <Icon name="pause" size={14} />All agents are paused. Queued work waits and routines skip until you resume.
      <button className="btn sm" onClick={() => api.resumeAll()}>Resume</button>
    </div>
  );
}

/** A small live view of the shared screen, pinned to the corner on every page. */
export function ScreenPip() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("agentbox.pip") !== "closed"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("agentbox.pip", open ? "open" : "closed"); } catch { /* storage unavailable */ }
  }, [open]);

  if (!open) {
    return (
      <button className="pip-tab" onClick={() => setOpen(true)} aria-label="Show the shared screen">
        <Icon name="screen" size={14} /><ScreenHolder compact />
      </button>
    );
  }
  return (
    <aside className="pip" aria-label="Shared screen preview">
      <div className="pip-bar">
        <ScreenHolder compact />
        <a className="icon-btn" href="#/screen" aria-label="Open the screen" title="Open the screen"><Icon name="screen" size={14} /></a>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Hide preview" title="Hide preview"><Icon name="close" size={14} /></button>
      </div>
      <div className="pip-screen">
        <iframe src={`http://${location.hostname}:7701/vnc_lite.html?scale=true&view_only=true`} title="Shared screen preview (view only)" tabIndex={-1} />
      </div>
    </aside>
  );
}
