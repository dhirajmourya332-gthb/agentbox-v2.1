import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import { toggleModule } from "../src/profile.ts";
import type { LogEntry, ModuleView, Snapshot, StepState, StepView } from "./types.ts";

// Every URL is relative: the page lives at / (direct) or /setup/ (through the portal).
const wsUrl = (p: string) => { const u = new URL(p, location.href); u.protocol = u.protocol === "https:" ? "wss:" : "ws:"; return u.toString(); };
async function post(p: string, body?: unknown) {
  const r = await fetch(p, { method: "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

const ICON: Record<StepState, string> = { pending: "○", running: "●", human: "⏸", done: "✔", failed: "✖", disabled: "─" };
const LABEL: Record<StepState, string> = { pending: "pending", running: "working", human: "your turn", done: "done", failed: "failed", disabled: "off" };

// --- the terminal (shared so "Paste in terminal" can type into it) -----------------------------------
let termSend: ((s: string) => void) | null = null;

function cssVar(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function termTheme() {
  return { background: cssVar("--term-bg"), foreground: cssVar("--term-fg"), cursor: cssVar("--accent"), selectionBackground: cssVar("--term-sel") };
}

function TerminalPane({ finished }: { finished: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  useEffect(() => {
    const term = new Terminal({ fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: termTheme(), allowProposedApi: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoff = 500;
    const sendSize = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows })); };
    const connect = () => {
      setStatus("connecting");
      ws = new WebSocket(wsUrl("ws/term"));
      ws.onopen = () => { setStatus("open"); backoff = 500; term.reset(); fit.fit(); sendSize(); };
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
      ws.onclose = () => {
        setStatus("closed");
        if (!stopped) setTimeout(connect, backoff = Math.min(backoff * 2, 8000));
      };
    };
    connect();
    const sub = term.onData((d) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "i", d })); });
    termSend = (s) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "i", d: s })); term.focus(); };
    const ro = new ResizeObserver(() => { try { fit.fit(); sendSize(); } catch { /* hidden */ } });
    ro.observe(host.current!);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => { term.options.theme = termTheme(); };
    mq.addEventListener("change", retheme);
    window.addEventListener("guide-theme", retheme);
    return () => { stopped = true; sub.dispose(); ro.disconnect(); ws?.close(); term.dispose(); mq.removeEventListener("change", retheme); window.removeEventListener("guide-theme", retheme); termSend = null; };
  }, []);
  useEffect(() => { if (finished) termSend = null; }, [finished]);
  return (
    <section className="pane term-pane" aria-label="Terminal">
      <div className="pane-head">
        <span>Terminal</span>
        <span className={`conn ${status}`}>{status === "open" ? "connected" : status}</span>
      </div>
      <div className="term-host" ref={host} />
    </section>
  );
}

// --- the setup agent's log ----------------------------------------------------------------------------
function AgentLog({ log, status }: { log: LogEntry[]; status: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [log]);
  return (
    <section className="pane log-pane" aria-label="Setup agent">
      <div className="pane-head"><span>Setup agent</span><span className={`agent-status s-${status}`}>{agentLabel(status)}</span></div>
      <div className="log" ref={box} onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }}>
        {log.length === 0 && <p className="muted">The setup agent's work shows up here once you start it.</p>}
        {log.map((e) => (
          <div key={e.id} className={`log-entry k-${e.kind}`}>
            <time>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            {e.kind === "text" ? <div className="md" dangerouslySetInnerHTML={{ __html: md(e.text) }} /> : <pre>{e.text}</pre>}
          </div>
        ))}
      </div>
    </section>
  );
}
const agentLabel = (s: string) => ({ idle: "idle", running: "working…", waiting: "waiting for you", paused: "paused" }[s] ?? s);

function md(s: string) { return DOMPurify.sanitize(marked.parse(s, { async: false, gfm: true, breaks: true }) as string); }

// --- roadmap pieces --------------------------------------------------------------------------------------
async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); return true; } catch {
    const t = document.createElement("textarea"); t.value = s; document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy"); t.remove(); return ok;
  }
}

function CopyRow({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-row">
      <code>{text}</code>
      <button className="btn small" onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } }}>{done ? "Copied" : "Copy"}</button>
      <button className="btn small" title="Type it into the terminal (you press Enter)" onClick={() => termSend?.(text)}>Paste in terminal</button>
    </div>
  );
}

function YourTurn({ step }: { step: StepView }) {
  return (
    <div className="your-turn">
      <div className="yt-head">Your turn</div>
      {step.instructions && <div className="md" dangerouslySetInnerHTML={{ __html: md(step.instructions) }} />}
      {step.copy && <CopyRow text={step.copy} />}
      {step.check && <div className="waiting">Waiting for: <code>{step.check.length > 140 ? step.check.slice(0, 140) + "…" : step.check}</code></div>}
    </div>
  );
}

