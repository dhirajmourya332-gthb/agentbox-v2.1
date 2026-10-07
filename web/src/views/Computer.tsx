import { useEffect, useState } from "react";
import { api } from "../api.ts";

const host = location.hostname;
const SCREEN_URL = `http://${host}:7701/vnc.html?autoconnect=1&resize=scale&reconnect=1&show_dot=1`;
const TERMINAL_URL = `http://${host}:7702/`;

export function Screen() {
  return (
    <section className="frame-view" aria-label="Shared screen">
      <div className="toolbar">
        <strong>Shared screen</strong>
        <span>Display :99 · every agent works on this screen</span>
        <a className="spacer" href={SCREEN_URL} target="_blank" rel="noopener">Open in new tab ↗</a>
      </div>
      <iframe src={SCREEN_URL} title="Shared screen of the agentbox VM" />
    </section>
  );
}

export function Terminal() {
  return (
    <section className="frame-view" aria-label="Terminal">
      <div className="toolbar">
        <strong>Terminal</strong>
        <span>
          Sign-ins live here: <code>claude</code> → <code>/login</code> · <code>gh auth login</code> · <code>aws configure sso</code>
        </span>
      </div>
      <iframe src={TERMINAL_URL} title="Terminal on the agentbox VM" />
    </section>
  );
}

const LABELS: Record<string, string> = {
  "agentbox-xvfb": "Display (Xvfb :99)",
  "agentbox-wm": "Window manager",
  "agentbox-vnc": "VNC server",
  "agentbox-novnc": "Web screen (noVNC)",
  "agentbox-ttyd": "Web terminal",
  "agentbox-chromium": "Shared browser",
};

function Row({ ok, word, name, val }: { ok: boolean; word: string; name: string; val?: string }) {
  return (
    <div className="row">
      <span className="status" style={{ minWidth: 84 }}><span className={`dot ${ok ? "ok" : "bad"}`} />{word}</span>
      <span className="name">{name}</span>
      <span className="val">{val}</span>
    </div>
  );
}

export function System() {
  const [h, setH] = useState<any>(null);
  const [checked, setChecked] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api.health()
        .then((x) => alive && (setH(x), setChecked(new Date()), setError(null)))
        .catch((e) => alive && setError(String(e.message ?? e)));
    poll();
    const t = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return (
    <div className="page">
      <div className="page-inner">
        <h1>System</h1>
        <p className="lede">Health of the shared computer and the tools agents depend on.</p>
        {error && <div className="error-box">Health check failed: {error}</div>}
        {h && (
          <>
            <h2>Services</h2>
            <div className="rows">
              {Object.entries(h.services).map(([k, v]) => (
                <Row key={k} ok={v === "active"} word={v === "active" ? "Running" : String(v)} name={LABELS[k] ?? k} val={k} />
              ))}
            </div>
            <h2>Shared browser</h2>
            <div className="rows">
              <Row ok={h.browser.ok} word={h.browser.ok ? "Reachable" : "Down"} name="Chromium (CDP 127.0.0.1:9222)" val={h.browser.version} />
            </div>
            <h2>Tools</h2>
            <div className="rows">
              {Object.entries(h.tools).map(([k, v]) => (
                <Row key={k} ok={!!v} word={v ? "Installed" : "Missing"} name={k} val={(v as string) ?? ""} />
              ))}
            </div>
            {checked && <p className="hint" style={{ marginTop: 8 }}>Checked {checked.toLocaleTimeString()} · refreshes every 10s</p>}
          </>
        )}
      </div>
    </div>
  );
}
