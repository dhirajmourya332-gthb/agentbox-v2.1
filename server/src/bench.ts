import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parse as parseYaml } from "yaml";
import { config, enabled, paths } from "./config.ts";
import { publish } from "./bus.ts";

/**
 * The device bridge ("bench", docs/BENCH.md): a script on the owner's computer
 * (setup/modules/bench/bridge/agentbox-bench.py) dials OUT to the portal over a WebSocket and shares
 * the capabilities the owner enabled; nothing listens on that computer. Each shared serial device gets
 * a port on 127.0.0.1 here, and agents talk RFC 2217 to it (rfc2217://127.0.0.1:<port>): the bridge
 * runs the RFC 2217 server next to the real port and this side only relays bytes.
 *
 * The WebSocket passes the portal's access check like any /api request (the owner's identity through
 * tailscale serve, or localhost in ssh-tunnel mode) and must also carry the bridge token
 * (<secrets>/bench.token, made when the integration is connected). One bridge at a time: a new one
 * replaces the old. Off (module disabled) means every /api/bench route is a 404 and the bridge is
 * dropped, without a restart.
 *
 * Wire format: JSON text frames for control; binary frames are [u32 channel][bytes].
 */

export const BENCH_ID = "bench";
const TOKEN_FILE = () => path.join(paths.secrets, "bench.token");
const SETTINGS_FILE = () => path.join(paths.integrations, "bench.yaml");
const PORTS_FILE = () => path.join(paths.data, "bench-ports.json");
const BRIDGE_FILE = () => path.join(paths.src, "setup", "modules", "bench", "bridge", "agentbox-bench.py");
const PORT_SPAN = 40;

export type BenchDevice = {
  id: string; kind: string; path: string; description: string; manufacturer: string; vid: string; pid: string; serial_number: string;
};
type Live = { dev: BenchDevice; port: number; server: net.Server; clients: number };
type Bridge = {
  ws: any; host: string; os: string; version: number; since: string; capabilities: Record<string, boolean>;
  devices: Map<string, Live>; channels: Map<number, net.Socket>; pending: Map<number, Buffer[]>;
  pings: Map<string, (ms: number) => void>; lastSeen: number;
};

let bridge: Bridge | null = null;
let nextChannel = 1;

export const benchOn = () => enabled(BENCH_ID as any);

/** The owner's choices on the portal (Integrations → Device bridge → settings). */
export function benchSettings(): { serial: boolean; loopback: boolean } {
  let s: any = {};
  try { s = parseYaml(fs.readFileSync(SETTINGS_FILE(), "utf8")) ?? {}; } catch { /* defaults */ }
  return { serial: s.serial !== false, loopback: s.loopback !== false };
}

function readToken(): string | null {
  try { return fs.readFileSync(TOKEN_FILE(), "utf8").trim() || null; } catch { return null; }
}
const sameToken = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// --- stable local ports: a device keeps its port across reconnects --------------------------------------

function portMap(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(PORTS_FILE(), "utf8")); } catch { return {}; }
}
function portFor(id: string): number {
  const base = config.ports.bench;
  const map = portMap();
  if (map[id]) return map[id];
  const used = new Set(Object.values(map));
  for (let p = base; p < base + PORT_SPAN; p++) {
    if (!used.has(p)) {
      map[id] = p;
      try { fs.writeFileSync(PORTS_FILE(), JSON.stringify(map, null, 2), { mode: 0o600 }); } catch { /* not persisted */ }
      return p;
    }
  }
  throw new Error(`no free bench port in ${base}–${base + PORT_SPAN - 1}`);
}

// --- devices → local listeners ----------------------------------------------------------------------------

function sendJson(b: Bridge, msg: unknown) {
  try { b.ws.send(JSON.stringify(msg)); } catch { /* closing */ }
}
function sendData(b: Bridge, channel: number, data: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(channel);
  try { b.ws.send(Buffer.concat([head, data])); } catch { /* closing */ }
}

function listen(b: Bridge, dev: BenchDevice): Live {
  const live: Live = { dev, port: portFor(dev.id), server: net.createServer(), clients: 0 };
  live.server.on("connection", (sock) => {
    if (bridge !== b) return sock.destroy();
    const channel = nextChannel++;
    live.clients++;
    b.channels.set(channel, sock);
    b.pending.set(channel, []);
    sendJson(b, { type: "open", channel, device: dev.id });
    sock.on("data", (d) => {
      const q = b.pending.get(channel);
      if (q) q.push(d); // until the bridge says "opened"
      else sendData(b, channel, d);
    });
    const done = () => {
      if (!b.channels.has(channel)) return;
      b.channels.delete(channel);
      b.pending.delete(channel);
      live.clients--;
      sendJson(b, { type: "close", channel });
      publishStatus();
    };
    sock.on("close", done);
    sock.on("error", done);
    publishStatus();
  });
  live.server.on("error", () => { /* port taken: shown as no port in the status */ });
  live.server.listen(live.port, "127.0.0.1");
  return live;
}

