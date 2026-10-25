/**
 * Linked work (linkedWork.ts): the owner links other work (often another crew's) to a piece of work, and
 * every task in it may read that work, without crossing crews. In-process, throwaway database, paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/linked-work.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-links-")));
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

const { setPaused } = await import("../src/control.ts");
setPaused(true);
const { run, newId, now } = await import("../src/db.ts");
const A = await import("../src/agents.ts");
const C = await import("../src/crews.ts");
const L = await import("../src/linkedWork.ts");
const TM = await import("../src/team.ts");
const RM = await import("../src/roadmaps.ts");
const Fastify = (await import("fastify")).default;
const app = Fastify();
L.registerLinkRoutes(app);
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name: string, scale = false) => {
  const a = A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
  if (scale) run(`UPDATE agents SET can_scale = 1 WHERE id = ?`, a.id);
  return A.getAgent(a.id)!;
};
const roboLead = mk("robotics-lead", true);
const controls = mk("controls");
const techLead = mk("tech-lead", true);
const coder = mk("coder");
C.createCrew({ name: "Robotics", members: [roboLead.id, controls.id] });
C.createCrew({ name: "Software", members: [techLead.id, coder.id] });

// The robotics work: a lead, a helper under it, a conversation and a roadmap.
const robo = A.spawnInstance(roboLead.id, { label: "YT stream events", createdBy: "owner" });
const roboHelper = A.spawnInstance(controls.id, { label: "Build ytchat-ingest", createdBy: robo.id, parentInstanceId: robo.id });
const say = (agentId: string, author: string, content: string) =>
  run(`INSERT INTO messages (id, thread_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)`, newId(), A.dmThreadOf(agentId), author, content, now());
say(robo.id, "user", "Ingest YouTube live chat into NATS.");
say(roboHelper.id, roboHelper.id, "Ingest works: 1.2k msgs/min, PR #31 open.");
const tid = newId();
run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'running', ?)`, tid, robo.id, A.dmThreadOf(robo.id), now());
RM.createRoadmap(robo, tid, { title: "YT pipeline", items: [{ id: "ingest", title: "Ingest chat", owner: "controls", status: "done" }, { id: "deploy", title: "Deploy", owner: "controls" }] });

// The software work that links it.
const swe = A.spawnInstance(techLead.id, { label: "Productionise ytchat", createdBy: "owner" });
const sweCoder = A.spawnInstance(coder.id, { label: "Harden ingest", createdBy: swe.id, parentInstanceId: swe.id });
const req = (method: any, url: string, payload?: any) => app.inject({ method, url, payload }).then((r) => ({ status: r.statusCode, body: r.json() }));
const call = async (agent: any, name: string, args: any) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'running', ?)`, id, agent.id, A.dmThreadOf(agent.id), now());
  const t = TM.teamTools(agent, id).find((x: any) => x.name === name)!;
  const r: any = await (t as any).handler(args, {});
  return { text: r.content.map((c: any) => c.text).join("\n"), error: !!r.isError };
};

test("nothing linked: nothing in the instructions, and reading is refused", async () => {
  assert.equal(L.linkedSection(swe), "");
  assert.match((await call(swe, "read_linked_work", {})).text, /No work is linked/);
  assert.equal((await call(swe, "read_linked_work", { work: robo.id })).error, true, "can't read unlinked work by id");
});

test("the owner links work (by any task in it); the root's whole work sees it, the other side sees who reads it", async () => {
  const r = await req("POST", `/api/work/${sweCoder.id}/links`, { work_id: roboHelper.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.room_id, swe.id);
  assert.equal(r.body.links[0].work.id, robo.id, "linked to the other work's root");
  assert.equal(r.body.links[0].work.crew_name, "Robotics");
  assert.equal((await req("POST", `/api/work/${swe.id}/links`, { work_id: robo.id })).body.links.length, 1, "linking twice is a no-op");
  assert.equal((await req("POST", `/api/work/${swe.id}/links`, { work_id: sweCoder.id })).status, 400, "not to itself");
  assert.equal((await req("POST", `/api/work/${swe.id}/links`, { work_id: "nope" })).status, 404);
  assert.equal((await req("GET", `/api/work/${robo.id}/links`)).body.linked_from[0].work.id, swe.id);
  for (const a of [swe, sweCoder]) assert.match(L.linkedSection(a), /"YT stream events" \(Robotics crew/);
});

test("tasks in the linking work read progress, conversation, documents and services", async () => {
  const progress = await call(sweCoder, "read_linked_work", { work: "yt stream" });
  assert.equal(progress.error, false, progress.text);
  assert.match(progress.text, /controls#1 "Build ytchat-ingest"/);
  assert.match(progress.text, /Roadmap: YT pipeline \(1\/2 done\)/);
  assert.match(progress.text, /\[done\] Ingest chat \(controls\)/);
  assert.match(progress.text, /PR #31/);
  const convo = await call(swe, "read_linked_work", { work: robo.id, part: "conversation" });
  assert.match(convo.text, /Owner ·.*\nIngest YouTube live chat/s);
  assert.match(convo.text, /controls#1 ·.*\nIngest works/s);
  assert.match((await call(swe, "read_linked_work", { work: robo.id, part: "conversation", limit: 1 })).text, /older ones: before=1/);
  assert.match((await call(swe, "read_linked_work", { work: robo.id, part: "documents" })).text, /No documents yet|documents/);
  assert.match((await call(swe, "read_linked_work", { work: robo.id, part: "services" })).text, /Nothing hosted/);
});

test("linking reads only: crews stay closed, and the linked side can't read back", async () => {
  assert.equal((await call(swe, "delegate_task", { to: "controls", title: "x", instructions: "x" })).error, true);
  assert.equal((await call(sweCoder, "send_message", { to: roboHelper.name, text: "hi" })).error, true);
  assert.match((await call(robo, "read_linked_work", {})).text, /No work is linked/, "links go one way");
});

test("unlinking removes it from the instructions; at most 8 links", async () => {
  const { links } = L.linksOf(swe.id);
  assert.equal((await req("DELETE", `/api/links/${links[0].id}`)).status, 200);
  assert.equal(L.linkedSection(sweCoder), "");
  for (let i = 0; i < 8; i++) L.addLink(swe.id, A.spawnInstance(controls.id, { label: `w${i}`, createdBy: "owner" }).id);
  assert.equal((await req("POST", `/api/work/${swe.id}/links`, { work_id: robo.id })).status, 400);
});
