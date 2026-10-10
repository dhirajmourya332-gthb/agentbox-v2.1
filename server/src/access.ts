import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import { getAccessConfig, type AccessConfig, type AccessMode } from "./access-config.ts";

/**
 * Portal authentication (docs/V2-ARCHITECTURE.md § 5, docs/ACCESS.md).
 *
 * One decision function, authorize(), judges every request to the portal: /api (and the
 * /api/events WebSocket), the /term and /screen reverse proxies (HTTP and WebSocket), and, in the
 * remote modes, the static UI too.
 *
 * - ssh-tunnel: localhost only (today's behaviour). Host and Origin must be loopback.
 * - tailscale: Host is the node's ts.net name; identity is Tailscale-User-Login, trusted only from a
 *   loopback peer (tailscale serve) and only if it equals owner.tailscale_login.
 * - cloudflare: Host is the public hostname; identity is the Cf-Access-Jwt-Assertion JWT, verified
 *   (RS256 against the team's JWKS, aud, iss, exp/nbf/iat) and its email must equal owner.email.
 * In the remote modes the first authenticated request gets a session cookie (8 h, server-side).
 * Every mode refuses Sec-Fetch-Site cross-site/same-site on /api and the proxies (audit M1), a
 * foreign Origin, and non-JSON write bodies.
 *
 * Local tools (agentbox CLI, scripts) in the remote modes use the local token: a random value the
 * server writes to a 0600 file at start, sent as X-Agentbox-Local-Token from a loopback peer to a
 * loopback Host. It grants exactly what any local process has in ssh-tunnel mode.
 */

export type Identity = { kind: "tailscale"; login: string } | { kind: "cloudflare"; email: string } | { kind: "local" };
export type Decision =
  | { ok: true; identity: Identity | null; setCookie?: string }
  | { ok: false; code: number; error: string };

/** What authorize() needs from a request: works for Fastify requests and raw IncomingMessages. */
export type RequestLike = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string | undefined;
};

export type JwksFetcher = (url: string) => Promise<unknown>;

export type AccessOptions = {
  config?: AccessConfig;
  /** Fetches and parses the Cloudflare JWKS. Tests inject one. */
  fetchJwks?: JwksFetcher;
  /** Clock in ms. Tests inject one. */
  now?: () => number;
  /** Where to write the local token (0600). Omit to disable local-token access. */
  localTokenFile?: string;
  /** "user:password" for ttyd's -c, injected as Basic auth on the proxied requests. Absent: none. */
  ttydCredentialFile?: string;
  /** x11vnc's -passwdfile; handed to the authenticated portal so noVNC can log in. */
  vncPasswordFile?: string;
  /** Upstream host for the proxies (127.0.0.1). */
  upstreamHost?: string;
};

export const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_SESSIONS = 256;
const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_MIN_REFRESH_MS = 30_000;
const MAX_JWT = 8192;
export const LOCAL_TOKEN_HEADER = "x-agentbox-local-token";
const SECURE_COOKIE = "__Host-agentbox_session";

// --- helpers ------------------------------------------------------------------------------------

const LOOPBACK_NAME = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_PEER = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const header = (h: RequestLike["headers"], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? undefined : v; // a repeated security header is never trusted
};
export const isLoopbackPeer = (addr: string | undefined) => !!addr && LOOPBACK_PEER.has(addr);

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `https://team.cloudflareaccess.com/` → `team.cloudflareaccess.com`; "" if it isn't a plain hostname. */
export function normalizeTeamDomain(v: string) {
  const s = v.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  return HOSTNAME.test(s) ? s : "";
}

