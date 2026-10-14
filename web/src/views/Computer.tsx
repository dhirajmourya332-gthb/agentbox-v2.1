import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { SCREEN_URL, ScreenHolder, TakeControl, TERMINAL_URL, useScreenUrl } from "../components/Controls.tsx";
import { useStore } from "../store.tsx";

export function Screen() {
  const { display } = useStore();
  const mine = display?.holder === "owner";
  const url = useScreenUrl(SCREEN_URL);
  return (
    <section className="frame-view" aria-label="Shared screen">
      <div className="toolbar">
        <strong>Shared screen</strong>
        <ScreenHolder />
        <span className="spacer" />
        <TakeControl />
        {url && <a href={url} target="_blank" rel="noopener noreferrer">Open in new tab ↗</a>}
      </div>
      {url && <iframe src={url} title="Shared screen of the agentbox VM" className={mine ? "in-control" : undefined} />}
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

function Row({ ok, word, name, val, neutral }: { ok: boolean; word: string; name: string; val?: ReactNode; neutral?: boolean }) {
  return (
    <div className="row">
      <span className="status" style={{ minWidth: 84 }}><span className={`dot ${neutral ? "" : ok ? "ok" : "bad"}`} />{word}</span>
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
              {Object.entries(h.tools).map(([k, v]) => {
                // A tool of an optional integration that isn't connected isn't missing: it's not set up.
                const it = h.tool_integrations?.[k] as { id: string; connected: boolean } | undefined;
                if (!v && it && !it.connected) {
                  return <Row key={k} ok neutral word="Not set up" name={k} val={<a href="#/integrations">optional · comes with the {it.id === "github" ? "GitHub" : "AWS"} integration</a>} />;
                }
                return <Row key={k} ok={!!v} word={v ? "Installed" : "Missing"} name={k} val={(v as string) ?? ""} />;
              })}
            </div>
            {checked && <p className="hint" style={{ marginTop: 8 }}>Checked {checked.toLocaleTimeString()} · refreshes every 10s</p>}
          </>
        )}
      </div>
    </div>
  );
}
