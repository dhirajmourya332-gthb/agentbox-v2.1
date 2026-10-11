/**
 * Integrations, the setup agent and approvals (docs/V2-ARCHITECTURE.md §10.3–10.5), in-process
 * against a throwaway database, temp folders, a temp sudoers dir and a fake `agentbox` CLI
 * (test/fake-agentbox-cli.mjs). Touches nothing outside a temp folder; never starts Claude.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/integrations.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-integrations-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations", "sudoers"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));

// The fake CLI and its state.
const cli = path.join(tmp, "agentbox");
fs.writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "fake-agentbox-cli.mjs")}" "$@"\n`, { mode: 0o755 });
const stateFile = path.join(tmp, "cli-state.json");
const logFile = path.join(tmp, "cli-log.jsonl");
const github = {
  id: "github", title: "GitHub", category: "code-hosting", kind: "integration", state: "connected", available: true,
  account: "octo-owner",
  settings: [{ key: "default_repo", prompt: "Default repository (owner/name)", required: false, value: "acme/example-repo" },
    { key: "project_board", prompt: "Board", required: false, value: null }],
  steps: [{ id: "install", title: "Install git and gh", human: false, state: "done" },
    { id: "login", title: "Log in to GitHub", human: true, instructions: "Run `gh auth login`", copy: "gh auth login", state: "done" }],
  default_roles: ["coder", "tech-lead"], skills: ["review-pr"],
};
const initialState = {
  integrations: [
    github,
    {
      id: "aws", title: "AWS", category: "cloud", kind: "integration", state: "available", available: true,
      settings: [{ key: "region", prompt: "Region", required: true, value: null }],
      steps: [{ id: "install", title: "Install the AWS CLI", human: false, state: "pending" },
        { id: "login", title: "Log in", human: true, instructions: "Run `aws configure sso`", copy: "aws configure sso", state: "pending" }],
      default_roles: ["devops"], skills: ["aws-cost"],
    },
    { id: "kubernetes", title: "Kubernetes", category: "cluster", kind: "integration", state: "connected", available: true, settings: [], steps: [], default_roles: [], skills: [] },
    { id: "broken", title: "Broken", category: "extras", kind: "integration", state: "error", available: true, settings: [], steps: [], default_roles: [], skills: [] },
    { id: "slack", title: "Slack", category: "chat", kind: "integration", state: "available", available: false, settings: [], steps: [], default_roles: [], skills: [] },
  ],
};
const resetCli = () => fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
resetCli();
fs.writeFileSync(logFile, "");

Object.assign(process.env, {
  AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations,
  AGENTBOX_SUDOERS_DIR: dirs.sudoers, AGENTBOX_SUDO_HELPER: "/nonexistent/helper",
  AGENTBOX_CLI: cli, FAKE_CLI_STATE: stateFile, FAKE_CLI_LOG: logFile, AGENTBOX_PROGRESS_TICK_MS: "3600000",
});
// Rendered summaries, as the CLI would write them for connected integrations.
fs.writeFileSync(path.join(dirs.integrations, "github.summary.md"), "GitHub: use `gh` for issues, PRs and reviews (default repo acme/example-repo).\n");
fs.writeFileSync(path.join(dirs.integrations, "kubernetes.summary.md"), "Kubernetes: kubectl, context example.\n");
fs.writeFileSync(path.join(dirs.integrations, "aws.summary.md"), "AWS: (stale summary of a disconnected integration)\n");
// Library skills that integrations bring.
for (const name of ["review-pr", "aws-cost", "own-skill"]) {
  fs.mkdirSync(path.join(dirs.skills, name), { recursive: true });
  fs.writeFileSync(path.join(dirs.skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${name}"\n---\n\nDo it.\n`);
}
fs.writeFileSync(path.join(dirs.team, "branching.md"), "# Branching\n\nmain is protected.\n");

const { run, get, all, newId, now } = await import("../src/db.ts");
const { subscribe } = await import("../src/bus.ts");
const A = await import("../src/agents.ts");
const I = await import("../src/integrations.ts");
const S = await import("../src/setup.ts");
const AP = await import("../src/approvals.ts");
const SU = await import("../src/sudo.ts");
const R = await import("../src/runner.ts");
const T = await import("../src/setupTools.ts");
const K = await import("../src/skills.ts");
const { registerIntegrationRoutes } = await import("../src/integrationRoutes.ts");
const Fastify = (await import("fastify")).default;

const mk = (name: string) => A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
const coder = mk("coder");
const writer = mk("writer");
const setup = S.ensureSetupRole();
const coderTask = A.spawnInstance(coder.id, { label: "Fix #12", createdBy: "owner" });
const setupTask = A.spawnInstance(setup.id, { label: "Connect GitHub", createdBy: "owner" });
const fakeTask = (agentId: string) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'done', ?)`,
    id, agentId, A.dmThreadOf(agentId), now());
  return id;
};
const layer = (agent: any, id: string) => R.instructionLayers(agent).find((l) => l.id === id)!.text;
const call = async (tools: any[], name: string, args: any) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name}`);
  return t.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};
const cliCalls = () => fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);

// --- the adapter --------------------------------------------------------------------------------
test("adapter: minimal shape, map-style settings, word and boolean step states, bad entries", () => {
  const a = I.adaptIntegration(github);
  assert.equal(a.state, "connected");
  assert.equal(a.account, "octo-owner");
  assert.deepEqual(a.settings[0], { key: "default_repo", prompt: "Default repository (owner/name)", required: false, value: "acme/example-repo" });
  assert.equal(a.steps[1].human, true);
  const b = I.adaptIntegration({ id: "x", settings: { region: "eu-west-1" }, steps: [
    { id: "a", ok: true }, { id: "b", human: true, state: "pending" }, { id: "c", ok: false, last_error: "boom" }, { id: "d", state: "weird" },
  ], coming_soon: true });
  assert.deepEqual(b.settings, [{ key: "region", prompt: "region", required: false, value: "eu-west-1" }]);
  assert.deepEqual(b.steps.map((s) => s.state), ["done", "human", "failed", "pending"]);
  assert.equal(b.steps[2].last_error, "boom");
  assert.equal(b.available, false);
  assert.equal(b.state, "available");
  assert.equal(b.category, "extras");
  assert.throws(() => I.adaptIntegration({ id: "../x" }));
  assert.throws(() => I.adaptIntegration(null));
});

// --- mapping CRUD ------------------------------------------------------------------------------
test("mapping: set per role and per integration, instances use their role's, bad input refused", () => {
  assert.deepEqual(I.setRoleIntegrations(coder.id, ["github", "aws", "github"]), ["aws", "github"]);
  assert.deepEqual(I.mappedIntegrations(coderTask.id), ["aws", "github"], "an instance sees its role's mapping");
  assert.deepEqual(I.setIntegrationRoles("kubernetes", [writer.id]), [writer.id]);
  assert.deepEqual(I.rolesFor("github"), [coder.id]);
  I.setIntegrationRoles("kubernetes", []);
  assert.deepEqual(I.rolesFor("kubernetes"), []);
  assert.throws(() => I.setRoleIntegrations(coder.id, ["Bad Id"]), /Bad integration id/);
  assert.throws(() => I.setRoleIntegrations(coderTask.id, ["github"]), /roles/);
  assert.throws(() => I.setIntegrationRoles("github", ["nope"]), /No such agent/);
  // Deleting a role drops its mappings.
  const temp = mk("temp-role");
  I.setRoleIntegrations(temp.id, ["github"]);
  A.deleteAgent(temp.id);
  assert.equal(get(`SELECT COUNT(*) AS n FROM role_integrations WHERE role_id = ?`, temp.id)?.n, 0);
});

// --- instruction layers ------------------------------------------------------------------------
test("layers: only integrations that are mapped AND connected, with pointers, in §10.3 order", async () => {
  I.setRoleIntegrations(coder.id, ["github", "aws"]); // aws mapped but not connected
  // kubernetes is connected but mapped to nobody
  await I.refreshIntegrations(0);
  const ls = R.instructionLayers(coderTask);
  assert.deepEqual(ls.map((l) => l.id), ["platform", "integrations", "team", "role", "work"]);
  const integ = layer(coderTask, "integrations");
  assert.match(integ, /use `gh` for issues/);
  assert.ok(integ.includes(path.join(dirs.team, "integrations", "github.md")), "pointer to the detailed rules");
  assert.doesNotMatch(integ, /AWS|stale summary/, "mapped but not connected: invisible");
  assert.doesNotMatch(integ, /Kubernetes/, "connected but unmapped: invisible");
  assert.equal(layer(writer, "integrations"), "", "nothing mapped: no layer");
  assert.match(layer(coderTask, "team"), /branching\.md/);
  // Ordering inside the assembled prompt.
  const all = ls.map((l) => l.text).filter(Boolean).join("\n\n");
  assert.ok(all.indexOf("## Platform rules") < all.indexOf("## Integrations") && all.indexOf("## Integrations") < all.indexOf("## Team rules"));
  // Connecting aws (per the CLI) makes it appear.
  const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  st.integrations.find((x: any) => x.id === "aws").state = "connected";
  fs.writeFileSync(stateFile, JSON.stringify(st));
  await I.refreshIntegrations(0);
  assert.match(layer(coderTask, "integrations"), /stale summary/);
  resetCli();
  await I.refreshIntegrations(0);
});

test("skills: integration skills only while connected and mapped; links follow", async () => {
  await I.refreshIntegrations(0);
  assert.deepEqual(I.integrationSkills(coderTask), ["review-pr"], "github connected+mapped; aws mapped but not connected");
  assert.deepEqual(I.integrationSkills(writer), []);
  K.setAgentSkills(coder.id, ["own-skill"]);
  const skills = [...new Set([...K.skillsOf(coderTask.id), ...I.integrationSkills(coderTask)])].filter(K.skillExists);
  K.syncLinks(coderTask, skills);
  const links = fs.readdirSync(path.join(A.homeOf(coder), ".claude", "skills")).sort();
  assert.deepEqual(links, ["own-skill", "review-pr"]);
  I.setRoleIntegrations(coder.id, ["aws"]);
  assert.deepEqual(I.integrationSkills(coderTask), [], "unmapped github: its skill goes");
  I.setRoleIntegrations(coder.id, ["github", "aws"]);
});

// --- the setup role ----------------------------------------------------------------------------
test("setup role: seeded once, can't be deleted, renamed or have its CLAUDE.md edited; notes instead", () => {
  assert.equal(S.ensureSetupRole().id, setup.id, "idempotent");
  assert.equal(setup.builtin, "setup");
  assert.equal(setup.title, "Setup & integrations");
  assert.throws(() => A.deleteAgent(setup.id), /can't be deleted/);
  assert.throws(() => A.editInstructions(setup, "# mine\n"), /maintained by agentbox/);
  assert.throws(() => A.updateAgent(setup.id, { title: "Something else" }), /built in/);
  assert.equal(A.updateAgent(setup.id, { model: "opus" }).model, "opus", "the model can change");
  // Tampering on disk is undone at the next start.
  fs.writeFileSync(A.instructionsPath(setup), "tampered");
  S.ensureSetupRole();
  assert.equal(A.readInstructions(setup), S.setupTemplate());
  assert.match(S.setupTemplate(), /Never handle secrets in chat/);
  // Ordinary roles stay editable.
  A.editInstructions(writer, "# writer v2\n");
  assert.equal(A.readInstructions(writer), "# writer v2\n");
  // Only the owner starts setup tasks.
  assert.throws(() => A.spawnInstance(setup.id, { label: "x", createdBy: coderTask.id }), /Only the owner/);
  assert.throws(() => A.spawnInstance(setup.id, { label: "x", createdBy: "routine:abc" }), /Only the owner/);
  // Notes: only for built-in roles, added to its role layer.
  assert.throws(() => S.setOwnerNotes(writer.id, "x"), /built-in/);
  S.setOwnerNotes(setup.id, "Prefer eu-west-1 for AWS.");
  assert.match(layer(A.getAgent(setupTask.id)!, "role"), /Prefer eu-west-1/);
  assert.equal(layer(coderTask, "role"), "");
  // Not offered to other agents for delegation.
  assert.match(layer(coderTask, "platform"), /writer/);
  assert.doesNotMatch(layer(coderTask, "platform"), /\*\*setup\*\*/);
});

