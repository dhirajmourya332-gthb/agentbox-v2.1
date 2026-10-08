/**
 * Mobile gateway test client (docs/MOBILE-PROTOCOL.md). Runs against a REHEARSAL server, never the
 * live one: it pairs, approves and revokes devices, pauses agents, creates a task and uploads.
 *
 *   PORTAL=http://127.0.0.1:7790 GATEWAY=http://127.0.0.1:7791 WORK=/tmp/mob/work \
 *     node --import tsx test/mobile-gateway.test.ts
 *
 * Start the server with short TTLs so the expiry cases don't take minutes:
 *   AGENTBOX_PAIRING_TTL_MS=15000 AGENTBOX_PENDING_TTL_MS=20000
 * See docs/MOBILE-SETUP.md › Testing for the full rehearsal recipe.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import WebSocket from "ws";
import { bodyHash, canonicalMessage, verifySignature } from "../src/signing.ts";

const PORTAL = new URL(process.env.PORTAL ?? "http://127.0.0.1:7790");
const GATEWAY = new URL(process.env.GATEWAY ?? "http://127.0.0.1:7791");
const WORK = process.env.WORK ?? "/tmp/mob/work";
const PAIRING_TTL = Number(process.env.AGENTBOX_PAIRING_TTL_MS ?? 15000);
const PENDING_TTL = Number(process.env.AGENTBOX_PENDING_TTL_MS ?? 20000);
// When the rehearsal server was started (ms); enables the "signed before the process started" case.
const SERVER_STARTED = Number(process.env.SERVER_STARTED_MS ?? 0);
// tailscale serve adds this for user devices; the gateway requires it at claim and binds to it.
const LOGIN = "owner@example.com";
const SUITE_START = new Date().toISOString(); // the rehearsal database may hold rows from earlier runs

if (/:(7700|7710)$/.test(PORTAL.host) || /:(7700|7710)$/.test(GATEWAY.host)) {
  console.error("Refusing to run against the live ports (7700/7710). Use a rehearsal server.");
  process.exit(2);
}

// --- tiny HTTP client (exact path control, raw bytes) ----------------------------------------

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
function request(base: URL, method: string, pathAndQuery: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: base.hostname, port: base.port, method, path: pathAndQuery, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = (r: Res) => JSON.parse(r.body.toString("utf8"));
const portal = (method: string, p: string, body?: unknown) =>
  request(PORTAL, method, p, body === undefined ? {} : { "content-type": "application/json" },
    body === undefined ? undefined : Buffer.from(JSON.stringify(body)));

// The gateway allows 10 claims a minute globally; pace ours so the other cases don't trip it.
// Every claim is recorded; creating a pairing waits until there's room for its claim(s) (at most
// two per pairing). Codes are short-lived in the rehearsal, so never wait after creating one.
const claimTimes: number[] = [];
async function claimSlot() {
  for (;;) {
    const recent = claimTimes.filter((t) => Date.now() - t < 61_000);
    if (recent.length <= 7) break;
    await new Promise((r) => setTimeout(r, 61_000 - (Date.now() - recent[0]) + 100));
  }
}
const claimRaw = (headers: Record<string, string>, body: Buffer) => {
  claimTimes.push(Date.now());
  return request(GATEWAY, "POST", "/m/pair/claim", headers, body);
};

// --- a phone ---------------------------------------------------------------------------------

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

class Phone {
  login: string | null = LOGIN;
  sk = ed25519.utils.randomSecretKey();
  pk = ed25519.getPublicKey(this.sk);
  id = "";
  get fingerprint() {
    const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let out = "", bits = 0, v = 0;
    for (const b of sha256(this.pk).subarray(0, 10)) {
      v = (v << 8) | b; bits += 8;
      while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; }
    }
    return out.match(/.{4}/g)!.join("-");
  }
  sign(method: string, p: string, body: Buffer = Buffer.alloc(0), o: { time?: number; nonce?: string; id?: string; key?: Uint8Array } = {}) {
    const time = String(o.time ?? Date.now());
    const nonce = o.nonce ?? b64u(randomBytes(16));
    const msg = ["AB1", method.toUpperCase(), p, time, nonce, b64u(sha256(body))].join("\n");
    // The login header goes with every request (tailscale serve adds it), so a negative case fails
    // only for the reason it tests.
    const h: Record<string, string> = {
      ...(this.login ? { "tailscale-user-login": this.login } : {}),
      "x-ab-device": o.id ?? this.id, "x-ab-time": time, "x-ab-nonce": nonce,
      "x-ab-sig": b64u(ed25519.sign(Buffer.from(msg, "utf8"), o.key ?? this.sk)),
    };
    return h;
  }
  call(method: string, p: string, body?: unknown, extra: Record<string, string> = {}, o = {}) {
    const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const login: Record<string, string> = this.login ? { "tailscale-user-login": this.login } : {};
    return request(GATEWAY, method, p, { ...login, ...this.sign(method, p, raw, o), ...(raw ? { "content-type": "application/json" } : {}), ...extra }, raw);
  }
  async claim(code: string, name = "Test phone") {
    return claimRaw({ "content-type": "application/json", ...(this.login ? { "tailscale-user-login": this.login } : {}) },
      Buffer.from(JSON.stringify({ code, public_key: b64u(this.pk), device_name: name, app_version: "0.0.1-test" })));
  }
}

// --- results -----------------------------------------------------------------------------------

const results: { name: string; ok: boolean; note?: string }[] = [];
async function test(name: string, fn: () => Promise<void | string>) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || undefined });
  } catch (e: any) {
    results.push({ name, ok: false, note: e?.message ?? String(e) });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const isEmpty404 = (r: Res, what = "") => {
  assert(r.status === 404, `${what} expected 404, got ${r.status} ${r.body.toString().slice(0, 120)}`);
  assert(r.body.length === 0, `${what} 404 body not empty: ${r.body.toString().slice(0, 120)}`);
  assert(!r.headers["content-type"], `${what} 404 has a content-type`);
  assert(!r.headers["x-powered-by"] && !r.headers.server, `${what} identifying header present`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newPairing(paced = true) {
  if (paced) await claimSlot();
  const r = await portal("POST", "/api/devices/pairings", {});
  assert(r.status === 200, `create pairing: ${r.status} ${r.body}`);
  return json(r) as { id: string; code: string; expires_at: string; url: string; qr_payload: string };
}
async function pairAndApprove(name: string) {
  const phone = new Phone();
  const p = await newPairing();
  const c = await phone.claim(p.code, name);
  assert(c.status === 202, `claim: ${c.status}`);
  phone.id = json(c).device_id;
  const a = await portal("POST", `/api/devices/${phone.id}/approve`, {});
  assert(a.status === 200, `approve: ${a.status} ${a.body}`);
  return phone;
}

// --- the cases ---------------------------------------------------------------------------------

async function main() {
  // A gateway URL is needed to make a QR (no Tailscale in the rehearsal).
  const g = await portal("PUT", "/api/devices/gateway", { url: "https://agentbox.rehearsal.ts.net" });
  assert(g.status === 200, `set manual url: ${g.status} ${g.body}`);

  const phone = new Phone();
  let code = "";

  await test("cross-check vector (RFC 8032 TEST 1 key) verifies with the server's signing code", async () => {
    const body = Buffer.from('{"text":"hello","images":[]}', "utf8");
    assert(bodyHash(body) === "EGIsxtPpSp3_LWAi_3e1xU_X6Yh9g4H9WmNZw64DuFE", `body hash ${bodyHash(body)}`);
    const msg = canonicalMessage("POST", "/m/v1/threads/thr_123/messages", "1700000000000", "AAECAwQFBgcICQoLDA0ODw", body);
    const pub = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const sig = "DC5gvHgl9QemsS05SeOBC6TTsY87Xg5sGtxb1_mkbTIBi1-ND35qjemsCFKkWf11rerQ-6_oISEvHSisIM-hDA";
    assert(verifySignature(pub, sig, msg), "vector signature does not verify");
    // And the RFC 8032 TEST 1 secret key reproduces it (Ed25519 is deterministic).
    const sk = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
    assert(b64u(ed25519.sign(msg, sk)) === sig, "re-signing with the RFC key gives a different signature");
    assert(!verifySignature(pub, sig, canonicalMessage("POST", "/m/v1/threads/thr_123/messages", "1700000000001", "AAECAwQFBgcICQoLDA0ODw", body)), "tampered message verified");
  });

  await test("unsigned requests → empty 404 (/, /m/v1/state, /m/v1/whoami, /api/state)", async () => {
    for (const p of ["/", "/m/v1/state", "/m/v1/whoami", "/api/state", "/m/pair/claim"]) isEmpty404(await request(GATEWAY, "GET", p), p);
  });

  await test("security headers on every response", async () => {
    const r = await request(GATEWAY, "GET", "/nothing");
    assert(r.headers["cache-control"] === "no-store", "cache-control");
    assert(r.headers["x-content-type-options"] === "nosniff", "nosniff");
    assert(r.headers["referrer-policy"] === "no-referrer", "referrer-policy");
  });

  await test("portal: pairing returns code, url and QR payload", async () => {
    const p = await newPairing();
    const q = JSON.parse(p.qr_payload);
    assert(q.v === 1 && q.u === "https://agentbox.rehearsal.ts.net" && q.c === p.code && q.n === "agentbox", "qr payload shape");
    assert(Buffer.from(p.code, "base64url").length === 32, "code is 32 bytes");
    code = p.code;
  });

  await test("claim with a wrong code → empty 404", async () => {
    isEmpty404(await phone.claim(b64u(randomBytes(32))));
  });

  await test("claim → 202 pending, fingerprint matches", async () => {
    const r = await phone.claim(code);
    assert(r.status === 202, `status ${r.status}`);
    const b = json(r);
    assert(b.status === "pending" && b.device_id, "body");
    assert(b.fingerprint === phone.fingerprint, `fingerprint ${b.fingerprint} vs ${phone.fingerprint}`);
    phone.id = b.device_id;
  });

  await test("pairing code is single-use", async () => {
    isEmpty404(await new Phone().claim(code));
  });

  await test("pending: whoami → {status: pending}; other routes → 404", async () => {
    const r = await phone.call("GET", "/m/v1/whoami");
    assert(r.status === 200 && json(r).status === "pending", `whoami ${r.status} ${r.body}`);
    isEmpty404(await phone.call("GET", "/m/v1/state"));
  });

  await test("portal lists the pending device with the same fingerprint", async () => {
    const d = json(await portal("GET", "/api/devices"));
    const mine = d.pending.find((x: any) => x.id === phone.id);
    assert(mine && mine.fingerprint === phone.fingerprint && !("public_key" in mine), "listed");
  });

  await test("approve → whoami active", async () => {
    const a = await portal("POST", `/api/devices/${phone.id}/approve`, {});
    assert(a.status === 200, `approve ${a.status}`);
    const r = await phone.call("GET", "/m/v1/whoami");
    const b = json(r);
    assert(r.status === 200 && b.status === "active" && b.device_id === phone.id && b.name === "Test phone", `whoami ${r.body}`);
  });

  await test("signed GET /m/v1/state and /m/v1/work?x=1 → 200 JSON", async () => {
    const r = await phone.call("GET", "/m/v1/state");
    assert(r.status === 200 && Array.isArray(json(r).agents), `state ${r.status}`);
    assert(String(r.headers["content-type"]).startsWith("application/json"), "content-type");
    const w = await phone.call("GET", "/m/v1/work?x=1");
    assert(w.status === 200 && "live" in json(w), `work ${w.status}`);
  });

  await test("signed POST /m/v1/pause with JSON body → 200 and audited", async () => {
    const r = await phone.call("POST", "/m/v1/pause", { stopRunning: false });
    assert(r.status === 200 && json(r).paused === true, `pause ${r.status} ${r.body}`);
    const act = json(await portal("GET", "/api/activity?limit=20"));
    const row = act.find((i: any) => i.kind === "phone" && i.title === "paused all agents");
    assert(row && row.detail === "via phone (Test phone)", "activity row");
  });

  await test("bad signature → 404", async () => {
    const h = phone.sign("GET", "/m/v1/state");
    const sig = Buffer.from(h["x-ab-sig"], "base64url");
    sig[5] ^= 1;
    isEmpty404(await request(GATEWAY, "GET", "/m/v1/state", { ...h, "x-ab-sig": b64u(sig) }));
    // Control: the untampered request (same nonce) still works, so a bad signature burns nothing.
    assert((await request(GATEWAY, "GET", "/m/v1/state", h)).status === 200, "control request");
  });

  await test("signature over a different path/query/body → 404", async () => {
    const h = phone.sign("GET", "/m/v1/work");
    isEmpty404(await request(GATEWAY, "GET", "/m/v1/work?x=1", h), "query");
    const b = Buffer.from(JSON.stringify({ stopRunning: false }));
    const h2 = phone.sign("POST", "/m/v1/pause", b);
    isEmpty404(await request(GATEWAY, "POST", "/m/v1/pause", { ...h2, "content-type": "application/json" }, Buffer.from(JSON.stringify({ stopRunning: true }))), "body");
  });

  await test("old timestamp (61 s) and future timestamp → 404", async () => {
    isEmpty404(await phone.call("GET", "/m/v1/state", undefined, {}, { time: Date.now() - 61_000 }), "old");
    isEmpty404(await phone.call("GET", "/m/v1/state", undefined, {}, { time: Date.now() + 61_000 }), "future");
  });

  await test("signature dated before the server started → 404", async () => {
    if (!SERVER_STARTED || Date.now() - SERVER_STARTED > 50_000) return "skipped: set SERVER_STARTED_MS and run within 50 s of starting the server";
    isEmpty404(await phone.call("GET", "/m/v1/whoami", undefined, {}, { time: SERVER_STARTED - 3000 }));
  });

  await test("replayed nonce → 404 (exact replay and fresh signature)", async () => {
    const h = phone.sign("GET", "/m/v1/state");
    assert((await request(GATEWAY, "GET", "/m/v1/state", h)).status === 200, "first");
    isEmpty404(await request(GATEWAY, "GET", "/m/v1/state", h), "replay");
    isEmpty404(await phone.call("GET", "/m/v1/state", undefined, {}, { nonce: h["x-ab-nonce"] }), "same nonce, new sig");
  });

  await test("wrong device (other key, this device id) → 404", async () => {
    isEmpty404(await phone.call("GET", "/m/v1/state", undefined, {}, { key: ed25519.utils.randomSecretKey() }));
    isEmpty404(await phone.call("GET", "/m/v1/state", undefined, {}, { id: "00000000-0000-0000-0000-000000000000" }), "unknown id");
  });

  await test("empty Origin header counts as absent (HTTP)", async () => {
    const r = await phone.call("GET", "/m/v1/whoami", undefined, { origin: "" });
    assert(r.status === 200, `empty origin → ${r.status}`);
  });

  await test("Origin header → 404 (even when signed)", async () => {
    isEmpty404(await phone.call("GET", "/m/v1/state", undefined, { origin: "https://evil.example" }));
    isEmpty404(await request(GATEWAY, "POST", "/m/pair/claim", { origin: "https://evil.example", "content-type": "application/json", "tailscale-user-login": LOGIN }, Buffer.from("{}")), "claim");
  });

  await test("non-allowlisted paths → 404 (signed)", async () => {
    for (const [m, p] of [
      ["GET", "/m/v1/agents"], ["GET", "/m/v1/devices"], ["POST", "/m/v1/display/take"], ["GET", "/m/v1/activity"],
      ["POST", "/m/v1/devices/revoke-all"], ["GET", "/m/v1/devices/gateway"], ["POST", "/m/v1/agents"], ["GET", "/m/v1/skills"],
      ["GET", "/m/v1/file/info?path=/etc/passwd"], ["GET", "/m/v1/../api/devices"], ["GET", "/m/v1/work/%2e%2e/devices"],
      ["DELETE", "/m/v1/routines/x"], ["PUT", "/m/v1/routines/x"], ["GET", "/m/v1//state"], ["GET", "/api/devices"],
    ]) {
      isEmpty404(await phone.call(m, p, m === "GET" || m === "DELETE" ? undefined : {}), `${m} ${p}`);
    }
  });

  await test("main app refuses gateway-marked requests to /api/devices and non-allowlisted routes", async () => {
    const r = await request(PORTAL, "GET", "/api/devices", { "x-agentbox-gateway": "1" });
    assert(r.status === 404, `devices ${r.status}`);
    const r2 = await request(PORTAL, "POST", "/api/display/take", { "x-agentbox-gateway": "1" });
    assert(r2.status === 404, `display/take ${r2.status}`);
  });

  await test("portal admin refuses foreign Origin, non-JSON and non-localhost Host", async () => {
    const a = await request(PORTAL, "POST", "/api/devices/pairings", { "content-type": "application/json", origin: "https://evil.example" }, Buffer.from("{}"));
    assert(a.status === 403, `origin ${a.status}`);
    const b = await request(PORTAL, "POST", "/api/devices/pairings", { "content-type": "text/plain" }, Buffer.from("{}"));
    assert(b.status === 415, `content-type ${b.status}`);
    const c = await request(PORTAL, "GET", "/api/devices", { host: "evil.example:7700" });
    assert(c.status === 403, `host ${c.status}`);
  });

  await test("portal /api is localhost-only: Host, Origin, JSON writes; bodyless POST still works", async () => {
    const h = await request(PORTAL, "GET", "/api/state", { host: "evil.example:7700" });
    assert(h.status === 403, `rebinding host → ${h.status}`);
    const h2 = await request(PORTAL, "GET", "/api/state", { host: "localhost:7700" });
    assert(h2.status === 200, `localhost host → ${h2.status}`);
    const o = await request(PORTAL, "GET", "/api/state", { origin: "https://evil.example" });
    assert(o.status === 403, `foreign origin → ${o.status}`);
    const o2 = await request(PORTAL, "GET", "/api/state", { origin: "http://localhost:5173" });
    assert(o2.status === 200, `loopback origin → ${o2.status}`);
    const n = await request(PORTAL, "GET", "/api/state", { origin: "null" });
    assert(n.status === 403, `null origin → ${n.status}`);
    const t = await request(PORTAL, "POST", "/api/pause", { "content-type": "text/plain" }, Buffer.from('{"stopRunning":false}'));
    assert(t.status === 415, `text/plain body → ${t.status}`);
    const b = await request(PORTAL, "POST", "/api/pause", {}); // like `curl -X POST localhost:7700/api/pause`
    assert(b.status === 200, `bodyless POST → ${b.status} ${b.body}`);
    const j = await request(PORTAL, "POST", "/api/pause", { "content-type": "application/json", origin: "http://localhost:7790" }, Buffer.from('{"stopRunning":false}'));
    assert(j.status === 200, `portal-style JSON POST → ${j.status}`);
    const forged = await request(PORTAL, "GET", "/api/state", { "x-agentbox-gateway": "1" });
    assert(forged.status === 404, `forged gateway marker → ${forged.status}`);
    const html = await request(PORTAL, "GET", "/", { host: "evil.example:7700" });
    assert(html.status !== 403, "the static UI isn't guarded");
  });

  await test("portal /api/events WebSocket: loopback or no Origin opens; foreign Origin or Host refused", async () => {
    const tryWs = (headers: Record<string, string>) => new Promise<string>((res) => {
      const ws = new WebSocket(`ws://${PORTAL.host}/api/events`, { headers });
      ws.once("open", () => { ws.close(); res("open"); });
      ws.once("unexpected-response", (_q, r) => res(String(r.statusCode)));
      ws.once("error", () => res("error"));
    });
    assert((await tryWs({})) === "open", "no origin");
    assert((await tryWs({ origin: `http://${PORTAL.host}` })) === "open", "loopback origin");
    assert((await tryWs({ origin: "https://evil.example" })) === "403", "foreign origin");
    assert((await tryWs({ host: "evil.example:7700" })) === "403", "rebinding host");
  });

  let uploaded = "";
  await test("POST /m/v1/uploads (small PNG) → 200, audited", async () => {
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(2048)]);
    const r = await phone.call("POST", "/m/v1/uploads", { name: "shot.png", type: "image/png", data: png.toString("base64") });
    assert(r.status === 200, `upload ${r.status} ${r.body}`);
    uploaded = json(r).path;
    assert(uploaded.startsWith(WORK + "/uploads/"), `path ${uploaded}`);
  });

  await test("GET /m/v1/file returns exact image bytes (PNG, 300 KB binary)", async () => {
    const file = path.join(WORK, "mobile-test", "pic.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(300 * 1024)]);
    fs.writeFileSync(file, bytes);
    const r = await phone.call("GET", `/m/v1/file?path=${encodeURIComponent(file)}`);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.headers["content-type"] === "image/png", `content-type ${r.headers["content-type"]}`);
    assert(r.body.equals(bytes), `bytes differ (${r.body.length} vs ${bytes.length})`);
    const u = await phone.call("GET", `/m/v1/file?path=${encodeURIComponent(uploaded)}`);
    assert(u.status === 200 && u.body.equals(fs.readFileSync(uploaded)), "uploaded file bytes");
    const denied = await phone.call("GET", `/m/v1/file?path=${encodeURIComponent("/etc/passwd")}`);
    assert(denied.status === 403, `outside /agents,/work → ${denied.status}`);
  });

  await test("upstream 404 becomes 410 (404 only ever means unauthenticated/not allowed)", async () => {
    const r = await phone.call("GET", "/m/v1/work/no-such-room");
    assert(r.status === 410, `room → ${r.status}`);
    const f = await phone.call("GET", `/m/v1/file?path=${encodeURIComponent(WORK + "/nope.png")}`);
    assert(f.status === 410, `missing file → ${f.status}`);
    const t = await phone.call("POST", "/m/v1/agents/no-such-agent/done");
    assert(t.status === 410, `done on missing agent → ${t.status}`);
  });

  await test("phone file reads are audited (once per file per 10 min)", async () => {
    const act = json(await portal("GET", "/api/activity?limit=50"));
    const rows = act.filter((i: any) => i.kind === "phone" && i.title === "opened pic.png" && i.ts >= SUITE_START);
    assert(rows.length === 1 && rows[0].detail === "via phone (Test phone)", `rows ${rows.length}`);
  });

  await test("upload body limit: 3 MB to uploads passes the gateway; 17 MB → 404; 2 MB elsewhere → 404", async () => {
    // 3 MB of a non-image type: passes the 16 MB gateway limit, then the API refuses it (400), nothing written.
    const mid = await phone.call("POST", "/m/v1/uploads", { name: "x.txt", type: "text/plain", data: randomBytes(2_300_000).toString("base64") });
    assert(mid.status === 400, `3 MB upload → ${mid.status}`);
    let big: Res | null = null;
    try {
      big = await phone.call("POST", "/m/v1/uploads", Buffer.alloc(17 * 1024 * 1024, 0x61));
    } catch (e: any) {
      return `17 MB: connection closed by server (${e.code})`; // also a refusal
    }
    isEmpty404(big, "17 MB upload");
    isEmpty404(await phone.call("POST", "/m/v1/work", Buffer.alloc(2 * 1024 * 1024, 0x61)), "2 MB to /work");
  });

  await test("POST /m/v1/work creates a task (agents paused), audited with link", async () => {
    const st = json(await phone.call("GET", "/m/v1/state"));
    const role = st.agents.find((a: any) => !a.base_agent_id);
    if (!role) return "skipped: no agent in this database";
    const r = await phone.call("POST", "/m/v1/work", { role_id: role.id, text: "Mobile gateway rehearsal task (ignore)" });
    assert(r.status === 200, `work ${r.status} ${r.body}`);
    const act = json(await portal("GET", "/api/activity?limit=50"));
    const row = act.find((i: any) => i.kind === "phone" && i.title === "started a task");
    assert(row && row.link === `#/work/${json(r).id}`, "audit link");
  });

  await test("WebSocket: signed connect receives events; closed on revoke", async () => {
    const ws = new WebSocket(`ws://${GATEWAY.host}/m/v1/events`, { headers: { "tailscale-user-login": LOGIN, ...phone.sign("GET", "/m/v1/events") } });
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade ${r.statusCode}`))); });
    const seen: string[] = [];
    const got = new Promise<any>((res) => ws.on("message", (m) => { const e = JSON.parse(String(m)); seen.push(e.type); if (e.type === "paused") res(e); }));
    // Portal-only events must not reach the phone: create and delete a skill (skill.updated/deleted).
    const sk = await portal("POST", "/api/skills", { name: "mobile-gateway-test", description: "rehearsal", body: "Ignore." });
    assert(sk.status === 200, `create skill ${sk.status} ${sk.body}`);
    await portal("DELETE", "/api/skills/mobile-gateway-test");
    await phone.call("POST", "/m/v1/pause", { stopRunning: false });
    const e = await Promise.race([got, sleep(3000).then(() => null)]);
    assert(e && e.paused === true, "no paused event");
    const leaked = seen.filter((t) => /^(skill|draft|devices)\.|^agent\.skills$/.test(t));
    assert(!leaked.length, `portal-only events reached the phone: ${leaked.join(",")}`);
    const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
    const r = await portal("POST", `/api/devices/${phone.id}/revoke`, {});
    assert(r.status === 200, `revoke ${r.status}`);
    const code = await Promise.race([closed, sleep(3000).then(() => -1)]);
    assert(code !== -1, "socket not closed after revoke");
    return `closed with ${code}`;
  });

  await test("revoked device → 404 (whoami and API)", async () => {
    isEmpty404(await phone.call("GET", "/m/v1/whoami"), "whoami");
    isEmpty404(await phone.call("GET", "/m/v1/state"), "state");
  });

  await test("WebSocket: unsigned / bad signature / with Origin → refused", async () => {
    const p2 = await pairAndApprove("WS phone");
    const tryWs = (headers: Record<string, string>) => new Promise<string>((res) => {
      const ws = new WebSocket(`ws://${GATEWAY.host}/m/v1/events`, { headers: { "tailscale-user-login": LOGIN, ...headers } });
      ws.once("open", () => { ws.close(); res("open"); });
      ws.once("unexpected-response", (_q, r) => res(String(r.statusCode)));
      ws.once("error", () => res("error"));
    });
    assert((await tryWs({})) === "404", "unsigned");
    const h = p2.sign("GET", "/m/v1/events");
    assert((await tryWs({ ...h, "x-ab-sig": b64u(randomBytes(64)) })) === "404", "bad sig");
    assert((await tryWs({ ...p2.sign("GET", "/m/v1/events"), origin: "https://evil.example" })) === "404", "origin");
    assert((await tryWs(p2.sign("GET", "/m/v1/events"))) === "open", "valid one opens");
    assert((await tryWs({ ...p2.sign("GET", "/m/v1/events"), origin: "" })) === "open", "empty Origin opens");
    await portal("POST", `/api/devices/${p2.id}/revoke`, {});
  });

  await test("Tailscale-User-Login binding: recorded at pairing, must match after", async () => {
    const p3 = new Phone();
    const p = await newPairing();
    const c = await claimRaw({ "content-type": "application/json", "tailscale-user-login": "owner@example.com" },
      Buffer.from(JSON.stringify({ code: p.code, public_key: b64u(p3.pk), device_name: "TS phone" })));
    assert(c.status === 202, `claim ${c.status}`);
    p3.id = json(c).device_id;
    await portal("POST", `/api/devices/${p3.id}/approve`, {});
    const ok = await p3.call("GET", "/m/v1/whoami", undefined, { "tailscale-user-login": "owner@example.com" });
    assert(ok.status === 200, `matching login ${ok.status}`);
    isEmpty404(await p3.call("GET", "/m/v1/whoami", undefined, { "tailscale-user-login": "someone@else.com" }), "other login");
    p3.login = null;
    isEmpty404(await p3.call("GET", "/m/v1/whoami"), "missing login");
    await portal("POST", `/api/devices/${p3.id}/revoke`, {});
  });

  await test("claim without Tailscale-User-Login → 404 (and the code still works)", async () => {
    const p = await newPairing();
    const anon = new Phone();
    anon.login = null;
    isEmpty404(await anon.claim(p.code), "no login");
    const ok = await new Phone().claim(p.code);
    assert(ok.status === 202, `claim with login → ${ok.status}`);
    await portal("POST", `/api/devices/${json(ok).device_id}/deny`, {});
  });

  await test("device names lose bidi/zero-width (\\p{Cf}) and control characters", async () => {
    const p = await newPairing();
    const ph = new Phone();
    const c = await ph.claim(p.code, "Evil\u202Egnp.exe\u200B\u2066x\u0007y");
    assert(c.status === 202, `claim ${c.status}`);
    const d = json(await portal("GET", "/api/devices")).pending.find((x: any) => x.id === json(c).device_id);
    assert(d && d.name === "Evilgnp.exex y", `name ${JSON.stringify(d?.name)}`);
    await portal("POST", `/api/devices/${d.id}/deny`, {});
  });

  await test("regenerating a code invalidates the previous one", async () => {
    const a = await newPairing(false);
    await newPairing();
    isEmpty404(await new Phone().claim(a.code));
  });

  await test("claim with an invalid public key burns the code", async () => {
    const p = await newPairing();
    const bad = await claimRaw({ "content-type": "application/json", "tailscale-user-login": LOGIN },
      Buffer.from(JSON.stringify({ code: p.code, public_key: "short", device_name: "x" })));
    isEmpty404(bad, "bad key");
    isEmpty404(await new Phone().claim(p.code), "code reused after failed claim");
  });

  await test(`pairing code expires (TTL ${PAIRING_TTL} ms)`, async () => {
    const p = await newPairing();
    await sleep(PAIRING_TTL + 500);
    isEmpty404(await new Phone().claim(p.code));
  });

  await test(`pending device expires (TTL ${PENDING_TTL} ms)`, async () => {
    const p4 = new Phone();
    const p = await newPairing();
    const c = await p4.claim(p.code);
    assert(c.status === 202, `claim ${c.status}`);
    p4.id = json(c).device_id;
    assert((await p4.call("GET", "/m/v1/whoami")).status === 200, "pending whoami");
    await sleep(PENDING_TTL + 500);
    isEmpty404(await p4.call("GET", "/m/v1/whoami"), "expired pending");
    const a = await portal("POST", `/api/devices/${p4.id}/approve`, {});
    assert(a.status === 404, `approve after expiry → ${a.status}`);
  });

  await test("POST /m/v1/device/forget → 204, device gone, its socket closed, audited", async () => {
    const p7 = await pairAndApprove("Forget phone");
    const ws = new WebSocket(`ws://${GATEWAY.host}/m/v1/events`, { headers: { "tailscale-user-login": LOGIN, ...p7.sign("GET", "/m/v1/events") } });
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
    const closed = new Promise<number>((res) => ws.once("close", (c) => res(c)));
    isEmpty404(await p7.call("GET", "/m/v1/device/forget"), "GET forget");
    const r = await p7.call("POST", "/m/v1/device/forget");
    assert(r.status === 204 && r.body.length === 0, `forget → ${r.status}`);
    assert((await Promise.race([closed, sleep(3000).then(() => -1)])) !== -1, "socket not closed");
    isEmpty404(await p7.call("GET", "/m/v1/whoami"), "whoami after forget");
    isEmpty404(await p7.call("POST", "/m/v1/device/forget"), "forget twice");
    const d = json(await portal("GET", "/api/devices"));
    assert(!d.active.some((x: any) => x.id === p7.id), "still listed");
    const act = json(await portal("GET", "/api/activity?limit=20"));
    assert(act.some((i: any) => i.kind === "phone" && i.title === "unpaired the phone" && i.detail === "via phone (Forget phone)"), "audit row");
    // A pending device may withdraw itself too.
    const p8 = new Phone();
    const c = await p8.claim((await newPairing()).code);
    p8.id = json(c).device_id;
    const f = await p8.call("POST", "/m/v1/device/forget");
    assert(f.status === 204, `pending forget → ${f.status}`);
  });

  await test("revoke-all removes every device", async () => {
    const p5 = await pairAndApprove("Revoke-all phone");
    assert((await p5.call("GET", "/m/v1/whoami")).status === 200, "before");
    const r = await portal("POST", "/api/devices/revoke-all", {});
    assert(r.status === 200, `revoke-all ${r.status}`);
    isEmpty404(await p5.call("GET", "/m/v1/whoami"), "after");
    const d = json(await portal("GET", "/api/devices"));
    assert(d.pending.length === 0 && d.active.length === 0, "list empty");
  });

  await test("rate limit: 600 signed requests per minute per device, then 404", async () => {
    const p6 = await pairAndApprove("Rate phone");
    // Parallel batches, so all 605 land well inside one minute even on a busy VM.
    const t0 = Date.now();
    let ok = 0, refused = 0;
    for (let i = 0; i < 605; i += 55) {
      const batch = await Promise.all(Array.from({ length: Math.min(55, 605 - i) }, () => p6.call("GET", "/m/v1/whoami")));
      for (const r of batch) r.status === 200 ? ok++ : (isEmpty404(r), refused++);
    }
    const secs = (Date.now() - t0) / 1000;
    assert(secs < 55, `took ${secs}s: too slow to test a one-minute window`);
    assert(ok === 600 && refused === 5, `ok=${ok} refused=${refused} in ${secs}s`);
    await portal("POST", `/api/devices/${p6.id}/revoke`, {});
    return `605 requests in ${secs.toFixed(1)}s`;
  });

  // Last: it uses up the global claim budget for a minute.
  await test("rate limit: pairing claims, 10 per minute per tailnet user", async () => {
    // Start from an empty window.
    const last = Math.max(0, ...claimTimes);
    await sleep(Math.max(0, 61_000 - (Date.now() - last)));
    const statuses: number[] = [];
    const claimAs = async (login: string) => {
      const p = await newPairing(false);
      const r = await request(GATEWAY, "POST", "/m/pair/claim", { "content-type": "application/json", "tailscale-user-login": login },
        Buffer.from(JSON.stringify({ code: p.code, public_key: b64u(new Phone().pk), device_name: "rate" })));
      return r.status;
    };
    for (let i = 0; i < 12; i++) statuses.push(await claimAs(LOGIN));
    assert(statuses.slice(0, 10).every((s) => s === 202) && statuses.slice(10).every((s) => s === 404), statuses.join(","));
    // Buckets are per tailnet user: someone else on the tailnet isn't blocked by this one.
    const other = await claimAs("someone-else@example.com");
    assert(other === 202, `other user's claim → ${other}`);
    await portal("POST", "/api/devices/revoke-all", {});
    return `statuses ${statuses.join(",")}`;
  });

  await portal("PUT", "/api/devices/gateway", { url: "" });

  const w = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}${r.note ? `  (${r.note})` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
