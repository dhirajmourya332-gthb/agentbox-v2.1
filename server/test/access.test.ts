/**
 * Portal auth (server/src/access.ts, docs/ACCESS.md). In-process: an app wired like index.ts with
 * stub /api routes, a fake ttyd / websockify upstream, and a locally generated RSA key behind a
 * mocked Cloudflare JWKS. Nothing touches a real VM, Tailscale or Cloudflare.
 *
 *   cd server && node --import tsx --test test/access.test.ts
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket, { WebSocketServer } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-access-"));
process.env.AGENTBOX_DATA = path.join(tmp, "data"); // devices.ts opens a DB on import
const { createAccess, registerAccessRoutes, verifyAccessJwt, Jwks, upstreamPath, SESSION_TTL_MS, LOCAL_TOKEN_HEADER } = await import("../src/access.ts");
const { guardApi, registerDeviceAdmin } = await import("../src/mobile.ts");
const { DEFAULT_ACCESS_CONFIG, toAccessConfig } = await import("../src/access-config.ts");
type AccessConfig = import("../src/access-config.ts").AccessConfig;
type AccessOptions = import("../src/access.ts").AccessOptions;

const TS_HOST = "box-7k2q.tail1234.ts.net";
const CF_HOST = "agentbox.example.com";
const TEAM = "acme.cloudflareaccess.com";
const AUD = "a".repeat(32) + "b".repeat(32);
const OWNER_LOGIN = "owner@example.com";
const OWNER_EMAIL = "owner@example.com";

// --- a fake ttyd / websockify --------------------------------------------------------------------

type Seen = { url: string; headers: http.IncomingHttpHeaders };
function fakeUpstream() {
  const http_: Seen[] = [], ws_: Seen[] = [];
  const server = http.createServer((req, res) => {
    http_.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "evil=1; Path=/" });
    res.end(`upstream ${req.url}`);
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("tty") ? "tty" : p.has("binary") ? "binary" : false) });
  server.on("upgrade", (req, socket, head) => {
    ws_.push({ url: req.url ?? "", headers: req.headers });
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (d, bin) => ws.send(d, { binary: bin })));
  });
  return { server, http: http_, ws: ws_ };
}

// --- the app under test --------------------------------------------------------------------------

async function makeApp(cfg: AccessConfig, opts: Partial<AccessOptions> = {}) {
  const access = createAccess({ config: cfg, ...opts });
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  guardApi(app, access);
  registerAccessRoutes(app, access);
  app.get("/api/state", async () => ({ ok: true }));
  app.post("/api/pause", async () => ({ paused: true }));
  app.get("/api/events", { websocket: true }, (socket) => { socket.send("hello"); });
  app.get("/", async () => "<html>portal</html>");
  registerDeviceAdmin(app, 1); // a closed port: nothing here asks the gateway
  return { app, access };
}

const tsConfig = (over: Partial<AccessConfig> = {}): AccessConfig => ({
  ...DEFAULT_ACCESS_CONFIG, access: "tailscale", tailscale: { hostname: TS_HOST },
  owner: { tailscale_login: OWNER_LOGIN, email: "" }, ...over,
});
const cfConfig = (over: Partial<AccessConfig> = {}): AccessConfig => ({
  ...DEFAULT_ACCESS_CONFIG, access: "cloudflare", cloudflare: { hostname: CF_HOST, team_domain: TEAM, aud: AUD },
  owner: { tailscale_login: "", email: OWNER_EMAIL }, ...over,
});

const cookieOf = (r: { headers: Record<string, any> }) => {
  const sc = r.headers["set-cookie"];
  const v = Array.isArray(sc) ? sc[0] : sc;
  return v ? String(v).split(";")[0] : "";
};

// --- RSA keys and JWTs --------------------------------------------------------------------------

const keyA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyB = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (pub: KeyObject, kid: string) => ({ ...pub.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);
function jwt(claims: Record<string, unknown> = {}, opt: { key?: KeyObject; kid?: string; head?: Record<string, unknown> } = {}) {
  const head = { alg: "RS256", kid: opt.kid ?? "kid-a", typ: "JWT", ...opt.head };
  const body = { aud: [AUD], email: OWNER_EMAIL, iss: `https://${TEAM}`, iat: nowS(), nbf: nowS(), exp: nowS() + 3600, type: "app", ...claims };
  const data = `${b64(head)}.${b64(body)}`;
  return `${data}.${cryptoSign("RSA-SHA256", Buffer.from(data), opt.key ?? keyA.privateKey).toString("base64url")}`;
}
function jwksFetcher(sets: unknown[][]) {
  let i = 0;
  const calls: string[] = [];
  const f = async (url: string) => { calls.push(url); return { keys: sets[Math.min(i++, sets.length - 1)] }; };
  return Object.assign(f, { calls });
}

// =================================================================================================

describe("ssh-tunnel mode (unchanged: localhost only)", () => {
  let app: FastifyInstance;
  before(async () => { ({ app } = await makeApp(DEFAULT_ACCESS_CONFIG)); });
  after(() => app.close());
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { host: "localhost:7700", ...headers } });

  test("Host must be loopback; Origin must be the portal's own", async () => {
    assert.equal((await get("/api/state")).statusCode, 200);
    assert.equal((await get("/api/state", { host: "127.0.0.1:7700" })).statusCode, 200);
    assert.equal((await get("/api/state", { host: "evil.example:7700" })).statusCode, 403);
    assert.equal((await get("/api/state", { origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await get("/api/state", { origin: "http://localhost:5173" })).statusCode, 403);
    assert.equal((await get("/api/state", { origin: "null" })).statusCode, 403);
    assert.equal((await get("/api/state", { origin: "http://localhost:7700" })).statusCode, 200);
  });
  test("JSON writes; bodyless POST works; forged gateway marker 404; percent-encoded API path 404", async () => {
    const t = await app.inject({ method: "POST", url: "/api/pause", headers: { host: "localhost", "content-type": "text/plain" }, payload: "{}" });
    assert.equal(t.statusCode, 415);
    assert.equal((await app.inject({ method: "POST", url: "/api/pause", headers: { host: "localhost" } })).statusCode, 200);
    const j = await app.inject({ method: "POST", url: "/api/pause", headers: { host: "localhost", "content-type": "application/json" }, payload: "{}" });
    assert.equal(j.statusCode, 200);
    assert.equal((await get("/api/state", { "x-agentbox-gateway": "1" })).statusCode, 404);
    assert.equal((await get("/%61pi/state")).statusCode, 404);
  });
  test("the static UI isn't guarded; no session cookie is issued", async () => {
    const r = await get("/", { host: "evil.example" });
    assert.notEqual(r.statusCode, 403);
    assert.equal((await get("/api/state")).headers["set-cookie"], undefined);
  });
  test("Sec-Fetch-Site cross-site / same-site refused on /api (audit M1)", async () => {
    assert.equal((await get("/api/state", { "sec-fetch-site": "cross-site" })).statusCode, 403);
    assert.equal((await get("/api/state", { "sec-fetch-site": "same-site" })).statusCode, 403);
    assert.equal((await get("/api/state", { "sec-fetch-site": "same-origin" })).statusCode, 200);
    assert.equal((await get("/api/state", { "sec-fetch-site": "none" })).statusCode, 200);
  });
  test("device admin still needs the guard and JSON on every write", async () => {
    assert.equal((await get("/api/devices")).statusCode, 200);
    assert.equal((await get("/api/devices", { host: "evil.example" })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices/revoke-all", headers: { host: "localhost" } })).statusCode, 415);
  });
});

// =================================================================================================

describe("tailscale mode", () => {
  let app: FastifyInstance;
  let clock = Date.now();
  let tokenFile = path.join(tmp, "ts-local-token");
  before(async () => { ({ app } = await makeApp(tsConfig(), { now: () => clock, localTokenFile: tokenFile })); });
  after(() => app.close());
  const owner = { host: TS_HOST, "tailscale-user-login": OWNER_LOGIN };
  const get = (url: string, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") =>
    app.inject({ method: "GET", url, headers, remoteAddress });

  test("the owner's header via serve (loopback) is accepted and gets a session cookie", async () => {
    const r = await get("/api/state", owner);
    assert.equal(r.statusCode, 200);
    const sc = String(r.headers["set-cookie"]);
    assert.match(sc, /^__Host-agentbox_session=[A-Za-z0-9_-]{43};/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_TTL_MS / 1000}`]) assert.ok(sc.includes(flag), flag);
    assert.ok(!/Domain=/i.test(sc));
  });
  test("login matching is case-insensitive but exact", async () => {
    assert.equal((await get("/api/state", { ...owner, "tailscale-user-login": "Owner@Example.com" })).statusCode, 200);
    assert.equal((await get("/api/state", { ...owner, "tailscale-user-login": "owner@example.com.evil" })).statusCode, 401);
  });
  test("another tailnet user is refused", async () => {
    assert.equal((await get("/api/state", { ...owner, "tailscale-user-login": "mallory@example.com" })).statusCode, 401);
  });
  test("the header with the wrong Host is refused (localhost, another name, none)", async () => {
    assert.equal((await get("/api/state", { ...owner, host: "localhost:7700" })).statusCode, 403);
    assert.equal((await get("/api/state", { ...owner, host: "evil.example" })).statusCode, 403);
    assert.equal((await get("/api/state", { ...owner, host: `x.${TS_HOST}` })).statusCode, 403);
    assert.equal((await get("/api/state", { ...owner, host: `${TS_HOST}:443` })).statusCode, 200);
  });
  test("the header is only trusted from a loopback peer", async () => {
    assert.equal((await get("/api/state", owner, "100.64.0.9")).statusCode, 401);
  });
  test("no identity, no session: 401 on /api and on the static UI", async () => {
    assert.equal((await get("/api/state", { host: TS_HOST })).statusCode, 401);
    assert.equal((await get("/", { host: TS_HOST })).statusCode, 401);
    assert.equal((await get("/", owner)).statusCode, 200);
  });
  test("Origin must be https://<ts name>", async () => {
    assert.equal((await get("/api/state", { ...owner, origin: `https://${TS_HOST}` })).statusCode, 200);
    assert.equal((await get("/api/state", { ...owner, origin: `http://${TS_HOST}` })).statusCode, 403);
    assert.equal((await get("/api/state", { ...owner, origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await get("/api/state", { ...owner, origin: "null" })).statusCode, 403);
  });
  test("Sec-Fetch-Site cross-site / same-site refused; a cross-site navigation to the UI is fine", async () => {
    assert.equal((await get("/api/state", { ...owner, "sec-fetch-site": "cross-site" })).statusCode, 403);
    assert.equal((await get("/api/state", { ...owner, "sec-fetch-site": "same-site" })).statusCode, 403);
    assert.equal((await get("/api/state", { ...owner, "sec-fetch-site": "same-origin" })).statusCode, 200);
    assert.equal((await get("/", { ...owner, "sec-fetch-site": "cross-site" })).statusCode, 200);
  });
  test("JSON writes are still enforced", async () => {
    const r = await app.inject({ method: "POST", url: "/api/pause", headers: { ...owner, "content-type": "text/plain" }, payload: "{}", remoteAddress: "127.0.0.1" });
    assert.equal(r.statusCode, 415);
  });
  test("sessions: the cookie alone works; it expires after 8 h; a different identity ends it", async () => {
    const c = cookieOf(await get("/api/state", owner));
    assert.equal((await get("/api/state", { host: TS_HOST, cookie: c })).statusCode, 200);
    assert.equal((await get("/api/state", { host: TS_HOST, cookie: "__Host-agentbox_session=" + "x".repeat(43) })).statusCode, 401);
    // A non-owner presenting the owner's cookie: refused, and the session is gone.
    assert.equal((await get("/api/state", { host: TS_HOST, cookie: c, "tailscale-user-login": "mallory@example.com" })).statusCode, 401);
    assert.equal((await get("/api/state", { host: TS_HOST, cookie: c })).statusCode, 401);
    const c2 = cookieOf(await get("/api/state", owner));
    clock += SESSION_TTL_MS + 1;
    assert.equal((await get("/api/state", { host: TS_HOST, cookie: c2 })).statusCode, 401);
    clock = Date.now();
  });
  test("logout clears the cookie and ends the session", async () => {
    const c = cookieOf(await get("/api/state", owner));
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { host: TS_HOST, cookie: c }, remoteAddress: "127.0.0.1" });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["set-cookie"]), /^__Host-agentbox_session=; .*Max-Age=0/);
    assert.equal((await get("/api/state", { host: TS_HOST, cookie: c })).statusCode, 401);
  });
  test("auth/me reports the identity", async () => {
    const r = await get("/api/auth/me", owner);
    assert.deepEqual(r.json(), { mode: "tailscale", host: TS_HOST, identity: { kind: "tailscale", login: OWNER_LOGIN } });
  });
  test("local token: 0600 file; only with a loopback Host and loopback peer", async () => {
    const st = fs.statSync(tokenFile);
    assert.equal(st.mode & 0o777, 0o600);
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    assert.equal((await get("/api/state", { host: "localhost:7700", [LOCAL_TOKEN_HEADER]: token })).statusCode, 200);
    assert.equal((await get("/api/devices", { host: "localhost:7700", [LOCAL_TOKEN_HEADER]: token })).statusCode, 200);
    assert.equal((await get("/api/state", { host: "localhost:7700", [LOCAL_TOKEN_HEADER]: token + "x" })).statusCode, 403);
    assert.equal((await get("/api/state", { host: "localhost:7700", [LOCAL_TOKEN_HEADER]: token }, "100.64.0.9")).statusCode, 403);
    assert.equal((await get("/api/state", { host: TS_HOST, [LOCAL_TOKEN_HEADER]: token })).statusCode, 401);
    assert.equal((await get("/api/state", { host: "localhost:7700", [LOCAL_TOKEN_HEADER]: token, origin: "https://evil.example" })).statusCode, 403);
  });
  test("a misconfigured remote mode fails closed (503)", async () => {
    const { app: bad } = await makeApp(tsConfig({ owner: { tailscale_login: "", email: "" } }));
    assert.equal((await bad.inject({ method: "GET", url: "/api/state", headers: owner, remoteAddress: "127.0.0.1" })).statusCode, 503);
    assert.equal((await bad.inject({ method: "GET", url: "/", headers: owner, remoteAddress: "127.0.0.1" })).statusCode, 503);
    await bad.close();
    const { app: unknown } = await makeApp({ ...DEFAULT_ACCESS_CONFIG, access: "funnel" as any });
    assert.equal((await unknown.inject({ method: "GET", url: "/api/state", headers: { host: "localhost" } })).statusCode, 503);
    await unknown.close();
  });
});

// =================================================================================================

describe("cloudflare mode: Access JWT", () => {
  let app: FastifyInstance;
  const fetcher = jwksFetcher([[jwkOf(keyA.publicKey, "kid-a")]]);
  before(async () => { ({ app } = await makeApp(cfConfig(), { fetchJwks: fetcher })); });
  after(() => app.close());
  const get = (token: string | undefined, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: "/api/state", remoteAddress: "127.0.0.1",
      headers: { host: CF_HOST, ...(token === undefined ? {} : { "cf-access-jwt-assertion": token }), ...headers } });

  test("a valid token passes and the JWKS URL is the team's certs endpoint", async () => {
    const r = await get(jwt());
    assert.equal(r.statusCode, 200, r.body);
    assert.match(String(r.headers["set-cookie"]), /^__Host-agentbox_session=/);
    assert.equal(fetcher.calls[0], `https://${TEAM}/cdn-cgi/access/certs`);
  });
  test("aud as a plain string also works", async () => {
    assert.equal((await get(jwt({ aud: AUD }))).statusCode, 200);
  });
  test("wrong aud fails", async () => { assert.equal((await get(jwt({ aud: ["c".repeat(64)] }))).statusCode, 401); });
  test("expired fails (beyond the skew)", async () => { assert.equal((await get(jwt({ exp: nowS() - 120 }))).statusCode, 401); });
  test("missing exp fails", async () => { assert.equal((await get(jwt({ exp: undefined }))).statusCode, 401); });
  test("nbf / iat in the future fail", async () => {
    assert.equal((await get(jwt({ nbf: nowS() + 600 }))).statusCode, 401);
    assert.equal((await get(jwt({ iat: nowS() + 600 }))).statusCode, 401);
  });
  test("wrong issuer fails", async () => { assert.equal((await get(jwt({ iss: "https://evil.cloudflareaccess.com" }))).statusCode, 401); });
  test("bad signature fails (signed by another key, or tampered)", async () => {
    assert.equal((await get(jwt({}, { key: keyB.privateKey }))).statusCode, 401);
    const [h, , s] = jwt().split(".");
    assert.equal((await get(`${h}.${b64({ aud: [AUD], email: OWNER_EMAIL, iss: `https://${TEAM}`, exp: nowS() + 3600 })}.${s}`)).statusCode, 401);
  });
  test("wrong email fails", async () => { assert.equal((await get(jwt({ email: "mallory@example.com" }))).statusCode, 401); });
  test("alg=none fails", async () => {
    const t = `${b64({ alg: "none", kid: "kid-a" })}.${b64({ aud: [AUD], email: OWNER_EMAIL, iss: `https://${TEAM}`, exp: nowS() + 3600 })}.`;
    assert.equal((await get(t)).statusCode, 401);
    assert.equal((await get(t + "AAAA")).statusCode, 401);
  });
  test("HS256 key confusion (HMAC keyed with the public key) fails", async () => {
    const head = b64({ alg: "HS256", kid: "kid-a", typ: "JWT" });
    const body = b64({ aud: [AUD], email: OWNER_EMAIL, iss: `https://${TEAM}`, exp: nowS() + 3600 });
    for (const secret of [keyA.publicKey.export({ type: "spki", format: "pem" }), JSON.stringify(jwkOf(keyA.publicKey, "kid-a"))]) {
      const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
      assert.equal((await get(`${head}.${body}.${sig}`)).statusCode, 401);
    }
  });
  test("garbage, a repeated header, and no token at all are refused", async () => {
    assert.equal((await get("not-a-jwt")).statusCode, 401);
    assert.equal((await get(undefined)).statusCode, 401);
    assert.equal((await get("a.b.c".repeat(3000))).statusCode, 401);
  });
  test("the JWT is only trusted from a loopback peer (cloudflared)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/state", remoteAddress: "203.0.113.5", headers: { host: CF_HOST, "cf-access-jwt-assertion": jwt() } });
    assert.equal(r.statusCode, 401);
  });
  test("Host and Origin must be the public hostname", async () => {
    assert.equal((await get(jwt(), { host: "localhost:7700" })).statusCode, 403);
    assert.equal((await get(jwt(), { host: "evil.example" })).statusCode, 403);
    assert.equal((await get(jwt(), { origin: `https://${CF_HOST}` })).statusCode, 200);
    assert.equal((await get(jwt(), { origin: "https://evil.example" })).statusCode, 403);
  });
  test("logout returns the Access logout URL", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", remoteAddress: "127.0.0.1", headers: { host: CF_HOST, "cf-access-jwt-assertion": jwt() } });
    assert.equal(r.json().logout_url, `https://${TEAM}/cdn-cgi/access/logout`);
  });
});

describe("JWKS cache", () => {
  test("refreshes on an unknown kid (key rotation), at most every 30 s", async () => {
    let clock = 1_000_000;
    const f = jwksFetcher([[jwkOf(keyA.publicKey, "kid-a")], [jwkOf(keyA.publicKey, "kid-a"), jwkOf(keyB.publicKey, "kid-b")]]);
    const jwks = new Jwks(`https://${TEAM}/cdn-cgi/access/certs`, f, () => clock);
    const v = (t: string) => verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD, jwks, nowMs: Date.now() });
    assert.equal((await v(jwt())).ok, true);
    assert.equal(f.calls.length, 1);
    // kid-b is unknown and the last fetch was just now: no refetch storm.
    assert.equal((await v(jwt({}, { key: keyB.privateKey, kid: "kid-b" }))).ok, false);
    assert.equal(f.calls.length, 1);
    clock += 31_000;
    assert.equal((await v(jwt({}, { key: keyB.privateKey, kid: "kid-b" }))).ok, true);
    assert.equal(f.calls.length, 2);
  });
  test("alg is checked before any key is used (none, HS256, RS512, PS256)", async () => {
    const jwks = new Jwks("https://x/certs", async () => ({ keys: [jwkOf(keyA.publicKey, "kid-a")] }), () => 0);
    for (const alg of ["none", "HS256", "RS512", "PS256", "rs256"]) {
      const r = await verifyAccessJwt(jwt({}, { head: { alg } }), { teamDomain: TEAM, aud: AUD, jwks, nowMs: Date.now() });
      assert.deepEqual(r, { ok: false, reason: "alg" }, alg);
    }
  });
  test("ignores non-RSA, small and non-signing keys; a failed fetch keeps the old keys", async () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 });
    let fail = false, clock = 0;
    const f = async () => {
      if (fail) throw new Error("down");
      return { keys: [{ kty: "oct", kid: "h", k: "AAAA" }, jwkOf(small.publicKey, "small"), { ...jwkOf(keyB.publicKey, "enc"), use: "enc" }, jwkOf(keyA.publicKey, "kid-a")] };
    };
    const jwks = new Jwks("https://x/certs", f, () => clock);
    assert.equal(await jwks.get("h"), null);
    clock += 31_000;
    assert.equal(await jwks.get("small"), null);
    clock += 31_000;
    assert.equal(await jwks.get("enc"), null);
    fail = true;
    clock += 2 * 60 * 60_000;
    assert.notEqual(await jwks.get("kid-a"), null);
  });
});

// =================================================================================================

describe("/term and /screen proxies", () => {
  const up = fakeUpstream();
  let app: FastifyInstance, base = "", credFile = path.join(tmp, "ttyd.credential"), vncFile = path.join(tmp, "vnc.password");
  let ssh: FastifyInstance, sshBase = "";
  before(async () => {
    await new Promise<void>((r) => up.server.listen(0, "127.0.0.1", r));
    const upPort = (up.server.address() as AddressInfo).port;
    fs.writeFileSync(credFile, "agentbox:s3cret\n", { mode: 0o600 });
    fs.writeFileSync(vncFile, "vncpass1\n", { mode: 0o600 });
    const ports = { screen: upPort, terminal: upPort };
    ({ app } = await makeApp(tsConfig({ ports }), { ttydCredentialFile: credFile, vncPasswordFile: vncFile }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    ({ app: ssh } = await makeApp({ ...DEFAULT_ACCESS_CONFIG, ports }));
    await ssh.listen({ host: "127.0.0.1", port: 0 });
    sshBase = `127.0.0.1:${(ssh.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app.close(); await ssh.close(); up.server.close(); });

  const httpGet = (b: string, p: string, headers: Record<string, string>) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const [host, port] = b.split(":");
    http.get({ host, port, path: p, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on("error", reject);
  });
  const tryWs = (b: string, p: string, headers: Record<string, string>, protocol = "tty") => new Promise<{ result: string; ws?: WebSocket }>((res) => {
    const ws = new WebSocket(`ws://${b}${p}`, [protocol], { headers });
    ws.once("open", () => res({ result: "open", ws }));
    ws.once("unexpected-response", (_q, r) => res({ result: String(r.statusCode) }));
    ws.once("error", () => res({ result: "error" }));
  });
  const owner = { host: TS_HOST, "tailscale-user-login": OWNER_LOGIN };

  test("HTTP without auth is refused and never reaches the upstream", async () => {
    const before_ = up.http.length;
    for (const p of ["/term/", "/screen/vnc.html", "/term", "/screen"]) {
      const r = await httpGet(base, p, { host: TS_HOST });
      assert.equal(r.status, 401, p);
    }
    assert.equal((await httpGet(base, "/term/", { ...owner, "tailscale-user-login": "mallory@example.com" })).status, 401);
    assert.equal((await httpGet(base, "/term/", { ...owner, host: "localhost" })).status, 403);
    assert.equal(up.http.length, before_);
  });
  test("WebSocket upgrade without auth is refused and never reaches the upstream", async () => {
    const before_ = up.ws.length;
    assert.equal((await tryWs(base, "/term/ws", { host: TS_HOST })).result, "401");
    assert.equal((await tryWs(base, "/screen/websockify", { host: TS_HOST }, "binary")).result, "401");
    assert.equal((await tryWs(base, "/term/ws", { ...owner, "tailscale-user-login": "mallory@example.com" })).result, "401");
    assert.equal((await tryWs(base, "/term/ws", { ...owner, origin: "https://evil.example" })).result, "403");
    assert.equal((await tryWs(base, "/term/ws", { ...owner, "sec-fetch-site": "cross-site" })).result, "403");
    assert.equal((await tryWs(base, "/term/ws", { ...owner, host: "localhost" })).result, "403");
    assert.equal(up.ws.length, before_);
  });
  test("authenticated HTTP is proxied with the prefix stripped, identity headers dropped, ttyd credential added", async () => {
    const c = cookieOf(await app.inject({ method: "GET", url: "/api/state", headers: owner, remoteAddress: "127.0.0.1" }));
    const r = await httpGet(base, "/term/?arg=1", { host: TS_HOST, cookie: c, "x-forwarded-for": "1.2.3.4" });
    assert.equal(r.status, 200);
    assert.equal(r.body, "upstream /?arg=1");
    assert.equal(r.headers["set-cookie"], undefined, "upstream cookies never reach the portal origin");
    assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
    const seen = up.http.at(-1)!;
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers["tailscale-user-login"], undefined);
    assert.equal(seen.headers["x-forwarded-for"], undefined);
    assert.equal(seen.headers.authorization, `Basic ${Buffer.from("agentbox:s3cret").toString("base64")}`);
    assert.match(String(seen.headers.host), /^127\.0\.0\.1:\d+$/);
    const s = await httpGet(base, "/screen/vnc.html", owner);
    assert.equal(s.body, "upstream /vnc.html");
    assert.equal(up.http.at(-1)!.headers.authorization, undefined, "the ttyd credential only goes to ttyd");
  });
  test("traversal and encoded paths are refused", async () => {
    for (const p of ["/term/../api/state", "/term/%2e%2e/x", "/term//etc/passwd", "/screen/a/./b", "/%74erm/"]) {
      const r = await httpGet(base, p, owner);
      assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
    }
    assert.equal(upstreamPath("/term/a/../b", "/term"), null);
    assert.equal(upstreamPath("/term/ws?x=1", "/term"), "/ws?x=1");
  });
  test("authenticated WebSocket is bridged; the upstream sees its own origin and the subprotocol", async () => {
    const { result, ws } = await tryWs(base, "/term/ws", { ...owner, origin: `https://${TS_HOST}` });
    assert.equal(result, "open");
    assert.equal(ws!.protocol, "tty");
    const echoed = await new Promise<string>((res) => { ws!.once("message", (d) => res(String(d))); ws!.send("ping"); });
    assert.equal(echoed, "ping");
    const seen = up.ws.at(-1)!;
    assert.equal(seen.url, "/ws");
    assert.match(String(seen.headers.origin), /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(seen.headers["tailscale-user-login"], undefined);
    assert.equal(seen.headers.cookie, undefined);
    ws!.close();
  });
  test("the VNC password is only given to an authenticated portal", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/screen/credential", headers: { host: TS_HOST }, remoteAddress: "127.0.0.1" })).statusCode, 401);
    const r = await app.inject({ method: "GET", url: "/api/screen/credential", headers: owner, remoteAddress: "127.0.0.1" });
    assert.deepEqual(r.json(), { password: "vncpass1" });
    assert.equal(r.headers["cache-control"], "no-store");
  });
  test("ssh-tunnel mode: loopback opens, a foreign Origin or Host is refused, also for WebSockets", async () => {
    assert.equal((await httpGet(sshBase, "/term/", { host: "localhost" })).status, 200);
    assert.equal((await httpGet(sshBase, "/term/", { host: "evil.example" })).status, 403);
    const ok = await tryWs(sshBase, "/term/ws", {});
    assert.equal(ok.result, "open");
    ok.ws!.close();
    assert.equal((await tryWs(sshBase, "/term/ws", { origin: "https://evil.example" })).result, "403");
    assert.equal((await tryWs(sshBase, "/term/ws", { host: "evil.example" })).result, "403");
    assert.equal((await tryWs(sshBase, "/api/events", { origin: "https://evil.example" })).result, "403");
  });
  test("/api/events WebSocket in tailscale mode needs the owner", async () => {
    assert.equal((await tryWs(base, "/api/events", { host: TS_HOST })).result, "401");
    const ok = await tryWs(base, "/api/events", owner);
    assert.equal(ok.result, "open");
    ok.ws!.close();
  });
});

describe("/setup: the setup guide behind the portal login", () => {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const wsSeen: http.IncomingHttpHeaders[] = [];
  const guide = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body }); res.writeHead(200, { "content-type": "application/json", "set-cookie": "agentbox_guide=x" }); res.end(JSON.stringify({ ok: true, url: req.url })); });
  });
  const wss = new WebSocketServer({ noServer: true });
  guide.on("upgrade", (req, socket, head) => { wsSeen.push(req.headers); wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (d) => ws.send(String(d)))); });
  const secretFile = path.join(tmp, "guide-proxy-token");
  let app: FastifyInstance, base = "";
  const owner = { host: TS_HOST, "tailscale-user-login": OWNER_LOGIN };
  before(async () => {
    await new Promise<void>((r) => guide.listen(0, "127.0.0.1", r));
    const gp = (guide.address() as AddressInfo).port;
    ({ app } = await makeApp(tsConfig({ ports: { screen: 1, terminal: 1, guide: gp } }), { guideProxyTokenFile: secretFile }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app.close(); guide.close(); });
  const inject = (o: any) => app.inject({ remoteAddress: "127.0.0.1", ...o });

  test("while the guide isn't running (no secret file): 503 for the owner, 401 for anyone else", async () => {
    fs.rmSync(secretFile, { force: true });
    assert.equal((await inject({ url: "/setup/api/state", headers: owner })).statusCode, 503);
    assert.equal((await inject({ url: "/setup/api/state", headers: { host: TS_HOST } })).statusCode, 401);
    assert.equal(seen.length, 0);
  });
  test("the owner reaches the guide with the secret; prefix stripped; identity and cookies dropped", async () => {
    fs.writeFileSync(secretFile, "guide-secret-123\n", { mode: 0o600 });
    const r = await inject({ url: "/setup/api/state?x=1", headers: { ...owner, cookie: "a=b" } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["set-cookie"], undefined, "the guide's cookies never reach the portal origin");
    const s = seen.at(-1)!;
    assert.equal(s.url, "/api/state?x=1");
    assert.equal(s.headers["x-agentbox-guide-proxy"], "guide-secret-123");
    assert.equal(s.headers["tailscale-user-login"], undefined);
    assert.equal(s.headers.cookie, undefined);
    assert.equal((await inject({ url: "/setup", headers: owner })).statusCode, 302);
  });
  test("JSON writes are forwarded; other bodies refused before the guide", async () => {
    const n = seen.length;
    const r = await inject({ method: "POST", url: "/setup/api/profile", headers: { ...owner, "content-type": "application/json" }, payload: { modules: { github: true } } });
    assert.equal(r.statusCode, 200);
    assert.equal(seen.at(-1)!.method, "POST");
    assert.deepEqual(JSON.parse(seen.at(-1)!.body), { modules: { github: true } });
    assert.equal((await inject({ method: "POST", url: "/setup/api/profile", headers: { ...owner, "content-type": "text/plain" }, payload: "x" })).statusCode, 415);
    assert.equal((await inject({ method: "POST", url: "/setup/api/finish", headers: owner })).statusCode, 200, "bodyless POST");
    assert.equal(seen.length, n + 2);
  });
  test("cross-site, foreign Origin and the wrong Host are refused", async () => {
    assert.equal((await inject({ url: "/setup/", headers: { ...owner, origin: "https://evil.example" } })).statusCode, 403);
    assert.equal((await inject({ url: "/setup/api/state", headers: { ...owner, "sec-fetch-site": "cross-site" } })).statusCode, 403);
    assert.equal((await inject({ url: "/setup/", headers: { ...owner, host: "localhost" } })).statusCode, 403);
  });
  test("the guide's WebSockets are bridged with the secret; refused without the owner", async () => {
    const open = (headers: Record<string, string>) => new Promise<{ r: string; ws?: WebSocket }>((res) => {
      const ws = new WebSocket(`${base}/setup/ws/term`, { headers });
      ws.once("open", () => res({ r: "open", ws }));
      ws.once("unexpected-response", (_q, x) => res({ r: String(x.statusCode) }));
      ws.once("error", () => res({ r: "error" }));
    });
    assert.equal((await open({ host: TS_HOST })).r, "401");
    const { r, ws } = await open({ ...owner, origin: `https://${TS_HOST}` });
    assert.equal(r, "open");
    const echo = await new Promise<string>((res) => { ws!.once("message", (d) => res(String(d))); ws!.send("hi"); });
    assert.equal(echo, "hi");
    assert.equal(wsSeen.at(-1)!["x-agentbox-guide-proxy"], "guide-secret-123");
    ws!.close();
  });
});

describe("config projection", () => {
  test("yaml keys map onto AccessConfig; absent keys are defaults", () => {
    const c = toAccessConfig({ access: "cloudflare", cloudflare: { hostname: " a.example.com ", team_domain: TEAM, aud: AUD }, owner: { email: OWNER_EMAIL }, ports: { terminal: 9000 } });
    assert.equal(c.access, "cloudflare");
    assert.equal(c.cloudflare.hostname, "a.example.com");
    assert.equal(c.ports.terminal, 9000);
    assert.equal(c.ports.screen, 7701);
    assert.equal(toAccessConfig({}).access, "ssh-tunnel");
  });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