test("setup role: Connect opens or reuses one task per integration, with a steps card", () => {
  const sent: string[] = [];
  const deps = {
    spawn: (roleId: string, label: string) => A.spawnInstance(roleId, { label, createdBy: "owner" }),
    send: (_id: string, text: string) => { sent.push(text); },
    card: (id: string) => S.postIntegrationCard(A.dmThreadOf(id)!, "aws"),
  };
  const a = S.setupTaskFor("connect", { id: "aws", title: "AWS" }, deps);
  assert.equal(a.created, true);
  assert.equal(a.instance.label, "Connect AWS");
  assert.match(sent[0], /id `aws`/);
  const b = S.setupTaskFor("connect", { id: "aws", title: "AWS" }, deps);
  assert.equal(b.created, false);
  assert.equal(b.instance.id, a.instance.id);
  S.postIntegrationCard(A.dmThreadOf(a.instance.id)!, "aws");
  assert.equal(all(`SELECT * FROM messages WHERE thread_id = ? AND author = 'integration'`, A.dmThreadOf(a.instance.id)).length, 1, "one card per integration per chat");
});

// --- approvals -----------------------------------------------------------------------------------
test("approvals: other roles refused; mapping applies only on approve; reject discards", () => {
  const tid = fakeTask(setupTask.id);
  assert.throws(() => AP.proposeMapping(coderTask, fakeTask(coderTask.id), "github", ["writer"]), /Only the setup agent/);
  assert.throws(() => AP.proposeTeamRule(coderTask, null, "x.md", "x"), /Only the setup agent/);
  assert.throws(() => AP.proposeMapping(setupTask, tid, "github", ["nobody"]), /No agent called "nobody"/);
  assert.throws(() => AP.proposeMapping(setupTask, tid, "github", ["setup"]), /No agent called/, "the setup agent can't map itself");

  const before = I.rolesFor("github");
  const p = AP.proposeMapping(setupTask, tid, "github", ["coder", "Writer"], "GitHub");
  assert.equal(p.status, "pending");
  assert.deepEqual(p.payload.added, [writer.id]);
  assert.deepEqual(I.rolesFor("github"), before, "nothing applied yet");
  const card = get(`SELECT * FROM messages WHERE author = 'approval' AND content = ?`, p.id);
  assert.equal(card?.thread_id, A.dmThreadOf(setupTask.id), "a card in the setup chat");

  AP.approve(p.id);
  assert.deepEqual(I.rolesFor("github").sort(), [coder.id, writer.id].sort());
  assert.throws(() => AP.approve(p.id), /Already approved/);

  const q = AP.proposeMapping(setupTask, tid, "github", ["coder"]);
  AP.reject(q.id);
  assert.equal(AP.getApproval(q.id)!.status, "rejected");
  assert.deepEqual(I.rolesFor("github").sort(), [coder.id, writer.id].sort(), "reject changes nothing");
  assert.throws(() => AP.approve(q.id), /Already rejected/);
  I.setIntegrationRoles("github", [coder.id]);
});

