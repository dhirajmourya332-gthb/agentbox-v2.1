import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { all, dataDir, get, newId, now, run, db } from "./db.ts";
import { config, ports } from "./config.ts";
import { publish, subscribe } from "./bus.ts";
import { getAgent, rootOf, type Agent } from "./agents.ts";
import { allowed, contentType } from "./documents.ts";
import { isOrchestrator, missingIntegration } from "./roleGuards.ts";

/**
 * Hosting (docs/HOSTING.md): agents serve what they build — a static folder or a command that
 * listens on $PORT — and get a link the owner opens straight away, e.g.
 * https://<node>.ts.net:10000/arm-dashboard/. Agents only see four tools (host_start, host_stop,
 * host_list, host_logs); ports, processes, the proxy and sign-in are handled here.
 *
 * - The gateway is its own origin (another port), never the portal's: a hosted page runs code an
 *   agent wrote, and on the portal's origin it would act as the owner. The portal's session cookie
 *   is stripped from what the gateway forwards, and the portal refuses requests from other origins.
 * - Who sees it: tailscale mode, the owner only (Tailscale-User-Login via `tailscale serve
 *   --https=<hosting.serve_port>`); ssh-tunnel mode, localhost. Local processes (agents testing their
 *   own app) may use http://127.0.0.1:<ports.apps>/<name>/.
 * - Control: whoever starts a service, and the lead of its task (the room's root or a lead that
 *   joined it), may stop or restart it; the owner may stop any (portal). Services belong to the task
 *   room: a helper finishing doesn't stop them, the work being marked done (its root retiring) does.
 * - Services survive an agentbox restart: commands are started again on the same port.
 */

export const LIMITS = { perRoom: 6, total: 24, startWaitMs: 45_000, logBytes: 2 * 1024 * 1024 };
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LOOPBACK_NAME = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_PEER = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const PORTAL_COOKIE = "__Host-agentbox_session";

export type Service = {
  id: string; name: string; kind: "static" | "command"; dir: string; command: string | null; port: number | null;
  strip_prefix: number; pid: number | null; status: "running" | "stopped" | "exited";
  started_by: string; room_id: string; created_at: string; stopped_at: string | null; stop_reason: string | null;
};

db.exec(`
CREATE TABLE IF NOT EXISTS hosted_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- static | command
  dir TEXT NOT NULL,
  command TEXT,
  port INTEGER,
  strip_prefix INTEGER NOT NULL DEFAULT 1,
  pid INTEGER,
  status TEXT NOT NULL,              -- running | stopped | exited
  started_by TEXT NOT NULL,          -- the instance that started it
  room_id TEXT NOT NULL,             -- the task room's root instance
  created_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_reason TEXT
);
CREATE INDEX IF NOT EXISTS hosted_running ON hosted_services(status, name);
CREATE INDEX IF NOT EXISTS hosted_room ON hosted_services(room_id, status);
`);

const logDir = () => path.join(dataDir, "hosting");
const logFile = (s: Pick<Service, "id">) => path.join(logDir(), `${s.id}.log`);
const servePort = () => config.hosting.serve_port;
const rangeStart = () => ports.apps + 10;
const RANGE = 100;

/** The link the owner opens. */
export function publicUrl(name: string) {
  if (config.access === "tailscale" && config.tailscale.hostname) {
    const p = servePort();
    return `https://${config.tailscale.hostname.toLowerCase()}${p === 443 ? "" : `:${p}`}/${name}/`;
  }
  return `http://localhost:${ports.apps}/${name}/`;
}
export const localUrl = (name: string) => `http://127.0.0.1:${ports.apps}/${name}/`;

const children = new Map<string, ReturnType<typeof spawn>>();

export function running(): Service[] {
  return all<Service>(`SELECT * FROM hosted_services WHERE status = 'running' ORDER BY created_at`);
}
export const serviceByName = (name: string) => get<Service>(`SELECT * FROM hosted_services WHERE status = 'running' AND name = ?`, name);
export const serviceById = (id: string) => get<Service>(`SELECT * FROM hosted_services WHERE id = ?`, id);

export function view(s: Service) {
  const starter = getAgent(s.started_by);
  return {
    id: s.id, name: s.name, kind: s.kind, dir: s.dir, command: s.command, port: s.port, status: s.status,
    url: publicUrl(s.name), local_url: localUrl(s.name), started_by: starter?.name ?? "?", started_by_id: s.started_by,
    room_id: s.room_id, created_at: s.created_at, stopped_at: s.stopped_at, stop_reason: s.stop_reason,
  };
}

