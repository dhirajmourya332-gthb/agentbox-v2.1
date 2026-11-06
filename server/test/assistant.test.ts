/**
 * The phone's voice assistant (server/src/assistant.ts), in-process against a throwaway database,
 * with the Claude call replaced. Agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/assistant.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-assistant-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\n`);
Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", NO_COLOR: "1",
});

const { run, newId, now } = await import("../src/db.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const AT = await import("../src/attention.ts");
const C = await import("../src/crews.ts");
const S = await import("../src/setup.ts");
const AS = await import("../src/assistant.ts");
const { allowedRoute } = await import("../src/mobile.ts");
const { auditTitle } = await import("../src/devices.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (name: string) => A.getAgent(A.createAgent({ name, title: name, summary: `${name} things`, model: "sonnet", instructions: `# ${name}\n`, interview: {} }).id)!;
const lead = mk("tech-lead");
const coder = mk("coder");
const crew = C.createCrew({ name: "Platform", members: [lead.id, coder.id] });
C.updateCrew(crew.id, { lead_role_id: lead.id });
const setup = S.ensureSetupRole();

const migration = A.spawnInstance(lead.id, { label: "Database migration", createdBy: "owner", asLead: true });
const helperWork = A.spawnInstance(setup.id, { label: "Connect GitHub", createdBy: "owner" });
const question = AT.raiseAttention("question", migration.id, null, migration.id, "tech-lead asks: keep the old API for a week? I recommend yes");
AT.raiseAttention("question", helperWork.id, null, helperWork.id, "Helper asks: which GitHub org?");
const say = (agentId: string, content: string) =>
  run(`INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, NULL, ?, ?)`, newId(), A.dmThreadOf(agentId), agentId, content, now());
say(migration.id, "Schema is done. **Two** options for the API: keep the old one a week, or cut over now.");

const call = async (tools: any[], name: string, args: any) => {
  const t = tools.find((x: any) => x.name === name);
  assert.ok(t, `tool ${name}`);
  return t.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};

test("gateway: the phone may ask; the route is audited as a question", () => {
  assert.ok(allowedRoute("POST", "assistant/ask"));
  assert.ok(!allowedRoute("GET", "assistant/ask"));
  assert.ok(!allowedRoute("POST", "assistant/other"));
  assert.equal(auditTitle("assistant/ask"), "asked the voice assistant");
});

test("snapshot: the owner's work and decisions, never the helper's", () => {
  const s = AS.snapshot();
  assert.match(s, /Database migration/);
  assert.match(s, /keep the old API for a week/);
  assert.match(s, /Needs you \(1\)/);
  assert.doesNotMatch(s, /Connect GitHub/);
  assert.doesNotMatch(s, /which GitHub org/);
});

test("work_detail and item_detail add the agents' latest words", async () => {
  const tools = AS.assistantToolList(() => {});
  const w = await call(tools, "work_detail", { work_id: migration.id });
  assert.match(w.content[0].text, /Schema is done/);
  assert.match(w.content[0].text, /Needs you here/);
  const i = await call(tools, "item_detail", { item_id: question.id });
  assert.match(i.content[0].text, /latest message/);
  assert.equal((await call(tools, "work_detail", { work_id: "nope" })).isError, true);
});

test("proposals: resolved to real ids, nothing changes until the phone does it", async () => {
  let got: any = null;
  const tools = AS.assistantToolList((a) => { got = a; });
  const before = (await import("../src/db.ts")).all(`SELECT id FROM tasks`).length;

  // A crew's name goes to its lead.
  await call(tools, "propose_new_task", { agent: "platform", text: "Add rate limits to the public API" });
  assert.deepEqual([got.kind, got.role_id, got.title], ["new_task", lead.id, "Add rate limits to the public API"]);
  assert.equal((await call(tools, "propose_new_task", { agent: "nobody", text: "x" })).isError, true);
  // The helper can't be given work by voice.
  assert.equal((await call(tools, "propose_new_task", { agent: setup.name, text: "x" })).isError, true);

  await call(tools, "propose_reply", { item_id: question.id, text: "Yes, keep it a week." });
  assert.deepEqual([got.kind, got.thread_id, got.attention_id, got.work], ["reply", A.dmThreadOf(migration.id), question.id, "Database migration"]);
  await call(tools, "propose_reply", { work_id: migration.id, text: "How's it going?" });
  assert.equal(got.agent_id, migration.id);

  assert.equal((await call(tools, "propose_plan_decision", { item_id: question.id, verdict: "approve" })).isError, true);
  assert.equal((await call(tools, "propose_run_routine", { routine: "nightly" })).isError, true);

  const { all } = await import("../src/db.ts");
  assert.equal(all(`SELECT id FROM tasks`).length, before, "proposing starts nothing");
});

test("ask: validates, passes the conversation, speaks plain text, returns the proposal", async () => {
  await assert.rejects(AS.askAssistant({}), /text must be a string/);
  await assert.rejects(AS.askAssistant({ text: "  " }), /Say something/);
  await assert.rejects(AS.askAssistant({ text: "x".repeat(1001) }), /too long/);
  await assert.rejects(AS.askAssistant({ text: "hi", history: [{ role: "system", text: "x" }] }), /role and text/);

  let seen = { prompt: "", system: "" };
  AS.setAssistantModel(async (prompt, system) => {
    seen = { prompt, system };
    return "## Migration\n- **Not done** yet. See https://example.com/x and `code`.";
  });
  const a = await AS.askAssistant({ text: "what's the update on the migration?", name: "Nova", box: "GCP Mumbai",
    history: [{ role: "user", text: "hello" }, { role: "assistant", text: "Hi." }] });
  assert.equal(a.speech, "Migration Not done yet. See a link and code.");
  assert.equal(a.action, null);
  assert.match(seen.system, /You are Nova/);
  assert.match(seen.system, /GCP Mumbai/);
  assert.match(seen.prompt, /<snapshot>[\s\S]*Database migration/);
  assert.match(seen.prompt, /Owner: hello\nNova: Hi\./);
  assert.match(seen.prompt, /The owner says: what's the update on the migration\?$/);

  // An empty answer still says something.
  AS.setAssistantModel(async () => "");
  assert.match((await AS.askAssistant({ text: "hm" })).speech, /didn't get an answer/);
  AS.setAssistantModel(null);
});