test("approvals: team rules show a diff and apply atomically; stale or unsafe paths refused", () => {
  const tid = fakeTask(setupTask.id);
  const file = path.join(dirs.team, "branching.md");
  const p = AP.proposeTeamRule(setupTask, tid, "branching.md", "# Branching\n\nmain is protected.\nSquash merges only.\n", "match the repo settings");
  assert.equal(p.payload.relative, "branching.md");
  assert.ok(p.payload.diff.some((d: any) => d.op === "+" && d.text === "Squash merges only."));
  assert.equal(fs.readFileSync(file, "utf8"), "# Branching\n\nmain is protected.\n", "not applied before approval");
  AP.approve(p.id);
  assert.match(fs.readFileSync(file, "utf8"), /Squash merges only/);
  assert.deepEqual(fs.readdirSync(dirs.team).filter((f) => f.endsWith(".tmp")), [], "no temp file left");

  // Changed since proposed: refused, file untouched.
  const q = AP.proposeTeamRule(setupTask, tid, "branching.md", "# Branching\n\nv3\n");
  fs.appendFileSync(file, "owner edit\n");
  assert.throws(() => AP.approve(q.id), /changed since/);
  assert.match(fs.readFileSync(file, "utf8"), /owner edit/);

  // A new file.
  const n = AP.proposeTeamRule(setupTask, tid, "/team/cloud.md", "# Cloud\n");
  AP.approve(n.id);
  assert.equal(fs.readFileSync(path.join(dirs.team, "cloud.md"), "utf8"), "# Cloud\n");

  for (const bad of ["../escape.md", "integrations/github.md", "notes.txt", ".hidden.md", "/etc/passwd.md"]) {
    assert.throws(() => AP.proposeTeamRule(setupTask, tid, bad, "x"), undefined, bad);
  }
  fs.symlinkSync(os.tmpdir(), path.join(dirs.team, "out"));
  assert.throws(() => AP.proposeTeamRule(setupTask, tid, "out/x.md", "x"), /leaves the team folder/);
});

