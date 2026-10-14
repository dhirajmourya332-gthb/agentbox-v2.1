import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type WebSocket from "ws";
import { redactSecrets } from "./redact.ts";

/**
 * The owner's terminal in the Setup workspace: one login shell (`bash -l`) as the portal's user (the
 * agent user, like ttyd and the guide's terminal) in a pty (node-pty), run by the portal itself so the
 * setup agent can READ it (read_terminal), which ttyd doesn't allow. Same idea as guide/src/terminal.ts.
 *
 * - One session for the owner. It outlives page reloads: a reconnecting page gets the recent output
 *   replayed. Several tabs share it.
 * - A headless xterm (@xterm/headless) keeps a rendered copy of the screen and scrollback, so the
 *   agent reads lines as the owner sees them (progress redraws, colours and cursor moves resolved).
 *   What the agent reads is passed through redactSecrets().
 * - Only the owner's browser types into it (the WebSocket route refuses agents: setupRoutes.ts). No
 *   server API writes to it; "Insert in terminal" is the owner's page sending text without Enter.
 *
 * Wire format (WebSocket /api/setup/terminal): server → page: raw output (text frames).
 * page → server: JSON `{"t":"i","d":"…"}` input, `{"t":"r","c":cols,"r":rows}` resize.
 */

export type Pty = {
  onData(fn: (d: string) => void): unknown;
  onExit(fn: (e: { exitCode: number }) => void): unknown;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(sig?: string): void;
  pid: number;
};
export type Spawn = (file: string, args: string[], opts: Record<string, unknown>) => Pty;

const require = createRequire(import.meta.url);
const REPLAY = 256 * 1024;
const MAX_INPUT = 64 * 1024;

/** The shell's environment: the essentials only, never the portal's own secrets (EXPO_ACCESS_TOKEN…). */
export function shellEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "XDG_RUNTIME_DIR", "AGENTBOX_CONFIG"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (from[k] !== undefined) env[k] = from[k];
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.DISPLAY = ":99"; // the shared screen, for CLIs that open a browser for their login
  env.BROWSER = "/usr/local/bin/agentbox-open";
  return env;
}

type Headless = {
  write(d: string, cb?: () => void): void;
  resize(c: number, r: number): void;
  buffer: { active: { length: number; getLine(i: number): { translateToString(trim?: boolean): string; isWrapped: boolean } | undefined } };
  dispose(): void;
};

export type TerminalRead = {
  /** False when no shell has been started yet (nobody opened the workspace since the portal started). */
  started: boolean;
  running: boolean;
  text: string;
  lines: number;
  last_output_at: string | null;
  last_input_at: string | null;
};

export type OwnerTerminal = ReturnType<typeof createOwnerTerminal>;

