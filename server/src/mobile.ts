import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyWebsocket, { type WebSocket } from "@fastify/websocket";
import type { Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { subscribe } from "./bus.ts";
import {
  approveDevice, audit, cancelPairings, claimPairing, createPairing, denyDevice, gatewayStatus, listDevices,
  liveDevice, revokeAll, revokeDevice, setManualUrl, setOnRemoved, sweep, touchDevice, type Device,
} from "./devices.ts";
import { b64urlBytes, canonicalMessage, verifySignature } from "./signing.ts";

/**
 * The mobile gateway (docs/MOBILE-PROTOCOL.md): a second Fastify instance on 127.0.0.1:7710 that
 * `tailscale serve` exposes on the tailnet. It answers anything it doesn't like with an empty 404,
 * checks each request's Ed25519 signature, and forwards a fixed allowlist of /m/v1/<rest> calls
 * to the main app's /api/<rest> handlers in-process with app.inject().
 */

/**
 * Set on every request the gateway injects into the main app. Its value is a per-process random
 * token, so nothing outside this process (a DNS-rebinding page, an agent's curl) can forge it.
 * Client headers are never copied into injected requests.
 */
export const GATEWAY_HEADER = "x-agentbox-gateway";
const GATEWAY_TOKEN = randomBytes(32).toString("base64url");
function isGatewayToken(v: unknown) {
  if (typeof v !== "string") return false;
  const a = Buffer.from(v), b = Buffer.from(GATEWAY_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MB = 1024 * 1024;
const BODY_LIMIT = 1 * MB;
const UPLOAD_LIMIT = 16 * MB;
const CLAIM_LIMIT = 8 * 1024;
const WINDOW_MS = 60_000;      // |now − X-AB-Time| must be within this
const NONCE_TTL_MS = 120_000;  // nonces remembered this long per device
const CLAIMS_PER_MIN = 10;     // per source (tailnet user)
const CLAIMS_PER_MIN_ALL = 30; // all sources together
const REQS_PER_MIN = 600;      // per device
const SOCKETS_PER_DEVICE = 4;
const FILE_AUDIT_MS = 10 * 60_000; // one audit row per device and file per 10 minutes

/**
 * Events a phone receives: only what its allowlisted reads already expose. state (agents, usage,
 * groups, pause, screen holder), work and threads (tasks, messages, streamed text, and steps: the
 * room and thread views return steps with their input and output), routines. Not skills, skill
 * drafts or device admin.
 */
const PHONE_EVENTS = new Set([
  "agent.created", "agent.updated", "agent.deleted", "agent.retired", "agent.status",
  "task.updated", "message.created", "turn.delta", "step.updated", "thread.created", "usage",
  "group.updated", "group.deleted", "routine.updated", "routine.deleted", "display.updated", "paused",
]);

// --- the allowlist ------------------------------------------------------------------------

const ID = "[A-Za-z0-9_-]{1,128}";
const ALLOW: { method: "GET" | "POST"; re: RegExp }[] = [
  ...["state", "work", `work/${ID}`, `work/${ID}/documents`, `threads/${ID}`, "tasks", "routines", `routines/${ID}`, "documents", "file", "control"]
    .map((p) => ({ method: "GET" as const, re: new RegExp(`^${p}$`) })),
  ...["work", `threads/${ID}/messages`, `tasks/${ID}/stop`, "pause", "resume", `routines/${ID}/run`, `agents/${ID}/done`, "uploads"]
    .map((p) => ({ method: "POST" as const, re: new RegExp(`^${p}$`) })),
];

/** Whether `<method> /api/<rest>` may be reached from a phone. `rest` has no query string. */
export function allowedRoute(method: string, rest: string) {
  if (rest.startsWith("devices")) return false;
  return ALLOW.some((a) => a.method === method && a.re.test(rest));
}

/** Split a raw URL into path and query ("" or "?…"). */
function splitUrl(url: string) {
  const q = url.indexOf("?");
  return q < 0 ? { path: url, query: "" } : { path: url.slice(0, q), query: url.slice(q) };
}

// --- main-app side: localhost only, and the gateway's allowlist again -------------------------

const LOOPBACK_NAME = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Why a request to the main app's /api isn't from the owner's own browser or a local tool, or null.
 * - Host must be a loopback name: blocks DNS rebinding (a page whose name resolves to 127.0.0.1).
 * - Origin, when sent, must be a loopback origin: blocks other sites (and their WebSockets).
 * - A write with a body must be JSON: a foreign page can't send that without a CORS preflight.
 *   Bodyless POSTs (curl, the portal's buttons) need no content type.
 */
function notLocal(req: FastifyRequest): { code: number; error: string } | null {
  if (!LOOPBACK_NAME.test(String(req.headers.host ?? ""))) return { code: 403, error: "Open agentbox on localhost" };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host = "";
    try { const u = new URL(origin); host = u.protocol === "http:" || u.protocol === "https:" ? u.host : ""; } catch { /* malformed */ }
    // Exactly the portal's own origin: another localhost port (a dev server) is another site.
    if (!LOOPBACK_NAME.test(host) || host.toLowerCase() !== String(req.headers.host ?? "").toLowerCase()) {
      return { code: 403, error: "Cross-origin request refused" };
    }
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const len = Number(req.headers["content-length"] ?? 0);
    const hasBody = len > 0 || req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      return { code: 415, error: "Send JSON" };
    }
  }
  return null;
}

/**
 * The main app's guard for every /api route and the /api/events WebSocket. Requests the gateway
 * injected (carrying the in-process token) are checked against the phone allowlist instead, and
 * /api/devices* refuses them outright, as defence in depth.
 */
export function guardApi(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    const { path } = splitUrl(req.url);
    // The router decodes the path before matching (/%61pi/pause is /api/pause), so judge both the
    // decoded path and the route that matched. Real API paths never need percent-encoding: refuse.
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch { return reply.code(400).send(); }
    const route = String(req.routeOptions?.url ?? "");
    const isApi = (p: string) => p === "/api" || p.toLowerCase().startsWith("/api/");
    if (!isApi(path) && !isApi(decoded) && !isApi(route)) return; // the static UI
    if (decoded !== path) return reply.code(404).send();
    const marker = req.headers[GATEWAY_HEADER];
    if (marker !== undefined) {
      const rest = path.slice(5);
      if (!isGatewayToken(marker) || rest.startsWith("devices") || !allowedRoute(req.method, rest)) return reply.code(404).send();
      return;
    }
    const bad = notLocal(req);
    if (bad) return reply.code(bad.code).send({ error: bad.error });
  });
}

