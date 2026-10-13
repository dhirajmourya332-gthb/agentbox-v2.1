/**
 * The admin's team changes (teamAdmin.ts): new agents, agent changes, skills, assignments and bundles as
 * approval cards; applied only on approve (with the owner's edits), refused when stale, undone on Undo;
 * the admin's write guard; test drive and start_work. In-process against a throwaway database; never
 * starts Claude.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/team-admin.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-admin-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\nmodules: { github: true }\n`);
Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", NO_COLOR: "1",
});

const { run, get, newId, now } = await import("../src/db.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const S = await import("../src/setup.ts");
const AP = await import("../src/approvals.ts");
const K = await import("../src/skills.ts");
const I = await import("../src/integrations.ts");
const TA = await import("../src/teamAdmin.ts");
const T = await import("../src/setupTools.ts");
const G = await import("../src/roleGuards.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (name: string, instructions = `# ${name}\n\n## Your job\nYou do ${name} work.\n`) =>
  A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions, interview: {} });
const lead = mk("tech-lead", "# tech-lead\n\n## Your job\nYou plan the work and write the code yourself when it's quick.\n\n## Reporting\nShort.\n");
const coder = mk("coder");
const admin = S.ensureSetupRole();
const adminTask = A.spawnInstance(admin.id, { label: "Team changes", createdBy: "owner" });
const coderTask = A.spawnInstance(coder.id, { label: "Fix #1", createdBy: "owner" });
const fakeTask = (agentId: string) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'done', ?)`,
    id, agentId, A.dmThreadOf(agentId), now());
  return id;
};
const tid = fakeTask(adminTask.id);
const tools = T.setupTools(adminTask, tid);
const call = async (name: string, args: any, ts: any[] = tools) => {
  const t = ts.find((x) => x.name === name);
  assert.ok(t, `tool ${name}`);
  return t.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};
const approvalIn = (text: string) => AP.getApproval(text.match(/approval ([0-9a-f-]{36})/)![1])!;
const skill = (name: string, body = "Do it.") => K.saveSkill({ name, description: `${name} skill`, body }, { create: true });
skill("review-pr");

test("the setup role is the admin; only it proposes team changes", async () => {
  assert.equal(admin.name, "admin");
  assert.equal(admin.builtin, "setup");
  assert.throws(() => TA.proposeAgentChange(coderTask, null, { agent: "coder", model: "opus" }), /Only the admin agent/);
  const other = T.setupTools(coderTask, fakeTask(coderTask.id));
  assert.equal((await call("propose_new_agent", { name: "x", title: "x", instructions: "x" }, other)).isError, true);
  // Its own instructions aren't changeable this way.
  assert.match((await call("propose_agent_change", { agent: "admin", instructions: "# me\n" })).content[0].text, /built into agentbox/);
});

test("overview and details read the team", async () => {
  K.setAgentSkills(lead.id, ["review-pr"]);
  const o = (await call("team_overview", {})).content[0].text;
  assert.match(o, /\*\*tech-lead\*\* \(tech-lead\)/);
  assert.match(o, /skills: review-pr/);
  assert.match(o, /- review-pr: review-pr skill · used by tech-lead/);
  const d = (await call("get_agent", { agent: "tech-lead" })).content[0].text;
  assert.match(d, /write the code yourself when it's quick/);
  assert.match((await call("get_skill", { name: "review-pr" })).content[0].text, /Do it\./);
  assert.equal((await call("get_agent", { agent: "nobody" })).isError, true);
});

test("agent change: a diff card; applied only on approve, with the owner's edit; undo puts it back", async () => {
  const before = A.readInstructions(lead);
  const next = before.replace("You plan the work and write the code yourself when it's quick.", "You plan and delegate. You never write code yourself.");
  const r = await call("propose_agent_change", { agent: "tech-lead", instructions: next, model: "opus", add_integrations: ["github"], reason: "Owner: orchestrate only" });
  assert.equal(r.isError, undefined, r.content[0].text);
  const a = approvalIn(r.content[0].text);
  assert.equal(a.kind, "agent_change");
  assert.equal(a.status, "pending");
  assert.ok(a.payload.instructions.diff.some((d: any) => d.op === "+" && /never write code/.test(d.text)));
  assert.deepEqual(a.payload.settings, [{ key: "model", before: "sonnet", after: "opus" }]);
  assert.equal(A.readInstructions(lead), before, "nothing changes before approval");
  // A card in the admin's chat.
  assert.ok(get(`SELECT 1 FROM messages WHERE author = 'approval' AND content = ?`, a.id));

  const edited = next.replace("You never write code yourself.", "You never write code yourself; reviews are yours.");
  const done = AP.approve(a.id, { "0": { instructions: edited } });
  assert.equal(done.status, "approved");
  assert.match(A.readInstructions(lead), /reviews are yours/, "the owner's edit is what's applied");
  assert.equal(A.getAgent(lead.id)!.model, "opus");
  assert.deepEqual(I.mappedIntegrations(lead.id), ["github"]);

  const undone = AP.undoApproval(a.id);
  assert.equal(undone.status, "undone");
  assert.equal(A.readInstructions(lead), before);
  assert.equal(A.getAgent(lead.id)!.model, "sonnet");
  assert.deepEqual(I.mappedIntegrations(lead.id), []);
  assert.throws(() => AP.undoApproval(a.id), /Already undone/);
});

test("stale proposals are refused, nothing applied; undo refused after a later edit", async () => {
  const before = A.readInstructions(coder);
  const r = await call("propose_agent_change", { agent: "coder", instructions: before + "\nAlways run the tests.\n" });
  const a = approvalIn(r.content[0].text);
  A.writeInstructions(coder, before + "\nSomeone else's edit.\n");
  assert.throws(() => AP.approve(a.id), /changed since this was proposed/);
  assert.equal(AP.getApproval(a.id)!.status, "pending");
  assert.match(A.readInstructions(coder), /Someone else's edit/);
  A.writeInstructions(coder, before);
  AP.reject(a.id);

  const b = approvalIn((await call("propose_agent_change", { agent: "coder", instructions: before + "\nAlways run the tests.\n" })).content[0].text);
  AP.approve(b.id);
  A.writeInstructions(coder, A.readInstructions(coder) + "Later edit.\n");
  assert.throws(() => AP.undoApproval(b.id), /changed since/);
  assert.match(A.readInstructions(coder), /Later edit/);
  A.writeInstructions(coder, before);
  // No change at all is refused at once.
  assert.match((await call("propose_agent_change", { agent: "coder", instructions: before })).content[0].text, /nothing to change/);
});

test("bundle: a new agent with a new skill that refers to it; applied together; undo removes both", async () => {
  const r = await call("propose_changes", {
    title: "Sales agent with lead research",
    items: [
      { type: "skill", name: "lead-research", description: "Research a lead before outreach", body: "1. Look them up.\n2. Summarise.", agents: ["sales"] },
      { type: "new_agent", name: "sales", title: "Sales assistant", instructions: "# sales — Sales assistant\n\n## Your job\nYou draft follow-ups.", skills: ["lead-research", "review-pr"], integrations: ["github"], model: "sonnet" },
      { type: "skill_assignment", skill: "lead-research", add: ["tech-lead"] },
    ],
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const a = approvalIn(r.content[0].text);
  assert.equal(a.kind, "bundle");
  assert.equal(a.payload.items.length, 3);
  assert.equal(TA.findRole("sales"), undefined, "nothing created yet");

  AP.approve(a.id);
  const sales = TA.findRole("sales")!;
  assert.ok(sales);
  assert.equal(sales.title, "Sales assistant");
  assert.match(A.readInstructions(sales), /You draft follow-ups/);
  assert.deepEqual(K.skillsOf(sales.id), ["lead-research", "review-pr"]);
  assert.deepEqual(I.mappedIntegrations(sales.id), ["github"]);
  assert.deepEqual(K.getSkill("lead-research")!.agents.sort(), [sales.id, lead.id].sort());
  assert.ok(fs.lstatSync(path.join(A.homeOf(sales), ".claude", "skills", "lead-research")).isSymbolicLink());

  AP.undoApproval(a.id);
  assert.equal(TA.findRole("sales"), undefined);
  assert.equal(K.getSkill("lead-research"), undefined);
  assert.ok(!K.skillsOf(lead.id).includes("lead-research"));
});

test("bundle items are checked: unknown names fail with the item number; a single change isn't a bundle", async () => {
  const r = await call("propose_changes", { title: "x", items: [{ type: "agent_change", agent: "ghost", model: "opus" }, { type: "skill_assignment", skill: "review-pr", add: ["coder"] }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Change 1 \(agent_change\): No agent called "ghost"/);
  assert.match((await call("propose_changes", { title: "x", items: [{ type: "skill_assignment", skill: "review-pr", add: ["coder"] }] })).content[0].text, /two or more/);
  assert.match((await call("propose_new_agent", { name: "coder", title: "x", instructions: "x" })).content[0].text, /already exists/);
});

test("skill change and assignment", async () => {
  const r = await call("propose_skill", { name: "review-pr", description: "Review a PR", body: "Read every file.\nRun the tests.", source: "https://github.com/example/skills/blob/main/review/SKILL.md" });
  const a = approvalIn(r.content[0].text);
  assert.equal(a.title, "Change skill: review-pr");
  assert.equal(a.payload.created, false);
  AP.approve(a.id, { "0": { body: "Read every file.\nRun the tests.\nComment once." } });
  assert.match(K.getSkill("review-pr")!.body, /Comment once/);
  AP.undoApproval(a.id);
  assert.equal(K.getSkill("review-pr")!.body.trim(), "Do it.");

  const s = approvalIn((await call("propose_skill_assignment", { skill: "review-pr", add: ["coder"], remove: ["tech-lead"] })).content[0].text);
  assert.equal(s.title, "Give review-pr to coder; take it from tech-lead");
  AP.approve(s.id);
  assert.deepEqual(K.getSkill("review-pr")!.agents, [coder.id]);
  AP.undoApproval(s.id);
  assert.deepEqual(K.getSkill("review-pr")!.agents, [lead.id]);
  assert.equal((await call("propose_skill", { name: "x", description: "d", body: "b", source: "http://evil" })).isError, true);
});

test("undo of a new agent is refused once it has done work", async () => {
  const a = approvalIn((await call("propose_new_agent", { name: "marketing", title: "Marketing", instructions: "# marketing\n" })).content[0].text);
  AP.approve(a.id);
  const m = TA.findRole("marketing")!;
  A.spawnInstance(m.id, { label: "Launch post", createdBy: "owner" });
  assert.throws(() => AP.undoApproval(a.id), /has done work since/);
  assert.ok(TA.findRole("marketing"));
});

test("test drive uses the proposed job description; start_work starts an owner task", async () => {
  let seen = "";
  TA.setDriveImpl(async (prompt) => { seen = prompt; return "- I'd delegate the fix to coder."; });
  const next = A.readInstructions(lead) + "\nNEW RULE: delegate everything.\n";
  const a = approvalIn((await call("propose_agent_change", { agent: "tech-lead", instructions: next })).content[0].text);
  const d = await call("test_drive", { agent: "tech-lead", task: "Fix the login bug", approval_id: a.id });
  assert.equal(d.content[0].text, "- I'd delegate the fix to coder.");
  assert.match(seen, /NEW RULE: delegate everything/);
  assert.match(seen, /<task>\nFix the login bug\n<\/task>/);
  await call("test_drive", { agent: "tech-lead", task: "Fix it" });
  assert.doesNotMatch(seen, /NEW RULE/, "without a proposal: the job description as it is");
  AP.reject(a.id);

  const w = await call("start_work", { agent: "coder", task: "Add a health endpoint", title: "Health endpoint" });
  assert.equal(w.isError, undefined, w.content[0].text);
  const id = w.content[0].text.match(/#\/work\/([0-9a-f-]{36})/)![1];
  const inst = A.getAgent(id)!;
  assert.equal(inst.base_agent_id, coder.id);
  assert.equal(inst.created_by, "owner");
  assert.equal(inst.label, "Health endpoint");
  assert.ok(get(`SELECT 1 FROM tasks WHERE agent_id = ? AND prompt LIKE '%health endpoint%'`, id));
  assert.match((await call("start_work", { agent: "admin", task: "x" })).content[0].text, /That's you/);
});

test("the admin can't write agents, skills or team rules directly; its own home is fine", async () => {
  const guard = G.adminGuard(adminTask);
  const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === "deny";
  const edit = (file_path: string) => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content: "x" } });
  const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/" });
  assert.ok(denied(await guard(edit(A.instructionsPath(lead)))));
  assert.ok(denied(await guard(edit(path.join(dirs.skills, "review-pr", "SKILL.md")))));
  assert.ok(denied(await guard(edit(path.join(dirs.team, "rules.md")))));
  assert.ok(!denied(await guard(edit(path.join(A.homeOf(admin), "docs", "notes.md")))));
  assert.ok(denied(await guard(bash(`echo hi >> ${A.instructionsPath(lead)}`))));
  assert.ok(denied(await guard(bash(`sudo cp /tmp/x ${dirs.skills}/review-pr/SKILL.md`))));
  assert.ok(!denied(await guard(bash(`cat ${A.instructionsPath(lead)}`))));
  // Other agents aren't affected by this guard.
  assert.ok(!denied(await G.adminGuard(coderTask)(edit(path.join(dirs.skills, "x", "SKILL.md")))));
});