function setDevices(b: Bridge, list: BenchDevice[]) {
  const want = new Map(list.filter((d) => d && typeof d.id === "string" && /^[\w.:-]{1,64}$/.test(d.id)).map((d) => [d.id, d]));
  for (const [id, live] of b.devices) {
    if (!want.has(id)) { live.server.close(); b.devices.delete(id); }
  }
  for (const [id, dev] of want) {
    const cur = b.devices.get(id);
    if (cur) cur.dev = dev;
    else b.devices.set(id, listen(b, dev));
  }
  publishStatus();
}

function drop(b: Bridge, why: string) {
  for (const live of b.devices.values()) live.server.close();
  for (const s of b.channels.values()) s.destroy();
  b.devices.clear();
  b.channels.clear();
  try { b.ws.close(1000, why); } catch { /* gone */ }
  if (bridge === b) bridge = null;
  publishStatus();
}

// --- status and test ---------------------------------------------------------------------------------------

export function benchStatus() {
  const s = benchSettings();
  return {
    enabled: benchOn(),
    token: !!readToken(),
    settings: s,
    connected: !!bridge,
    bridge: bridge && { host: bridge.host, os: bridge.os, version: bridge.version, since: bridge.since, capabilities: bridge.capabilities },
    devices: bridge ? [...bridge.devices.values()].map((l) => ({
      id: l.dev.id, kind: l.dev.kind, description: l.dev.description, manufacturer: l.dev.manufacturer, vid: l.dev.vid, pid: l.dev.pid,
      port: l.port, url: `rfc2217://127.0.0.1:${l.port}`, in_use: l.clients > 0,
      // The real-looking port agentbox-bench-tty makes for it (null when that service isn't running).
      dev: fs.existsSync(`/dev/bench/${l.dev.id}`) ? `/dev/bench/${l.dev.id}` : null,
    })) : [],
  };
}
function publishStatus() {
  publish({ type: "bench.status", status: benchStatus() } as any);
}

function ping(b: Bridge, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const t0 = Date.now();
    const timer = setTimeout(() => { b.pings.delete(nonce); reject(new Error("no answer from the bridge in 5 s")); }, timeoutMs);
    b.pings.set(nonce, () => { clearTimeout(timer); resolve(Date.now() - t0); });
    sendJson(b, { type: "ping", nonce });
  });
}