/**
 * The portal's device admin: never via the gateway, and (on top of guardApi) every write must be
 * JSON even without a body, so it always needs a CORS preflight.
 */
function adminGuard(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (req.headers[GATEWAY_HEADER] !== undefined) return void reply.code(404).send();
  const bad = notLocal(req);
  if (bad) return void reply.code(bad.code).send({ error: bad.error });
  if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return void reply.code(415).send({ error: "Send JSON" });
  }
  done();
}

export function registerDeviceAdmin(app: FastifyInstance, mobilePort: number) {
  const opts = { onRequest: adminGuard };
  const status = async () => gatewayStatus(mobilePort);
  app.post("/api/devices/pairings", opts, async (_req, reply) => {
    const gw = await status();
    if (!gw.url) {
      return reply.code(409).send({ error: "No gateway URL yet. Set up Tailscale (scripts/mobile-setup.sh) or enter the URL below." });
    }
    const p = createPairing();
    const payload = { v: 1, u: gw.url, c: p.code, n: "agentbox" };
    return { id: p.id, code: p.code, expires_at: p.expires_at, url: gw.url, qr_payload: JSON.stringify(payload) };
  });
  app.delete("/api/devices/pairings", opts, async () => {
    cancelPairings();
    return { ok: true };
  });
  app.get("/api/devices", opts, async () => listDevices());
  const act = (fn: (id: string) => boolean, what: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!fn(String((req.params as any).id))) return reply.code(404).send({ error: `No such ${what}` });
    return { ok: true };
  };
  app.post("/api/devices/:id/approve", opts, act(approveDevice, "pending device (it may have expired)"));
  app.post("/api/devices/:id/deny", opts, act(denyDevice, "pending device"));
  app.post("/api/devices/:id/revoke", opts, act(revokeDevice, "device"));
  app.post("/api/devices/revoke-all", opts, async () => ({ revoked: revokeAll() }));
  app.get("/api/devices/gateway", opts, async (req) => gatewayStatus(mobilePort, (req.query as any)?.fresh === "1"));
  app.put("/api/devices/gateway", opts, async (req, reply) => {
    try {
      setManualUrl((req.body as any)?.url);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    return gatewayStatus(mobilePort, true);
  });
}