test("approvals: only the owner's POST applies; local-token calls refused", async () => {
  const app = Fastify();
  app.setErrorHandler((err: any, _req, reply) => { reply.status(err.statusCode ?? 400).send({ error: err.message }); });
  registerIntegrationRoutes(app);
  const tid = fakeTask(setupTask.id);
  const p = AP.proposeMapping(setupTask, tid, "github", ["writer"]);
  const viaCli = await app.inject({ method: "POST", url: `/api/approvals/${p.id}/approve`, headers: { "x-agentbox-local-token": "x" } });
  assert.equal(viaCli.statusCode, 403);
  assert.equal(AP.getApproval(p.id)!.status, "pending");
  const ok = await app.inject({ method: "POST", url: `/api/approvals/${p.id}/approve` });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(I.rolesFor("github"), [writer.id]);
  const again = await app.inject({ method: "POST", url: `/api/approvals/${p.id}/reject` });
  assert.equal(again.statusCode, 409);
  const missing = await app.inject({ method: "POST", url: `/api/approvals/nope/approve` });
  assert.equal(missing.statusCode, 404);
  // Notes and instructions routes: built-in protections hold over HTTP too.
  const notes = await app.inject({ method: "PUT", url: `/api/agents/${setup.id}/notes`, payload: { text: "hi" } });
  assert.equal(notes.statusCode, 200);
  const list = await app.inject({ method: "GET", url: `/api/integrations` });
  const body = JSON.parse(list.body);
  assert.equal(body.error, null);
  assert.ok(body.integrations.find((x: any) => x.id === "github").roles.includes(writer.id));
  assert.equal(body.setup_role_id, setup.id);
  I.setIntegrationRoles("github", [coder.id]);
  await app.close();
});

