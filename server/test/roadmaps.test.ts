/**
 * Roadmaps (docs/V2.1-PLAN.md §3), in-process against a throwaway database. Agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/roadmaps.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-roadmaps-")));
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
const { subscribe } = await import("../src/bus.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const RU = await import("../src/runner.ts");
const TM = await import("../src/team.ts");
const RM = await import("../src/roadmaps.ts");
const S = await import("../src/setup.ts");
const { registerReviewRoutes } = await import("../src/reviewRoutes.ts");
const Fastify = (await import("fastify")).default;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const events: any[] = [];
subscribe((e) => events.push(e));
const mk = (name: string) => A.getAgent(A.createAgent({ name, title: name, summary: name, model: "sonnet", instructions: `# ${name}\n`, interview: {} }).id)!;
const lead = mk("tech-lead");
const coder = mk("coder");
const setup = S.ensureSetupRole();
const fakeTask = (agentId: string) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'done', ?)`, id, agentId, A.dmThreadOf(agentId), now());
  return id;
};
const call = async (tools: any[], name: string, args: any) => {
  const t = tools.find((x: any) => x.name === name);
  assert.ok(t, `tool ${name}`);
  return t.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};

const STEPS = [
  { id: "spec", title: "Spec + acceptance checks", phase: "Plan" },
  { id: "schema", title: "Schema + migration", phase: "Build", after: ["spec"] },
  { id: "api", title: "API endpoints", phase: "Build", after: ["schema"], owner: "coder#1" },
  { id: "ui", title: "Settings page", phase: "Build", after: ["spec"] },
  { id: "ship", title: "Staging + release", phase: "Ship", after: ["api", "ui"] },
];

test("create: validates ids, dependencies and cycles; posts one card; the work layer lists it", async () => {
  const t = A.spawnInstance(lead.id, { label: "Partner API keys", createdBy: "owner", asLead: true });
  const tools = TM.teamTools(t, fakeTask(t.id));
  for (const [args, re] of [
    [{ title: "x", items: [] }, /at least one/],
    [{ title: "x", items: [{ id: "a", title: "A", after: ["nope"] }] }, /isn't a step/],
    [{ title: "x", items: [{ id: "a", title: "A", after: ["b"] }, { id: "b", title: "B", after: ["a"] }] }, /circle/],
    [{ title: "x", items: [{ id: "a", title: "A" }, { id: "a", title: "B" }] }, /used twice/],
    [{ title: "x", items: [{ id: "a b", title: "A" }] }, /short id/],
    [{ title: "x", items: [{ id: "a", title: "A", status: "maybe" }] }, /status must be one of/],
    [{ title: "x", items: [{ id: "a", title: "A", link: "javascript:alert(1)" }] }, /http\(s\) URL/],
  ] as const) {
    const r = await call(tools, "roadmap_create", args);
    assert.ok(r.isError, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  const ok = await call(tools, "roadmap_create", { title: "Partner API keys", items: STEPS });
  assert.ok(!ok.isError, ok.content[0].text);
  const [rm] = RM.roadmapsOf(t.id);
  assert.equal(rm.title, "Partner API keys");
  assert.equal(rm.status, "active");
  assert.deepEqual(RM.itemsOf(rm.id).map((i) => i.id), ["spec", "schema", "api", "ui", "ship"]);
  assert.ok(get(`SELECT 1 AS x FROM messages WHERE author = 'roadmap' AND content = ?`, rm.id), "a card in the conversation");
  assert.ok(events.some((e) => e.type === "roadmap.updated" && e.roadmap.id === rm.id && e.roadmap.counts.total === 5));
  const dup = await call(tools, "roadmap_create", { title: "partner api keys", items: STEPS });
  assert.match(dup.content[0].text, /already has a roadmap/);
  const layer = RU.instructionLayers(t).find((l) => l.id === "work")!.text;
  assert.match(layer, /## Roadmaps of this work/);
  assert.match(layer, new RegExp(`\\*\\*Partner API keys\\*\\* \\(id ${rm.id}\\): 0/5 done`));
  assert.match(layer, /\[ \] api: API endpoints \(coder#1\)/);
  assert.match(RU.instructionLayers(t).find((l) => l.id === "platform")!.text, /roadmap_create/);
});

test("update: helpers in the same work update steps; events, counts and done/active follow", async () => {
  const t = A.listAgents().find((a) => a.label === "Partner API keys")!;
  const rm = RM.roadmapsOf(t.id)[0];
  // A helper the lead delegated to (same tree) can update it; another work's agent can't.
  const helper = A.spawnInstance(coder.id, { label: "API endpoints", createdBy: t.id, parentInstanceId: t.id } as any);
  const tools = TM.teamTools(helper, fakeTask(helper.id));
  let r = await call(tools, "roadmap_update", { roadmap: rm.id, items: [{ id: "spec", status: "done" }, { id: "schema", status: "doing", owner: helper.name }] });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /1\/5 done/);
  r = await call(tools, "roadmap_update", { roadmap: "Partner API keys", items: [{ id: "ui", status: "blocked", note: "waiting on design" }] });
  assert.ok(!r.isError, "by exact title too");
  const view = RM.roadmapView(RM.getRoadmap(rm.id)!);
  assert.deepEqual([view.counts.done, view.counts.doing, view.counts.blocked, view.counts.todo], [1, 1, 1, 2]);
  assert.equal(view.items.find((i) => i.id === "schema")!.updated_by, helper.name);
  assert.match(view.events[0].text, /Settings page: todo → blocked \(waiting on design\)/);
  assert.equal(view.events[0].by, helper.name);
  const other = A.spawnInstance(coder.id, { label: "Unrelated", createdBy: "owner", asLead: true });
  const no = await call(TM.teamTools(other, fakeTask(other.id)), "roadmap_update", { roadmap: rm.id, items: [{ id: "spec", status: "todo" }] });
  assert.match(no.content[0].text, /No roadmap/);
  // Add, remove, re-link; a cycle is refused and nothing changes.
  const bad = await call(tools, "roadmap_update", { roadmap: rm.id, items: [{ id: "spec", after: ["ship"] }] });
  assert.match(bad.content[0].text, /circle/);
  assert.deepEqual(RM.itemsOf(rm.id).find((i) => i.id === "spec")!.after, []);
  r = await call(tools, "roadmap_update", { roadmap: rm.id, add: [{ id: "docs", title: "Docs", phase: "Ship", after: ["api"] }], remove: ["ui"], items: [{ id: "ship", after: ["api", "docs"] }] });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(RM.itemsOf(rm.id).map((i) => i.id), ["spec", "schema", "api", "ship", "docs"]);
  const gone = await call(tools, "roadmap_update", { roadmap: rm.id, remove: ["schema"] });
  assert.match(gone.content[0].text, /"api" comes after "schema"/, "removing a step others depend on is refused");
  // All done (or skipped) → done; one back to doing → active again.
  await call(tools, "roadmap_update", { roadmap: rm.id, items: ["schema", "api", "ship"].map((id) => ({ id, status: "done", link: "https://github.com/acme/web/pull/7" })).concat([{ id: "docs", status: "skipped" } as any]) });
  assert.equal(RM.getRoadmap(rm.id)!.status, "done");
  await call(tools, "roadmap_update", { roadmap: rm.id, items: [{ id: "ship", status: "doing" }] });
  assert.equal(RM.getRoadmap(rm.id)!.status, "active");
});

test("several labelled roadmaps per work; the setup agent and roles can't make them", async () => {
  const t = A.listAgents().find((a) => a.label === "Partner API keys")!;
  const tools = TM.teamTools(t, fakeTask(t.id));
  const r = await call(tools, "roadmap_create", { title: "Rollout", items: [{ id: "canary", title: "Canary 10%" }, { id: "all", title: "All tenants", after: ["canary"] }] });
  assert.ok(!r.isError);
  assert.deepEqual(RM.roadmapsOf(t.id).map((x) => x.title), ["Partner API keys", "Rollout"]);
  const st = A.spawnInstance(setup.id, { label: "Setup", createdBy: "owner" });
  assert.match((await call(TM.teamTools(st, fakeTask(st.id)), "roadmap_create", { title: "x", items: [{ id: "a", title: "A" }] })).content[0].text, /setup agent/);
});

test("routes: the work's roadmaps for any task in it; archive is the owner's; archived ones leave the agents' view", async () => {
  const app = Fastify();
  registerReviewRoutes(app);
  const t = A.listAgents().find((a) => a.label === "Partner API keys")!;
  const helper = A.listAgents().find((a) => a.label === "API endpoints")!;
  let r = await app.inject({ method: "GET", url: `/api/agents/${helper.id}/roadmaps` });
  assert.equal(r.json().root_id, t.id);
  assert.deepEqual(r.json().roadmaps.map((x: any) => x.title), ["Partner API keys", "Rollout"]);
  const rollout = r.json().roadmaps[1];
  assert.equal(rollout.counts.total, 2);
  r = await app.inject({ method: "POST", url: `/api/roadmaps/${rollout.id}/archive`, headers: { "x-agentbox-local-token": "t" }, payload: {} });
  assert.equal(r.statusCode, 403);
  r = await app.inject({ method: "POST", url: `/api/roadmaps/${rollout.id}/archive`, payload: {} });
  assert.equal(r.json().status, "archived");
  r = await app.inject({ method: "GET", url: `/api/agents/${t.id}/roadmaps` });
  assert.deepEqual(r.json().roadmaps.map((x: any) => x.title), ["Partner API keys"]);
  assert.ok(!RU.instructionLayers(t).find((l) => l.id === "work")!.text.includes("Rollout"));
  r = await app.inject({ method: "GET", url: `/api/agents/${t.id}/roadmaps?archived=1` });
  assert.equal(r.json().roadmaps.length, 2);
  r = await app.inject({ method: "GET", url: `/api/agents/${lead.id}/roadmaps` });
  assert.equal(r.statusCode, 404);
  await app.close();
});
