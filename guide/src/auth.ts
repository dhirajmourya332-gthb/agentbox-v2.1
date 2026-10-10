import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Who may use the guide (docs/GUIDE.md › Security).
 *
 * The guide listens on 127.0.0.1 only and hands out a shell, so every request needs one of:
 *
 * 1. **A guide session** (direct, e.g. through the Lima forward or an SSM / IAP / SSH port forward):
 *    `agentbox guide` (root or the agent user, i.e. someone who already has a shell on the VM) mints
 *    a one-time token and prints `http://127.0.0.1:<port>/?t=<token>`. The token's SHA-256 is a file
 *    in `<data>/guide/tokens/` holding its expiry; the guide consumes it (deletes the file) and sets
 *    an HttpOnly, SameSite=Strict session cookie. Host must be a loopback name (DNS rebinding),
 *    Origin, when sent, must be exactly the guide's own origin, and `Sec-Fetch-Site: cross-site` /
 *    `same-site` is refused (another localhost port is "same-site").
 *
 * 2. **The portal** (after the access module is set up): the portal serves the guide under
 *    `/setup/` behind its own login (createAccess in server/src/access.ts: Tailscale identity or the
 *    Cloudflare Access JWT, Host/Origin checks, session) and forwards to the guide with
 *    `X-Agentbox-Guide-Proxy: <secret>`. The guide writes the secret to `<data>/guide/proxy-token`
 *    (0600, the agent user's) at start and deletes it at stop, so the portal's proxy is dead while
 *    the guide isn't running. The guide trusts that header only from a loopback peer.
 */

export const COOKIE = "agentbox_guide";
export const PROXY_HEADER = "x-agentbox-guide-proxy";
export const TOKEN_TTL_MS = 30 * 60_000;
export const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_SESSIONS = 32;

export type Req = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string | undefined;
};

const LOOPBACK_NAME = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const LOOPBACK_PEER = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLoopbackPeer = (a: string | undefined) => !!a && LOOPBACK_PEER.has(a);

const one = (h: Req["headers"], k: string) => { const v = h[k]; return Array.isArray(v) ? undefined : v; };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function parseCookies(h: string | undefined) {
  const out = new Map<string, string>();
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { const k = part.slice(0, i).trim(); if (!out.has(k)) out.set(k, part.slice(i + 1).trim()); }
  }
  return out;
}

/** Mint a one-time token (what agentbox-guide.sh does in bash; used by tests and `token` below). */
export function mintToken(dir: string, now = Date.now(), ttlMs = TOKEN_TTL_MS) {
  const token = randomBytes(32).toString("base64url");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, sha256(token)), String(Math.floor((now + ttlMs) / 1000)), { mode: 0o600 });
  return token;
}

export type Decision = { ok: true; via: "session" | "proxy"; setCookie?: string } | { ok: false; code: number; error: string };

export function createGuideAuth(opts: { tokensDir: string; proxyTokenFile: string; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, number>(); // id → expiry
  let proxySecret: string | null = null;

  /** Exchange a one-time token for a session. The token file is deleted whatever happens next. */
  function consumeToken(token: string): boolean {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return false;
    const file = path.join(opts.tokensDir, sha256(token));
    let exp: number;
    try { exp = Number(fs.readFileSync(file, "utf8").trim()); } catch { return false; }
    try { fs.rmSync(file, { force: true }); } catch { /* still one-time below */ }
    if (fs.existsSync(file)) return false; // couldn't delete: refuse rather than allow reuse
    return Number.isFinite(exp) && exp * 1000 > now();
  }

  function newSession() {
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, now() + SESSION_TTL_MS);
    return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }

  function sessionOk(req: Req) {
    const id = parseCookies(one(req.headers, "cookie")).get(COOKIE);
    if (!id) return false;
    const exp = sessions.get(id);
    if (!exp) return false;
    if (exp <= now()) { sessions.delete(id); return false; }
    return true;
  }

  function proxyOk(req: Req) {
    const v = one(req.headers, PROXY_HEADER);
    return !!proxySecret && typeof v === "string" && isLoopbackPeer(req.remoteAddress) && safeEqual(v, proxySecret);
  }

  /** Host / Origin / Sec-Fetch-Site / JSON-body checks for direct requests. */
  function direct(req: Req, api: boolean): { code: number; error: string } | null {
    if (!isLoopbackPeer(req.remoteAddress)) return { code: 403, error: "loopback only" };
    const host = String(one(req.headers, "host") ?? "").toLowerCase();
    if (!LOOPBACK_NAME.test(host)) return { code: 403, error: "Open the guide on localhost (agentbox guide prints the link)" };
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let u: URL | null = null;
      try { u = typeof origin === "string" ? new URL(origin) : null; } catch { /* "null", malformed */ }
      if (!u || !(u.protocol === "http:" || u.protocol === "https:") || u.host.toLowerCase() !== host) {
        return { code: 403, error: "Cross-origin request refused" };
      }
    }
    if (api && req.headers["sec-fetch-site"] !== undefined) {
      const site = one(req.headers, "sec-fetch-site");
      if (site === undefined || site === "cross-site" || site === "same-site") return { code: 403, error: "Cross-site request refused" };
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const len = Number(one(req.headers, "content-length") ?? 0);
      const hasBody = len > 0 || req.headers["transfer-encoding"] !== undefined;
      if (hasBody && !/^application\/json(\s*;|$)/i.test(String(one(req.headers, "content-type") ?? ""))) {
        return { code: 415, error: "Send JSON" };
      }
    }
    return null;
  }

  /**
   * The decision for one request. `token` is the `?t=` value on a page load (only honoured on GET
   * of the page itself); `api` marks /api, /ws and other non-page requests.
   */
  function authorize(req: Req, o: { api: boolean; token?: string }): Decision {
    if (proxyOk(req)) return { ok: true, via: "proxy" }; // the portal did Host/Origin/identity
    const bad = direct(req, o.api);
    if (bad) return { ok: false, ...bad };
    if (sessionOk(req)) return { ok: true, via: "session" };
    if (o.token !== undefined && req.method === "GET" && !o.api) {
      if (consumeToken(o.token)) return { ok: true, via: "session", setCookie: newSession() };
      return { ok: false, code: 401, error: "This link was already used or has expired. Run `agentbox guide` for a new one." };
    }
    return { ok: false, code: 401, error: "Open the link printed by `agentbox guide` (it carries a one-time token)." };
  }

  /** Write the portal-proxy secret (start). */
  function enableProxy() {
    proxySecret = randomBytes(32).toString("base64url");
    fs.mkdirSync(path.dirname(opts.proxyTokenFile), { recursive: true, mode: 0o700 });
    const tmp = `${opts.proxyTokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, proxySecret + "\n", { mode: 0o600 });
    fs.renameSync(tmp, opts.proxyTokenFile);
  }

  /** Finish / stop: every session, unused token and the proxy secret stop working. */
  function revokeAll() {
    sessions.clear();
    proxySecret = null;
    try { fs.rmSync(opts.proxyTokenFile, { force: true }); } catch { /* best effort */ }
    try {
      for (const f of fs.readdirSync(opts.tokensDir)) fs.rmSync(path.join(opts.tokensDir, f), { force: true });
    } catch { /* none */ }
  }

  return { authorize, enableProxy, revokeAll, sessions, consumeToken };
}

export type GuideAuth = ReturnType<typeof createGuideAuth>;
