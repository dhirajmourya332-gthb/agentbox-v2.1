// Guide auth: one-time token → session cookie, loopback Host, Origin, Sec-Fetch-Site, the portal
// proxy secret; then the same through the real HTTP app (pages, API, WebSockets).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createGuideAuth, mintToken, PROXY_HEADER } from "../src/auth.ts";
import { createGuide } from "../src/app.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-guide-auth-"));
const req = (h: Record<string, string>, method = "GET", remoteAddress = "127.0.0.1") => ({ method, headers: { host: "localhost:8699", ...h }, remoteAddress });

describe("createGuideAuth", () => {
  const dir = path.join(tmp, "unit");
  let now = Date.now();
  const auth = createGuideAuth({ tokensDir: path.join(dir, "tokens"), proxyTokenFile: path.join(dir, "proxy-token"), now: () => now });

  test("no token, no session: 401", () => {
    const d = auth.authorize(req({}), { api: false });
    assert.equal(d.ok, false);
    assert.equal((d as any).code, 401);
  });
  test("a token works once, sets an HttpOnly SameSite=Strict cookie", () => {
    const t = mintToken(path.join(dir, "tokens"), now);
    const d = auth.authorize(req({}), { api: false, token: t });
    assert.ok(d.ok && d.setCookie);
    assert.match(d.setCookie!, /^agentbox_guide=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict/);
    const again = auth.authorize(req({}), { api: false, token: t });
    assert.equal(again.ok, false);
    const cookie = d.setCookie!.split(";")[0];
    assert.equal(auth.authorize(req({ cookie }), { api: true }).ok, true);
  });
  test("tokens aren't accepted on API calls or non-GET, and expire", () => {
    const t = mintToken(path.join(dir, "tokens"), now);
    assert.equal(auth.authorize(req({}), { api: true, token: t }).ok, false);
    const t2 = mintToken(path.join(dir, "tokens"), now - 31 * 60_000);
    assert.equal(auth.authorize(req({}), { api: false, token: t2 }).ok, false);
    assert.equal(auth.authorize(req({}), { api: false, token: "../../etc/passwd" }).ok, false);
  });
  test("Host must be loopback; Origin must be our own; cross-site fetches refused", () => {
    const t = mintToken(path.join(dir, "tokens"), now);
    const cookie = (auth.authorize(req({}), { api: false, token: t }) as any).setCookie.split(";")[0];
    assert.equal(auth.authorize(req({ cookie, host: "evil.example.com" }), { api: true }).ok, false, "DNS rebinding");
    assert.equal(auth.authorize(req({ cookie, origin: "http://localhost:3000" }), { api: true }).ok, false, "another localhost port");
    assert.equal(auth.authorize(req({ cookie, origin: "null" }), { api: true }).ok, false);
    assert.equal(auth.authorize(req({ cookie, origin: "http://localhost:8699" }), { api: true }).ok, true);
    assert.equal(auth.authorize(req({ cookie, "sec-fetch-site": "same-site" }), { api: true }).ok, false);
    assert.equal(auth.authorize(req({ cookie, "sec-fetch-site": "same-origin" }), { api: true }).ok, true);
    assert.equal(auth.authorize(req({ cookie }, "GET", "10.0.0.5"), { api: true }).ok, false, "not loopback");
    const form = auth.authorize({ method: "POST", headers: { host: "localhost:8699", cookie, "content-type": "text/plain", "content-length": "3" }, remoteAddress: "127.0.0.1" }, { api: true });
    assert.equal((form as any).code, 415);
  });
  test("the portal's proxy secret: only from loopback, only while enabled", () => {
    auth.enableProxy();
    const secret = fs.readFileSync(path.join(dir, "proxy-token"), "utf8").trim();
    assert.equal((fs.statSync(path.join(dir, "proxy-token")).mode & 0o777), 0o600);
    assert.equal(auth.authorize(req({ [PROXY_HEADER]: secret, host: "box.ts.net" }), { api: true }).ok, true);
    assert.equal(auth.authorize(req({ [PROXY_HEADER]: secret }, "GET", "10.0.0.5"), { api: true }).ok, false);
    assert.equal(auth.authorize(req({ [PROXY_HEADER]: "x".repeat(43) }), { api: true }).ok, false);
    auth.revokeAll();
    assert.equal(auth.authorize(req({ [PROXY_HEADER]: secret }), { api: true }).ok, false);
    assert.equal(fs.existsSync(path.join(dir, "proxy-token")), false);
  });
  test("revokeAll ends sessions and deletes unused tokens", () => {
    const t = mintToken(path.join(dir, "tokens"), now);
    const t2 = mintToken(path.join(dir, "tokens"), now);
    const cookie = (auth.authorize(req({}), { api: false, token: t }) as any).setCookie.split(";")[0];
    auth.revokeAll();
    assert.equal(auth.authorize(req({ cookie }), { api: true }).ok, false);
    assert.equal(auth.authorize(req({}), { api: false, token: t2 }).ok, false);
    now += 1;
  });
});