/** Services in a task room (the running ones, then the last few that ended). */
export function roomServices(roomId: string) {
  const live = all<Service>(`SELECT * FROM hosted_services WHERE room_id = ? AND status = 'running' ORDER BY created_at`, roomId);
  const ended = all<Service>(`SELECT * FROM hosted_services WHERE room_id = ? AND status != 'running' ORDER BY stopped_at DESC LIMIT 5`, roomId);
  return [...live, ...ended].map(view);
}

/** The lead of a room: its root, or an orchestrator instance that joined it. */
function leads(agent: Agent, roomId: string) {
  return agent.id === roomId || (isOrchestrator(agent) && rootOf(agent).id === roomId);
}
export function mayControl(agent: Agent, s: Service) {
  return s.started_by === agent.id || leads(agent, s.room_id);
}

async function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host: "127.0.0.1", port }, () => srv.close(() => resolve(true)));
  });
}
async function pickPort(prefer?: number | null) {
  const taken = new Set(running().map((s) => s.port).filter(Boolean));
  if (prefer && !taken.has(prefer) && await portFree(prefer)) return prefer;
  for (let p = rangeStart(); p < rangeStart() + RANGE; p++) if (!taken.has(p) && await portFree(p)) return p;
  throw new Error(`No free port in ${rangeStart()}–${rangeStart() + RANGE - 1}; stop a service first`);
}
const listening = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
});

export function tailLog(s: Pick<Service, "id">, lines = 40) {
  try {
    const buf = fs.readFileSync(logFile(s));
    const txt = buf.subarray(Math.max(0, buf.length - 64 * 1024)).toString("utf8");
    return txt.split("\n").slice(-Math.max(1, Math.min(lines, 400)) - 1).join("\n").trim();
  } catch { return ""; }
}

/** A clean environment: nothing from the portal's own (which may carry secrets). */
function serviceEnv(s: Service) {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "SHELL"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return {
    ...env, PORT: String(s.port), HOST: "127.0.0.1", BASE_PATH: `/${s.name}/`, PUBLIC_URL: publicUrl(s.name),
    AGENTBOX_SERVICE: s.name, BROWSER: "none", CI: "1",
  };
}

function launch(s: Service) {
  fs.mkdirSync(logDir(), { recursive: true, mode: 0o700 });
  // Keep the log bounded across restarts.
  try { if (fs.statSync(logFile(s)).size > LIMITS.logBytes) fs.truncateSync(logFile(s), 0); } catch { /* new */ }
  const out = fs.openSync(logFile(s), "a", 0o600);
  fs.writeSync(out, `\n--- ${now()} start: ${s.command} (PORT=${s.port}, cwd ${s.dir})\n`);
  const child = spawn("bash", ["-c", s.command!], { cwd: s.dir, env: serviceEnv(s), detached: true, stdio: ["ignore", out, out] });
  fs.closeSync(out);
  children.set(s.id, child);
  run(`UPDATE hosted_services SET pid = ?, status = 'running' WHERE id = ?`, child.pid ?? null, s.id);
  child.on("exit", (code, sig) => {
    children.delete(s.id);
    const cur = serviceById(s.id);
    if (cur?.status === "running" && cur.pid === child.pid) {
      run(`UPDATE hosted_services SET status = 'exited', stopped_at = ?, stop_reason = ?, pid = NULL WHERE id = ?`,
        now(), sig ? `killed by ${sig}` : `exited with code ${code}`, s.id);
      publish({ type: "hosting.updated", service: view(serviceById(s.id)!) });
    }
  });
  return child;
}

function killGroup(pid: number, sig: NodeJS.Signals) {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
}
async function terminate(s: Service) {
  if (!s.pid) return;
  const pid = s.pid;
  killGroup(pid, "SIGTERM");
  for (let i = 0; i < 25; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 200));
  }
  killGroup(pid, "SIGKILL");
}

export async function stopService(s: Service, reason: string) {
  if (s.status !== "running") return view(s);
  run(`UPDATE hosted_services SET status = 'stopped', stopped_at = ?, stop_reason = ? WHERE id = ?`, now(), reason, s.id);
  await terminate(s);
  run(`UPDATE hosted_services SET pid = NULL WHERE id = ?`, s.id);
  const v = view(serviceById(s.id)!);
  publish({ type: "hosting.updated", service: v });
  return v;
}

export type StartInput = { name: string; dir?: string; command?: string; stripPrefix?: boolean };