function StepRow({ step, onRetry }: { step: StepView; onRetry?: () => void }) {
  return (
    <li className={`step st-${step.state}`}>
      <div className="step-line">
        <span className="icon" aria-label={LABEL[step.state]} title={LABEL[step.state]}>{ICON[step.state]}</span>
        <span className="step-title">{step.title}</span>
        {step.state === "running" && <span className="tag">working…</span>}
      </div>
      {step.state === "human" && <YourTurn step={step} />}
      {step.state === "failed" && (
        <div className="failure">
          {step.error && <pre>{step.error}</pre>}
          {onRetry && <button className="btn small" onClick={onRetry}>Retry</button>}
        </div>
      )}
    </li>
  );
}

function ModuleGroup({ m, onRetry, hide }: { m: ModuleView; onRetry: (id: string) => void; hide?: Set<string> }) {
  const steps = m.steps.filter((s) => !hide?.has(s.key));
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (m.state !== "done");
  return (
    <section className={`group st-${m.state}`}>
      <button className="group-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <span className="icon">{ICON[m.state]}</span>
        <span className="group-title">{m.title}</span>
        {m.implied && <span className="tag">needed by another module</span>}
        <span className="count">{steps.filter((s) => s.state === "done").length}/{steps.length}</span>
      </button>
      {expanded && <ul className="steps">{steps.map((s) => <StepRow key={s.key} step={s} onRetry={() => onRetry(m.id)} />)}</ul>}
    </section>
  );
}

