/**
 * Tags on work (server/src/tags.ts), in-process against a
 * throwaway database. Agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/tags.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-tags-")));
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
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const T = await import("../src/tags.ts");
const W = await import("../src/work.ts");
const { allowedRoute } = await import("../src/mobile.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const lead = A.getAgent(A.createAgent({ name: "lead", title: "lead", summary: "lead", model: "sonnet", instructions: "# lead\n", interview: {} }).id)!;

test("tags are normalised: lowercase, one word, no duplicates, bounded", () => {
  assert.deepEqual(T.normalizeTags([" Brandsek ", "#infra", "Mobile App", "brandsek", ""]), ["brandsek", "infra", "mobile-app"]);
  assert.deepEqual(T.normalizeTags("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(T.normalizeTags(undefined), []);
  assert.throws(() => T.normalizeTags(["x".repeat(30)]), /at most 24/);
  assert.throws(() => T.normalizeTags(["1", "2", "3", "4", "5", "6", "7", "8", "9"]), /At most 8/);
});

test("new work carries its tags; tagging a task inside it tags the whole work", () => {
  const inst = W.startOwnerWork({ role: lead, text: "Fix the login retry", tags: ["Brandsek", "auth"] });
  const room = W.workList().live.find((r) => r.root.id === inst.id)!;
  assert.deepEqual(room.root.tags, ["brandsek", "auth"]);
  const child = A.spawnInstance(lead.id, { label: "helper", createdBy: "agent", parentInstanceId: inst.id });
  assert.deepEqual(T.setWorkTags(child.id, ["infra"]), { id: inst.id, tags: ["infra"] });
  assert.deepEqual(W.workList().live.find((r) => r.root.id === inst.id)!.root.tags, ["infra"]);
  assert.deepEqual(T.knownTags(), [{ tag: "infra", n: 1 }]);
  assert.deepEqual(T.setWorkTags(inst.id, []).tags, []);
  assert.deepEqual(T.knownTags(), []);
  assert.throws(() => T.setWorkTags(lead.id, ["x"]), /No such task/);
  assert.throws(() => W.startOwnerWork({ role: lead, text: "x", tags: ["y".repeat(40)] }), /at most 24/);
});

test("the phone may set tags and read the known ones, nothing more", () => {
  assert.ok(allowedRoute("PATCH", "work/abc123/tags"));
  assert.ok(allowedRoute("GET", "work-tags"));
  assert.ok(!allowedRoute("PATCH", "agents/abc123/meta"));
});

test("groups: @everyone wakes every member (owner only); work linked to a group is read by its members there", async () => {
  const G = await import("../src/groups.ts");
  const L = await import("../src/linkedWork.ts");
  const mk = (name: string) => A.getAgent(A.createAgent({ name, title: name, summary: name, model: "sonnet", instructions: `# ${name}\n`, interview: {} }).id)!;
  const a = mk("alpha"), b = mk("beta");
  const g = G.createGroup({ name: "core", purpose: "", members: [lead.id, a.id, b.id], lead: b.id });
  const all_ = G.mentions(g, "hi @everyone", undefined, { everyone: true });
  assert.equal(all_[0], b.id); // the lead first
  assert.deepEqual([...all_].sort(), [lead.id, a.id, b.id].sort());
  assert.deepEqual(G.mentions(g, "@all and @alpha", a.id, { everyone: true }).sort(), [b.id, lead.id].sort());
  assert.deepEqual(G.mentions(g, "hi @everyone"), []); // an agent's @everyone wakes nobody
  const work = W.startOwnerWork({ role: lead, text: "Migration" });
  L.addGroupLink(g.id, work.id);
  assert.equal(L.groupLinksOf(g.id).links[0].work.id, work.id);
  const member = G.groupInstance(g, a.id);
  const seen = L.linksOf(member.id);
  assert.equal(seen.links[0].work.id, work.id);
  assert.equal(seen.links[0].via_group, g.id);
  assert.match(L.linkedSection(member), /group #core/);
  assert.equal(L.linksOf(work.id).linked_from[0].work.label, "#core");
  assert.throws(() => L.addGroupLink(g.id, member.id), /own conversation/);
  G.deleteGroup(g.id);
  assert.equal(L.linksOf(work.id).linked_from.length, 0);
});
