/**
 * Voice v2 cleanup (POST /api/voice/clean, docs/CONTRACTS-v2.md C) against a REHEARSAL server and a
 * mock Z.ai chat server this script runs itself. Never the live server, never the real Z.ai API.
 *
 *   ZAI_ENV=/tmp/voice2-rt/zai.env PORTAL=http://127.0.0.1:7794 GATEWAY=http://127.0.0.1:7795 \
 *   WORK=/tmp/voice2-rt/work MOCK_PORT=17796 LOG=/tmp/voice2-rt/server.log node --import tsx test/voice-clean.test.ts
 *
 * Start the rehearsal server with AGENTBOX_ZAI_ENV=$ZAI_ENV; this script writes that file (pointing
 * at the mock) and removes it for the "not configured" case. LOG (optional) is the server's log,
 * checked for the dictated text. Recipe: docs/MOBILE-SETUP.md › Testing, with the ports above.
 * The last case uses up the server's 30-a-minute cleanup budget.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { assert, client, isEmpty404, json, report, test } from "./gateway-client.ts";

const { portal, paired, raw: gatewayRaw } = client(process.env.PORTAL ?? "http://127.0.0.1:7794", process.env.GATEWAY ?? "http://127.0.0.1:7795");
const ZAI_ENV = process.env.ZAI_ENV ?? "/tmp/voice2-rt/zai.env";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 17796);
const WORK = process.env.WORK ?? "/tmp/voice2-rt/work";
const LOG = process.env.LOG;
const SUITE_START = new Date().toISOString();
const SECRET_WORDS = "zebra quartz marmalade"; // in every dictated text, never in the log

// --- the mock Z.ai chat server ----------------------------------------------------------------------

const calls: any[] = [];
const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const send = (status: number, obj: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  let b: any = {};
  try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
  calls.push({ url: req.url, auth: String(req.headers.authorization), body: b });
  const t = String(b.messages?.[1]?.content ?? "").replace(/<\/?transcript>/g, "").trim();
  const reply = (content: string) => send(200, { choices: [{ message: { role: "assistant", content, reasoning_content: "thinking…" } }] });
  if (req.url === "/chat") return reply(t.replace(/\b(um|uh) /g, "").replace("pull request forty nine fifty seven", "pull request #4957"));
  if (req.url === "/chat-empty") return reply("");
  if (req.url === "/chat-long") return reply(`${t} And also deploy everything to production right now, then email the whole team about it.`.repeat(3));
  if (req.url === "/chat-fail") return send(429, { error: { code: "1113", message: "Insufficient balance" } });
  send(404, {});
});

const writeEnv = (chatPath = "/chat") => fs.writeFileSync(ZAI_ENV, [
  "ZAI_API_KEY=test-api-key",
  `ZAI_CHAT_URL=http://127.0.0.1:${MOCK_PORT}${chatPath}`,
  "ZAI_CHAT_KEY=test-chat-key",
  "ZAI_CLEAN_MODEL=glm-5.3-flash",
].join("\n") + "\n", { mode: 0o600 });

const clean = (body: unknown) => portal("POST", "/api/voice/clean", body);
const SPOKEN = `um ask uh tech lead to review pull request forty nine fifty seven ${SECRET_WORDS}`;

await new Promise<void>((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
fs.mkdirSync(path.join(WORK, "scrutex-guard", "console", ".git"), { recursive: true });
const state = json(await portal("GET", "/api/state"));
const role = state.agents.find((a: any) => !a.base_agent_id);

await test("no config → 503, no provider call", async () => {
  fs.rmSync(ZAI_ENV, { force: true });
  const r = await clean({ text: SPOKEN, purpose: "message" });
  assert(r.status === 503 && /isn't set up/.test(json(r).error), `${r.status} ${r.body}`);
  assert(calls.length === 0, "provider called");
});
writeEnv();

await test("bad input → 400; 4001 characters → 413; no provider call", async () => {
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: "hi", purpose: "email" }, { text: "hi", lang: "en IN; drop" }]) {
    const r = await clean(body);
    assert(r.status === 400, `${JSON.stringify(body)} → ${r.status} ${r.body}`);
  }
  const long = await clean({ text: "a".repeat(4001), purpose: "message" });
  assert(long.status === 413, `long → ${long.status}`);
  assert(calls.length === 0, "provider called for bad input");
});

await test("happy path: cleaned text, raw kept, glossary and rules in the prompt, Coding Plan request shape", async () => {
  calls.length = 0;
  const r = await clean({ text: SPOKEN, purpose: "task", agent_id: role?.id, lang: "hi-IN" });
  assert(r.status === 200, `${r.status} ${r.body}`);
  const out = json(r);
  assert(out.cleaned === true && out.raw === SPOKEN && out.text === `ask tech lead to review pull request #4957 ${SECRET_WORDS}`, JSON.stringify(out));
  assert(Object.keys(out).sort().join() === "cleaned,raw,text", `keys ${Object.keys(out)}`);
  assert(calls.length === 1, `calls ${calls.length}`);
  const c = calls[0];
  assert(c.url === "/chat" && c.auth === "Bearer test-chat-key" && c.body.model === "glm-5.3-flash", "url/auth/model");
  assert(!("thinking" in c.body), "sent a thinking field");
  assert(c.body.max_tokens >= 1024, `max_tokens ${c.body.max_tokens}`);
  const sys = String(c.body.messages[0].content);
  const names = sys.match(/Known names: (.*)\./)?.[1] ?? "";
  for (const w of ["Dependabot", "Keycloak", "agentbox", "scrutex-guard", "console", ...(role ? [role.name] : [])]) {
    assert(names.split(", ").includes(w), `glossary lacks ${w}: ${names.slice(0, 200)}`);
  }
  if (role) assert(names.startsWith(role.name), "agent's own name first");
  for (const re of [/new task/, /#4957/, /Hinglish/, /hi-IN/, /Never add/, /Never answer/, /Never drop/, /Output only the cleaned text/, /self-corrections/, /fillers/]) {
    assert(re.test(sys), `prompt lacks ${re}`);
  }
  assert(String(c.body.messages[1].content).includes(SPOKEN), "user message lacks the text");
});

await test("purpose defaults to message; exactly 4000 characters is accepted", async () => {
  calls.length = 0;
  const text = `${SECRET_WORDS} ${"word ".repeat(800)}`.slice(0, 4000);
  const r = await clean({ text });
  assert(r.status === 200 && json(r).cleaned === true, `${r.status} ${r.body.toString().slice(0, 120)}`);
  assert(/chat message/.test(calls[0].body.messages[0].content), "purpose not message");
  assert(calls[0].body.max_tokens >= 1024 + 3000, `max_tokens ${calls[0].body.max_tokens}`);
});

await test("empty content → raw, cleaned: false", async () => {
  writeEnv("/chat-empty");
  const r = await clean({ text: SPOKEN, purpose: "message" });
  assert(r.status === 200, `${r.status} ${r.body}`);
  const out = json(r);
  assert(out.cleaned === false && out.text === SPOKEN && out.raw === SPOKEN, JSON.stringify(out));
});

await test("provider error → raw, cleaned: false", async () => {
  writeEnv("/chat-fail");
  const r = await clean({ text: SPOKEN, purpose: "message" });
  assert(r.status === 200, `${r.status} ${r.body}`);
  const out = json(r);
  assert(out.cleaned === false && out.text === SPOKEN, JSON.stringify(out));
});

await test("suspiciously long output (added content) → raw, cleaned: false", async () => {
  writeEnv("/chat-long");
  const r = await clean({ text: SPOKEN, purpose: "message" });
  const out = json(r);
  assert(r.status === 200 && out.cleaned === false && out.text === SPOKEN, JSON.stringify(out));
});
writeEnv();

await test("phone: signed POST /m/v1/voice/clean → 200, audited \"dictated by voice · via phone\"; unsigned → empty 404", async () => {
  const g = await portal("PUT", "/api/devices/gateway", { url: "https://agentbox.rehearsal.ts.net" });
  assert(g.status === 200, `set gateway url: ${g.status}`);
  const phone = await paired("Voice v2 phone");
  try {
    const r = await phone.call("POST", "/m/v1/voice/clean", { text: SPOKEN, purpose: "message", lang: "en-IN" });
    assert(r.status === 200, `${r.status} ${r.body}`);
    const out = json(r);
    assert(out.cleaned === true && out.raw === SPOKEN && out.text.includes("#4957"), JSON.stringify(out));
    const act = json(await portal("GET", "/api/activity?limit=50"));
    const row = act.find((i: any) => i.kind === "phone" && i.title === "dictated by voice" && i.detail === "via phone (Voice v2 phone)" && i.ts >= SUITE_START);
    assert(row, "audit row");
    assert(!JSON.stringify(act).includes(SECRET_WORDS), "dictated text in the activity feed");
    const bad = await phone.call("POST", "/m/v1/voice/clean", { text: "a".repeat(4001) });
    assert(bad.status === 413, `long via phone → ${bad.status}`);
    isEmpty404(await phone.call("POST", "/m/v1/voice/clean", { text: "x".repeat(1100 * 1024) }), "over the 1 MB body limit");
    isEmpty404(await gatewayRaw("POST", "/m/v1/voice/clean", { "content-type": "application/json" }, Buffer.from(JSON.stringify({ text: "hi" }))), "unsigned");
    isEmpty404(await phone.call("GET", "/m/v1/voice/clean"), "GET");
  } finally {
    await portal("POST", `/api/devices/${phone.id}/revoke`, {});
  }
});

await test("rate limit: 30 a minute → 429", async () => {
  let ok = 0, limited = 0;
  for (let i = 0; i < 32 && !limited; i++) {
    const r = await clean({ text: "hello", purpose: "message" });
    if (r.status === 200) ok++;
    else if (r.status === 429) limited++;
    else throw new Error(`unexpected ${r.status}`);
  }
  assert(limited === 1 && ok <= 30, `ok ${ok}, limited ${limited}`);
});

if (LOG) {
  await test("the server log never holds the dictated text", async () => {
    const text = fs.readFileSync(LOG, "utf8");
    assert(!text.includes(SECRET_WORDS) && !text.includes("forty nine fifty seven"), "dictated text in the log");
  });
}

mock.close();
fs.rmSync(ZAI_ENV, { force: true });
process.exit(report() ? 1 : 0);