function ProfileCard({ snap, onError }: { snap: Snapshot; onError: (e: string) => void }) {
  const mods = snap.roadmap.modules;
  const optional = mods.filter((m) => !snap.profile.required.includes(m.id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  const current = draft ?? snap.profile.modules;
  const showEditor = editing || (!snap.profile.done && snap.profile.checked);
  const deps = mods.map((m) => ({ id: m.id, depends: m.depends }));
  const save = async () => {
    setBusy(true);
    try { await post("api/profile", { modules: current }); setEditing(false); setDraft(null); } catch (e: any) { onError(e.message); }
    setBusy(false);
  };
  const on = [...snap.profile.required, ...Object.entries(snap.profile.modules).filter(([, v]) => v).map(([k]) => k)];
  return (
    <div className="card">
      <div className="step-line">
        <span className="icon">{snap.profile.done ? ICON.done : snap.profile.checked ? ICON.human : ICON.pending}</span>
        <span className="step-title">Choose your modules</span>
        {snap.profile.done && !showEditor && <button className="btn small link" onClick={() => { setEditing(true); setDraft(null); }}>Change</button>}
      </div>
      {!showEditor && snap.profile.done && <p className="muted small">{on.join(" · ")}</p>}
      {showEditor && (
        <div className="profile">
          <p className="muted small">core, Claude Code and access are always on. Turning a module on also turns on what it needs. Nothing of a module is installed unless it's on.</p>
          <ul className="toggles">
            {mods.filter((m) => snap.profile.required.includes(m.id)).map((m) => (
              <li key={m.id} className="toggle fixed"><input type="checkbox" checked disabled id={`t-${m.id}`} /><label htmlFor={`t-${m.id}`}><b>{m.title}</b> <span className="muted">always on</span><br /><span className="muted small">{m.description}</span></label></li>
            ))}
            {optional.map((m) => (
              <li key={m.id} className="toggle">
                <input type="checkbox" id={`t-${m.id}`} checked={!!current[m.id]} onChange={(e) => setDraft(toggleModule(deps, current, m.id, e.target.checked))} />
                <label htmlFor={`t-${m.id}`}>
                  <b>{m.title}</b>{m.depends.length > 0 && <span className="muted small"> · needs {m.depends.join(", ")}</span>}
                  {m.id === "mobile" && snap.host.access !== "tailscale" && <span className="warn small"> · needs access: tailscale</span>}
                  <br /><span className="muted small">{m.description}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save profile"}</button>
            {snap.profile.done && <button className="btn" onClick={() => { setEditing(false); setDraft(null); }}>Cancel</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCard({ snap, onError }: { snap: Snapshot; onError: (e: string) => void }) {
  const s = snap.agent.status;
  const ready = snap.claudeReady && snap.profile.done;
  const act = (p: string) => post(p).catch((e) => onError(e.message));
  let note = "";
  if (!snap.claudeReady) note = "Starts once you're logged in to Claude.";
  else if (!snap.profile.done) note = "Starts once you've chosen your modules.";
  else if (s === "waiting") note = "Waiting for your turn above; it continues by itself when that step turns green.";
  else if (s === "paused") note = "Paused. Nothing runs until you resume.";
  else if (s === "running") note = "Installing in dependency order. You can watch it below the terminal.";
  else if (snap.roadmap.allDone) note = "Everything is done.";
  return (
    <div className="card">
      <div className="step-line">
        <span className="icon">{s === "running" ? ICON.running : snap.roadmap.allDone ? ICON.done : ICON.pending}</span>
        <span className="step-title">Setup agent</span>
        <span className={`agent-status s-${s}`}>{agentLabel(s)}</span>
      </div>
      <p className="muted small">{note}</p>
      <div className="actions">
        {s !== "running" && s !== "paused" && <button className="btn primary" disabled={!ready} onClick={() => act("api/agent/start")}>{snap.agent.hasSession ? "Continue" : "Start setup agent"}</button>}
        {s === "running" && <button className="btn" onClick={() => act("api/agent/pause")}>Pause</button>}
        {s === "paused" && <button className="btn primary" disabled={!ready} onClick={() => act("api/agent/resume")}>Resume</button>}
      </div>
    </div>
  );
}

function SelftestCard({ snap, onError }: { snap: Snapshot; onError: (e: string) => void }) {
  const t = snap.selftest;
  const [show, setShow] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const all = snap.roadmap.allDone && snap.profile.done;
  const state: StepState = t.running ? "running" : t.ok ? "done" : t.ok === false ? "failed" : "pending";
  const portal = snap.portalUrl ?? (snap.host.access === "ssh-tunnel" ? localPortal(snap) : null);
  return (
    <div className="card final">
      <div className="step-line">
        <span className="icon">{ICON[state]}</span>
        <span className="step-title">Security self-test</span>
        {t.output && <button className="btn small link" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"} output</button>}
      </div>
      {!all && <p className="muted small">Runs when every step above is done.</p>}
      {t.running && <p className="muted small">Running <code>agentbox selftest</code>…</p>}
      {show && t.output && <pre className="selftest-out">{t.output}</pre>}
      {all && !t.running && t.ok === false && (
        <div className="failure"><p>The self-test found problems (see the output). Fix them in the terminal, then run it again.</p>
          <button className="btn small" onClick={() => post("api/selftest").catch((e) => onError(e.message))}>Run again</button></div>
      )}
      {all && !t.running && t.ok === undefined && <button className="btn" onClick={() => post("api/selftest").catch((e) => onError(e.message))}>Run self-test</button>}
      {all && t.ok && (
        <div className="done-box">
          <p>All set. Your portal: {portal ? <a href={portal} target="_blank" rel="noreferrer">{portal}</a> : <span className="muted">open it through your access path</span>}</p>
          <p className="muted small">Finish stops the guide and invalidates its links. You can bring it back any time with <code>agentbox guide</code> (e.g. to add a module).</p>
          <button className="btn primary" disabled={finishing} onClick={async () => { setFinishing(true); try { await post("api/finish"); } catch (e: any) { onError(e.message); setFinishing(false); } }}>Finish</button>
        </div>
      )}
    </div>
  );
}

/** ssh-tunnel: the portal is a sibling forward. On Lima the Mac port is the guide's + 1 (host/lima/lib.sh). */
function localPortal(snap: Snapshot) {
  const p = Number(location.port || 80);
  if (location.pathname.startsWith("/setup/")) return new URL("/", location.href).toString();
  if (snap.host.kind === "lima" && p) return `${location.protocol}//${location.hostname}:${p + 1}/`;
  return `${location.protocol}//${location.hostname}:${snap.ports.portal}/`;
}

function Roadmap({ snap, onError }: { snap: Snapshot; onError: (e: string) => void }) {
  const login = snap.roadmap.modules.find((m) => m.id === "claude")?.steps.find((s) => s.id === "login");
  const hide = useMemo(() => new Set(login ? [login.key] : []), [login?.key]);
  const on = snap.roadmap.modules.filter((m) => m.enabled);
  const off = snap.roadmap.modules.filter((m) => !m.enabled);
  const retry = (id: string) => post("api/retry", { module: id }).catch((e) => onError(e.message));
  const c = snap.roadmap.counts;
  return (
    <section className="pane roadmap" aria-label="Roadmap">
      <div className="pane-head">
        <span>Roadmap</span>
        <span className="muted">{c.done}/{c.total} steps{c.human ? ` · ${c.human} waiting for you` : ""}{c.failed ? ` · ${c.failed} failed` : ""}</span>
        <button className="btn small link" onClick={() => post("api/recheck").catch((e) => onError(e.message))}>Re-check all</button>
      </div>
      <div className="roadmap-body">
        {snap.problems.length > 0 && <div className="failure"><pre>{snap.problems.join("\n")}</pre></div>}
        {snap.roadmap.profile.missing.length > 0 && <div className="failure"><p>Missing modules: {snap.roadmap.profile.missing.join(", ")}</p></div>}
        <h2 className="section">Start here</h2>
        {login && <div className="card"><ul className="steps flat"><StepRow step={{ ...login, title: "Log in to Claude" }} /></ul></div>}
        <ProfileCard snap={snap} onError={onError} />
        <AgentCard snap={snap} onError={onError} />
        <h2 className="section">Modules</h2>
        {on.map((m) => <ModuleGroup key={m.id} m={m} onRetry={retry} hide={hide} />)}
        {off.length > 0 && (
          <div className="off-list">
            {off.map((m) => <div key={m.id} className="off" title={m.description}><span className="icon">{ICON.disabled}</span> {m.title} <span className="muted small">off</span></div>)}
          </div>
        )}
        <h2 className="section">Finish</h2>
        <SelftestCard snap={snap} onError={onError} />
      </div>
    </section>
  );
}

// --- the page --------------------------------------------------------------------------------------------
function useTheme() {
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("guide-theme") ?? "auto"; } catch { return "auto"; } });
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("guide-theme", theme); } catch { /* private mode */ }
    window.dispatchEvent(new Event("guide-theme"));
  }, [theme]);
  return [theme, () => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")] as const;
}

function Usage({ u }: { u: Snapshot["usage"] }) {
  if (!u.status && u.costUsd === undefined) return null;
  const bits: string[] = [];
  if (u.status) bits.push(u.status === "allowed" ? "Claude OK" : u.status === "allowed_warning" ? "Claude: near limit" : "Claude: limited");
  if (typeof u.utilization === "number") bits.push(`${Math.round(u.utilization * 100)}%`);
  if (u.resetsAt) bits.push(`resets ${new Date(u.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  if (typeof u.costUsd === "number") bits.push(`$${u.costUsd.toFixed(2)} this turn`);
  return <span className={`chip ${u.status && u.status !== "allowed" ? "warn" : ""}`}>{bits.join(" · ")}</span>;
}

function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [conn, setConn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState<{ portalUrl: string | null } | null>(null);
  const [theme, cycleTheme] = useTheme();
  useEffect(() => {
    let ws: WebSocket | null = null, stopped = false, backoff = 500;
    const connect = () => {
      ws = new WebSocket(wsUrl("ws/state"));
      ws.onopen = () => { setConn(true); backoff = 500; };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "state") setSnap(m);
        else if (m.type === "logs") setLog(m.log);
        else if (m.type === "log") setLog((l) => [...l.slice(-399), m.entry]);
        else if (m.type === "finished") { setFinished({ portalUrl: m.portalUrl }); stopped = true; }
      };
      ws.onclose = (ev) => {
        setConn(false);
        if (ev.code === 1008 || stopped) return;
        setTimeout(connect, backoff = Math.min(backoff * 2, 8000));
      };
    };
    connect();
    return () => { stopped = true; ws?.close(); };
  }, []);
  useEffect(() => { if (error) { const t = setTimeout(() => setError(null), 8000); return () => clearTimeout(t); } }, [error]);

  if (finished) {
    const portal = finished.portalUrl ?? (snap ? localPortal(snap) : null);
    return (
      <div className="finished">
        <h1>Setup complete</h1>
        <p>The guide has stopped and its links no longer work.</p>
        {portal && <p>Open your portal: <a href={portal}>{portal}</a></p>}
        <p className="muted">To change modules later, run <code>agentbox guide</code> on the VM.</p>
      </div>
    );
  }
  return (
    <div className="app">
      <header className="top">
        <span className="brand"><span className="brand-mark">a</span> agentbox setup</span>
        {snap && <span className="chip" title="host adapter · machine">{snap.host.kind} · {snap.host.name}</span>}
        {snap && <span className="chip" title="access mode">access: {snap.host.access}</span>}
        {snap && <Usage u={snap.usage} />}
        <span className="spacer" />
        {!conn && <span className="chip warn">reconnecting…</span>}
        <button className="btn small" onClick={cycleTheme} title="Theme">{theme === "auto" ? "Theme: auto" : theme === "light" ? "Theme: light" : "Theme: dark"}</button>
      </header>
      {error && <div className="toast" role="alert" onClick={() => setError(null)}>{error}</div>}
      <main className="split">
        <div className="left">
          <TerminalPane finished={!!finished} />
          <AgentLog log={log} status={snap?.agent.status ?? "idle"} />
        </div>
        {snap ? <Roadmap snap={snap} onError={setError} /> : <section className="pane roadmap"><p className="muted pad">Loading…</p></section>}
      </main>
    </div>
  );
}


createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
