/**
 * Crews (crews.ts): separate teams whose agents only see and hand work to each other. In-process against
 * a throwaway database; agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/crews.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-crews-")));
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
const { run, newId, now, all } = await import("../src/db.ts");
const A = await import("../src/agents.ts");
const C = await import("../src/crews.ts");
const TM = await import("../src/team.ts");
const Fastify = (await import("fastify")).default;
const app = Fastify();
C.registerCrewRoutes(app);
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name: string, scale = false) => {
  const a = A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
  if (scale) run(`UPDATE agents SET can_scale = 1 WHERE id = ?`, a.id);
  return A.getAgent(a.id)!;
};
const roboLead = mk("robotics-lead", true);
const cad = mk("cad");
const electronics = mk("electronics");
const techLead = mk("tech-lead", true);
const coder = mk("coder");
const req = (method: any, url: string, payload?: any) => app.inject({ method, url, payload }).then((r) => ({ status: r.statusCode, body: r.json() }));
const taskOf = (agentId: string) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'running', ?)`,
    id, agentId, A.dmThreadOf(agentId), now());
  return id;
};
const call = async (agent: any, name: string, args: any) => {
  const t = TM.teamTools(agent, taskOf(agent.id)).find((x: any) => x.name === name)!;
  const r: any = await (t as any).handler(args, {});
  return { text: r.content.map((c: any) => c.text).join("\n"), error: !!r.isError };
};

let robotics: any, software: any;

test("without crews everyone works with everyone, as before", async () => {
  const cadTask = A.spawnInstance(cad.id, { label: "Part", createdBy: "owner" });
  assert.match(TM.rosterFor(cadTask), /coder/);
  const r = await call(cadTask, "delegate_task", { to: "coder", title: "Script", instructions: "x" });
  assert.equal(r.error, false, r.text);
});

test("crews are made, given members, a lead; names are unique", async () => {
  robotics = (await req("POST", "/api/crews", { name: "Robotics", summary: "Arms and firmware", members: [roboLead.id, cad.id, electronics.id] })).body;
  software = (await req("POST", "/api/crews", { name: "Software", members: [techLead.id, coder.id] })).body;
  assert.equal((await req("POST", "/api/crews", { name: "robotics" })).status, 409);
  assert.equal((await req("POST", "/api/crews", { name: "  " })).status, 400);
  assert.equal(C.crewLead(robotics.id)?.id, roboLead.id, "the planning agent leads by default");
  assert.equal((await req("PATCH", `/api/crews/${software.id}`, { lead_role_id: cad.id })).status, 400, "a lead from another crew");
  assert.equal((await req("PATCH", `/api/crews/${software.id}`, { lead_role_id: coder.id })).status, 200);
  assert.equal(C.crewLead(software.id)?.id, coder.id);
  const state = (await req("GET", "/api/crews")).body.crews.map((c: any) => c.name);
  assert.deepEqual(state, ["Robotics", "Software"]);
});

test("an agent only sees, delegates to and messages its own crew", async () => {
  const cadTask = A.spawnInstance(cad.id, { label: "Bracket", createdBy: "owner" });
  const roster = TM.rosterFor(cadTask);
  assert.match(roster, /Robotics\*\* crew/);
  assert.match(roster, /electronics/);
  assert.doesNotMatch(roster, /coder|tech-lead/);
  const listed = await call(cadTask, "list_agents", {});
  assert.match(listed.text, /electronics/);
  assert.doesNotMatch(listed.text, /coder|tech-lead/);
  assert.equal((await call(cadTask, "list_agents", { pool: "coder" })).error, true);

  const cross = await call(cadTask, "delegate_task", { to: "coder", title: "Write a script", instructions: "x" });
  assert.equal(cross.error, true);
  assert.match(cross.text, /coder is in Software, not your crew \(Robotics\)/);
  assert.equal((await call(cadTask, "send_message", { to: "tech-lead", text: "hi" })).error, true);
  // A live task of the other crew, by its instance name, is refused too.
  const coderTask = A.spawnInstance(coder.id, { label: "Fix", createdBy: "owner" });
  assert.equal((await call(cadTask, "delegate_task", { to: coderTask.name, title: "x", instructions: "x" })).error, true);
  assert.equal((await call(coderTask, "delegate_task", { to: "cad", title: "Model it", instructions: "x" })).error, true, "and the other way");

  const inside = await call(cadTask, "delegate_task", { to: "electronics", title: "Wire it", instructions: "x" });
  assert.equal(inside.error, false, inside.text);
});

test("find_work only shows the crew's own work", async () => {
  const coderTask = A.spawnInstance(coder.id, { label: "Secret fix", createdBy: "owner" });
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 'Fix login #4242', 'p', 'done', ?)`,
    newId(), coderTask.id, A.dmThreadOf(coderTask.id), now());
  const elTask = A.spawnInstance(electronics.id, { label: "Board", createdBy: "owner" });
  assert.match((await call(elTask, "find_work", { query: "#4242" })).text, /No tasks mention/);
  const tl = A.spawnInstance(techLead.id, { label: "Lead", createdBy: "owner" });
  assert.match((await call(tl, "find_work", { query: "#4242" })).text, /Fix login #4242/);
});

test("moving an agent moves its live tasks; a lead that leaves stops leading; deleting a crew frees its agents", async () => {
  const coderTask = A.spawnInstance(coder.id, { label: "Port", createdBy: "owner" });
  assert.equal((await req("PUT", `/api/agents/${coder.id}/crew`, { crew_id: robotics.id })).status, 200);
  assert.equal(C.crewIdOf(coderTask), robotics.id);
  assert.equal(C.getCrew(software.id)!.lead_role_id, null);
  assert.equal(C.crewLead(software.id)?.id, techLead.id);
  assert.equal((await req("PUT", `/api/agents/${coderTask.id}/crew`, { crew_id: software.id })).status, 400, "tasks follow their agent");
  assert.equal((await req("DELETE", `/api/crews/${robotics.id}`)).status, 200);
  assert.equal(C.crewIdOf(A.getAgent(cad.id)!), null);
  assert.equal(all(`SELECT 1 FROM crews WHERE id = ?`, robotics.id).length, 0);
});
