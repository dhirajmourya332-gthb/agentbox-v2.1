/**
 * Integrations, the setup agent and approvals (docs/V2-ARCHITECTURE.md §10.3–10.5), in-process
 * against a throwaway database, temp folders, a temp sudoers dir and the REAL `agentbox` CLI
 * (cli/agentbox.mjs) over a throwaway config and module tree (AGENTBOX_NO_SUDO=1: it writes into the
 * temp folder as this user). So the adapter is tested against the CLI's actual JSON. Touches
 * nothing outside a temp folder; never starts Claude.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/integrations.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-integrations-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations", "sudoers", "demo"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));

// --- a module tree for the real CLI ------------------------------------------------------------
const src = path.join(tmp, "src");
const mods = path.join(src, "setup", "modules");
const mod = (id: string, yaml: string, files: Record<string, string> = {}) => {
  fs.mkdirSync(path.join(mods, id), { recursive: true });
  fs.writeFileSync(path.join(mods, id, "module.yaml"), yaml);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(mods, id, f), c);
};
const flag = (name: string) => `test -f "$DEMO_DIR/${name}"`;
mod("core", "id: core\nkind: base\ntitle: core\ndepends: []\nsteps: [{ id: ok, title: ok, check: 'true' }]\n");
mod("github", `id: github
kind: integration
category: code-hosting
title: GitHub
description: git + gh
depends: [core]
settings:
  - { key: default_repo, prompt: "Default repository (owner/name)", pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', example: acme/web-app }
  - { key: labels, type: list, prompt: "Labels" }
  - { key: base_branch, prompt: "The main branch", default: main }
instructions:
  summary: "GitHub: use \`gh\` for issues, PRs and reviews{{#default_repo}} (default repo {{default_repo}}){{/default_repo}}."
  file: instructions.md
skills: [review-pr]
default_roles: [coder, tech-lead]
account: "echo octo-owner"
revoke: "On the VM: gh auth logout. On GitHub: Settings → Applications → revoke GitHub CLI."
steps:
  - { id: install, title: Install git and gh, run: install.sh, check: '${flag("github-installed")}' }
  - { id: login, title: Log in to GitHub, human: true, instructions: "In the terminal run: \`gh auth login\`", copy: "gh auth login", check: '${flag("github-login")}' }
`, {
  "install.sh": `#!/usr/bin/env bash\nset -e\necho "installing gh"\ntouch "$DEMO_DIR/github-installed"\n`,
  "instructions.md": "# GitHub rules\n\nRepo: {{default_repo}}\n",
});
mod("aws", `id: aws
kind: integration
category: cloud
title: AWS
depends: [core]
settings:
  - { key: region, prompt: "Default region", required: true, pattern: '^[a-z]{2}-[a-z]+-[0-9]$', example: eu-west-1 }
instructions:
  summary: "AWS: the aws CLI, region {{region}}."
  file: instructions.md
skills: [aws-cost]
default_roles: [devops]
revoke: "aws sso logout"
steps:
  - { id: install, title: Install the AWS CLI, run: install.sh, check: '${flag("aws-installed")}' }
  - { id: login, title: Log in, human: true, instructions: "Run \`aws configure sso\`", copy: "aws configure sso", check: '${flag("aws-login")}' }
`, {
  "install.sh": `#!/usr/bin/env bash\nset -e\necho "==> installing awscli"\necho "unpacking"\ntouch "$DEMO_DIR/aws-installed"\necho "done"\n`,
  "instructions.md": "# AWS\n\nRegion {{region}}.\n",
});
// No detailed instructions file: the layer lists none.
mod("kubernetes", `id: kubernetes
kind: integration
category: cluster
title: Kubernetes
depends: [core]
instructions:
  summary: "Kubernetes: kubectl, context example."
revoke: "remove ~/.kube/config"
steps:
  - { id: kubectl, title: kubectl, check: 'true' }
`);
mod("broken", `id: broken
kind: integration
category: extras
title: Broken
depends: [core]
steps:
  - { id: install, title: Install, run: install.sh, check: 'false' }
`, { "install.sh": "#!/usr/bin/env bash\necho 'E: unable to locate package' >&2\nexit 3\n" });
mod("slow", `id: slow
kind: integration
category: extras
title: Slow
depends: [core]
steps:
  - { id: install, title: Install, run: install.sh, check: 'false' }
`, { "install.sh": "#!/usr/bin/env bash\necho start\nsleep 5\n" });
mod("slack", "id: slack\nkind: integration\ncategory: chat\ntitle: Slack\navailable: false\nsteps: []\n");

const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima
access: ssh-tunnel
user: ${os.userInfo().username}
agent_sudo: true
paths: { src: ${src}, team: ${dirs.team}, work: ${dirs.work}, secrets: ${dirs.secrets}, data: ${dirs.data}, agents: ${dirs.agents}, skills: ${dirs.skills}, integrations: ${dirs.integrations} }
modules: { github: false, aws: false, kubernetes: false }
`);

// The CLI as the portal runs it.
const cliScript = path.join(repo, "cli", "agentbox.mjs");
const cli = path.join(tmp, "agentbox");
fs.writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${cliScript}" "$@"\n`, { mode: 0o755 });

Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_NO_SUDO: "1", DEMO_DIR: dirs.demo, NO_COLOR: "1",
  AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations,
  AGENTBOX_INTEGRATIONS_DIR: dirs.integrations,
  AGENTBOX_SUDOERS_DIR: dirs.sudoers, AGENTBOX_SUDO_HELPER: "/nonexistent/helper",
  AGENTBOX_CLI: cli, AGENTBOX_PROGRESS_TICK_MS: "3600000",
});
const agentbox = (...args: string[]) => {
  const r = spawnSync(cli, args, { encoding: "utf8", env: process.env });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
// Connected before the portal starts: GitHub (with its login done) and Kubernetes.
fs.writeFileSync(path.join(dirs.demo, "github-login"), "");
for (const args of [["connect", "github", "--set", "default_repo=acme/example-repo"], ["connect", "kubernetes"]]) {
  const r = agentbox("integration", ...args);
  assert.equal(r.code, 0, r.err + r.out);
}
// A stale summary of an integration that isn't connected: never shown.
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
const C = await import("../src/config.ts");
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
const statusJson = (id: string) => JSON.parse(agentbox("integration", "status", id, "--json").out);

// --- the adapter --------------------------------------------------------------------------------
test("adapter: the real CLI's status --json (connected, with settings, steps, instructions)", () => {
  const raw = statusJson("github");
  const a = I.adaptIntegration(raw);
  assert.equal(a.state, "connected");
  assert.equal(a.enabled, true);
  assert.equal(a.available, true);
  assert.equal(a.account, "octo-owner");
  assert.deepEqual(a.depends, ["core"]);
  assert.deepEqual(a.settings.map((x) => [x.key, x.type, x.value, x.default]), [
    ["default_repo", "string", "acme/example-repo", null], ["labels", "list", null, null], ["base_branch", "string", null, "main"],
  ]);
  assert.equal(a.settings[0].pattern, raw.settings.schema[0].pattern);
  assert.equal(a.settings[0].example, "acme/web-app");
  assert.equal(a.settings_saved, true);
  assert.equal(a.settings_file, path.join(dirs.integrations, "github.yaml"));
  assert.deepEqual(a.steps.map((x) => [x.id, x.state, x.human, x.check?.ok]), [["install", "done", false, true], ["login", "done", true, true]]);
  assert.equal(a.steps[1].copy, "gh auth login");
  assert.deepEqual(a.gates, []);
  assert.match(a.revoke!, /gh auth logout/);
  assert.deepEqual(a.skills, ["review-pr"]);
  assert.deepEqual(a.default_roles, ["coder", "tech-lead"]);
  assert.equal(a.instructions.file, path.join(dirs.team, "integrations", "github.md"));
  assert.equal(a.instructions.summary_file, path.join(dirs.integrations, "github.summary.md"));
  assert.equal(a.instructions.rendered, true);
  assert.equal(a.last?.action, "connect");
  assert.equal(a.last?.ok, true);
  assert.ok(a.checked_at);
});

test("adapter: gates (a setting and a login), failed checks, unavailable, list entries, bad input", () => {
  // Not connected: no gates (they're listed once it's enabled).
  const avail = I.adaptIntegration(statusJson("aws"));
  assert.equal(avail.state, "available");
  assert.deepEqual(avail.missing, ["region"]);
  assert.equal(avail.settings[0].missing, true);
  assert.equal(avail.settings[0].required, true);
  // From the contract: an enabled integration waiting for the owner.
  const raw = {
    id: "aws", title: "AWS", description: "", category: "cloud", available: true, enabled: true, state: "connecting", account: null, depends: ["core"],
    steps: [
      { id: "install", title: "Install", human: false, state: "done", check: { ok: true, code: 0 }, instructions: null, copy: null },
      { id: "login", title: "Log in", human: true, state: "human", check: { ok: false, code: 1, output: "not logged in" }, instructions: "Run `aws configure sso`", copy: "aws configure sso" },
      { id: "verify", title: "Verify", human: false, state: "failed", check: { ok: false, code: null, output: "", timed_out: true }, instructions: null, copy: null },
      { id: "extra", title: "Extra", human: false, state: "skipped", check: null, instructions: null, copy: null },
    ],
    settings: { file: "/etc/agentbox/integrations/aws.yaml", saved: false, schema: [{ key: "region", prompt: "Region", type: "string", required: true }, { key: "mode", prompt: "Mode", type: "enum", required: false, options: ["read-only", "full"], default: "read-only" }], values: { mode: "full" }, missing: ["region"], errors: [{ key: "mode", error: "one of read-only, full" }] },
    instructions: { summary: "AWS: region .", summary_file: "/etc/agentbox/integrations/aws.summary.md", file: "/team/integrations/aws.md", rendered: false },
    skills: ["aws-cost"], default_roles: ["devops"], revoke: "aws sso logout",
    gates: [{ kind: "setting", key: "region", title: "Region", command: "agentbox integration settings aws --set region=…" }, { kind: "step", id: "login", title: "Log in", instructions: "Run `aws configure sso`", copy: "aws configure sso" }],
    last: { action: "connect", ok: true, at: "2026-10-11T00:00:00Z" }, checked_at: "2026-10-11T00:00:00Z",
  };
  const a = I.adaptIntegration(raw);
  assert.equal(a.state, "connecting");
  assert.deepEqual(a.steps.map((x) => x.state), ["done", "human", "failed", "skipped"]);
  assert.equal(a.steps[1].last_error, null, "a gate is the owner's turn, not an error");
  assert.equal(a.steps[2].last_error, "the check timed out");
  assert.deepEqual(a.gates, raw.gates);
  assert.deepEqual(a.settings[1], { key: "mode", prompt: "Mode", type: "enum", required: false, default: "read-only", options: ["read-only", "full"], pattern: null, example: null, value: "full", missing: false, error: "one of read-only, full" });
  assert.equal(a.settings_saved, false);
  assert.equal(a.revoke, "aws sso logout");
  // Coming soon.
  const soon = I.adaptIntegration(statusJson("slack"));
  assert.equal(soon.state, "unavailable");
  assert.equal(soon.available, false);
  assert.equal(I.adaptIntegration({ id: "teams", available: false, state: "available" }).state, "unavailable");
  // A `list --json` entry: no steps or settings, safe defaults.
  const listed = JSON.parse(agentbox("integration", "list", "--json").out).integrations;
  const l = I.adaptIntegration(listed.find((x: any) => x.id === "github"));
  assert.equal(l.state, "connecting", "enabled but no state reported");
  assert.deepEqual([l.steps, l.settings, l.gates], [[], [], []]);
  assert.throws(() => I.adaptIntegration({ id: "../x" }));
  assert.throws(() => I.adaptIntegration(null));
});

test("cli output: JSON after progress lines (settings prints 'rendered …' first)", () => {
  assert.deepEqual(I.parseJsonOutput('  rendered /a\n  rendered /b\n{\n  "id": "x",\n  "values": {\n    "a": 1\n  }\n}\n'), { id: "x", values: { a: 1 } });
  assert.deepEqual(I.parseJsonOutput('[1, 2]'), [1, 2]);
  assert.equal(I.parseJsonOutput("no json here"), null);
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
  assert.deepEqual(ls.map((l) => l.id), ["platform", "integrations", "repos", "team", "role", "work"]);
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
  // Kubernetes has no detailed rules file: its summary only.
  I.setRoleIntegrations(writer.id, ["kubernetes"]);
  const k = layer(writer, "integrations");
  assert.match(k, /Kubernetes: kubectl/);
  assert.doesNotMatch(k, /Detailed rules/);
  I.setRoleIntegrations(writer.id, []);
});

test("modules.<id> in config.yaml is picked up without a restart", async () => {
  assert.equal(I.isConnected("github"), true);
  const text = fs.readFileSync(configFile, "utf8");
  const changes: string[][] = [];
  const off = C.onModulesChange((ids) => changes.push(ids));
  // Someone ran `agentbox integration disconnect github` (or edited the file): off at once.
  fs.writeFileSync(configFile, text.replace("github: true", "github: false"));
  assert.deepEqual(C.refreshModules(0), ["github"]);
  assert.equal(C.config.modules.github, false);
  assert.equal(I.isConnected("github"), false, "the cached 'connected' doesn't outlive the switch");
  assert.equal(layer(coderTask, "integrations"), "");
  // Back on: the next turn waits for a fresh status (the cache is dirty), then it's visible again.
  fs.writeFileSync(configFile, text);
  C.refreshModules(0);
  await I.integrationsForTurn();
  assert.equal(I.isConnected("github"), true);
  assert.match(layer(coderTask, "integrations"), /use `gh` for issues/);
  off();
  assert.deepEqual(changes, [["github"], ["github"]]);
  // An unknown id from a newer catalog comes from the file too.
  fs.writeFileSync(configFile, text.replace("modules: {", "modules: { future-thing: true,"));
  C.refreshModules(0);
  assert.equal(C.moduleOn("future-thing"), true);
  fs.writeFileSync(configFile, text);
  C.refreshModules(0);
  assert.equal(C.moduleOn("future-thing"), false);
});

test("skills: integration skills only while connected and mapped; others' skills are withheld; links follow", async () => {
  await I.refreshIntegrations(0);
  assert.deepEqual(I.integrationSkills(coderTask), ["review-pr"], "github connected+mapped; aws mapped but not connected");
  assert.deepEqual(I.integrationSkills(writer), []);
  K.setAgentSkills(coder.id, ["own-skill"]);
  const skills = I.effectiveSkills(coderTask, K.skillsOf(coderTask.id)).filter(K.skillExists);
  K.syncLinks(coderTask, skills);
  const links = fs.readdirSync(path.join(A.homeOf(coder), ".claude", "skills")).sort();
  assert.deepEqual(links, ["own-skill", "review-pr"]);
  // Assigned directly, but its integration (AWS) isn't connected: withheld.
  K.setAgentSkills(writer.id, ["own-skill", "aws-cost", "review-pr"]);
  assert.deepEqual(I.effectiveSkills(writer, K.skillsOf(writer.id)), ["own-skill"], "github unmapped, aws not connected");
  I.setRoleIntegrations(writer.id, ["github"]);
  assert.deepEqual(I.effectiveSkills(writer, K.skillsOf(writer.id)), ["own-skill", "review-pr"]);
  I.setRoleIntegrations(writer.id, []);
  K.setAgentSkills(writer.id, []);
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
test("tools: list, status (posts a card), settings via the CLI, connect streams output, gates, verify, disconnect", async () => {
  const tid = fakeTask(setupTask.id);
  const thread = A.dmThreadOf(setupTask.id)!;
  const tools = T.setupTools(setupTask, tid);
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ["add_repo", "add_steps", "complete_setup_request", "connect", "disconnect", "integration_status", "list_integrations", "list_repos", "list_setup_requests", "propose_mapping", "propose_team_rule", "read_terminal", "save_settings", "set_plan", "update_step", "verify"]);

  const l = await call(tools, "list_integrations", {});
  assert.match(l.content[0].text, /code-hosting:\n {2}- github: GitHub \[connected\]/);
  assert.match(l.content[0].text, /slack: Slack \[coming soon\]/);

  const s = await call(tools, "integration_status", { id: "aws" });
  assert.match(s.content[0].text, /state: available/);
  assert.match(s.content[0].text, /region \[string, required\]: \(not set\) · Default region \(e\.g\. eu-west-1\)/);
  assert.match(s.content[0].text, /To revoke its credentials.*aws sso logout/);
  assert.equal(all(`SELECT * FROM messages WHERE thread_id = ? AND author = 'integration' AND content = 'aws'`, thread).length, 1);

  // Settings: validated by the CLI (pattern, secrets), unknown keys refused before it runs.
  const unknownKey = await call(tools, "save_settings", { id: "aws", values: { token: "x" } });
  assert.equal(unknownKey.isError, true);
  assert.match(unknownKey.content[0].text, /no setting "token"/);
  const badPattern = await call(tools, "save_settings", { id: "aws", values: { region: "Europe" } });
  assert.equal(badPattern.isError, true);
  assert.match(badPattern.content[0].text, /aws\.region: must match/);
  const secret = await call(tools, "save_settings", { id: "github", values: { default_repo: "ghp_" + "x".repeat(36) } });
  assert.equal(secret.isError, true);
  assert.match(secret.content[0].text, /looks like a secret/);
  const saved = await call(tools, "save_settings", { id: "aws", values: { region: "eu-west-1" } });
  assert.equal(saved.isError, undefined, saved.content[0].text);
  assert.match(saved.content[0].text, /Saved region for aws\. Nothing required is missing/);
  assert.match(fs.readFileSync(path.join(dirs.integrations, "aws.yaml"), "utf8"), /region: eu-west-1/);
  const list = await call(tools, "save_settings", { id: "github", values: { labels: ["bug", "feature"] } });
  assert.equal(list.isError, undefined, list.content[0].text);
  assert.match(fs.readFileSync(path.join(dirs.integrations, "github.yaml"), "utf8"), /default_repo: acme\/example-repo[\s\S]*- bug/);

  // Connect: output streams into the chat; it stops at the login gate (connecting, a "your turn").
  const lines: string[] = [];
  const jobs: any[] = [];
  const off = subscribe((e: any) => {
    if (e.type === "integration.output" && e.integrationId === "aws") lines.push(e.line);
    if (e.type === "integration.job" && e.integrationId === "aws") jobs.push(e.job);
  });
  const c = await call(tools, "connect", { id: "aws" });
  off();
  assert.equal(c.isError, undefined, c.content[0].text);
  for (const want of ["==> installing awscli", "unpacking", "done"]) assert.ok(lines.includes(want), `streamed: ${want} in ${JSON.stringify(lines)}`);
  assert.deepEqual(jobs.map((j) => j.running), [true, false]);
  assert.equal(jobs[1].ok, true);
  assert.match(c.content[0].text, /connect aws: finished/);
  assert.match(c.content[0].text, /state: connecting/);
  assert.match(c.content[0].text, /Waiting for the owner:\n {2}- Log in: Run `aws configure sso` \[copy: aws configure sso\]/);
  assert.deepEqual(I.outputOf("aws").map((x) => x.line), lines);
  assert.equal(C.config.modules.aws, true, "the server saw modules.aws flip without a restart");
  const st = await I.integrationStatus("aws");
  assert.deepEqual(st.gates, [{ kind: "step", id: "login", title: "Log in", instructions: "Run `aws configure sso`", copy: "aws configure sso" }]);
  assert.equal(I.isConnected("aws"), false, "a gate is open: not connected yet");
  assert.doesNotMatch(layer(coderTask, "integrations"), /AWS/);

  // The owner logs in; verify → connected; the layer and the skill follow.
  fs.writeFileSync(path.join(dirs.demo, "aws-login"), "");
  const v = await call(tools, "verify", { id: "aws" });
  assert.equal(v.isError, undefined, v.content[0].text);
  assert.match(v.content[0].text, /state: connected/);
  await I.integrationsForTurn();
  assert.equal(I.isConnected("aws"), true);
  assert.match(layer(coderTask, "integrations"), /AWS: the aws CLI, region eu-west-1\./);
  assert.doesNotMatch(layer(coderTask, "integrations"), /stale summary/);
  assert.deepEqual(I.integrationSkills(coderTask), ["aws-cost", "review-pr"]);

  const bad = await call(tools, "connect", { id: "broken" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /failed \(exit 1\)[\s\S]*unable to locate package/);

  const soon = await call(tools, "connect", { id: "slack" });
  assert.equal(soon.isError, true);
  assert.match(soon.content[0].text, /coming soon/);

  // Disconnect: the revoke text comes back; modules.aws off at once; layer and skill gone.
  const d = await call(tools, "disconnect", { id: "aws" });
  assert.equal(d.isError, undefined, d.content[0].text);
  assert.match(d.content[0].text, /Credentials were left alone[\s\S]*aws sso logout/);
  assert.match(d.content[0].text, /state: disconnected/);
  assert.equal(C.config.modules.aws, false);
  assert.equal(I.isConnected("aws"), false);
  assert.doesNotMatch(layer(coderTask, "integrations"), /AWS/);
  assert.deepEqual(I.integrationSkills(coderTask), ["review-pr"]);

  const pm = await call(tools, "propose_mapping", { id: "aws", roles: ["coder"] });
  assert.match(pm.content[0].text, /nothing changes until they approve/);
  assert.equal(AP.listApprovals({ threadId: thread, status: "pending" }).some((a) => a.payload.integration_id === "aws"), true);

  const tr = await call(tools, "propose_team_rule", { file: "aws.md", content: "# AWS\n", reason: "new" });
  assert.match(tr.content[0].text, /Proposed aws\.md/);
});

test("sudo: the CLI's writes need the setup turn's grant (or agent_sudo); refused otherwise", async () => {
  const tools = T.setupTools(setupTask, fakeTask(setupTask.id));
  const saved = { nosudo: process.env.AGENTBOX_NO_SUDO, agent_sudo: C.config.agent_sudo };
  delete process.env.AGENTBOX_NO_SUDO;
  C.config.agent_sudo = false;
  try {
    assert.equal(I.cliCanWrite(), false);
    for (const [name, args] of [["connect", { id: "kubernetes" }], ["verify", { id: "kubernetes" }], ["disconnect", { id: "kubernetes" }], ["save_settings", { id: "github", values: { base_branch: "trunk" } }]] as const) {
      const r = await call(tools, name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /needs root, which the setup agent has only while one of its turns runs/, name);
    }
    SU.grantSetupSudo("turn-1");
    assert.equal(I.cliCanWrite(), true, "while a setup turn holds the grant");
    SU.releaseSetupSudo("turn-1");
    assert.equal(I.cliCanWrite(), false);
  } finally {
    if (saved.nosudo !== undefined) process.env.AGENTBOX_NO_SUDO = saved.nosudo;
    C.config.agent_sudo = saved.agent_sudo;
  }
});

test("routes: the card's status has the job and the server's clock; the catalog has coming-soon entries", async () => {
  const app = Fastify();
  app.setErrorHandler((err: any, _req, reply) => { reply.status(err.statusCode ?? 400).send({ error: err.message }); });
  registerIntegrationRoutes(app);
  const one = JSON.parse((await app.inject({ method: "GET", url: "/api/integrations/aws" })).body);
  assert.equal(one.state, "disconnected");
  assert.equal(one.job.action, "disconnect");
  assert.equal(one.job.running, false);
  assert.equal(one.job.lines, undefined);
  assert.ok(Array.isArray(one.output) && one.output.length > 0);
  assert.ok(Date.parse(one.now));
  const cat = JSON.parse((await app.inject({ method: "GET", url: "/api/integrations" })).body);
  assert.equal(cat.integrations.find((x: any) => x.id === "slack").state, "unavailable");
  await app.close();
});

test("tools: refused for any other role, even if attached by mistake", async () => {
  const tools = T.setupTools(coderTask, fakeTask(coderTask.id));
  for (const [name, args] of [["list_integrations", {}], ["connect", { id: "aws" }], ["propose_mapping", { id: "aws", roles: ["coder"] }]] as const) {
    const r = await call(tools, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /setup agent only/);
  }
});

test("cli: a hung command is killed at its timeout (with its children)", async () => {
  const t0 = Date.now();
  const r = await I.runCli(["connect", "slow"], { json: false, timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 4500, "didn't wait for the sleep");
  assert.match(r.stdout, /start/);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