describe("the guide over HTTP", () => {
  let guide: Awaited<ReturnType<typeof createGuide>>;
  let base: string;
  let port: number;
  const stateDir = path.join(tmp, "http");
  let finished = 0;
  before(async () => {
    const configFile = path.join(tmp, "config.yaml");
    fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\nmodules: { github: true }\nports: { guide: 7699, portal: 7700 }\n`);
    guide = await createGuide({
      configFile, stateDir, src: path.resolve(import.meta.dirname, "../.."),
      runCheck: async () => ({ ok: false, code: 1, output: "", at: Date.now() }),
      runAdmin: async () => ({ code: 0, output: "" }),
      onFinish: () => { finished++; },
      webDist: path.join(tmp, "no-dist"),
    });
    await guide.app.listen({ host: "127.0.0.1", port: 0 });
    port = (guide.app.server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => { await guide.close(); });

  const login = async () => {
    const t = mintToken(path.join(stateDir, "tokens"));
    const r = await fetch(`${base}/?t=${t}`, { redirect: "manual" });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "./");
    return r.headers.get("set-cookie")!.split(";")[0];
  };

  test("without the token the page and the API are refused", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 401);
    assert.match(await page.text(), /agentbox guide/);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/?t=${"a".repeat(43)}`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
  test("with the token: a session, then the state", async () => {
    const cookie = await login();
    const r = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    const s = await r.json();
    assert.equal(s.host.kind, "lima");
    assert.ok(s.roadmap.modules.some((m: any) => m.id === "github" && m.enabled));
  });
  test("the setup agent doesn't start before the Claude login check is green", async () => {
    const cookie = await login();
    const r = await fetch(`${base}/api/agent/start`, { method: "POST", headers: { cookie } });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /Claude/);
  });
  test("Finish needs a passing self-test", async () => {
    const cookie = await login();
    assert.equal((await fetch(`${base}/api/finish`, { method: "POST", headers: { cookie } })).status, 409);
    assert.equal(finished, 0);
  });
  test("WebSockets: refused cross-origin and without a session", async () => {
    const cookie = await login();
    const open = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term`, { headers });
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => resolve(-1));
    });
    assert.equal(await open({ origin: "http://evil.example.com", cookie }), 403);
    assert.equal(await open({ origin: "http://localhost:3000", cookie, host: "localhost:8699" }), 403);
    assert.equal(await open({ origin: `http://127.0.0.1:${port}` }), 401);
    assert.equal(await open({ origin: `http://127.0.0.1:${port}`, cookie }), 101);
  });
  test("profile save goes through agentbox (config set / module disable) and marks the step", async () => {
    const calls: string[][] = [];
    const g2 = await createGuide({
      configFile: path.join(tmp, "config.yaml"), stateDir: path.join(tmp, "http2"), src: path.resolve(import.meta.dirname, "../.."),
      runCheck: async () => ({ ok: false, code: 1, output: "", at: Date.now() }),
      runAdmin: async (args) => { calls.push(args); return { code: 0, output: "" }; },
      webDist: path.join(tmp, "no-dist"),
    });
    await g2.app.ready();
    const t = mintToken(path.join(tmp, "http2", "tokens"));
    const r1 = await g2.app.inject({ url: `/?t=${t}`, headers: { host: "localhost" }, remoteAddress: "127.0.0.1" });
    const cookie = String(r1.headers["set-cookie"]).split(";")[0];
    const r = await g2.app.inject({
      method: "POST", url: "/api/profile", headers: { host: "localhost", cookie, "content-type": "application/json" },
      remoteAddress: "127.0.0.1", payload: { modules: { github: false, kubernetes: true } },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(calls, [["module", "disable", "github"], ["config", "set", "modules.aws", "true"], ["config", "set", "modules.kubernetes", "true"]]);
    assert.ok(fs.existsSync(path.join(tmp, "http2", "profile-confirmed")));
    await g2.close();
  });
});

describe("sessions survive a guide restart", () => {
  const dir = path.join(tmp, "persist");
  const sessionsFile = path.join(dir, "sessions.json");
  let now = Date.now();
  const mk = () => createGuideAuth({ tokensDir: path.join(dir, "tokens"), proxyTokenFile: path.join(dir, "proxy-token"), sessionsFile, now: () => now });

  test("a session from before the restart still works; the file is 0600 and holds no session id", () => {
    const a = mk();
    const t = mintToken(path.join(dir, "tokens"), now);
    const cookie = (a.authorize(req({}), { api: false, token: t }) as any).setCookie.split(";")[0];
    const id = cookie.split("=")[1];
    assert.equal(fs.statSync(sessionsFile).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(sessionsFile, "utf8").includes(id), "only hashes are stored");
    const b = mk(); // the restarted guide
    assert.equal(b.authorize(req({ cookie }), { api: true }).ok, true);
    // One-time tokens stay one-time across the restart.
    assert.equal(b.authorize(req({}), { api: false, token: t }).ok, false);
    // A forged cookie isn't a session.
    assert.equal(b.authorize(req({ cookie: `agentbox_guide=${"A".repeat(43)}` }), { api: true }).ok, false);
  });

  test("expired sessions are dropped on load", () => {
    const a = mk();
    const t = mintToken(path.join(dir, "tokens"), now);
    const cookie = (a.authorize(req({}), { api: false, token: t }) as any).setCookie.split(";")[0];
    now += 8 * 60 * 60_000 + 1;
    const b = mk();
    assert.equal(b.sessions.size, 0);
    assert.equal(b.authorize(req({ cookie }), { api: true }).ok, false);
  });

  test("revokeAll (Finish) deletes the sessions file; disableProxy (a stop) keeps it", () => {
    const a = mk();
    a.enableProxy();
    const t = mintToken(path.join(dir, "tokens"), now);
    const cookie = (a.authorize(req({}), { api: false, token: t }) as any).setCookie.split(";")[0];
    a.disableProxy();
    assert.equal(fs.existsSync(path.join(dir, "proxy-token")), false);
    assert.equal(mk().authorize(req({ cookie }), { api: true }).ok, true);
    a.revokeAll();
    assert.equal(fs.existsSync(sessionsFile), false);
    assert.equal(mk().authorize(req({ cookie }), { api: true }).ok, false);
  });
});