// --- the gateway ----------------------------------------------------------------------------

type Authed = { device: Device; sigOk: boolean };
declare module "fastify" {
  interface FastifyRequest { ab?: Authed }
}

/** Sliding one-minute counters. */
function limiter(max: number) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string) {
      const t = Date.now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(t);
      hits.set(key, list);
      return true;
    },
    forget: (key: string) => hits.delete(key),
    sweep() {
      const t = Date.now();
      for (const [k, list] of hits) if (!list.some((x) => t - x < 60_000)) hits.delete(k);
    },
  };
}

export async function startMobileGateway(app: FastifyInstance, port: number) {
  const log = app.log;
  const claims = limiter(CLAIMS_PER_MIN);
  const allClaims = limiter(CLAIMS_PER_MIN_ALL);
  const fileAudits = new Map<string, number>(); // device + path → last audited
  // Signatures made before this process started are refused, so a restart (which empties the
  // nonce cache) can't make a captured request replayable within its 60 s window.
  const startedAt = Date.now();
  const requests = limiter(REQS_PER_MIN);
  const nonces = new Map<string, Map<string, number>>(); // device → nonce → expiry
  const sockets = new Map<string, Set<WebSocket>>();
  const lastTouch = new Map<string, number>(); // last_seen_at is written at most every 30 s per device

  const closeSockets = (deviceId: string) => {
    for (const ws of sockets.get(deviceId) ?? []) {
      try { ws.close(1008, "revoked"); } catch { /* already closing */ }
      setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000).unref();
    }
    sockets.delete(deviceId);
  };
  setOnRemoved((id) => {
    closeSockets(id);
    nonces.delete(id);
    requests.forget(id);
    lastTouch.delete(id);
  });

  const timer = setInterval(() => {
    const t = Date.now();
    for (const [d, m] of nonces) {
      for (const [n, exp] of m) if (exp <= t) m.delete(n);
      if (!m.size) nonces.delete(d);
    }
    claims.sweep();
    allClaims.sweep();
    for (const [k, at] of fileAudits) if (t - at > FILE_AUDIT_MS) fileAudits.delete(k);
    requests.sweep();
    try { sweep(); } catch (e) { log.error(e); }
  }, 15_000);
  timer.unref();

  const gw = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    bodyLimit: BODY_LIMIT,
    routerOptions: { maxParamLength: 256 },
    // Malformed HTTP gets the same bare 404 as everything else, then the socket closes.
    clientErrorHandler: (_err: Error, socket: Socket) => {
      if (socket.writable) socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      else socket.destroy();
    },
    frameworkErrors: (_err, _req, reply) => { (reply as FastifyReply).code(404).send(); },
  });
  await gw.register(fastifyWebsocket, { options: { maxPayload: 4096 } });

  // Bodies are kept as raw bytes: the signature covers them exactly.
  gw.removeAllContentTypeParsers();
  gw.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  const empty = (reply: FastifyReply) => reply.code(404).send();

  gw.setNotFoundHandler((_req, reply) => { empty(reply); });
  gw.setErrorHandler((err: any, _req, reply) => {
    if (!(err?.statusCode >= 400 && err.statusCode < 500)) log.error({ err }, "mobile gateway error");
    empty(reply);
  });

  // Same headers on every response; nothing that identifies the server.
  gw.addHook("onSend", async (_req, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.removeHeader("x-powered-by");
    reply.removeHeader("server");
    return payload;
  });

  // Stage 1, before the body is read: shape of the request, device, clock, allowlist.
  gw.addHook("onRequest", async (req, reply) => {
    // Browsers send Origin; the app doesn't. React Native's Android WebSocket adds one unless told
    // otherwise, so the app sends an empty one: empty counts as absent, anything else is refused.
    if (req.headers.origin !== undefined && req.headers.origin !== "") return empty(reply);
    const { path, query } = splitUrl(req.url);
    if (req.method === "POST" && path === "/m/pair/claim" && !query) {
      // Phones are user devices, so tailscale serve always adds Tailscale-User-Login.
      const login = req.headers["tailscale-user-login"];
      if (typeof login !== "string" || !VALID_LOGIN.test(login)) return empty(reply);
      if (!claims.take(`login:${login.toLowerCase()}`) || !allClaims.take("all")) return empty(reply);
      return;
    }
    if (!path.startsWith("/m/v1/") || query.length > 4096) return empty(reply);
    const rest = path.slice(6);
    const special = !query && (
      ((rest === "whoami" || rest === "events") && req.method === "GET") || (rest === "device/forget" && req.method === "POST"));
    if (!special && !allowedRoute(req.method, rest)) return empty(reply);

    const h = req.headers;
    const id = h["x-ab-device"], time = h["x-ab-time"], nonce = h["x-ab-nonce"], sig = h["x-ab-sig"];
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return empty(reply);
    if (typeof time !== "string" || !/^\d{1,16}$/.test(time)) return empty(reply);
    if (Math.abs(Date.now() - Number(time)) > WINDOW_MS || Number(time) < startedAt) return empty(reply);
    if (!b64urlBytes(nonce, 16) || !b64urlBytes(sig, 64)) return empty(reply);
    const device = liveDevice(id);
    if (!device) return empty(reply);
    // A pending device may only ask whether it's approved yet, or withdraw itself.
    if (device.status !== "active" && !(device.status === "pending" && (rest === "whoami" || rest === "device/forget"))) return empty(reply);
    if (device.tailnet_login && h["tailscale-user-login"] !== device.tailnet_login) return empty(reply);
    req.ab = { device, sigOk: false };
  });

  // Stage 2, with the raw body: signature, then the nonce, then the rate limit.
  gw.addHook("preHandler", async (req, reply) => {
    if (!req.ab) return; // only /m/pair/claim gets here unsigned
    const { device } = req.ab;
    // Raw body bytes (the buffer parser below; nothing is JSON-parsed here) and the raw, undecoded URL.
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const time = req.headers["x-ab-time"] as string;
    const nonce = req.headers["x-ab-nonce"] as string;
    const message = canonicalMessage(req.method, req.raw.url ?? req.url, time, nonce, body);
    if (!verifySignature(device.public_key, req.headers["x-ab-sig"], message)) return empty(reply);
    let seen = nonces.get(device.id);
    if (!seen) nonces.set(device.id, (seen = new Map()));
    if (seen.has(nonce)) return empty(reply);
    seen.set(nonce, Date.now() + NONCE_TTL_MS);
    if (!requests.take(device.id)) return empty(reply);
    // Re-read: it may have been revoked while the body was arriving.
    const fresh = liveDevice(device.id);
    if (!fresh || fresh.status !== device.status) return empty(reply);
    req.ab.sigOk = true;
    if (Date.now() - (lastTouch.get(device.id) ?? 0) > 30_000) {
      lastTouch.set(device.id, Date.now());
      touchDevice(device.id);
    }
  });

  // --- routes ---
  gw.post("/m/pair/claim", { bodyLimit: CLAIM_LIMIT }, async (req, reply) => {
    let body: any = null;
    try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : ""); } catch { return empty(reply); }
    const result = claimPairing(body, req.headers["tailscale-user-login"] as string); // checked in onRequest
    if (!result) return empty(reply);
    return reply.code(202).header("content-type", "application/json").send(JSON.stringify(result));
  });

  gw.get("/m/v1/whoami", async (req, reply) => {
    const d = req.ab?.sigOk ? liveDevice(req.ab.device.id) : null;
    if (!d) return empty(reply);
    const body = d.status === "active" ? { status: "active", device_id: d.id, name: d.name } : { status: "pending" };
    return reply.header("content-type", "application/json").send(JSON.stringify(body));
  });

  // The app's "Forget this device": the device revokes itself. Not an /api route.
  gw.post("/m/v1/device/forget", async (req, reply) => {
    if (!req.ab?.sigOk) return empty(reply);
    const d = req.ab.device;
    if (!revokeDevice(d.id)) return empty(reply);
    try { audit(d, "POST", "device/forget", 204, null); } catch (e) { log.error(e, "mobile audit failed"); }
    return reply.code(204).send();
  });

  gw.get("/m/v1/events", { websocket: true }, (socket, req) => {
    const d = req.ab?.sigOk ? liveDevice(req.ab.device.id) : null;
    if (!d || d.status !== "active") return socket.terminate();
    let set = sockets.get(d.id);
    if (!set) sockets.set(d.id, (set = new Set()));
    // A device gets a few sockets; the oldest goes when it opens more.
    while (set.size >= SOCKETS_PER_DEVICE) {
      const oldest = set.values().next().value!;
      set.delete(oldest);
      try { oldest.close(1008, "too many sockets"); } catch { /* gone */ }
    }
    set.add(socket);
    const off = subscribe((e) => {
      if (!PHONE_EVENTS.has(e.type)) return;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    });
    socket.on("message", () => { /* the app only listens */ });
    socket.on("close", () => {
      off();
      sockets.get(d.id)?.delete(socket);
    });
  });

  const auditFileRead = (device: Device, query: string) => {
    const file = new URLSearchParams(query.slice(1)).get("path") ?? "";
    const key = `${device.id}\n${file}`;
    if (Date.now() - (fileAudits.get(key) ?? 0) < FILE_AUDIT_MS) return;
    fileAudits.set(key, Date.now());
    try { audit(device, "GET", "file", 200, file.slice(0, 1024) || null); } catch (e) { log.error(e, "mobile audit failed"); }
  };

  const forward = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.ab?.sigOk) return empty(reply);
    const { path, query } = splitUrl(req.url);
    const rest = path.slice(6);
    if (!allowedRoute(req.method, rest)) return empty(reply); // checked in onRequest too
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers: Record<string, string> = { [GATEWAY_HEADER]: GATEWAY_TOKEN };
    if (body.length) headers["content-type"] = "application/json";
    const method = req.method as "GET" | "POST";
    const target = `/api/${rest}${query}`;

    if (method === "GET") {
      // Stream: files can be large and binary.
      const res = await app.inject({ method, url: target, headers, payloadAsStream: true });
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.stream().destroy();
        return empty(reply); // the gateway never redirects
      }
      if (rest === "file" && res.statusCode === 200) auditFileRead(req.ab.device, query);
      passHeaders(res.headers, reply);
      return reply.code(upstreamStatus(res.statusCode)).send(res.stream());
    }

    // The raw body bytes the phone signed, untouched.
    const res = await app.inject({ method, url: target, headers, payload: body.length ? body : undefined });
    if (res.statusCode >= 300 && res.statusCode < 400) return empty(reply); // the gateway never redirects
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let ref: string | null = rest.split("/")[1] ?? null;
      if (rest === "work") {
        try { ref = String(JSON.parse(res.payload).id ?? "") || null; } catch { ref = null; }
      }
      try { audit(req.ab.device, method, rest, res.statusCode, ref); } catch (e) { log.error(e, "mobile audit failed"); }
    }
    passHeaders(res.headers, reply);
    return reply.code(upstreamStatus(res.statusCode)).send(res.rawPayload);
  };
  gw.post("/m/v1/uploads", { bodyLimit: UPLOAD_LIMIT }, forward);
  gw.route({ method: ["GET", "POST"], url: "/m/v1/*", handler: forward });

  await gw.listen({ host: "127.0.0.1", port });
  log.info(`mobile gateway listening on 127.0.0.1:${port}`);
  return gw;
}

/**
 * An empty 404 always means "not authenticated or not allowed", so the API's own 404 (no such
 * task, file not found…) reaches the phone as 410.
 */
const upstreamStatus = (status: number) => (status === 404 ? 410 : status);

/** Printable, no whitespace or control/format characters, bounded. */
const VALID_LOGIN = /^[^\s\p{C}]{1,256}$/u;

const PASS = ["content-type", "content-disposition", "content-security-policy"];
function passHeaders(from: Record<string, unknown>, reply: FastifyReply) {
  for (const k of PASS) {
    const v = from[k];
    if (typeof v === "string") reply.header(k, v);
  }
}