// --- temporary sudo ----------------------------------------------------------------------------
test("sudo: drop-in exists only while a setup turn holds it; cleaned at start and by the sweep", () => {
  const f = SU.sudoersFile();
  assert.equal(path.dirname(f), dirs.sudoers);
  assert.deepEqual(SU.grantSetupSudo("t1"), { ok: true });
  assert.equal(fs.statSync(f).mode & 0o777, 0o440);
  assert.match(fs.readFileSync(f, "utf8"), /ALL=\(ALL\) NOPASSWD:ALL/);
  assert.equal(SU.sudoActive(), true);
  SU.grantSetupSudo("t2");
  SU.releaseSetupSudo("t1");
  assert.equal(fs.existsSync(f), true, "another setup turn still runs");
  SU.releaseSetupSudo("t2");
  assert.equal(fs.existsSync(f), false, "the last one out removes it");
  assert.equal(SU.sudoActive(), false);
  // A leftover from a crash: removed at start.
  fs.writeFileSync(f, "x");
  SU.cleanupSetupSudo();
  assert.equal(fs.existsSync(f), false);
  // Or by the sweep, when no turn holds it.
  fs.writeFileSync(f, "x");
  SU.sweepSetupSudo();
  assert.equal(fs.existsSync(f), false);
  SU.grantSetupSudo("t3");
  SU.sweepSetupSudo();
  assert.equal(fs.existsSync(f), true, "the sweep leaves a held grant");
  SU.releaseSetupSudo("t3");
  // The platform layer tells the setup agent what it has.
  assert.match(R.instructionLayers(setupTask, { ok: true }).find((l) => l.id === "platform")!.text, /temporary\*\* passwordless sudo/);
  assert.match(R.instructionLayers(setupTask, { ok: false, error: "no helper" }).find((l) => l.id === "platform")!.text, /couldn't be granted \(no helper\)/);
});

// --- the MCP tools with the fake CLI ------------------------------------------------------------
test("tools: list, status (posts a card), connect streams output, settings validated, proposals", async () => {
  resetCli();
  const tid = fakeTask(setupTask.id);
  const thread = A.dmThreadOf(setupTask.id)!;
  const tools = T.setupTools(setupTask, tid);
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ["connect", "disconnect", "integration_status", "list_integrations", "propose_mapping", "propose_team_rule", "save_settings", "verify"]);

  const l = await call(tools, "list_integrations", {});
  assert.match(l.content[0].text, /code-hosting:\n {2}- github: GitHub \[connected\]/);
  assert.match(l.content[0].text, /slack: Slack \[coming soon\]/);

  const s = await call(tools, "integration_status", { id: "aws" });
  assert.match(s.content[0].text, /⏸ login: Log in \[human\] \(human gate\)/);
  assert.match(s.content[0].text, /region \(required\): \(not set\)/);
  assert.equal(all(`SELECT * FROM messages WHERE thread_id = ? AND author = 'integration' AND content = 'aws'`, thread).length, 1);

  const lines: string[] = [];
  const off = subscribe((e: any) => { if (e.type === "integration.output" && e.integrationId === "aws") lines.push(e.line); });
  const c = await call(tools, "connect", { id: "aws" });
  off();
  assert.equal(c.isError, undefined, c.content[0].text);
  assert.deepEqual(lines, ["==> connect aws", "installing things", "done"], "streamed, without the JSON result line");
  assert.match(c.content[0].text, /connect aws: finished/);
  assert.match(c.content[0].text, /state: connected/);
  assert.deepEqual(I.outputOf("aws").map((x) => x.line), lines);

  const bad = await call(tools, "connect", { id: "broken" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /failed \(exit 3\)[\s\S]*unable to locate package/);

  const unknownKey = await call(tools, "save_settings", { id: "aws", values: { token: "x" } });
  assert.equal(unknownKey.isError, true);
  assert.match(unknownKey.content[0].text, /no setting "token"/);
  const multi = await call(tools, "save_settings", { id: "aws", values: { region: "eu\nwest" } });
  assert.equal(multi.isError, true);
  const saved = await call(tools, "save_settings", { id: "aws", values: { region: "eu-west-1" } });
  assert.equal(saved.isError, undefined, saved.content[0].text);
  assert.ok(cliCalls().some((a) => a.join(" ") === "integration settings aws --set region=eu-west-1 --json"));

  const pm = await call(tools, "propose_mapping", { id: "aws", roles: ["coder"] });
  assert.match(pm.content[0].text, /nothing changes until they approve/);
  assert.equal(AP.listApprovals({ threadId: thread, status: "pending" }).some((a) => a.payload.integration_id === "aws"), true);

  const tr = await call(tools, "propose_team_rule", { file: "aws.md", content: "# AWS\n", reason: "new" });
  assert.match(tr.content[0].text, /Proposed aws\.md/);

  // Every CLI call used --json.
  assert.ok(cliCalls().every((a) => a[0] === "integration" && a.includes("--json")));
});

test("tools: refused for any other role, even if attached by mistake", async () => {
  const tools = T.setupTools(coderTask, fakeTask(coderTask.id));
  for (const [name, args] of [["list_integrations", {}], ["connect", { id: "aws" }], ["propose_mapping", { id: "aws", roles: ["coder"] }]] as const) {
    const r = await call(tools, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /setup agent only/);
  }
});

test("cli: a hung command is killed at its timeout", async () => {
  process.env.FAKE_CLI_SLEEP = "5000";
  const r = await I.runCli(["verify", "github"], { timeoutMs: 300 });
  delete process.env.FAKE_CLI_SLEEP;
  assert.equal(r.timedOut, true);
  resetCli();
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