/** Why the config can't be used, or null. Remote modes with a missing piece fail closed (503). */
export function configProblem(c: AccessConfig): string | null {
  if (c.access === "ssh-tunnel") return null;
  if (c.access === "tailscale") {
    if (!HOSTNAME.test(c.tailscale.hostname.toLowerCase())) return "tailscale.hostname is not set (the node's ts.net name)";
    if (!c.owner.tailscale_login) return "owner.tailscale_login is not set";
    return null;
  }
  if (c.access === "cloudflare") {
    if (!HOSTNAME.test(c.cloudflare.hostname.toLowerCase())) return "cloudflare.hostname is not set";
    if (!normalizeTeamDomain(c.cloudflare.team_domain)) return "cloudflare.team_domain is not set (e.g. myteam.cloudflareaccess.com)";
    if (!/^[A-Za-z0-9]{16,128}$/.test(c.cloudflare.aud)) return "cloudflare.aud is not set (the Access application's AUD tag)";
    if (!/^[^\s@]+@[^\s@]+$/.test(c.owner.email)) return "owner.email is not set";
    return null;
  }
  return `unknown access mode "${String(c.access)}"`;
}

/** The public hostname in the remote modes, or null in ssh-tunnel. */
export function publicHost(c: AccessConfig): string | null {
  if (c.access === "tailscale") return c.tailscale.hostname.toLowerCase();
  if (c.access === "cloudflare") return c.cloudflare.hostname.toLowerCase();
  return null;
}

function parseCookies(h: string | undefined) {
  const out = new Map<string, string>();
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

// --- Cloudflare Access JWT ---------------------------------------------------------------------

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Fetches the team's signing keys; caches them; refreshes on an unknown kid (at most every 30 s). */
export class Jwks {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  constructor(private url: string, private fetcher: JwksFetcher, private now: () => number) {}

  private refresh() {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const doc: any = await this.fetcher(this.url);
          const next = new Map<string, KeyObject>();
          for (const jwk of Array.isArray(doc?.keys) ? doc.keys : []) {
            if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
            if (jwk.use !== undefined && jwk.use !== "sig") continue;
            if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
            try {
              const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
              if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) next.set(jwk.kid, key);
            } catch { /* skip a bad key */ }
          }
          if (next.size) this.keys = next; // a failed or empty fetch keeps the old keys
        } catch { /* keep the old keys */ }
        this.fetchedAt = this.now();
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  async get(kid: string): Promise<KeyObject | null> {
    const stale = this.now() - this.fetchedAt > JWKS_TTL_MS;
    if (stale || (!this.keys.has(kid) && this.now() - this.fetchedAt > JWKS_MIN_REFRESH_MS)) await this.refresh();
    return this.keys.get(kid) ?? null;
  }
}

export const defaultFetchJwks: JwksFetcher = async (url) => {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (res.status !== 200) throw new Error(`JWKS ${res.status}`);
  const text = await res.text();
  if (text.length > 256 * 1024) throw new Error("JWKS too large");
  return JSON.parse(text);
};

/** Verifies a Cloudflare Access application token. Returns the email, or why it was refused. */
export async function verifyAccessJwt(
  token: string, opts: { teamDomain: string; aud: string; jwks: Jwks; nowMs: number },
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  if (token.length > MAX_JWT) return { ok: false, reason: "too long" };
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return { ok: false, reason: "malformed" };
  let head: any, claims: any;
  try { head = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return { ok: false, reason: "malformed" }; }
  if (!head || typeof head !== "object" || !claims || typeof claims !== "object") return { ok: false, reason: "malformed" };
  // Only RS256: refuses alg=none and HS256 key confusion (an HMAC keyed with the public key).
  if (head.alg !== "RS256") return { ok: false, reason: "alg" };
  if (head.crit !== undefined) return { ok: false, reason: "crit" };
  if (typeof head.kid !== "string" || !head.kid || head.kid.length > 256) return { ok: false, reason: "kid" };
  const key = await opts.jwks.get(head.kid);
  if (!key) return { ok: false, reason: "unknown kid" };
  const sig = Buffer.from(parts[2], "base64url");
  let good = false;
  try { good = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, sig); } catch { good = false; }
  if (!good) return { ok: false, reason: "signature" };

  const now = Math.floor(opts.nowMs / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.some((a: unknown) => typeof a === "string" && safeEqual(a, opts.aud))) return { ok: false, reason: "aud" };
  if (claims.iss !== `https://${opts.teamDomain}`) return { ok: false, reason: "iss" };
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_SKEW_S) return { ok: false, reason: "expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + CLOCK_SKEW_S)) return { ok: false, reason: "nbf" };
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > now + CLOCK_SKEW_S)) return { ok: false, reason: "iat" };
  if (typeof claims.email !== "string" || !claims.email) return { ok: false, reason: "no email" };
  return { ok: true, email: claims.email };
}