export function createOwnerTerminal(opts: {
  spawn?: Spawn; env?: NodeJS.ProcessEnv; cwd?: string; log?: (m: string) => void;
  scrollback?: number; now?: () => number;
} = {}) {
  const now = opts.now ?? Date.now;
  let pty: Pty | null = null;
  let replay = "";
  let cols = 100, rows = 30;
  let started = false;
  let lastOutputAt: number | null = null;
  let lastInputAt: number | null = null;
  let loadError: string | null = null;
  const clients = new Set<WebSocket>();
  let spawnFn: Spawn | null = opts.spawn ?? null;
  const listeners = new Set<(chunk: string) => void>();

  // A rendered copy for reading. Falls back to ANSI-stripped raw output if the package is missing.
  let screen: Headless | null = null;
  const newScreen = () => {
    try {
      const { Terminal } = require("@xterm/headless");
      return new Terminal({ cols, rows, scrollback: opts.scrollback ?? 3000, allowProposedApi: true }) as Headless;
    } catch (e: any) {
      opts.log?.(`terminal: no headless renderer (${e.message}); reading raw output`);
      return null;
    }
  };

  async function load(): Promise<Spawn> {
    if (spawnFn) return spawnFn;
    try {
      // macOS prebuilds ship spawn-helper without its exec bit (npm drops it): "posix_spawnp failed".
      if (process.platform === "darwin") {
        try {
          const helper = path.join(path.dirname(require.resolve("node-pty/package.json")), "prebuilds", `darwin-${process.arch}`, "spawn-helper");
          if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o100)) fs.chmodSync(helper, 0o755);
        } catch { /* not installed, or not ours to change */ }
      }
      const mod: any = await import("node-pty");
      spawnFn = (mod.spawn ?? mod.default?.spawn) as Spawn;
      if (typeof spawnFn !== "function") throw new Error("node-pty has no spawn()");
      return spawnFn;
    } catch (e: any) {
      loadError = `node-pty isn't available (${String(e?.message ?? e).split("\n")[0]})`;
      throw new Error(loadError);
    }
  }

  /** Whether a pty can be started here (node-pty installed and loadable). */
  async function available(): Promise<{ ok: boolean; error: string | null }> {
    try { await load(); return { ok: true, error: null }; } catch (e: any) { return { ok: false, error: e.message }; }
  }

  const broadcast = (d: string) => { for (const c of clients) if (c.readyState === 1) c.send(d); };

  async function ensure() {
    if (pty) return pty;
    const spawn = await load();
    const env = opts.env ?? shellEnv();
    pty = spawn("bash", ["-l"], { name: "xterm-256color", cols, rows, cwd: opts.cwd ?? env.HOME ?? os.homedir(), env });
    started = true;
    if (!screen) screen = newScreen();
    const p = pty;
    p.onData((d) => {
      replay += d;
      if (replay.length > REPLAY) replay = replay.slice(-REPLAY);
      lastOutputAt = now();
      screen?.write(d);
      broadcast(d);
      for (const fn of listeners) fn(d);
    });
    p.onExit(({ exitCode }) => {
      if (pty !== p) return;
      pty = null;
      const msg = `\r\n\x1b[2m[shell exited (${exitCode}); press Enter for a new one]\x1b[0m\r\n`;
      replay += msg;
      screen?.write(msg);
      broadcast(msg);
    });
    return p;
  }

  /** The owner's input (keys, pastes and "Insert in terminal"), from the page only. */
  async function input(d: string) {
    if (typeof d !== "string" || !d || d.length > MAX_INPUT) return;
    // Every connected page answers a program's colour query, late (over the network), so the answers
    // reached the shell as typed input ("could not prompt: unexpected escape sequence" in gh). Drop them
    // here, whichever page (an old tab too) sent them; programs fall back to their default colours.
    d = stripColorReplies(d);
    if (!d) return;
    lastInputAt = now();
    const p = pty ?? (await ensure().catch(() => null));
    p?.write(d);
  }

  function resize(c: number, r: number) {
    if (!(Number.isInteger(c) && Number.isInteger(r) && c > 1 && r > 1 && c < 1000 && r < 500)) return;
    cols = c; rows = r;
    try { pty?.resize(c, r); } catch { /* exited */ }
    try { screen?.resize(c, r); } catch { /* disposed */ }
  }

  function attach(ws: WebSocket) {
    clients.add(ws);
    if (replay) ws.send(replay);
    ensure().catch((e) => {
      opts.log?.(`terminal: ${e.message}`);
      if (ws.readyState === 1) ws.send(`\r\n[the terminal can't start: ${e.message}]\r\n`);
    });
    ws.on("message", (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m?.t === "i") void input(m.d);
      else if (m?.t === "r") resize(m.c, m.r);
    });
    ws.on("close", () => clients.delete(ws));
  }

  /** Wait until the headless screen has processed everything written so far. */
  const settle = () => new Promise<void>((resolve) => (screen ? screen.write("", resolve) : resolve()));

  /** The last `n` lines as the owner sees them, secrets redacted. */
  async function read(n = 200): Promise<TerminalRead> {
    const want = Math.max(1, Math.min(1000, Math.floor(n) || 200));
    let lines: string[];
    if (screen) {
      await settle();
      const buf = screen.buffer.active;
      lines = [];
      for (let i = 0; i < buf.length; i++) {
        const l = buf.getLine(i);
        if (!l) continue;
        const t = l.translateToString(true);
        if (l.isWrapped && lines.length) lines[lines.length - 1] += t;
        else lines.push(t);
      }
    } else {
      lines = stripAnsi(replay).split("\n");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const tail = lines.slice(-want);
    return {
      started, running: !!pty,
      text: redactSecrets(tail.join("\n")),
      lines: tail.length,
      last_output_at: lastOutputAt ? new Date(lastOutputAt).toISOString() : null,
      last_input_at: lastInputAt ? new Date(lastInputAt).toISOString() : null,
    };
  }

  function onOutput(fn: (chunk: string) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function close() {
    for (const c of clients) try { c.close(1001, "portal stopping"); } catch { /* gone */ }
    clients.clear();
    try { pty?.kill(); } catch { /* gone */ }
    pty = null;
    screen?.dispose();
    screen = null;
  }

  return {
    attach, input, resize, read, close, available, onOutput, ensure,
    get clients() { return clients.size; },
    get loadError() { return loadError; },
  };
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;
export function stripAnsi(s: string) {
  // \r\n → \n; a bare \r (a progress redraw) keeps only what came after it on that line.
  return s.replace(ANSI, "").replace(/\r\n/g, "\n").split("\n").map((l) => l.split("\r").filter(Boolean).pop() ?? "").join("\n");
}

// The portal's one owner terminal (index.ts creates it; the setup tools read it).
let current: OwnerTerminal | null = null;
export const setOwnerTerminal = (t: OwnerTerminal | null) => { current = t; };
export const ownerTerminal = () => current;

/** Terminal answers to colour queries (OSC 4/10/11/12 "…;rgb:…"), removed from a page's input. */
export const COLOR_REPLY = /\x1b\](?:4;\d+|1[0-2]);rgb:[0-9a-fA-F/]*(?:\x07|\x1b\\)/g;
export const stripColorReplies = (d: string) => d.replace(COLOR_REPLY, "");
