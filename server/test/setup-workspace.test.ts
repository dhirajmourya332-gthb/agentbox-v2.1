/**
 * The Setup workspace (docs/V2-ARCHITECTURE.md › Changes (setup workspace)): the checklist tools and
 * their persistence, the checker (pointer, timeout, output cap, one note per step), read_terminal and
 * its redaction, role-only tools, and the terminal WebSocket's auth. In-process against a throwaway
 * database and temp folders; a fake pty; never starts Claude (agents stay paused).
 *
 *   cd server && node --disable-warning=ExperimentalWarning --import tsx --test test/setup-workspace.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-setup-ws-"));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations", "sudoers"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima
access: ssh-tunnel
user: ${os.userInfo().username}
agent_sudo: false
paths: { team: ${dirs.team}, work: ${dirs.work}, secrets: ${dirs.secrets}, data: ${dirs.data}, agents: ${dirs.agents}, skills: ${dirs.skills}, integrations: ${dirs.integrations} }
`);
Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_NO_SUDO: "1", NO_COLOR: "1",
  AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations,
  AGENTBOX_SUDOERS_DIR: dirs.sudoers, AGENTBOX_SUDO_HELPER: "/nonexistent/helper",
  AGENTBOX_CLI: "/nonexistent/agentbox", AGENTBOX_PROGRESS_TICK_MS: "3600000",
});

const { all, get, newId, now, run } = await import("../src/db.ts");
const A = await import("../src/agents.ts");
const S = await import("../src/setup.ts");
const P = await import("../src/setupPlan.ts");
const T = await import("../src/setupTools.ts");
const RD = await import("../src/redact.ts");
const TERM = await import("../src/terminal.ts");
const SR = await import("../src/setupRoutes.ts");
const { setPaused } = await import("../src/control.ts");
const { subscribe } = await import("../src/bus.ts");
const { createAccess } = await import("../src/access.ts");
const { guardApi } = await import("../src/mobile.ts");
const { DEFAULT_ACCESS_CONFIG } = await import("../src/access-config.ts");
const Fastify = (await import("fastify")).default;
const fastifyWebsocket = (await import("@fastify/websocket")).default;

setPaused(true); // a queued note must never start Claude here

const mk = (name: string) => A.createAgent({ name, title: name, summary: name, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
const coder = mk("coder");
const setup = S.ensureSetupRole();
const session = A.spawnInstance(setup.id, { label: "GitHub and AWS", createdBy: "owner" });
const coderTask = A.spawnInstance(coder.id, { label: "Fix #12", createdBy: "owner" });
const fakeTask = (agentId: string) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'done', ?)`,
    id, agentId, A.dmThreadOf(agentId), now());
  return id;
};
const call = async (tools: any[], name: string, args: any) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name}`);
  return t.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await wait(10); }
}

// A fake pty: echoes input like a tty, and lets the test print output.
function fakePty() {
  const data = new Set<(d: string) => void>();
  const exit = new Set<(e: { exitCode: number }) => void>();
  const written: string[] = [];
  const pty = {
    pid: 1, written,
    onData: (fn: (d: string) => void) => data.add(fn),
    onExit: (fn: (e: { exitCode: number }) => void) => exit.add(fn),
    write: (d: string) => { written.push(d); for (const f of data) f(d); },
    resize: () => {}, kill: () => {},
    print: (d: string) => { for (const f of data) f(d); },
  };
  return pty;
}

// --- redaction ----------------------------------------------------------------------------------

test("redaction: tokens, keys and passwords never reach the agent", () => {
  const ghp = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const pat = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV";
  const awsId = "AKIAIOSFODNN7EXAMPLE";
  const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const glpat = "glpat-xR4nd0mT0k3nV4lu3Abc";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const cases: [string, string[]][] = [
    [`export GITHUB_TOKEN=${ghp}`, [ghp]],
    [`token: ${pat}`, [pat]],
    [`gho_abcdefghijklmnopqrstuvwxyz0123 and ghs_ABCDEFGHIJKLMNOPQRSTUVWX0123456789`, ["gho_abcdefghijklmnopqrstuvwxyz0123", "ghs_ABCDEFGHIJKLMNOPQRSTUVWX0123456789"]],
    [`AWS Access Key ID [None]: ${awsId}\nAWS Secret Access Key [None]: ${awsSecret}\nDefault region name [None]: eu-west-1`, [awsId, awsSecret]],
    [`[default]\naws_access_key_id = ${awsId}\naws_secret_access_key = ${awsSecret}`, [awsId, awsSecret]],
    [`{"AccessKeyId": "ASIAY34FZKBOKMUTVV7A", "SecretAccessKey": "${awsSecret}", "SessionToken": "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQ"}`, ["ASIAY34FZKBOKMUTVV7A", awsSecret, "IQoJb3JpZ2luX2VjEJr"]],
    [`git push https://oauth2:${glpat}@gitlab.com/acme/x.git`, [glpat]],
    [`Cookie: session=${jwt}`, [jwt]],
    [`curl -H 'Authorization: Bearer sk-live-0123456789abcdef' https://api.example.com`, ["sk-live-0123456789abcdef"]],
    [`Authorization: Basic dXNlcjpwYXNzd29yZA==`, ["dXNlcjpwYXNzd29yZA=="]],
    [`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----\nnext`, ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "AAAAMwAAAAtzc2gtZWQyNTUxOQ"]],
    [`-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0123456789abcdef`, ["MIIEpAIBAAKCAQEA0123456789abcdef"]],
    [`client_secret = 4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a99`, ["4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a99"]],
    [`api_key: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"`, ["Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"]],
    [`DB_PASSWORD=hunter2 psql`, ["hunter2"]],
    [`mysql --password=s3cr3t!`, ["s3cr3t!"]],
    [`! First copy your one-time code: ABCD-1234`, ["ABCD-1234"]],
    [`xoxb-1234567890-abcdefghij`, ["xoxb-1234567890-abcdefghij"]],
  ];
  for (const [input, secrets] of cases) {
    const out = RD.redactSecrets(input);
    for (const s of secrets) assert.ok(!out.includes(s), `leaked ${s} in: ${out}`);
    assert.match(out, /\[REDACTED\]/, input);
    assert.equal(RD.redactSecrets(out), out, "idempotent");
  }
  // Ordinary output survives.
  for (const keep of [
    "✓ Logged in to github.com account octo-owner (keyring)",
    "Press any key to continue",
    "The key fingerprint is SHA256:abc",
    "Generated key pair in /home/agentbox/.ssh/id_ed25519",
    "aws-cli/2.17.0 Python/3.12.6 Linux/6.8.0 exe/x86_64.ubuntu.24",
    "Default region name [None]: eu-west-1",
    "token_type: bearer",
    "Saved the key to /home/agentbox/.config/gh/hosts.yml",
  ]) assert.equal(RD.redactSecrets(keep), keep, keep);
});

// --- the plan tools -------------------------------------------------------------------------------

test("plan tools: set_plan validates, persists per session, update_step and add_steps edit it", async () => {
  const tid = fakeTask(session.id);
  const tools = T.setupTools(session, tid);
  // Commands that would press Enter (or send escapes), and checks with sudo, are refused.
  for (const bad of [
    { id: "a", title: "A", commands: ["gh auth login\n"] },
    { id: "a", title: "A", commands: ["echo hi\rrm -rf ~"] },
    { id: "a", title: "A", commands: ["printf '\x1b[201~'"] },
    { id: "a", title: "A", check: "sudo cat /etc/shadow" },
    { id: "Bad Id", title: "A" },
    { id: "a" },
  ]) {
    const r = await call(tools, "set_plan", { title: "x", steps: [bad] });
    assert.equal(r.isError, true, JSON.stringify(bad));
  }
  const dup = await call(tools, "set_plan", { title: "x", steps: [{ id: "a", title: "A" }, { id: "a", title: "B" }] });
  assert.match(dup.content[0].text, /used twice/);

  const r = await call(tools, "set_plan", {
    title: "GitHub and AWS",
    steps: [
      { id: "gh-install", title: "Install gh", why: "The GitHub CLI", check: "true", human: false },
      { id: "gh-login", title: "Log in to GitHub", why: "So agents can open PRs", instructions: "Run it and follow the browser page.", commands: ["gh auth login --web --git-protocol https"], check: "exit 1", human: true },
      { id: "aws-login", title: "Log in to AWS", commands: ["aws configure sso"], human: true },
    ],
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const p = P.getPlan(session.id)!;
  assert.equal(p.title, "GitHub and AWS");
  assert.deepEqual(p.steps.map((s) => s.id), ["gh-install", "gh-login", "aws-login"]);
  // Stored in the DB (survives restarts), per session.
  const row = get(`SELECT steps FROM setup_plans WHERE instance_id = ?`, session.id);
  assert.equal(JSON.parse(row.steps)[1].commands[0], "gh auth login --web --git-protocol https");
  assert.equal(P.getPlan(coderTask.id), null);

  const up = await call(tools, "update_step", { id: "gh-login", instructions: "Pick GitHub.com, HTTPS, then log in with a browser.", note: "try --web" });
  assert.equal(up.isError, undefined, up.content[0].text);
  assert.equal(P.getPlan(session.id)!.steps[1].instructions, "Pick GitHub.com, HTTPS, then log in with a browser.");
  assert.equal(P.getPlan(session.id)!.steps[1].note, "try --web");
  const missing = await call(tools, "update_step", { id: "nope", title: "x" });
  assert.equal(missing.isError, true);

  const add = await call(tools, "add_steps", { after: "gh-login", steps: [{ id: "gh-setup-git", title: "Use gh for git", commands: ["gh auth setup-git"], check: "true" }] });
  assert.equal(add.isError, undefined, add.content[0].text);
  assert.deepEqual(P.getPlan(session.id)!.steps.map((s) => s.id), ["gh-install", "gh-login", "gh-setup-git", "aws-login"]);
  // set_plan again keeps the progress of a step that comes back unchanged.
  P.updateStep(session.id, "gh-install", { status: "done" });
  P.setPlan(session.id, "GitHub and AWS", P.getPlan(session.id)!.steps.map((s) => ({ ...s, integration: s.integration?.id, integration_step: s.integration?.step })));
  assert.equal(P.getPlan(session.id)!.steps[0].status, "done");
  assert.equal(P.getPlan(session.id)!.steps[0].done_by, "agent");
  run(`DELETE FROM setup_plans WHERE instance_id = ?`, session.id);
});

test("plan tools: integration steps come from the CLI's status (title, instructions, command, human)", async () => {
  const fake = async (id: string) => ({
    id, title: "GitHub", steps: [
      { id: "install", title: "Install git and gh", human: false, instructions: null, copy: null, state: "done" },
      { id: "login", title: "Log in to GitHub", human: true, instructions: "In the terminal run: `gh auth login`", copy: "gh auth login", state: "human" },
      { id: "extra", title: "Not here", human: false, instructions: null, copy: null, state: "skipped" },
    ],
  }) as any;
  const all_ = await T.expandIntegrationSteps([{ integration: "github" }], fake);
  assert.deepEqual(all_.map((s) => s.id), ["github-install", "github-login"]);
  assert.deepEqual(all_[1].commands, ["gh auth login"]);
  assert.equal(all_[1].human, true);
  const one = await T.expandIntegrationSteps([{ id: "gh", integration: "github", integration_step: "login", why: "PRs" }], fake);
  assert.equal(one[0].title, "GitHub: Log in to GitHub");
  assert.equal(one[0].why, "PRs");
  await assert.rejects(T.expandIntegrationSteps([{ id: "x", integration: "github", integration_step: "nope" }], fake), /no step "nope"/);
});

// --- the checker ------------------------------------------------------------------------------------

test("checker: polls the current step, moves the pointer when it passes, and tells the agent once", async () => {
  const flags = new Set<string>();
  const nudges: { display: string; prompt: string }[] = [];
  let runs: string[] = [];
  const c = P.createPlanChecker({
    run: async (cmd) => { runs.push(cmd); const ok = flags.has(cmd); return { ok, code: ok ? 0 : 1, output: ok ? "ok" : `not yet ${cmd}`, timedOut: false }; },
    nudge: (_i, display, prompt) => nudges.push({ display, prompt }),
    liveInstances: () => [session.id], intervalMs: 200, debounceMs: 600,
  });
  P.setPlanChecker(c);
  P.setPlan(session.id, "Two logins", [
    { id: "one", title: "First login", check: "check-one", human: true },
    { id: "two", title: "Second login", check: "check-two", human: true },
    { id: "three", title: "Agent step", check: "check-three" },
  ]);
  const events: any[] = [];
  const off = subscribe((e) => { if (e.type === "setup.check" || e.type === "setup.plan") events.push(e); });

  c.tick();
  await until(() => runs.length === 1);
  assert.deepEqual(runs, ["check-one"], "only the current step is polled");
  await until(() => !c.liveOf(session.id, "one")?.since);
  c.tick();
  assert.equal(runs.length, 1, "not again before the interval");
  assert.equal(P.planView(session.id)!.current, "one");
  assert.equal(P.getPlan(session.id)!.steps[0].status, "pending", "a failing poll isn't a failure");
  assert.match(P.getPlan(session.id)!.steps[0].last_check!.output, /not yet/);

  flags.add("check-one");
  await wait(220);
  c.tick();
  await until(() => P.getPlan(session.id)!.steps[0].status === "done");
  assert.equal(P.getPlan(session.id)!.steps[0].done_by, "check");
  assert.equal(P.planView(session.id)!.current, "two");
  // The step turned back (a regression) and passed again: still only one note for it.
  await until(() => nudges.length === 1, 2000);
  assert.match(nudges[0].display, /First login passed its check/);
  assert.match(nudges[0].display, /Next: Second login\./);
  assert.match(nudges[0].prompt, /pointer is now on step "two"/);
  await c.ownerAction(session.id, "one", "reopen");
  flags.add("check-one");
  await wait(220); c.tick();
  await until(() => P.getPlan(session.id)!.steps[0].status === "done");
  await wait(700);
  assert.equal(nudges.length, 1, "at most one automatic note per step");

  // Two steps passing close together: one debounced note.
  flags.add("check-two"); flags.add("check-three");
  await wait(220); c.tick();
  await until(() => P.getPlan(session.id)!.steps[1].status === "done");
  await wait(220); c.tick();
  await until(() => P.getPlan(session.id)!.steps[2].status === "done");
  await until(() => nudges.length === 2, 2000);
  assert.match(nudges[1].display, /Second login[\s\S]*Agent step[\s\S]*Every step of the plan is done/);
  assert.equal(P.planView(session.id)!.current, null);
  runs = [];
  await wait(220); c.tick();
  assert.equal(runs.length, 0, "nothing to poll when everything is done");
  // Background polls are silent: no "checking" events, and a plan update only when a step changed.
  assert.equal(events.filter((e) => e.type === "setup.check").length, 0, "polls publish no check events");
  const seen = events.filter((e) => e.type === "setup.plan")
    .map((e) => JSON.stringify([e.plan.current, e.plan.steps.map((x: any) => [x.status, x.last_check?.ok, x.last_check?.output])]));
  assert.ok(seen.length > 0);
  seen.slice(1).forEach((v, i) => assert.notEqual(v, seen[i], `plan update ${i + 1} repeats the previous one`));
  off();
  c.stop();
});

test("checker: owner buttons (check now, skip, mark done) and the first pass after set_plan", async () => {
  const nudges: string[] = [];
  const c = P.createPlanChecker({
    run: async (cmd) => ({ ok: cmd === "true", code: cmd === "true" ? 0 : 1, output: cmd === "true" ? "" : "gh: not logged in", timedOut: false }),
    nudge: (_i, d) => nudges.push(d), liveInstances: () => [], debounceMs: 10,
  });
  P.setPlanChecker(c);
  P.setPlan(session.id, "Buttons", [
    { id: "done-already", title: "Already there", check: "true" },
    { id: "login", title: "Log in", check: "false", human: true },
    { id: "optional", title: "Optional", human: true },
    { id: "manual", title: "Manual", human: true },
  ]);
  const first = await c.initialPass(session.id);
  assert.deepEqual(first.map((r) => [r.id, r.ok]), [["done-already", true], ["login", false]]);
  assert.equal(P.getPlan(session.id)!.steps[0].status, "done");
  assert.equal(P.getPlan(session.id)!.steps[0].nudged, true, "the agent learns it from set_plan's result, not a note");

  const r = await c.ownerAction(session.id, "login", "check");
  assert.equal(r!.ok, false);
  assert.equal(P.getPlan(session.id)!.steps[1].status, "failed", "an explicit check that fails shows as failed");
  assert.match(P.getPlan(session.id)!.steps[1].last_check!.output, /not logged in/);
  await assert.rejects(c.ownerAction(session.id, "optional", "check"), /no check/);
  await c.ownerAction(session.id, "login", "done");
  await c.ownerAction(session.id, "optional", "skip");
  assert.equal(P.getPlan(session.id)!.steps[2].status, "skipped");
  await assert.rejects(c.ownerAction(session.id, "manual", "explode"), /action is/);
  await until(() => nudges.length === 1, 1000);
  assert.match(nudges[0], /Log in was marked done by the owner[\s\S]*Optional was skipped by the owner[\s\S]*Next: Manual\./);
  c.stop();
});

test("checker: a hung check is killed at its timeout; output is capped and redacted", async () => {
  const t0 = Date.now();
  const r = await P.shellCheck("echo start; sleep 5", 1500);
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 4000, "didn't wait for the sleep");
  assert.match(r.output, /start/);

  const c = P.createPlanChecker({ nudge: () => {}, liveInstances: () => [], timeoutMs: 1500 });
  P.setPlanChecker(c);
  P.setPlan(session.id, "Caps", [
    { id: "hang", title: "Hangs", check: "sleep 5" },
    { id: "loud", title: "Loud", check: "head -c 50000 /dev/zero | tr '\\0' x; echo; echo token=ghp_abcdefghijklmnopqrstuvwxyz0123456789; exit 3" },
    { id: "env", title: "Env", check: "test -z \"$SECRET_FROM_PORTAL\"" },
  ]);
  process.env.SECRET_FROM_PORTAL = "leak";
  const hang = await c.check(session.id, "hang");
  assert.equal(hang.result!.timed_out, true);
  assert.match(hang.result!.output, /timed out after/);
  const loud = await c.check(session.id, "loud");
  assert.ok(loud.result!.output.length <= 4097, `capped (${loud.result!.output.length})`);
  assert.ok(!loud.result!.output.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.equal(loud.result!.code, 3);
  const env = await c.check(session.id, "env");
  assert.equal(env.result!.ok, true, "checks don't see the portal's environment");
  delete process.env.SECRET_FROM_PORTAL;
  c.stop();
});

test("checker: integration steps are checked through the CLI", async () => {
  const asked: string[] = [];
  const c = P.createPlanChecker({
    nudge: () => {}, liveInstances: () => [],
    integrationCheck: async (id, step) => { asked.push(`${id}/${step}`); return { ok: step === "install", output: step === "install" ? "done" : "gh: not logged in" }; },
  });
  P.setPlanChecker(c);
  P.setPlan(session.id, "Via CLI", [
    { id: "gh-install", title: "Install", integration: "github", integration_step: "install" },
    { id: "gh-login", title: "Login", integration: "github", integration_step: "login", human: true },
  ]);
  await c.initialPass(session.id);
  assert.deepEqual(asked.sort(), ["github/install", "github/login"]);
  assert.equal(P.planView(session.id)!.current, "gh-login");
  c.stop();
});

test("notes: a passed step queues one short turn in the setup session's thread (no Claude while paused)", () => {
  const thread = A.dmThreadOf(session.id)!;
  SR.nudgeSetupAgent(session.id, "✔ Log in passed its check.", "[agentbox setup] Plan update");
  const task = get(`SELECT * FROM tasks WHERE agent_id = ? AND source = 'setup' ORDER BY created_at DESC`, session.id);
  assert.equal(task.status, "queued");
  assert.match(task.prompt, /Plan update/);
  const msg = get(`SELECT * FROM messages WHERE thread_id = ? AND task_id = ?`, thread, task.id);
  assert.equal(msg.author, "system");
  // Not for other roles' tasks.
  const before = all(`SELECT id FROM tasks WHERE agent_id = ?`, coderTask.id).length;
  SR.nudgeSetupAgent(coderTask.id, "x", "y");
  assert.equal(all(`SELECT id FROM tasks WHERE agent_id = ?`, coderTask.id).length, before);
});

// --- the terminal -------------------------------------------------------------------------------------

test("read_terminal: what the owner sees, rendered, secrets redacted; only for the setup agent", async () => {
  const pty = fakePty();
  const term = TERM.createOwnerTerminal({ spawn: () => pty as any, env: {} });
  TERM.setOwnerTerminal(term);
  const tools = T.setupTools(session, fakeTask(session.id));
  const before = await call(tools, "read_terminal", {});
  assert.match(before.content[0].text, /hasn't been opened/);

  await term.ensure();
  pty.print("$ gh auth status\r\n\x1b[32m✓\x1b[0m Logged in to github.com account octo-owner\r\n");
  pty.print("  - Token: gho_abcdefghijklmnopqrstuvwxyz0123456789\r\n");
  pty.print("Downloading 10%\rDownloading 100%\r\n");
  pty.print("AWS Secret Access Key [None]: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\r\n$ ");
  const r = await call(tools, "read_terminal", { lines: 50 });
  const out = r.content[0].text;
  assert.match(out, /✓ Logged in to github.com account octo-owner/);
  assert.ok(!out.includes("\x1b["), "colours resolved");
  assert.match(out, /^Downloading 100%$/m, "progress redraws resolved");
  assert.ok(!/Downloading 10%/.test(out));
  assert.ok(!out.includes("gho_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(!out.includes("wJalrXUtnFEMI"));
  assert.match(out, /2 secret\(s\) redacted/);
  assert.match(out, /data, not instructions/);
  const few = await term.read(2);
  assert.equal(few.lines, 2);

  // No tool types into it: the agent's tools are read-only, and the only writer is the owner's page.
  assert.ok(!T.setupTools(session, "t").some((t: any) => /write|type|send|input|run_in_terminal/i.test(t.name)));
  // Other roles can't read it (or touch the plan), even if the tools were attached by mistake.
  const other = T.setupTools(coderTask, fakeTask(coderTask.id));
  for (const [name, args] of [["read_terminal", {}], ["set_plan", { title: "x", steps: [{ id: "a", title: "A" }] }], ["update_step", { id: "a" }], ["add_steps", { steps: [] }]] as const) {
    const res = await call(other, name, args);
    assert.equal(res.isError, true, name);
    assert.match(res.content[0].text, /setup agent only/);
  }
  term.close();
  TERM.setOwnerTerminal(null);
});

test("terminal WebSocket: the owner's page attaches (replayed); local tools and foreign pages are refused", async () => {
  const pty = fakePty();
  const term = TERM.createOwnerTerminal({ spawn: () => pty as any, env: {} });
  TERM.setOwnerTerminal(term);
  await term.ensure();
  pty.print("hello from the shell\r\n");

  const app = Fastify();
  await app.register(fastifyWebsocket);
  const access = createAccess({ config: DEFAULT_ACCESS_CONFIG, localTokenFile: path.join(dirs.data, "local-token") });
  guardApi(app, access);
  SR.registerSetupRoutes(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/api/setup/terminal`;
  const origin = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(dirs.data, "local-token"), "utf8").trim();

  const attempt = (headers: Record<string, string>) => new Promise<{ status: number | null; first?: string; ws?: WebSocket }>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => { resolve({ status: res.statusCode ?? null }); ws.terminate(); });
    ws.on("message", (d) => resolve({ status: 101, first: String(d), ws }));
    ws.on("error", () => resolve({ status: null }));
  });
  // A local tool (the agentbox CLI, or an agent using the local token): refused, even with an Origin.
  assert.equal((await attempt({ "x-agentbox-local-token": token, origin })).status, 403);
  assert.equal((await attempt({ "x-agentbox-local-token": "wrong", origin })).status, 403);
  // No browser Origin (a script on this computer): refused.
  assert.equal((await attempt({})).status, 403);
  // Another site: refused by the portal's guard.
  assert.equal((await attempt({ origin: "https://evil.example" })).status, 403);
  // The owner's page: attached, with the scrollback replayed.
  const ok = await attempt({ origin });
  assert.equal(ok.status, 101);
  assert.match(ok.first!, /hello from the shell/);
  // Its keys reach the shell; "Insert in terminal" sends text without Enter.
  ok.ws!.send(JSON.stringify({ t: "i", d: "gh auth login" }));
  await until(() => pty.written.includes("gh auth login"));
  assert.ok(!pty.written.some((w) => /\r|\n/.test(w)));
  ok.ws!.close();

  // The plan routes: the owner's buttons refuse the local token too.
  P.setPlan(session.id, "Routes", [{ id: "a", title: "A", human: true }]);
  P.setPlanChecker(P.createPlanChecker({ nudge: () => {}, liveInstances: () => [] }));
  const viaCli = await app.inject({ method: "POST", url: `/api/setup/plans/${session.id}/steps/a`, headers: { "x-agentbox-local-token": token, host: "127.0.0.1", "content-type": "application/json" }, payload: { action: "done" } });
  assert.equal(viaCli.statusCode, 403);
  const owner = await app.inject({ method: "POST", url: `/api/setup/plans/${session.id}/steps/a`, headers: { host: "127.0.0.1", "content-type": "application/json" }, payload: { action: "done" } });
  assert.equal(owner.statusCode, 200, owner.body);
  assert.equal(JSON.parse(owner.body).plan.steps[0].status, "done");
  const notSetup = await app.inject({ method: "GET", url: `/api/setup/plans/${coderTask.id}`, headers: { host: "127.0.0.1" } });
  assert.equal(notSetup.statusCode, 404);
  const sessions = JSON.parse((await app.inject({ method: "GET", url: `/api/setup/sessions`, headers: { host: "127.0.0.1" } })).body);
  assert.equal(sessions.setup_role_id, setup.id);
  assert.equal(sessions.sessions[0].id, session.id);
  assert.equal(sessions.sessions[0].plan.title, "Routes");
  P.planChecker()?.stop();
  await app.close();
  term.close();
  TERM.setOwnerTerminal(null);
});

test.after(() => { P.setPlanChecker(null); fs.rmSync(tmp, { recursive: true, force: true }); });