/** Start (or restart, same name in the same room) a service for an agent. Returns its view. */
export async function startService(agent: Agent, input: StartInput) {
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!NAME.test(name)) throw new Error("name: lowercase letters, digits and dashes, up to 40 (e.g. arm-dashboard); it becomes the link's path");
  const command = input.command?.trim() || null;
  const dir = path.resolve(String(input.dir ?? "").trim() || ".");
  if (!input.dir?.trim()) throw new Error("dir: the folder to serve (static) or to run the command in, an absolute path");
  if (!allowed(dir)) throw new Error("dir must be under /work or your home (/agents)");
  let st: fs.Stats;
  try { st = fs.statSync(dir); } catch { throw new Error(`No such folder: ${dir}`); }
  if (!st.isDirectory()) throw new Error(`${dir} is a file; give its folder`);
  if (command) {
    if (command.length > 2000) throw new Error("command is too long");
    const hit = missingIntegration(agent, command);
    if (hit) throw new Error(`\`${hit.cmd}\` isn't one of your tools; hand that part to the teammate who has it`);
  }
  const roomId = rootOf(agent).id;
  const existing = serviceByName(name);
  if (existing) {
    if (existing.room_id !== roomId || !mayControl(agent, existing)) {
      throw new Error(`"${name}" is already in use by ${getAgent(existing.started_by)?.name ?? "another task"}; pick another name`);
    }
    await stopService(existing, `restarted by ${agent.name}`);
  }
  if (all(`SELECT id FROM hosted_services WHERE room_id = ? AND status = 'running'`, roomId).length >= LIMITS.perRoom) {
    throw new Error(`This task already hosts ${LIMITS.perRoom} services; stop one first (host_list)`);
  }
  if (running().length >= LIMITS.total) throw new Error(`agentbox already hosts ${LIMITS.total} services; ask the lead to stop some`);

  const port = command ? await pickPort(existing?.port) : null;
  const s: Service = {
    id: newId(), name, kind: command ? "command" : "static", dir, command, port, strip_prefix: input.stripPrefix === false ? 0 : 1,
    pid: null, status: "running", started_by: agent.id, room_id: roomId, created_at: now(), stopped_at: null, stop_reason: null,
  };
  run(`INSERT INTO hosted_services (id, name, kind, dir, command, port, strip_prefix, pid, status, started_by, room_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'running', ?, ?, ?)`,
    s.id, s.name, s.kind, s.dir, s.command, s.port, s.strip_prefix, s.started_by, s.room_id, s.created_at);

  if (command) {
    const child = launch(s);
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < LIMITS.startWaitMs) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (await listening(port!)) { up = true; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!up) {
      const exited = child.exitCode !== null || child.signalCode !== null;
      await stopService(serviceById(s.id)!, exited ? "exited during start" : "didn't listen on $PORT in time");
      const tail = tailLog(s, 25);
      throw new Error(`${exited ? "The command exited" : `Nothing listened on port ${port} (it must use $PORT and 127.0.0.1) within ${LIMITS.startWaitMs / 1000}s`}; stopped.${tail ? `\nLast output:\n${tail}` : ""}`);
    }
  }
  const v = view(serviceById(s.id)!);
  publish({ type: "hosting.updated", service: v });
  return v;
}

/** Stop everything a task room hosts (its work was marked done). */
export async function stopRoom(roomId: string, reason: string) {
  for (const s of all<Service>(`SELECT * FROM hosted_services WHERE room_id = ? AND status = 'running'`, roomId)) await stopService(s, reason);
}

/** After a restart: static services carry on; commands start again (same port when it's free). */
async function resume(log: (m: string) => void) {
  for (const s of running()) {
    if (s.kind !== "command") continue;
    const room = getAgent(s.room_id);
    if (!room || room.retired_at) {
      run(`UPDATE hosted_services SET status = 'stopped', stopped_at = ?, stop_reason = 'its task had ended', pid = NULL WHERE id = ?`, now(), s.id);
      continue;
    }
    if (s.pid) killGroup(s.pid, "SIGTERM"); // a leftover from before the restart
    try {
      const p = await pickPort(s.port);
      run(`UPDATE hosted_services SET port = ? WHERE id = ?`, p, s.id);
      launch({ ...s, port: p });
    } catch (e: any) {
      run(`UPDATE hosted_services SET status = 'exited', stopped_at = ?, stop_reason = ?, pid = NULL WHERE id = ?`, now(), `couldn't restart: ${e.message}`, s.id);
      log(`hosting: ${s.name} couldn't restart: ${e.message}`);
    }
  }
}

