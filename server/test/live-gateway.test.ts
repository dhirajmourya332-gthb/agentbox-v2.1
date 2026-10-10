/**
 * Live progress and "needs you" end to end, against a REHEARSAL server (never the live one): rows
 * seeded straight into the rehearsal database, then checked over the portal API and WebSocket and
 * through the phone gateway with signed requests. Start the server with a short stall time and
 * tick, e.g.
 *
 *   AGENTBOX_STALL_MIN=1 AGENTBOX_PROGRESS_TICK_MS=2000 PORT=7792 AGENTBOX_MOBILE_PORT=7793 …
 *
 * then:
 *
 *   PORTAL=http://127.0.0.1:7792 GATEWAY=http://127.0.0.1:7793 DB=/tmp/live-rt/data/agentbox.db \
 *     node --disable-warning=ExperimentalWarning --import tsx test/live-gateway.test.ts
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import WebSocket from "ws";

const PORTAL = new URL(process.env.PORTAL ?? "http://127.0.0.1:7792");
const GATEWAY = new URL(process.env.GATEWAY ?? "http://127.0.0.1:7793");
const DB = process.env.DB ?? "/tmp/live-rt/data/agentbox.db";
const LOGIN = "owner@example.com";
if (/:(7700|7710)$/.test(PORTAL.host) || /:(7700|7710)$/.test(GATEWAY.host) || DB.startsWith("/opt/")) {
  console.error("Refusing to run against the live server or database. Use a rehearsal copy.");
  process.exit(2);
}

type Res = { status: number; body: Buffer };
function request(base: URL, method: string, p: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: base.hostname, port: base.port, method, path: p, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = (r: Res) => JSON.parse(r.body.toString("utf8"));
const portal = (method: string, p: string, body?: unknown) =>
  request(PORTAL, method, p, body === undefined ? {} : { "content-type": "application/json" }, body === undefined ? undefined : Buffer.from(JSON.stringify(body)));

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
class Phone {
  sk = ed25519.utils.randomSecretKey();
  pk = ed25519.getPublicKey(this.sk);
  id = "";
  sign(method: string, p: string, body: Buffer = Buffer.alloc(0)) {
    const time = String(Date.now()), nonce = b64u(randomBytes(16));
    const msg = ["AB1", method, p, time, nonce, b64u(sha256(body))].join("\n");
    return { "tailscale-user-login": LOGIN, "x-ab-device": this.id, "x-ab-time": time, "x-ab-nonce": nonce, "x-ab-sig": b64u(ed25519.sign(Buffer.from(msg), this.sk)) };
  }
  call(method: string, p: string, body?: unknown) {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return request(GATEWAY, method, p, { ...this.sign(method, p, raw), ...(raw ? { "content-type": "application/json" } : {}) }, raw);
  }
}

const results: { name: string; ok: boolean; note?: string }[] = [];
async function test(name: string, fn: () => Promise<void | string>) {
  try { const note = await fn(); results.push({ name, ok: true, note: note || undefined }); } catch (e: any) { results.push({ name, ok: false, note: e?.message ?? String(e) }); }
}
function assert(c: unknown, msg: string): asserts c { if (!c) throw new Error(msg); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** Collect events from a socket; wait for one matching `pred`. */
function collector(ws: WebSocket) {
  const seen: any[] = [];
  ws.on("message", (m) => seen.push(JSON.parse(String(m))));
  return {
    seen,
    async wait(pred: (e: any) => boolean, ms = 12_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const e = seen.find(pred);
        if (e) return e;
        await sleep(200);
      }
      throw new Error(`no matching event within ${ms} ms; saw ${[...new Set(seen.map((e) => e.type))].join(", ")}`);
    },
  };
}
const open = (ws: WebSocket) => new Promise<void>((res, rej) => {
  ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade ${r.statusCode}`)));
});

async function main() {
  const db = new DatabaseSync(DB);
  const portalWs = new WebSocket(`ws://${PORTAL.host}/api/events`);
  await open(portalWs);
  const pe = collector(portalWs);

  // A role and an owner-started task (agents are paused in the rehearsal, so it stays queued).
  const role = await portal("POST", "/api/agents", { name: `Live-${Date.now() % 100000}`, title: "Rehearsal", summary: "Rehearsal", model: "haiku", instructions: "Rehearsal agent.", interview: {} });
  assert(role.status === 200, `create agent ${role.status} ${role.body}`);
  const inst = await portal("POST", "/api/work", { role_id: json(role).id, text: "Ship partner API keys" });
  assert(inst.status === 200, `new task ${inst.status} ${inst.body}`);
  const instance = json(inst);
  const roomView = json(await portal("GET", `/api/work/${instance.id}`));
  const taskId: string = roomView.tasks[0].id;

  const checks = ["server unit tests\tfail\t3m\thttps://x/1", "Swagger drift\tfail\t1m\thttps://x/2", "claude-review\tfail\t1m\thttps://x/3",
    ...["e2e", "lint", "preview", "security", "docs"].map((n) => `${n}\tpending\t0\thttps://x/${n}`)].join("\n");
  db.prepare(`UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`).run(ago(6), taskId);
  const step = (seq: number, command: string, o: { status: string; started: number; finished?: number; output?: string }) => {
    const id = `rt-${randomBytes(6).toString("hex")}`;
    db.prepare(`INSERT INTO steps (id, task_id, seq, kind, name, summary, input, output, status, started_at, finished_at) VALUES (?, ?, ?, 'shell', 'Shell', ?, ?, ?, ?, ?, ?)`)
      .run(id, taskId, seq, command.split("\n")[0], JSON.stringify({ command }), o.output ?? null, o.status, ago(o.started), o.finished === undefined ? null : ago(o.finished));
    return id;
  };
  step(0, "gh pr checks 4984", { status: "done", started: 5, finished: 4.9, output: checks });
  const watch = step(1, "cd /work/web-app-4950 && gh pr checks 4984 --watch", { status: "running", started: 2 });

  let stalledItem: any;
  await test("portal socket: progress.updated (activity, stalled, summary) and attention.updated (stalled)", async () => {
    const e = await pe.wait((x) => x.type === "progress.updated" && x.progress.task_id === taskId && x.progress.state === "stalled");
    const p = e.progress;
    assert(p.activity === "Waiting on CI for PR #4984", `activity ${p.activity}`);
    assert(p.root_id === instance.id && p.group_id === null, `room ${p.root_id}`);
    assert(p.summary === "3 checks failed: server unit tests, Swagger drift, claude-review; 5 pending", `summary ${p.summary}`);
    const a = await pe.wait((x) => x.type === "attention.updated" && x.item.kind === "stalled" && x.item.task_id === taskId);
    stalledItem = a.item;
    assert(stalledItem.room_id === instance.id && !stalledItem.seen_at, JSON.stringify(stalledItem));
    return `${p.activity} · stalled ${p.stalled_for_s}s`;
  });

  await test("GET /api/progress and /api/attention", async () => {
    const list = json(await portal("GET", "/api/progress"));
    assert(list.some((p: any) => p.task_id === taskId && p.state === "stalled"), "progress list");
    const att = json(await portal("GET", "/api/attention"));
    assert(Array.isArray(att.items) && att.items.some((i: any) => i.id === stalledItem?.id), "attention list");
  });

  const phone = new Phone();
  await test("phone: pair and approve (rehearsal gateway URL)", async () => {
    await portal("PUT", "/api/devices/gateway", { url: "https://agentbox.rehearsal.ts.net" });
    const p = json(await portal("POST", "/api/devices/pairings", {}));
    const c = await request(GATEWAY, "POST", "/m/pair/claim", { "content-type": "application/json", "tailscale-user-login": LOGIN },
      Buffer.from(JSON.stringify({ code: p.code, public_key: b64u(phone.pk), device_name: "Live test", app_version: "0.0.1-test" })));
    assert(c.status === 202, `claim ${c.status}`);
    phone.id = json(c).device_id;
    const a = await portal("POST", `/api/devices/${phone.id}/approve`, {});
    assert(a.status === 200, `approve ${a.status}`);
  });

  let phoneEvents: ReturnType<typeof collector> | null = null;
  let phoneWs: WebSocket | null = null;
  await test("phone: signed GET /m/v1/progress and /m/v1/attention return the same records", async () => {
    const pr = await phone.call("GET", "/m/v1/progress");
    assert(pr.status === 200, `progress ${pr.status}`);
    const mine = json(pr).find((p: any) => p.task_id === taskId);
    assert(mine && mine.activity === "Waiting on CI for PR #4984" && mine.state === "stalled", JSON.stringify(mine));
    const at = await phone.call("GET", "/m/v1/attention");
    assert(at.status === 200 && json(at).items.some((i: any) => i.id === stalledItem?.id), `attention ${at.status}`);
    phoneWs = new WebSocket(`ws://${GATEWAY.host}/m/v1/events`, { headers: phone.sign("GET", "/m/v1/events") });
    await open(phoneWs);
    phoneEvents = collector(phoneWs);
  });

  await test("resume: a new step → progress working on both sockets; the stall item is cleared (seen)", async () => {
    db.prepare(`UPDATE steps SET status = 'done', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), watch);
    db.prepare(`INSERT INTO steps (id, task_id, seq, kind, name, summary, input, status, started_at) VALUES (?, ?, 2, 'read', 'Read', '/work/web-app-4950/src/app.ts', '{}', 'running', ?)`)
      .run(`rt-${randomBytes(6).toString("hex")}`, taskId, new Date().toISOString());
    const working = (x: any) => x.type === "progress.updated" && x.progress.task_id === taskId && x.progress.state === "working";
    const e = await pe.wait(working);
    assert(e.progress.activity === "Reading app.ts", `activity ${e.progress.activity}`);
    await phoneEvents!.wait(working);
    const cleared = await pe.wait((x) => x.type === "attention.updated" && x.item.id === stalledItem?.id && x.item.seen_at);
    await phoneEvents!.wait((x) => x.type === "attention.updated" && x.item.id === stalledItem?.id && x.item.seen_at);
    return `cleared at ${cleared.item.seen_at}`;
  });

  await test("turn ends → progress.cleared (portal and phone)", async () => {
    db.prepare(`UPDATE steps SET status = 'done', finished_at = ? WHERE task_id = ? AND status = 'running'`).run(new Date().toISOString(), taskId);
    db.prepare(`UPDATE tasks SET status = 'done', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), taskId);
    const gone = (x: any) => x.type === "progress.cleared" && x.task_id === taskId;
    await pe.wait(gone);
    await phoneEvents!.wait(gone);
    const list = json(await portal("GET", "/api/progress"));
    assert(!list.some((p: any) => p.task_id === taskId), "still listed");
  });

  await test("phone: POST attention/:id/seen, seen-room/:id, seen-all → 200; unknown id → 410", async () => {
    // A fresh unseen item to mark (rows straight into the rehearsal DB, like the steps above).
    const mk = (kind: string) => {
      const id = `rt-${randomBytes(6).toString("hex")}`;
      db.prepare(`INSERT INTO attention (id, kind, agent_id, task_id, room_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, kind, instance.id, taskId, instance.id, `${instance.name} replied: rehearsal`, new Date().toISOString());
      return id;
    };
    const one = mk("reply");
    const r1 = await phone.call("POST", `/m/v1/attention/${one}/seen`);
    assert(r1.status === 200 && json(r1).seen_at, `seen ${r1.status} ${r1.body}`);
    await pe.wait((x) => x.type === "attention.updated" && x.item.id === one && x.item.seen_at);
    mk("failed");
    const r2 = await phone.call("POST", `/m/v1/attention/seen-room/${instance.id}`);
    assert(r2.status === 200 && json(r2).seen === 1, `seen-room ${r2.status} ${r2.body}`);
    mk("reply");
    const r3 = await phone.call("POST", "/m/v1/attention/seen-all");
    assert(r3.status === 200 && json(r3).seen >= 1, `seen-all ${r3.status} ${r3.body}`);
    const r4 = await phone.call("POST", "/m/v1/attention/nope/seen");
    assert(r4.status === 410, `unknown ${r4.status}`);
    const left = json(await portal("GET", "/api/attention")).items.filter((i: any) => !i.seen_at).length;
    assert(left === 0, `${left} unseen left`);
  });

  await test("phone: attention routes outside the allowlist → empty 404", async () => {
    for (const [m, p] of [["GET", "/m/v1/attention/x"], ["POST", "/m/v1/attention"], ["GET", "/m/v1/progress/x"], ["POST", "/m/v1/progress"]] as const) {
      const r = await phone.call(m, p);
      assert(r.status === 404 && r.body.length === 0, `${m} ${p} → ${r.status}`);
    }
  });

  (phoneWs as WebSocket | null)?.close();
  portalWs.close();
  await portal("POST", `/api/devices/${phone.id}/revoke`, {});
  await portal("PUT", "/api/devices/gateway", { url: "" });
  db.close();

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `  (${r.note})` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
