import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api.ts";
import { TERMINAL_URL } from "./Controls.tsx";

/**
 * The owner's terminal in the Setup workspace: xterm.js over /api/setup/terminal, a shell the portal
 * runs in a pty (server/src/terminal.ts) so the setup agent can read it. Same look and behaviour as
 * the first-run guide's terminal: one shell that survives reloads (its recent output is replayed),
 * reconnects by itself. Only this page types into it; "Insert in terminal" pastes a command without
 * Enter, so the owner reads it and runs it.
 *
 * Without node-pty on the computer it falls back to the portal's ttyd terminal (/term/), which the
 * setup agent can't read.
 */

import { insertable } from "./insert.ts";

export type TerminalHandle = { insert: (text: string) => boolean; focus: () => void };

function cssVar(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function termTheme() {
  return {
    background: cssVar("--term-bg"), foreground: cssVar("--term-fg"), cursor: cssVar("--accent"), cursorAccent: cssVar("--term-bg"),
    selectionBackground: cssVar("--term-sel"),
  };
}

export type TermStatus = "connecting" | "open" | "closed" | "fallback";

export function OwnerTerminal({ onHandle, onStatus }: { onHandle: (h: TerminalHandle | null) => void; onStatus?: (s: TermStatus) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"checking" | "pty" | "fallback">("checking");
  const [why, setWhy] = useState<string | null>(null);

  useEffect(() => {
    api.terminalInfo()
      .then((i) => { setMode(i.available ? "pty" : "fallback"); setWhy(i.error); })
      .catch(() => setMode("pty")); // try; the socket says if it can't
  }, []);

  useEffect(() => {
    if (mode === "fallback") { onStatus?.("fallback"); onHandle(null); }
    if (mode !== "pty") return;
    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000,
      theme: termTheme(), allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    ignoreColorQueries(term);
    term.open(host.current!);
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoff = 500;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = (m: unknown) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
    const sendSize = () => send({ t: "r", c: term.cols, r: term.rows });
    const refit = () => {
      const el = host.current;
      if (!el || el.clientWidth < 20 || el.clientHeight < 20) return; // hidden (another tab)
      try { fit.fit(); sendSize(); } catch { /* not laid out yet */ }
    };
    const connect = () => {
      onStatus?.("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/setup/terminal`);
      ws.onopen = () => { onStatus?.("open"); backoff = 500; term.reset(); refit(); };
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
      ws.onclose = () => {
        onStatus?.("closed");
        if (!stopped) retry = setTimeout(connect, backoff = Math.min(backoff * 2, 8000));
      };
    };
    connect();
    const sub = term.onData((d) => send({ t: "i", d }));
    onHandle({
      insert: (text) => {
        const t = insertable(text);
        if (!t || ws?.readyState !== 1) return false;
        term.paste(t); // bracketed paste when the shell asks for it; never a newline
        term.focus();
        return true;
      },
      focus: () => term.focus(),
    });
    const ro = new ResizeObserver(() => refit());
    ro.observe(host.current!);
    const retheme = () => { term.options.theme = termTheme(); };
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", retheme);
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      stopped = true;
      clearTimeout(retry);
      sub.dispose(); ro.disconnect(); mo.disconnect(); mq.removeEventListener("change", retheme);
      ws?.close(); term.dispose(); onHandle(null);
    };
  }, [mode]);

  if (mode === "fallback") {
    return (
      <div className="ws-term-fallback">
        <p className="hint ws-term-note">
          The helper can't read this terminal{why ? ` (${why})` : ""}; tell it what you see. Inserting commands works by copying them.
        </p>
        <iframe src={TERMINAL_URL} title="Terminal on the agentbox computer" />
      </div>
    );
  }
  return <div className="ws-term-host" ref={host} />;
}

/**
 * Don't answer colour queries (OSC 4/10/11/12 "?"). Over a remote link the answer arrives after the asking
 * program has started reading keys, so it lands as typed input: `gh auth login` aborted with "unexpected
 * escape sequence from terminal" and the leftovers appeared at the shell prompt. Programs that ask fall
 * back to their defaults, as on terminals without this query. Setting colours still works.
 */
export function ignoreColorQueries(term: { parser: { registerOscHandler(id: number, cb: (data: string) => boolean): unknown } }) {
  for (const id of [4, 10, 11, 12]) term.parser.registerOscHandler(id, (data) => data.split(";").includes("?"));
}