// --- sessions ------------------------------------------------------------------------------------

type Session = { identity: Identity; expires: number };

export class Sessions {
  private map = new Map<string, Session>();
  constructor(private now: () => number) {}
  create(identity: Identity) {
    while (this.map.size >= MAX_SESSIONS) this.map.delete(this.map.keys().next().value!); // oldest first
    const id = randomBytes(32).toString("base64url");
    const expires = this.now() + SESSION_TTL_MS;
    this.map.set(id, { identity, expires });
    return { id, expires };
  }
  get(id: string | undefined): Session | null {
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const s = this.map.get(id);
    if (!s) return null;
    if (s.expires <= this.now()) { this.map.delete(id); return null; }
    return s;
  }
  delete(id: string | undefined) { if (id) this.map.delete(id); }
  get size() { return this.map.size; }
}

const sameIdentity = (a: Identity, b: Identity) =>
  a.kind === b.kind && (a.kind === "tailscale" ? a.login === (b as any).login : a.kind === "cloudflare" ? a.email === (b as any).email : true);

// --- the access object ----------------------------------------------------------------------------

export type PathKind = "api" | "term" | "screen" | "static";

export function pathKind(p: string): PathKind {
  const l = p.toLowerCase();
  if (l === "/api" || l.startsWith("/api/")) return "api";
  if (l === "/term" || l.startsWith("/term/")) return "term";
  if (l === "/screen" || l.startsWith("/screen/")) return "screen";
  return "static";
}

export type Access = ReturnType<typeof createAccess>;

