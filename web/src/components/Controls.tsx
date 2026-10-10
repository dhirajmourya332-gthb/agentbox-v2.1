import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, relTime } from "./ui.tsx";

// The screen (noVNC) and terminal (ttyd) are served through the portal's /screen and /term proxies,
// behind the same login and Origin checks as /api (docs/ACCESS.md). noVNC builds its WebSocket URL
// from `path`, relative to the site root.
export const SCREEN_URL = "/screen/vnc.html?autoconnect=1&resize=scale&reconnect=1&show_dot=1&path=screen/websockify";
export const SCREEN_PREVIEW_URL = "/screen/vnc_lite.html?scale=true&view_only=true&path=screen/websockify";
export const TERMINAL_URL = "/term/";

/**
 * A noVNC URL with the VNC password (x11vnc -passwdfile) in the fragment, which browsers never send
 * to a server; noVNC reads `&password=` from the whole URL. null while the password is loading.
 */
export function useScreenUrl(base: string): string | null {
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.screenCredential()
      .then((r) => alive && setPassword(r.password))
      .catch(() => alive && setPassword(null));
    return () => { alive = false; };
  }, []);
  if (password === undefined) return null;
  return password ? `${base}#&password=${encodeURIComponent(password)}` : base;
}

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

type Theme = "system" | "light" | "dark";
const THEMES: { key: Theme; label: string; icon: string }[] = [
  { key: "system", label: "System", icon: "screen" },
  { key: "light", label: "Light", icon: "sun" },
  { key: "dark", label: "Dark", icon: "moon" },
];

/** Light / Dark / System (backlog #2). Remembered per browser; applied instantly. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("agentbox.theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("agentbox.theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const current = THEMES.find((t) => t.key === theme)!;
  return (
    <div className="popover-anchor" ref={ref}>
      <button className="icon-btn" aria-label={`Theme: ${current.label}`} title={`Theme: ${current.label}`} aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <Icon name={current.icon} />
      </button>
      {open && (
        <div className="popover menu" role="menu" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.key} role="menuitemradio" aria-checked={theme === t.key} className="menu-item"
              onClick={() => { setTheme(t.key); setOpen(false); }}>
              <Icon name={t.icon} size={14} />{t.label}{theme === t.key && <span className="menu-check"><Icon name="check" size={14} /></span>}
            </button>
          ))}
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
  const { display } = useStore();
  // "auto": a small pill, opening by itself while an agent is using the screen. A choice made by
  // hand (open / closed) sticks.
  const [mode, setMode] = useState<"auto" | "open" | "closed">(() => {
    try { const v = localStorage.getItem("agentbox.pip2"); return v === "open" || v === "closed" ? v : "auto"; } catch { return "auto"; }
  });
  const choose = (m: "open" | "closed") => {
    setMode(m);
    try { localStorage.setItem("agentbox.pip2", m); } catch { /* storage unavailable */ }
  };
  const agentOnScreen = !!display && display.holder !== "owner";
  const open = mode === "open" || (mode === "auto" && agentOnScreen);
  const setOpen = (v: boolean) => choose(v ? "open" : "closed");
  const previewUrl = useScreenUrl(SCREEN_PREVIEW_URL);

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
        {previewUrl && <iframe src={previewUrl} title="Shared screen preview (view only)" tabIndex={-1} />}
      </div>
    </aside>
  );
}
