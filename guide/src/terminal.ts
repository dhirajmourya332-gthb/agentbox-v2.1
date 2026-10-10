import os from "node:os";
import type WebSocket from "ws";

/**
 * The guide's terminal: one login shell (`bash -l`) as the agent user (the guide runs as that
 * user) in a pty (node-pty). It outlives page reloads: a reconnecting page gets the recent output
 * replayed. Several tabs share the same shell.
 *
 * Wire format (WebSocket /ws/term): server → page: raw output (text frames). page → server: JSON
 * `{"t":"i","d":"…"}` input, `{"t":"r","c":cols,"r":rows}` resize.
 */

type Pty = {
  onData(fn: (d: string) => void): unknown;
  onExit(fn: (e: { exitCode: number }) => void): unknown;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(sig?: string): void;
  pid: number;
};
type Spawn = (file: string, args: string[], opts: Record<string, unknown>) => Pty;

const SCROLLBACK = 256 * 1024;

export function createTerminal(opts: { env: NodeJS.ProcessEnv; cwd?: string; spawn?: Spawn; log?: (m: string) => void }) {
  let pty: Pty | null = null;
  let buffer = "";
  const clients = new Set<WebSocket>();
  let spawnFn: Spawn | null = opts.spawn ?? null;

  async function load(): Promise<Spawn> {
    if (spawnFn) return spawnFn;
    const mod: any = await import("node-pty");
    spawnFn = (mod.spawn ?? mod.default?.spawn) as Spawn;
    return spawnFn;
  }

  async function ensure(cols = 100, rows = 30) {
    if (pty) return pty;
    const spawn = await load();
    const env = { ...opts.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    delete (env as any).AGENTBOX_GUIDE_PROXY; // nothing of the guide's own leaks in
    pty = spawn("bash", ["-l"], { name: "xterm-256color", cols, rows, cwd: opts.cwd ?? os.homedir(), env });
    const p = pty;
    p.onData((d) => {
      buffer += d;
      if (buffer.length > SCROLLBACK) buffer = buffer.slice(-SCROLLBACK);
      for (const c of clients) if (c.readyState === 1) c.send(d);
    });
    p.onExit(({ exitCode }) => {
      if (pty !== p) return;
      pty = null;
      const msg = `\r\n\x1b[2m[shell exited (${exitCode}); press Enter for a new one]\x1b[0m\r\n`;
      buffer += msg;
      for (const c of clients) if (c.readyState === 1) c.send(msg);
    });
    return p;
  }

  function attach(ws: WebSocket) {
    clients.add(ws);
    if (buffer) ws.send(buffer);
    ensure().catch((e) => {
      opts.log?.(`terminal: ${e.message}`);
      ws.send(`\r\n[the terminal can't start: ${e.message}]\r\n`);
    });
    ws.on("message", async (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m?.t === "i" && typeof m.d === "string" && m.d.length <= 64 * 1024) {
        const p = pty ?? (await ensure().catch(() => null));
        p?.write(m.d);
      } else if (m?.t === "r" && Number.isInteger(m.c) && Number.isInteger(m.r) && m.c > 1 && m.r > 1 && m.c < 1000 && m.r < 500) {
        try { pty?.resize(m.c, m.r); } catch { /* exited */ }
      }
    });
    ws.on("close", () => clients.delete(ws));
  }

  function close() {
    for (const c of clients) try { c.close(1001, "guide stopped"); } catch { /* gone */ }
    clients.clear();
    try { pty?.kill(); } catch { /* gone */ }
    pty = null;
  }

  return { attach, close, get clients() { return clients.size; } };
}
