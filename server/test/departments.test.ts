/**
 * Departments (server/src/departments.ts): connected groups, in-process against a
 * throwaway database. Agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/departments.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-depts-")));
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

const { run, get, newId, now } = await import("../src/db.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const G = await import("../src/groups.ts");
const GW = await import("../src/groupWork.ts");
const D = await import("../src/departments.ts");
const L = await import("../src/linkedWork.ts");
const T = await import("../src/team.ts");
const { enqueueTask, taskRow } = await import("../src/runner.ts");
const { publish } = await import("../src/bus.ts");
const Fastify = (await import("fastify")).default;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (name: string) => A.getAgent(A.createAgent({ name, title: name, summary: name, model: "sonnet", instructions: `# ${name}\n`, interview: {} }).id)!;
const rl = mk("robotics-lead"), tl = mk("tech-lead"), dl = mk("design-lead");
const robotics = G.createGroup({ name: "robotics", purpose: "the arm", members: [rl.id], lead: rl.id });
const software = G.createGroup({ name: "software", purpose: "the apps", members: [tl.id], lead: tl.id });
const design = G.createGroup({ name: "product-design", purpose: "", members: [dl.id], lead: dl.id });
const rLead = G.groupInstance(robotics, rl.id);
const turn = (inst: any, groupId: string) => enqueueTask({ agentId: inst.id, threadId: groupId, source: "group", title: "turn", prompt: "x", input: null });
const finish = (taskId: string, result: string) => {
  run(`UPDATE tasks SET status = 'done', result = ?, finished_at = ? WHERE id = ?`, result, now(), taskId);
  const t = taskRow(taskId);
  publish({ type: "task.updated", task: t });
  T.returnResult(t);
};

test("connecting departments: owner only, both ways, no duplicates", () => {
  assert.throws(() => D.connect(robotics.id, robotics.id), /itself/);
  assert.equal(D.departmentNote(rLead), "", "nothing to say before a connection");
  D.connect(robotics.id, software.id);
  D.connect(software.id, robotics.id); // the same connection
  const v = D.departmentsView(software.id);
  assert.deepEqual(v.connections.map((c: any) => c.group.name), ["robotics"]);
  assert.match(D.departmentNote(rLead), /#software — the apps \(lead tech-lead\)/);
  assert.equal(D.departmentNote(A.spawnInstance(rl.id, { label: "x", createdBy: "owner" })), "", "only the lead in its group");
});

test("ask: the other lead answers in its group, the answer comes back to the asker", () => {
  const t = turn(rLead, robotics.id);
  assert.throws(() => D.askDepartment(rLead, t.id, "#product-design", "question", { text: "?" }), /No connected department/);
  const r = D.askDepartment(rLead, t.id, "#software", "question", { text: "Which API serves joint angles?" });
  const tLead = G.groupInstance(software, tl.id);
  const handler = get<any>(`SELECT * FROM tasks WHERE agent_id = ? AND thread_id = ? AND source = 'agent'`, tLead.id, software.id);
  assert.ok(handler, "a turn for the software lead, in #software");
  assert.match(handler.prompt, /Department request .* from #robotics/);
  assert.ok(get(`SELECT 1 FROM messages WHERE thread_id = ? AND content LIKE '%Which API serves joint angles%'`, software.id), "shown in #software");
  finish(handler.id, "GET /api/joints on the arm service");
  assert.equal(get<any>(`SELECT status, answer FROM dept_requests WHERE id = ?`, r.id).status, "answered");
  const back = get<any>(`SELECT * FROM tasks WHERE agent_id = ? AND source = 'result' AND thread_id = ?`, rLead.id, robotics.id);
  assert.ok(back && /joints/.test(back.prompt), "the answer wakes the robotics lead in #robotics");
});

test("delegate: acknowledged, then the result reported back; reading their work", () => {
  const t = turn(rLead, robotics.id);
  const r = D.askDepartment(rLead, t.id, "software", "work", { title: "Dashboard for the arm", text: "Build a web dashboard showing joint angles" });
  const tLead = G.groupInstance(software, tl.id);
  const handler = get<any>(`SELECT handler_task FROM dept_requests WHERE id = ?`, r.id).handler_task;
  finish(handler, "On it: a workspace led by coder");
  assert.equal(get<any>(`SELECT status FROM dept_requests WHERE id = ?`, r.id).status, "accepted");
  assert.match(D.departmentNote(tLead), /from #robotics: work "Dashboard for the arm" — accepted/);
  // software's workspace for it: robotics' lead can read it (via the department connection)
  const ws = A.spawnInstance(tl.id, { label: "Arm dashboard", createdBy: `glead:${software.id}` });
  run(`INSERT INTO group_workspaces (id, group_id, root_id, item_id, title, created_at) VALUES (?, ?, ?, 'i1', 'Arm dashboard', ?)`, newId(), software.id, ws.id, now());
  const seen = L.linksOf(rLead.id).links.find((l: any) => l.work.id === ws.id);
  assert.equal(seen?.via_department, software.id);
  assert.equal(L.linkedSection(rLead), "", "covered by the department note instead");
  assert.match(D.readDepartment(rLead, "#software"), /"Arm dashboard"/);
  assert.match(D.readDepartment(rLead, "#software", "conversation"), /Dashboard for the arm/);
  // the result
  const t2 = turn(tLead, software.id);
  assert.throws(() => D.reportToDepartment(rLead, t.id, r.id, "x"), /No request/, "only the department that got it reports");
  D.reportToDepartment(tLead, t2.id, r.id.slice(0, 8), "Shipped: PR #12, live at /arm");
  assert.equal(get<any>(`SELECT status FROM dept_requests WHERE id = ?`, r.id).status, "done");
  assert.ok(get(`SELECT 1 FROM tasks WHERE agent_id = ? AND source = 'result' AND prompt LIKE '%Shipped: PR #12%'`, rLead.id));
});

test("only a connected lead, and disconnecting ends it", async () => {
  const member = A.spawnInstance(rl.id, { label: "y", createdBy: "owner" });
  assert.throws(() => D.askDepartment(member, "t", "software", "question", { text: "?" }), /Only a department's/);
  const app = Fastify();
  app.setErrorHandler((err: any, _req, reply) => reply.status(err.statusCode ?? 400).send({ error: err.message }));
  D.registerDepartmentRoutes(app);
  const add = await app.inject({ method: "POST", url: `/api/groups/${design.id}/departments`, payload: { group_id: software.id } });
  assert.equal(add.statusCode, 200);
  const view = (await app.inject({ method: "GET", url: `/api/groups/${software.id}/departments` })).json();
  assert.deepEqual(view.connections.map((c: any) => c.group.name).sort(), ["product-design", "robotics"]);
  assert.ok(view.requests.length >= 2);
  const conn = view.connections.find((c: any) => c.group.name === "robotics");
  assert.equal((await app.inject({ method: "DELETE", url: `/api/group-connections/${conn.id}` })).statusCode, 200);
  const t = turn(rLead, robotics.id);
  assert.throws(() => D.askDepartment(rLead, t.id, "software", "question", { text: "?" }), /isn't connected/);
  assert.equal((await app.inject({ method: "GET", url: "/api/departments" })).json().connections.length, 1);
  G.deleteGroup(design.id);
  assert.equal(D.connectionsOf(software.id).length, 0, "deleting a group drops its connections");
});
