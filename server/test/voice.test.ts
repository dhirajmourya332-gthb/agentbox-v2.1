/**
 * Voice input (POST /api/voice/transcribe, docs/CONTRACTS-v2.md C) against a REHEARSAL server and a
 * mock Z.ai server this script runs itself. Never the live server, never the real Z.ai API.
 *
 *   ZAI_ENV=/tmp/voice-rt/zai.env PORTAL=http://127.0.0.1:7794 GATEWAY=http://127.0.0.1:7795 \
 *   WORK=/tmp/voice-rt/work MOCK_PORT=17796 node --import tsx test/voice.test.ts
 *
 * The rehearsal server must be started with AGENTBOX_ZAI_ENV=$ZAI_ENV; this script writes that file
 * (pointing at the mock) and removes it for the "not configured" case. Needs ffmpeg for test audio.
 * Recipe: docs/MOBILE-SETUP.md › Testing, with the ports above.
 *
 * The server allows 20 transcriptions a minute; this suite makes about a dozen.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const PORTAL = new URL(process.env.PORTAL ?? "http://127.0.0.1:7794");
const GATEWAY = new URL(process.env.GATEWAY ?? "http://127.0.0.1:7795");
const ZAI_ENV = process.env.ZAI_ENV ?? "/tmp/voice-rt/zai.env";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 17796);
const WORK = process.env.WORK ?? "/tmp/voice-rt/work";
const LOGIN = "owner@example.com";
const SUITE_START = new Date().toISOString();

if (/:(7700|7710)$/.test(PORTAL.host) || /:(7700|7710)$/.test(GATEWAY.host)) {
  console.error("Refusing to run against the live ports (7700/7710). Use a rehearsal server.");
  process.exit(2);
}

// --- HTTP -----------------------------------------------------------------------------------------

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
function request(base: URL, method: string, p: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: base.hostname, port: base.port, method, path: p, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (res) => {
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
  request(PORTAL, method, p, body === undefined ? {} : { "content-type": "application/json" }, body === undefined ? undefined : Buffer.from(JSON.stringify(body)));

// --- a signed phone (as in mobile-gateway.test.ts) ----------------------------------------------

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
class Phone {
  sk = ed25519.utils.randomSecretKey();
  pk = ed25519.getPublicKey(this.sk);
  id = "";
  call(method: string, p: string, body?: unknown) {
    const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const time = String(Date.now());
    const nonce = b64u(randomBytes(16));
    const msg = ["AB1", method, p, time, nonce, b64u(sha256(raw ?? Buffer.alloc(0)))].join("\n");
    return request(GATEWAY, method, p, {
      "tailscale-user-login": LOGIN, "x-ab-device": this.id, "x-ab-time": time, "x-ab-nonce": nonce,
      "x-ab-sig": b64u(ed25519.sign(Buffer.from(msg, "utf8"), this.sk)), ...(raw ? { "content-type": "application/json" } : {}),
    }, raw);
  }
}
async function pairAndApprove(name: string) {
  const g = await portal("PUT", "/api/devices/gateway", { url: "https://agentbox.rehearsal.ts.net" });
  if (g.status !== 200) throw new Error(`set gateway url: ${g.status}`);
  const p = json(await portal("POST", "/api/devices/pairings", {}));
  const phone = new Phone();
  const c = await request(GATEWAY, "POST", "/m/pair/claim", { "content-type": "application/json", "tailscale-user-login": LOGIN },
    Buffer.from(JSON.stringify({ code: p.code, public_key: b64u(phone.pk), device_name: name, app_version: "0.0.1-test" })));
  if (c.status !== 202) throw new Error(`claim: ${c.status}`);
  phone.id = json(c).device_id;
  const a = await portal("POST", `/api/devices/${phone.id}/approve`, {});
  if (a.status !== 200) throw new Error(`approve: ${a.status}`);
  return phone;
}

// --- the mock Z.ai server -------------------------------------------------------------------------

type AsrCall = { auth: string; model: string; stream: string; prompt: string; hotwords: string[]; hotwordsRaw: string[]; seconds: number; wavOk: boolean };
const asrCalls: AsrCall[] = [];
const chatCalls: any[] = [];

function wavInfo(b: Buffer) {
  const ok = b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE" && b.readUInt16LE(20) === 1
    && b.readUInt16LE(22) === 1 && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16;
  return { ok, seconds: ok ? b.readUInt32LE(40) / 32000 : 0 };
}

const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const send = (status: number, obj: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.url === "/asr") {
    const form = await new Request("http://x/", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body }).formData();
    const file = form.get("file") as File;
    const info = wavInfo(Buffer.from(await file.arrayBuffer()));
    const hotwordsRaw = [...form.getAll("hotwords"), ...form.getAll("hotwords[]")].map(String);
    let hotwords: string[] = [];
    try { hotwords = JSON.parse(hotwordsRaw[0] ?? "[]"); } catch { hotwords = hotwordsRaw; }
    const prompt = String(form.get("prompt") ?? "");
    asrCalls.push({ auth: String(req.headers.authorization), model: String(form.get("model")), stream: String(form.get("stream")), prompt, hotwords, hotwordsRaw, seconds: info.seconds, wavOk: info.ok });
    const n = prompt ? prompt.split(" ").length / 2 + 1 : 1; // each part is two words
    return send(200, { id: "x", created: 0, model: "glm-asr-2512", text: `um part${n}` });
  }
  if (req.url === "/chat") {
    const b = JSON.parse(body.toString("utf8"));
    chatCalls.push({ auth: String(req.headers.authorization), ...b });
    const t = String(b.messages?.[1]?.content ?? "").replace(/<\/?transcript>/g, "").trim();
    return send(200, { choices: [{ message: { role: "assistant", content: t.replace(/\bum /g, "") } }] });
  }
  if (req.url === "/chat-fail") return send(500, { error: { message: "boom" } });
  send(404, {});
});

const writeEnv = (chatPath = "/chat", extra = "") => fs.writeFileSync(ZAI_ENV, [
  "ZAI_API_KEY=test-asr-key",
  `ZAI_ASR_URL=http://127.0.0.1:${MOCK_PORT}/asr`,
  `ZAI_CHAT_URL=http://127.0.0.1:${MOCK_PORT}${chatPath}`,
  "ZAI_CHAT_KEY=test-chat-key",
  extra,
].join("\n") + "\n", { mode: 0o600 });

// --- audio --------------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
function tone(seconds: number, ext: string, codec: string[]) {
  const out = path.join(tmp, `t${seconds}${ext}`);
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ac", "1", ...codec, out]);
  return fs.readFileSync(out).toString("base64");
}

// --- results --------------------------------------------------------------------------------------------

const results: { name: string; ok: boolean; note?: string }[] = [];
async function test(name: string, fn: () => Promise<void | string>) {
  try { results.push({ name, ok: true, note: (await fn()) || undefined }); } catch (e: any) { results.push({ name, ok: false, note: e?.message ?? String(e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const transcribe = (body: unknown) => portal("POST", "/api/voice/transcribe", body);

async function main() {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  fs.mkdirSync(path.join(WORK, "acme", "web-app", ".git"), { recursive: true });
  const state = json(await portal("GET", "/api/state"));
  const role = state.agents.find((a: any) => !a.base_agent_id);

  await test("no config → 503", async () => {
    fs.rmSync(ZAI_ENV, { force: true });
    const r = await transcribe({ audio: "AAAA", mime: "audio/wav", purpose: "message" });
    assert(r.status === 503 && json(r).error === "Voice isn't set up", `${r.status} ${r.body}`);
  });
  writeEnv();

  await test("bad mime → 400, bad purpose → 400, empty audio → 400", async () => {
    const a = await transcribe({ audio: "AAAA", mime: "text/plain", purpose: "message" });
    assert(a.status === 400, `mime ${a.status}`);
    const b = await transcribe({ audio: "AAAA", mime: "audio/wav", purpose: "email" });
    assert(b.status === 400, `purpose ${b.status}`);
    const c = await transcribe({ audio: "", mime: "audio/wav", purpose: "message" });
    assert(c.status === 400, `empty ${c.status}`);
    assert(asrCalls.length === 0, "no provider call for bad input");
  });

  await test("70 s MP3 → 3 segments (≤ 28 s WAV 16 kHz mono), prompt continuity, hotwords, keys, cleanup", async () => {
    asrCalls.length = 0; chatCalls.length = 0;
    const r = await transcribe({ audio: tone(70, ".mp3", ["-b:a", "32k"]), mime: "audio/mpeg", purpose: "task", agent_id: role?.id });
    assert(r.status === 200, `${r.status} ${r.body}`);
    const out = json(r);
    assert(asrCalls.length === 3, `segments ${asrCalls.length}`);
    assert(asrCalls.every((c) => c.wavOk && c.seconds <= 28.01), `wav ${asrCalls.map((c) => c.seconds)}`);
    assert(Math.abs(asrCalls.reduce((s, c) => s + c.seconds, 0) - 70) < 0.5, "total length");
    assert(asrCalls[0].prompt === "" && asrCalls[1].prompt === "um part1" && asrCalls[2].prompt === "um part1 um part2", `prompts ${asrCalls.map((c) => JSON.stringify(c.prompt))}`);
    assert(asrCalls.every((c) => c.auth === "Bearer test-asr-key" && c.model === "glm-asr-2512" && c.stream === "false"), "asr auth/model/stream");
    const hw = asrCalls[0].hotwords;
    assert(asrCalls[0].hotwordsRaw.length === 1, "hotwords sent as one JSON field");
    assert(hw.includes("Dependabot") && hw.includes("Swagger") && hw.includes("web-app") && hw.includes("acme"), `hotwords ${hw.join(",")}`);
    if (role) assert(hw[0] === role.name, `agent first: ${hw[0]}`);
    assert(hw.length <= 100 && !hw.includes("uploads"), "hotword cap / no uploads");
    assert(chatCalls.length === 1 && chatCalls[0].auth === "Bearer test-chat-key" && chatCalls[0].model === "glm-5.3-flash", "chat call");
    assert(/new task/.test(chatCalls[0].messages[0].content) && /#1234/.test(chatCalls[0].messages[0].content), "cleanup prompt");
    assert(out.raw === "um part1 um part2 um part3" && out.text === "part1 part2 part3" && out.cleaned === true, JSON.stringify(out));
    assert(Math.abs(out.duration_s - 70) < 0.5, `duration ${out.duration_s}`);
  });

  await test("12 s WebM/Opus (as MediaRecorder sends it, mime with codecs) → 1 segment", async () => {
    asrCalls.length = 0;
    const r = await transcribe({ audio: tone(12, ".webm", ["-c:a", "libopus", "-b:a", "32k"]), mime: "audio/webm;codecs=opus", purpose: "message" });
    assert(r.status === 200 && asrCalls.length === 1 && json(r).cleaned === true, `${r.status} ${r.body} calls=${asrCalls.length}`);
  });

  await test("cleanup failure → raw text, cleaned: false", async () => {
    writeEnv("/chat-fail");
    const r = await transcribe({ audio: tone(4, ".m4a", ["-c:a", "aac", "-b:a", "48k"]), mime: "audio/mp4", purpose: "message" });
    writeEnv();
    assert(r.status === 200, `${r.status} ${r.body}`);
    const out = json(r);
    assert(out.cleaned === false && out.text === "um part1" && out.raw === "um part1", JSON.stringify(out));
  });

  await test("ASR failure → 502", async () => {
    fs.writeFileSync(ZAI_ENV, `ZAI_API_KEY=k\nZAI_ASR_URL=http://127.0.0.1:${MOCK_PORT}/nope\n`);
    const r = await transcribe({ audio: tone(3, ".wav", []), mime: "audio/wav", purpose: "message" });
    writeEnv();
    assert(r.status === 502, `${r.status} ${r.body}`);
  });

  await test("over 5 min → 413 (nothing sent to the provider)", async () => {
    asrCalls.length = 0;
    const r = await transcribe({ audio: tone(310, ".mp3", ["-b:a", "8k"]), mime: "audio/mpeg", purpose: "message" });
    assert(r.status === 413 && asrCalls.length === 0, `${r.status} ${r.body}`);
  });

  await test("over 15 MB (but under the 21 MB body limit) → 413", async () => {
    const r = await transcribe({ audio: randomBytes(15.5 * 1024 * 1024).toString("base64"), mime: "audio/mpeg", purpose: "message" });
    assert(r.status === 413, `${r.status}`);
  });

  await test("garbage audio → 400", async () => {
    const r = await transcribe({ audio: randomBytes(4000).toString("base64"), mime: "audio/wav", purpose: "message" });
    assert(r.status === 400, `${r.status} ${r.body}`);
  });

  await test("temp dirs are removed", async () => {
    const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("agentbox-voice-"));
    assert(left.length === 0, `left behind: ${left.join(",")}`);
  });

  await test("phone: signed POST /m/v1/voice/transcribe → 200, audited via phone; 2 MB body passes the gateway", async () => {
    const phone = await pairAndApprove("Voice phone");
    asrCalls.length = 0;
    const r = await phone.call("POST", "/m/v1/voice/transcribe", { audio: tone(5, ".m4a", ["-c:a", "aac"]), mime: "audio/mp4", purpose: "message" });
    assert(r.status === 200 && json(r).text === "part1", `${r.status} ${r.body}`);
    const act = json(await portal("GET", "/api/activity?limit=50"));
    assert(act.some((i: any) => i.kind === "phone" && i.title === "dictated by voice" && i.detail === "via phone (Voice phone)" && i.ts >= SUITE_START), "audit row");
    // More than the gateway's default 1 MB: reaches the API, which can't decode it (400), not an empty 404.
    const big = await phone.call("POST", "/m/v1/voice/transcribe", { audio: randomBytes(2 * 1024 * 1024).toString("base64"), mime: "audio/wav", purpose: "message" });
    assert(big.status === 400, `2 MB → ${big.status}`);
    const unsigned = await request(GATEWAY, "POST", "/m/v1/voice/transcribe", { "content-type": "application/json" }, Buffer.from("{}"));
    assert(unsigned.status === 404 && unsigned.body.length === 0, "unsigned → empty 404");
    await portal("POST", `/api/devices/${phone.id}/revoke`, {});
  });

  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(ZAI_ENV, { force: true });
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `  — ${r.note}` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