// --- the gateway ---------------------------------------------------------------------------------------

const hdr = (req: http.IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? undefined : v;
};

/** Who may open hosted services. null = allowed, else why not. */
export function gatewayRefusal(req: { headers: http.IncomingHttpHeaders; socket: { remoteAddress?: string } }): string | null {
  const host = String(req.headers.host ?? "").toLowerCase();
  const loopbackPeer = LOOPBACK_PEER.has(req.socket.remoteAddress ?? "");
  if (loopbackPeer && LOOPBACK_NAME.test(host) && req.headers["tailscale-user-login"] === undefined) return null; // local, or ssh-tunnel
  if (config.access === "tailscale") {
    const ts = config.tailscale.hostname.toLowerCase();
    if (!ts || !(host === ts || host === `${ts}:${servePort()}`)) return "Wrong host";
    const login = req.headers["tailscale-user-login"];
    if (!loopbackPeer || typeof login !== "string") return "Sign in to Tailscale as the owner";
    if (login.trim().toLowerCase() !== config.owner.tailscale_login.trim().toLowerCase()) return "Only the owner can open hosted services";
    return null;
  }
  return config.access === "cloudflare" ? "Hosting isn't available in cloudflare mode yet" : "Open it on localhost";
}

/** /name/rest → the service and the path to send it. Falls back to the Referer for absolute asset paths. */
export function route(url: string, referer?: string): { s: Service; upstream: string } | { redirect: string } | null {
  const q = url.indexOf("?");
  const p = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q);
  const m = /^\/([a-z0-9-]{1,40})(\/.*)?$/.exec(p);
  const s = m ? serviceByName(m[1]) : undefined;
  if (s && m) {
    if (m[2] === undefined) return { redirect: `/${s.name}/${query}` };
    return { s, upstream: (s.strip_prefix ? m[2] : p) + query };
  }
  // An app that asks for /assets/x.js from /my-app/: send it to my-app.
  if (referer) {
    try {
      const r = /^\/([a-z0-9-]{1,40})\//.exec(new URL(referer).pathname);
      const owner = r ? serviceByName(r[1]) : undefined;
      if (owner) return { s: owner, upstream: p + query };
    } catch { /* not a URL */ }
  }
  return null;
}

function forwardHeaders(req: http.IncomingMessage, s: Service) {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP.has(k) || k.startsWith("tailscale-") || k === "host") continue;
    if (k === "cookie") {
      const kept = String(v).split(";").map((c) => c.trim()).filter((c) => c && !c.startsWith(PORTAL_COOKIE + "=")).join("; ");
      if (kept) out.cookie = kept;
      continue;
    }
    out[k] = v;
  }
  out.host = `127.0.0.1:${s.port}`;
  out["x-forwarded-host"] = String(req.headers.host ?? "");
  out["x-forwarded-proto"] = config.access === "tailscale" && !LOOPBACK_NAME.test(String(req.headers.host ?? "")) ? "https" : "http";
  out["x-forwarded-prefix"] = `/${s.name}`;
  return out;
}

