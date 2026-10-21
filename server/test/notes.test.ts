/**
 * Notes (notes.ts): a piece of work's notebook, shared by every task in it. In-process against a
 * throwaway database; agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/notes.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-notes-")));
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
const A = await import("../src/agents.ts");
const N = await import("../src/notes.ts");
const { subscribe } = await import("../src/bus.ts");
const Fastify = (await import("fastify")).default;
const app = Fastify();
N.registerNoteRoutes(app);
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name: string) => A.getAgent(A.createAgent({ name, title: name, summary: name, model: "sonnet", instructions: `# ${name}\n`, interview: {} }).id)!;
const role = mk("robotics-lead");
const lead = A.spawnInstance(role.id, { label: "Arm", createdBy: "owner" });
const helper = A.spawnInstance(role.id, { label: "Dashboard", createdBy: lead.id, parentInstanceId: lead.id });
const other = A.spawnInstance(role.id, { label: "Other work", createdBy: "owner" });

const req = (method: any, url: string, payload?: any) => app.inject({ method, url, payload }).then((r) => ({ status: r.statusCode, body: r.json() }));

test("a note saved from a helper's chat lands in the root's notebook; other work has its own", async () => {
  const seen: any[] = [];
  const off = subscribe((e: any) => { if (e.type === "notes.updated") seen.push(e); });
  const r = await req("POST", `/api/work/${helper.id}/notes`, { quote: "  Dashboard: https://x.ts.net:10000/arm/\r\n", body: "the arm UI", message_id: "m1", author: helper.id });
  off();
  assert.equal(r.status, 200);
  assert.equal(r.body.room_id, lead.id);
  assert.equal(r.body.quote, "Dashboard: https://x.ts.net:10000/arm/");
  assert.deepEqual(seen.map((e) => e.roomId), [lead.id]);
  await req("POST", `/api/work/${lead.id}/notes`, { body: "wire servo to D9" });
  const viaHelper = await req("GET", `/api/work/${helper.id}/notes`);
  const viaLead = await req("GET", `/api/work/${lead.id}/notes`);
  assert.deepEqual(viaHelper.body, viaLead.body);
  assert.deepEqual(viaLead.body.notes.map((n: any) => n.body), ["wire servo to D9", "the arm UI"], "newest first");
  assert.deepEqual((await req("GET", `/api/work/${other.id}/notes`)).body.notes, []);
});

test("edit and delete; empty, oversized and unknown are refused", async () => {
  const n = (await req("POST", `/api/work/${other.id}/notes`, { body: "draft" })).body;
  const edited = await req("PATCH", `/api/notes/${n.id}`, { body: "final" });
  assert.equal(edited.body.body, "final");
  assert.equal((await req("PATCH", `/api/notes/${n.id}`, { body: "  " })).status, 400, "a plain note can't be emptied");
  assert.equal((await req("POST", `/api/work/${other.id}/notes`, { body: " ", quote: "" })).status, 400);
  assert.equal((await req("POST", `/api/work/${other.id}/notes`, { body: "x".repeat(20_001) })).status, 400);
  assert.equal((await req("POST", `/api/work/nope/notes`, { body: "x" })).status, 404);
  assert.equal((await req("POST", `/api/work/${role.id}/notes`, { body: "x" })).status, 404, "a role isn't a piece of work");
  // A saved quote may lose its own words.
  const q = (await req("POST", `/api/work/${other.id}/notes`, { quote: "keep me", body: "why" })).body;
  assert.equal((await req("PATCH", `/api/notes/${q.id}`, { body: "" })).status, 200);
  assert.equal((await req("DELETE", `/api/notes/${n.id}`)).status, 200);
  assert.equal((await req("DELETE", `/api/notes/${n.id}`)).status, 404);
  assert.deepEqual((await req("GET", `/api/work/${other.id}/notes`)).body.notes.map((x: any) => x.quote), ["keep me"]);
});