/** Through the loopback device's local port, exactly the way an agent connects: bytes come back. */
function echo(port: number, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = `agentbox-bench-${crypto.randomBytes(4).toString("hex")}`;
    const t0 = Date.now();
    let got = "";
    const sock = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("the loopback test port didn't echo in 8 s")); }, timeoutMs);
    sock.on("connect", () => sock.write(probe));
    // RFC 2217 negotiation bytes (IAC …) come first; look for the probe in what follows.
    sock.on("data", (d) => {
      got += d.toString("latin1");
      if (got.includes(probe)) { clearTimeout(timer); sock.destroy(); resolve(Date.now() - t0); }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function benchTest() {
  const steps: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });
  add("enabled", benchOn(), benchOn() ? "the Device bridge integration is on" : "connect the Device bridge integration first");
  add("token", !!readToken(), readToken() ? "bridge token present" : "no bridge token (re-run the integration's install step)");
  const b = bridge;
  add("bridge", !!b, b ? `${b.host} (${b.os}), connected since ${b.since}` : "no bridge connected: run agentbox-bench on your computer");
  if (b) {
    try { add("round trip", true, `${await ping(b)} ms`); } catch (e: any) { add("round trip", false, e.message); }
    const loop = b.devices.get("loopback");
    if (loop) {
      try { add("serial relay", true, `loopback echoed through ${`rfc2217://127.0.0.1:${loop.port}`} in ${await echo(loop.port)} ms`); } catch (e: any) { add("serial relay", false, e.message); }
    } else {
      add("serial relay", true, "skipped: the loopback test port is off");
    }
    const real = [...b.devices.values()].filter((l) => l.dev.id !== "loopback");
    add("devices", true, real.length ? real.map((l) => `${l.dev.id} → rfc2217://127.0.0.1:${l.port}`).join(", ") : "no USB serial devices plugged in (that's fine)");
  }
  return { ok: steps.every((s) => s.ok), steps, status: benchStatus() };
}

// --- the installer the owner downloads -------------------------------------------------------------------------

function portalUrl(req: FastifyRequest) {
  const host = String(req.headers.host ?? `localhost:${config.ports.portal}`);
  return `${config.access === "ssh-tunnel" ? "http" : "https"}://${host}`;
}

function installer(req: FastifyRequest, token: string) {
  const portal = portalUrl(req);
  const s = benchSettings();
  const cfg = JSON.stringify({ portal, token, serial: s.serial, loopback: s.loopback, devices: [] }, null, 2);
  return `#!/usr/bin/env bash
# agentbox device bridge installer, made for ${portal}.
# Puts the bridge in ~/.agentbox-bench and checks the connection. It installs nothing system-wide and
# opens no port: the bridge dials out to your portal. Holds your bridge token: don't share this file.
set -euo pipefail
dir="$HOME/.agentbox-bench"
mkdir -p "$dir" && chmod 700 "$dir"
umask 077
cat > "$dir/config.json" <<'JSON'
${cfg}
JSON
curl -fsSL "${portal}/api/bench/bridge.py" -o "$dir/agentbox-bench.py"
chmod 700 "$dir/agentbox-bench.py"
command -v python3 >/dev/null || { echo "agentbox-bench needs Python 3.9+ (python3)"; exit 1; }
python3 "$dir/agentbox-bench.py" --check
echo
echo "Installed. Start sharing (keep it running; Ctrl+C stops it):"
echo "  python3 ~/.agentbox-bench/agentbox-bench.py"
echo "What it would share:  python3 ~/.agentbox-bench/agentbox-bench.py --list"
`;
}

// --- routes ----------------------------------------------------------------------------------------------------

export function registerBench(app: FastifyInstance) {
  const on = (reply: any) => {
    if (benchOn()) return true;
    reply.code(404).send({ error: "The Device bridge integration is off" });
    return false;
  };

  app.get("/api/bench/status", async (_req, reply) => (on(reply) ? benchStatus() : undefined));
  app.post("/api/bench/test", async (_req, reply) => (on(reply) ? benchTest() : undefined));

  app.get("/api/bench/bridge.py", async (_req, reply) => {
    if (!on(reply)) return;
    reply.type("text/x-python; charset=utf-8").header("cache-control", "no-store");
    return fs.readFileSync(BRIDGE_FILE(), "utf8");
  });
  app.get("/api/bench/install.sh", async (req, reply) => {
    if (!on(reply)) return;
    const token = readToken();
    if (!token) return reply.code(409).send({ error: "No bridge token yet: run the Device bridge's install step" });
    reply.type("text/x-shellscript; charset=utf-8").header("cache-control", "no-store")
      .header("content-disposition", 'attachment; filename="agentbox-bench-install.sh"');
    return installer(req, token);
  });

  app.get("/api/bench/connect", { websocket: true }, (socket: any, req) => {
    const token = readToken();
    const given = String(req.headers["x-agentbox-bench-token"] ?? "");
    if (!benchOn() || !token || !given || !sameToken(given, token)) {
      // "off": the bridge waits and retries; "token": it stops (a new installer is needed).
      socket.send(JSON.stringify(!benchOn() || !token
        ? { type: "refused", reason: "off", message: "the Device bridge is off on the portal" }
        : { type: "refused", reason: "token", message: "wrong or missing bridge token (download the installer again)" }));
      return socket.close(4401, "refused");
    }
    if (bridge) drop(bridge, "replaced by a newer bridge");
    const b: Bridge = {
      ws: socket, host: "?", os: "?", version: 0, since: new Date().toISOString(), capabilities: {},
      devices: new Map(), channels: new Map(), pending: new Map(), pings: new Map(), lastSeen: Date.now(),
    };
    bridge = b;
    const watch = setInterval(() => {
      if (!benchOn() || readToken() !== token) return drop(b, "disabled or token changed");
      if (Date.now() - b.lastSeen > 60_000) return drop(b, "silent for 60 s");
      ping(b).catch(() => {});
    }, 15_000);
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      b.lastSeen = Date.now();
      if (isBinary) {
        if (raw.length < 4) return;
        const s = b.channels.get(raw.readUInt32BE(0));
        if (s) s.write(raw.subarray(4));
        return;
      }
      let m: any;
      try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (m.type === "hello") {
        b.host = String(m.host ?? "?").slice(0, 80);
        b.os = String(m.os ?? "?").slice(0, 80);
        b.version = Number(m.version) || 0;
        b.capabilities = { serial: !!m.capabilities?.serial, camera: !!m.capabilities?.camera, screen: !!m.capabilities?.screen };
        const s = benchSettings();
        sendJson(b, { type: "welcome", enable: { serial: s.serial } });
        publishStatus();
      } else if (m.type === "devices" && Array.isArray(m.devices)) {
        const s = benchSettings();
        setDevices(b, (m.devices as BenchDevice[]).filter((d) => s.serial && (d.id !== "loopback" || s.loopback)).slice(0, PORT_SPAN));
      } else if (m.type === "opened") {
        const ch = Number(m.channel);
        const q = b.pending.get(ch);
        b.pending.delete(ch);
        for (const d of q ?? []) sendData(b, ch, d);
      } else if (m.type === "error" || m.type === "closed") {
        const s = b.channels.get(Number(m.channel));
        if (s) { if (m.type === "error") s.end(`\r\nagentbox-bench: ${String(m.message ?? "error").slice(0, 200)}\r\n`); s.destroy(); }
      } else if (m.type === "pong") {
        b.pings.get(String(m.nonce))?.(0);
        b.pings.delete(String(m.nonce));
      }
    });
    socket.on("close", () => { clearInterval(watch); if (bridge === b) drop(b, "closed"); });
    socket.on("error", () => { clearInterval(watch); if (bridge === b) drop(b, "error"); });
  });
}