export function createAccess(opts: AccessOptions = {}) {
  const cfg = opts.config ?? getAccessConfig();
  const now = opts.now ?? Date.now;
  const problem = configProblem(cfg);
  const mode: AccessMode = cfg.access;
  const host = publicHost(cfg);
  const secure = mode !== "ssh-tunnel";
  const cookieName = SECURE_COOKIE;
  const sessions = new Sessions(now);
  const teamDomain = normalizeTeamDomain(cfg.cloudflare.team_domain);
  const jwks = mode === "cloudflare" && teamDomain
    ? new Jwks(`https://${teamDomain}/cdn-cgi/access/certs`, opts.fetchJwks ?? defaultFetchJwks, now)
    : null;

  let localToken: string | null = null;
  if (opts.localTokenFile) {
    localToken = randomBytes(32).toString("base64url");
    fs.mkdirSync(path.dirname(opts.localTokenFile), { recursive: true });
    const tmp = `${opts.localTokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, localToken + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, opts.localTokenFile);
  }

  const cookie = (id: string, maxAgeS: number) =>
    `${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;

  /** Host, Origin and body-type checks shared by every mode. */
  function hostOriginBody(req: RequestLike, kind: PathKind, allowLoopbackHost: boolean): { code: number; error: string } | null {
    const h = String(header(req.headers, "host") ?? "").toLowerCase();
    const loopbackHost = LOOPBACK_NAME.test(h);
    const remoteHostOk = host !== null && (h === host || h === `${host}:443`);
    if (!(remoteHostOk || (allowLoopbackHost && loopbackHost))) {
      return { code: 403, error: host ? `Open agentbox at https://${host}` : "Open agentbox on localhost" };
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (typeof origin !== "string") return { code: 403, error: "Cross-origin request refused" };
      let u: URL | null = null;
      try { u = new URL(origin); } catch { /* malformed, "null" */ }
      const ok = !!u && (
        remoteHostOk
          ? u.protocol === "https:" && u.host.toLowerCase() === host
          // Exactly the portal's own origin: another localhost port (a dev server) is another site.
          : (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_NAME.test(u.host) && u.host.toLowerCase() === h);
      if (!ok) return { code: 403, error: "Cross-origin request refused" };
    }
    if (kind !== "static") {
      // Audit M1: browsers send no Origin on <img>/<script> GETs, but they do send Sec-Fetch-Site.
      const site = header(req.headers, "sec-fetch-site");
      if (req.headers["sec-fetch-site"] !== undefined && (site === undefined || site === "cross-site" || site === "same-site")) {
        return { code: 403, error: "Cross-site request refused" };
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const len = Number(header(req.headers, "content-length") ?? 0);
      const hasBody = len > 0 || req.headers["transfer-encoding"] !== undefined;
      if (hasBody && !/^application\/json(\s*;|$)/i.test(String(header(req.headers, "content-type") ?? ""))) {
        return { code: 415, error: "Send JSON" };
      }
    }
    return null;
  }

  function localTokenOk(req: RequestLike) {
    const t = header(req.headers, LOCAL_TOKEN_HEADER);
    return !!localToken && typeof t === "string" && isLoopbackPeer(req.remoteAddress)
      && LOOPBACK_NAME.test(String(header(req.headers, "host") ?? "")) && safeEqual(t, localToken);
  }

  /** The identity the access path vouches for: undefined = none presented, null = presented but refused. */
  async function presentedIdentity(req: RequestLike): Promise<Identity | null | undefined> {
    if (mode === "tailscale") {
      const raw = req.headers["tailscale-user-login"];
      if (raw === undefined) return undefined;
      // tailscale serve replaces any client-sent Tailscale-* headers; only trust it via serve (loopback).
      if (typeof raw !== "string" || !isLoopbackPeer(req.remoteAddress)) return null;
      const login = raw.trim().toLowerCase();
      if (!login || login !== cfg.owner.tailscale_login.trim().toLowerCase()) return null;
      return { kind: "tailscale", login };
    }
    if (mode === "cloudflare") {
      const raw = req.headers["cf-access-jwt-assertion"];
      if (raw === undefined) return undefined;
      if (typeof raw !== "string" || !jwks || !isLoopbackPeer(req.remoteAddress)) return null;
      const r = await verifyAccessJwt(raw, { teamDomain, aud: cfg.cloudflare.aud, jwks, nowMs: now() });
      if (!r.ok) return null;
      const email = r.email.trim().toLowerCase();
      if (email !== cfg.owner.email.trim().toLowerCase()) return null;
      return { kind: "cloudflare", email };
    }
    return undefined;
  }

  /** The decision for one request. `path` is the raw path without the query. */
  async function authorize(req: RequestLike, kind: PathKind): Promise<Decision> {
    if (mode === "ssh-tunnel") {
      if (problem) return { ok: false, code: 503, error: `Access is misconfigured: ${problem}` };
      if (kind === "static") return { ok: true, identity: null }; // as today: the UI bundle isn't guarded
      const bad = hostOriginBody(req, kind, true);
      return bad ? { ok: false, ...bad } : { ok: true, identity: { kind: "local" } };
    }
    // Remote modes. Local tools first: loopback peer, loopback Host, and the token.
    if (localTokenOk(req)) {
      const bad = hostOriginBody(req, kind, true);
      return bad ? { ok: false, ...bad } : { ok: true, identity: { kind: "local" } };
    }
    if (problem) return { ok: false, code: 503, error: `Access is misconfigured: ${problem}` };
    const bad = hostOriginBody(req, kind, false);
    if (bad) return { ok: false, ...bad };

    const sid = parseCookies(header(req.headers, "cookie")).get(cookieName);
    const session = sessions.get(sid);
    const presented = await presentedIdentity(req);
    if (presented === null) {
      sessions.delete(sid); // a refused identity also ends the session it came with
      return { ok: false, code: 401, error: "Not signed in as the owner" };
    }
    if (session) {
      if (presented && !sameIdentity(presented, session.identity)) {
        sessions.delete(sid);
        return { ok: false, code: 401, error: "Not signed in as the owner" };
      }
      return { ok: true, identity: session.identity };
    }
    if (!presented) return { ok: false, code: 401, error: "Sign in first" };
    const s = sessions.create(presented);
    return { ok: true, identity: presented, setCookie: cookie(s.id, Math.floor(SESSION_TTL_MS / 1000)) };
  }

  function logout(req: RequestLike) {
    sessions.delete(parseCookies(header(req.headers, "cookie")).get(cookieName));
    return {
      setCookie: secure ? cookie("", 0) : undefined,
      logout_url: mode === "cloudflare" && teamDomain ? `https://${teamDomain}/cdn-cgi/access/logout` : null,
    };
  }

  const readSecretLine = (file: string | undefined) => {
    if (!file) return null;
    try { return fs.readFileSync(file, "utf8").split("\n")[0].trim() || null; } catch { return null; }
  };

  return {
    mode, host, problem, sessions, authorize, logout,
    localToken: () => localToken,
    ports: cfg.ports,
    upstreamHost: opts.upstreamHost ?? "127.0.0.1",
    ttydCredential: () => readSecretLine(opts.ttydCredentialFile),
    vncPassword: () => readSecretLine(opts.vncPasswordFile),
  };
}

export const requestLike = (req: FastifyRequest): RequestLike => ({
  method: req.method, url: req.url, headers: req.headers, remoteAddress: req.socket?.remoteAddress ?? req.raw.socket?.remoteAddress,
});

declare module "fastify" {
  interface FastifyRequest { portalAuth?: Decision & { ok: true } }
}

// --- routes: auth, screen credential, /term and /screen proxies ----------------------------------

const FORWARD_REQ = ["accept", "accept-encoding", "accept-language", "user-agent", "if-none-match", "if-modified-since", "range", "cache-control", "pragma"];
const DROP_RES = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie", "server", "x-powered-by"]);
const SAFE_SUBPATH = /^\/[A-Za-z0-9._~\/-]*$/;

/** /term/x → /x for ttyd; /screen/x → /x for websockify. null when the path isn't one we forward. */
export function upstreamPath(url: string, prefix: "/term" | "/screen") {
  const q = url.indexOf("?");
  const p = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q);
  if (!p.startsWith(prefix + "/")) return null;
  const rest = p.slice(prefix.length);
  if (!SAFE_SUBPATH.test(rest) || rest.includes("//") || rest.split("/").some((s) => s === "." || s === "..")) return null;
  if (query.length > 4096 || /[\s\0]/.test(query)) return null;
  return rest + query;
}

export function registerAccessRoutes(app: FastifyInstance, access: Access) {
  app.get("/api/auth/me", async (req) => ({
    mode: access.mode, host: access.host, identity: req.portalAuth?.identity ?? null,
  }));
  app.post("/api/auth/logout", async (req, reply) => {
    const r = access.logout(requestLike(req));
    if (r.setCookie) reply.header("set-cookie", r.setCookie);
    return { ok: true, logout_url: r.logout_url };
  });
  // The VNC password for noVNC (x11vnc -passwdfile). Portal-only: never reachable via the gateway.
  app.get("/api/screen/credential", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return { password: access.vncPassword() };
  });

  const target = (which: "term" | "screen") => (which === "term" ? access.ports.terminal : access.ports.screen);
  const upstreamHeaders = (req: FastifyRequest, which: "term" | "screen") => {
    const out: Record<string, string> = {};
    for (const k of FORWARD_REQ) {
      const v = req.headers[k];
      if (typeof v === "string") out[k] = v;
    }
    out.host = `${access.upstreamHost}:${target(which)}`;
    if (which === "term") {
      const cred = access.ttydCredential();
      if (cred) out.authorization = `Basic ${Buffer.from(cred).toString("base64")}`;
    }
    return out;
  };

  const proxyHttp = (which: "term" | "screen") => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.portalAuth) return reply.code(403).send({ error: "Not allowed" }); // the guard always runs first
    const up = upstreamPath(req.url, which === "term" ? "/term" : "/screen");
    if (up === null) return reply.code(404).send();
    reply.hijack();
    const res = reply.raw;
    const upReq = http.request({
      host: access.upstreamHost, port: target(which), method: req.method, path: up, headers: upstreamHeaders(req, which),
      timeout: 15_000,
    }, (upRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !DROP_RES.has(k)) headers[k] = v;
      headers["cache-control"] = "no-store";
      headers["x-frame-options"] = "SAMEORIGIN";
      headers["x-content-type-options"] = "nosniff";
      headers["referrer-policy"] = "no-referrer";
      res.writeHead(upRes.statusCode ?? 502, headers);
      upRes.pipe(res);
    });
    upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
    upReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(res.headersSent ? undefined : JSON.stringify({ error: `The ${which === "term" ? "terminal" : "screen"} isn't running` }));
    });
    req.raw.on("aborted", () => upReq.destroy());
    upReq.end();
  };

  const proxyWs = (which: "term" | "screen") => (client: WebSocket, req: FastifyRequest) => {
    const up = upstreamPath(req.url, which === "term" ? "/term" : "/screen");
    if (!req.portalAuth || up === null) return client.close(1008, "not allowed");
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const headers = upstreamHeaders(req, which);
    delete headers.host; // ws sets it from the URL
    // ttyd -O compares Origin with Host: the proxy speaks as the upstream's own origin, after
    // authorize() has checked the browser's Origin against the portal's.
    headers.origin = `http://${access.upstreamHost}:${target(which)}`;
    const upstream = new WebSocket(`ws://${access.upstreamHost}:${target(which)}${up}`, protocols, {
      headers, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 10_000,
    });
    const queue: [WebSocket.RawData, boolean][] = [];
    let queued = 0;
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) return upstream.send(data, { binary: isBinary });
      queued += (data as Buffer).length ?? 0;
      if (queued > 1024 * 1024) return client.close(1009, "too much before upstream opened");
      queue.push([data, isBinary]);
    });
    upstream.on("open", () => { for (const [d, b] of queue.splice(0)) upstream.send(d, { binary: b }); });
    upstream.on("message", (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
    const closeCode = (c: number) => (c >= 1000 && c < 5000 && c !== 1004 && c !== 1005 && c !== 1006 && c !== 1015 ? c : 1011);
    upstream.on("close", (code, reason) => { if (client.readyState <= WebSocket.OPEN) client.close(closeCode(code), reason.subarray(0, 120)); });
    upstream.on("error", () => { if (client.readyState <= WebSocket.OPEN) client.close(1011, "upstream unavailable"); });
    upstream.on("unexpected-response", () => { upstream.terminate(); if (client.readyState <= WebSocket.OPEN) client.close(1011, "upstream refused"); });
    client.on("close", () => { if (upstream.readyState <= WebSocket.OPEN) upstream.terminate(); });
    client.on("error", () => upstream.terminate());
  };

  for (const which of ["term", "screen"] as const) {
    app.get(`/${which}`, async (_req, reply) => reply.redirect(`/${which}/`, 302));
    app.route({ method: "GET", url: `/${which}/*`, handler: proxyHttp(which), wsHandler: proxyWs(which) } as any);
  }
}