function sendText(res: http.ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function indexPage(res: http.ServerResponse) {
  const rows = running().map((s) => `<li><a href="/${s.name}/">${esc(s.name)}</a> <small>${esc(s.kind === "command" ? s.command ?? "" : s.dir)} · ${esc(getAgent(s.started_by)?.name ?? "?")}</small></li>`).join("");
  sendText(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hosted by agentbox</title>
<style>body{font:15px system-ui,sans-serif;margin:2rem auto;max-width:44rem;padding:0 1rem;color:#222;background:#fafafa}small{color:#777}li{margin:.5rem 0}@media(prefers-color-scheme:dark){body{background:#151515;color:#ddd}a{color:#8ab4ff}}</style>
<h1>Hosted by agentbox</h1>${rows ? `<ul>${rows}</ul>` : "<p>Nothing is hosted right now.</p>"}`, "text/html; charset=utf-8");
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, s: Service, upstream: string) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Static service: GET only");
  let rel: string;
  try { rel = decodeURIComponent(upstream.split("?")[0]); } catch { return sendText(res, 400, "Bad path"); }
  if (rel.includes("\0")) return sendText(res, 400, "Bad path");
  const root = fs.realpathSync(s.dir);
  let file = path.resolve(root, "." + path.posix.normalize("/" + rel));
  try {
    if (fs.statSync(file).isDirectory()) {
      if (!rel.endsWith("/")) { res.writeHead(301, { location: `/${s.name}${rel}/` }); return res.end(); }
      file = path.join(file, "index.html");
    }
    file = fs.realpathSync(file);
  } catch {
    // A single-page app's routes: fall back to its index.html for paths without an extension.
    const idx = path.join(root, "index.html");
    if (!path.extname(rel) && fs.existsSync(idx)) file = idx;
    else return sendText(res, 404, "Not found");
  }
  if (!(file === root || file.startsWith(root + path.sep))) return sendText(res, 404, "Not found");
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return sendText(res, 404, "Not found"); }
  if (!st.isFile()) return sendText(res, 404, "Not found");
  res.writeHead(200, { "content-type": contentType(file), "content-length": st.size, "cache-control": "no-store" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

function proxy(req: http.IncomingMessage, res: http.ServerResponse, s: Service, upstream: string) {
  const up = http.request({ host: "127.0.0.1", port: s.port!, method: req.method, path: upstream, headers: forwardHeaders(req, s), timeout: 300_000 }, (r) => {
    const h: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k)) h[k] = v;
    // Keep redirects inside the service's path.
    const loc = typeof r.headers.location === "string" ? r.headers.location : undefined;
    if (loc && s.strip_prefix) {
      if (loc.startsWith("/") && !loc.startsWith("//") && !loc.startsWith(`/${s.name}/`)) h.location = `/${s.name}${loc}`;
      else {
        try {
          const u = new URL(loc);
          if (["127.0.0.1", "localhost"].includes(u.hostname) && Number(u.port) === s.port) h.location = `/${s.name}${u.pathname}${u.search}`;
        } catch { /* relative */ }
      }
    }
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("timeout")));
  up.on("error", () => {
    if (!res.headersSent) sendText(res, 502, `${s.name} isn't answering (it may have stopped; see host_logs)`);
    else res.end();
  });
  req.on("aborted", () => up.destroy());
  req.pipe(up);
}

function upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  const refusal = gatewayRefusal(req);
  const r = refusal ? null : route(req.url ?? "/", hdr(req, "referer"));
  if (!r || "redirect" in r || r.s.kind !== "command") {
    socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
    return;
  }
  const { s, upstream } = r;
  const conn = net.connect({ host: "127.0.0.1", port: s.port! }, () => {
    const h = forwardHeaders(req, s);
    h.connection = "Upgrade";
    h.upgrade = String(req.headers.upgrade ?? "websocket");
    if (typeof h.origin === "string") h.origin = `http://127.0.0.1:${s.port}`; // dev servers check Origin against Host
    const lines = [`${req.method} ${upstream} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
    conn.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) conn.write(head);
    conn.pipe(socket);
    socket.pipe(conn);
  });
  const close = () => { conn.destroy(); socket.destroy(); };
  conn.on("error", close);
  socket.on("error", close);
  socket.on("close", () => conn.destroy());
}

export function gatewayHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const refusal = gatewayRefusal(req);
  if (refusal) return sendText(res, 403, refusal);
  const url = req.url ?? "/";
  if (url === "/" || url.startsWith("/?")) return indexPage(res);
  if (url === "/favicon.ico") return sendText(res, 404, "");
  const r = route(url, hdr(req, "referer"));
  if (!r) return sendText(res, 404, `Nothing is hosted at ${url.split("?")[0]}. See / for what's running.`);
  if ("redirect" in r) { res.writeHead(302, { location: r.redirect }); return res.end(); }
  if (r.s.kind === "static") return serveStatic(req, res, r.s, r.upstream);
  return proxy(req, res, r.s, r.upstream);
}

export async function startHosting(opts: { log: (m: string) => void }) {
  await resume(opts.log);
  // A room's root retired: the work was marked done. Its services stop with it.
  const off = subscribe((e) => {
    if (e.type === "agent.retired") void stopRoom(e.agentId, "the work was marked done").catch((err) => opts.log(`hosting: stop failed: ${err?.message ?? err}`));
  });
  const server = http.createServer(gatewayHandler);
  server.on("upgrade", upgrade);
  server.on("clientError", (_e, sock) => sock.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: ports.apps }, () => resolve());
  });
  opts.log(`hosting: gateway on 127.0.0.1:${ports.apps}${config.access === "tailscale" ? ` (https://${config.tailscale.hostname}:${servePort()})` : ""}`);
  return {
    stop: async () => {
      off();
      server.close();
      // Leave services running: systemd stops the whole unit; a dev restart starts them again.
    },
  };
}
