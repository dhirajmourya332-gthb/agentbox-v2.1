/**
 * Plan approval and diff review (docs/V2.1-PLAN.md), in-process against a throwaway database and temp
 * folders. Remotes are local bare repos behind `url.<dir>.insteadOf https://example.test/`. Agents stay
 * paused: callbacks are queued as tasks, never run.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/review-plan.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-review-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations", "remotes", "scratch"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const gitconfig = path.join(tmp, "gitconfig");
fs.writeFileSync(gitconfig, `[user]\n\tname = Test\n\temail = test@example.test\n[init]\n\tdefaultBranch = main\n[url "${dirs.remotes}/"]\n\tinsteadOf = https://example.test/\n[uploadpack]\n\tallowFilter = true\n[protocol "file"]\n\tallow = always\n`);
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\nagent_sudo: true\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\n`);
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1",
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", AGENTBOX_REPO_FETCH_MS: "3600000", NO_COLOR: "1",
});

const sh = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
};
function makeRemote(name: string) {
  const bare = path.join(dirs.remotes, "acme", `${name}.git`);
  sh("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const work = path.join(dirs.scratch, `seed-${name}`);
  sh("git", ["clone", "-q", bare, work]);
  fs.writeFileSync(path.join(work, "README.md"), `# ${name}\n\nline two\nline three\n`);
  fs.writeFileSync(path.join(work, "old.txt"), "going away\n");
  sh("git", ["add", "."], work);
  sh("git", ["commit", "-q", "-m", "init"], work);
  sh("git", ["push", "-q", "origin", "HEAD:main"], work);
  return `https://example.test/acme/${name}.git`;
}

const { run, all, get, newId, now } = await import("../src/db.ts");
const { subscribe } = await import("../src/bus.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const R = await import("../src/repos.ts");
const S = await import("../src/setup.ts");
const RU = await import("../src/runner.ts");
const TM = await import("../src/team.ts");
const P = await import("../src/plans.ts");
const C = await import("../src/changes.ts");
const { registerReviewRoutes } = await import("../src/reviewRoutes.ts");
const Fastify = (await import("fastify")).default;

const events: any[] = [];
subscribe((e) => events.push(e));

const mk = (name: string) => {
  const a = A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
  return A.getAgent(a.id)!;
};
const coder = mk("coder");
const setup = S.ensureSetupRole();
const task = (roleId: string, label: string) => A.spawnInstance(roleId, { label, createdBy: "owner", asLead: true });
const fakeTask = (agentId: string) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'done', ?)`,
    id, agentId, A.dmThreadOf(agentId), now());
  return id;
};
const call = async (tools: any[], name: string, args: any) => {
  const t = tools.find((x: any) => x.name === name);
  assert.ok(t, `tool ${name}`);
  return t.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};
const waitFor = async (fn: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 50)); }
};
const queued = (agentId: string) => all<any>(`SELECT * FROM tasks WHERE agent_id = ? AND status = 'queued' ORDER BY created_at`, agentId);

const background = R.startRepos({ log: () => {} });
after(() => { background.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// The owner's own example: service1 → service2 becomes service1 → [logger, service2].
const LOGGER = {
  title: "Add a logger service",
  summary: "Service1 sends its events to a new logger service as well as to service2.",
  diagram: {
    before: { nodes: [{ id: "s1", label: "service1" }, { id: "s2", label: "service2" }], edges: [{ from: "s1", to: "s2" }] },
    after: {
      nodes: [{ id: "s1", label: "service1", change: "also emits events" }, { id: "s2", label: "service2" }, { id: "log", label: "logger-service" }],
      edges: [{ from: "s1", to: "s2" }, { from: "s1", to: "log", label: "events" }],
    },
  },
  changes: ["New logger-service", "service1 publishes events to it"],
  checks: ["service1 tests pass", "events show up in the logger"],
};

// --- validation: the diagram must stay small and about the change -----------------------------------
test("plans: a simple before/after passes; too big, unrelated boxes, no change and broken arrows are refused", () => {
  const p = P.validatePlan(LOGGER);
  assert.equal(p.diagram.after.nodes.length, 3);
  assert.equal(p.diagram.after.nodes[0].change, "also emits events");
  assert.deepEqual(p.risks, []);
  // Something entirely new: no before.
  assert.ok(P.validatePlan({ ...LOGGER, diagram: { after: LOGGER.diagram.after } }));

  const many = Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, label: `box ${i}` }));
  assert.throws(() => P.validatePlan({ ...LOGGER, diagram: { before: { nodes: [], edges: [] }, after: { nodes: many, edges: [] } } }), /too big/);
  // A box that doesn't change and touches nothing that does.
  const noisy = structuredClone(LOGGER);
  noisy.diagram.before.nodes.push({ id: "db", label: "billing db" });
  noisy.diagram.after.nodes.push({ id: "db", label: "billing db" } as any);
  assert.throws(() => P.validatePlan(noisy), /billing db.*Leave them out/);
  // Same picture twice.
  assert.throws(() => P.validatePlan({ ...LOGGER, diagram: { before: LOGGER.diagram.before, after: LOGGER.diagram.before } }), /same picture/);
  // Arrows must join boxes of their own graph.
  assert.throws(() => P.validatePlan({ ...LOGGER, diagram: { before: LOGGER.diagram.before, after: { nodes: LOGGER.diagram.after.nodes, edges: [{ from: "s1", to: "nope" }] } } }), /both ends/);
  // Long labels and too many bullets.
  assert.throws(() => P.validatePlan({ ...LOGGER, diagram: { after: { nodes: [{ id: "x", label: "a".repeat(40) }], edges: [] } } }), /keep it to 32/);
  assert.throws(() => P.validatePlan({ ...LOGGER, changes: Array(7).fill("x") }), /keep the 6/);
  assert.throws(() => P.validatePlan({ ...LOGGER, changes: [] }), /at least 1/);
});

// --- submitting and deciding ---------------------------------------------------------------------------
test("plans: by default a plan is shared and the agent carries on (no needs-you); a redirect reaches it", async () => {
  const t = task(coder.id, "Shared");
  const tools = TM.teamTools(t, fakeTask(t.id));
  const r = await call(tools, "submit_plan", LOGGER);
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /shared with the owner\. Carry on/);
  const [p] = P.plansOf(t.id);
  assert.equal(p.status, "shared");
  assert.equal(p.attention_id, null, "nothing for the owner to answer");
  assert.ok(get<any>(`SELECT 1 AS x FROM messages WHERE author = 'plan' AND content = ?`, p.id), "still a card to look at");
  assert.equal(P.planNote(t), "", "no plan section without the gate");
  // "Looks good" without a note: no turn (the agent never waited).
  const before = queued(t.id).length;
  P.decidePlan(p.id, "approve", "");
  assert.equal(queued(t.id).length, before);
  // A later shared plan can be redirected: the agent adjusts the work under way.
  await call(tools, "submit_plan", { ...LOGGER, title: "Logger v2" });
  const p2 = P.plansOf(t.id)[0];
  P.decidePlan(p2.id, "changes", "No new service; log in-process");
  assert.match(queued(t.id).at(-1).prompt, /plan you shared.*different approach: No new service.*Don't wait for approval/s);
  // Asked in words: it waits.
  await call(tools, "submit_plan", { ...LOGGER, title: "Logger v3", wait_for_owner: true });
  const p3 = P.plansOf(t.id)[0];
  assert.equal(p3.status, "pending");
  assert.ok(p3.attention_id);
});

test("plans: behind the gate a plan posts a card and a needs-you item; a new version replaces a pending one", async () => {
  const t = task(coder.id, "Logging");
  P.setGate(t.id, true);
  const tools = TM.teamTools(t, fakeTask(t.id));
  const r = await call(tools, "submit_plan", LOGGER);
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /for approval.*End your turn/s);
  const [p1] = P.plansOf(t.id);
  assert.equal(p1.status, "pending");
  assert.equal(p1.version, 1);
  const card = get<any>(`SELECT * FROM messages WHERE author = 'plan' AND content = ?`, p1.id);
  assert.equal(card.thread_id, A.dmThreadOf(t.id));
  const item = get<any>(`SELECT * FROM attention WHERE id = ?`, p1.attention_id);
  assert.match(item.title, /coder.* has a plan for you: Add a logger service/);
  // A refused plan says what to simplify.
  const bad = await call(tools, "submit_plan", { ...LOGGER, changes: [] });
  assert.ok(bad.isError);
  assert.match(bad.content[0].text, /Plan not submitted: changes/);
  // v2 replaces v1.
  await call(tools, "submit_plan", { ...LOGGER, title: "Add a logger service (v2)" });
  const [p2, old] = P.plansOf(t.id);
  assert.equal(p2.version, 2);
  assert.equal(old.status, "superseded");
  assert.ok(get<any>(`SELECT seen_at FROM attention WHERE id = ?`, old.attention_id).seen_at, "the old needs-you item is cleared");
  // The setup agent uses its checklist instead.
  const st = task(setup.id, "Setup");
  const sr = await call(TM.teamTools(st, fakeTask(st.id)), "submit_plan", LOGGER);
  assert.ok(sr.isError);
});

test("plans: approve / changes / reject call the agent back; decided plans can't be decided again", async () => {
  const t = task(coder.id, "Decide");
  P.setGate(t.id, true);
  const tools = TM.teamTools(t, fakeTask(t.id));
  await call(tools, "submit_plan", LOGGER);
  let p = P.plansOf(t.id)[0];
  assert.throws(() => P.decidePlan(p.id, "changes", ""), /Say what to change/);
  P.decidePlan(p.id, "changes", "Keep logging in-process, no new service");
  let q = queued(t.id).at(-1);
  assert.match(q.prompt, /asks for changes.*Keep logging in-process/s);
  assert.match(q.prompt, /submit_plan/);
  assert.throws(() => P.decidePlan(p.id, "approve", ""), /already sent back/);

  await call(tools, "submit_plan", { ...LOGGER, title: "In-process logger" });
  p = P.plansOf(t.id)[0];
  const decided = P.decidePlan(p.id, "approve", "Ship it behind a flag");
  assert.equal(decided.status, "approved");
  q = queued(t.id).at(-1);
  assert.match(q.prompt, /approved your plan "In-process logger" \(v2\).*behind a flag/s);
  const msg = get<any>(`SELECT * FROM messages WHERE task_id = ?`, q.id);
  assert.equal(msg.author, "user");
  assert.match(msg.content, /^Plan approved: In-process logger/);
  assert.ok(events.some((e) => e.type === "plan.updated" && e.plan.id === p.id && e.plan.status === "approved"));

  // A closed task is reopened to hear the decision.
  const t2 = task(coder.id, "Closed later");
  P.setGate(t2.id, true);
  await call(TM.teamTools(t2, fakeTask(t2.id)), "submit_plan", LOGGER);
  run(`UPDATE agents SET retired_at = ? WHERE id = ?`, now(), t2.id);
  P.decidePlan(P.plansOf(t2.id)[0].id, "reject", "Not now");
  assert.equal(A.getAgent(t2.id)!.retired_at, null);
  assert.match(queued(t2.id).at(-1).prompt, /rejected your plan.*Not now.*Don't implement/s);
});

test("plan gate: edits in worktrees and commits wait for an approved plan; the work layer says so", async () => {
  const url = makeRemote("gate");
  R.addRepo({ url } as any, { onboard: () => {} });
  await waitFor(() => R.getRepo("gate")!.status === "ready");
  const t = task(coder.id, "Gated");
  const wt = await R.ensureWorktree(t, "gate");
  P.setGate(t.id, true);
  const guard = P.planGuard(t);
  const edit = (file: string) => guard({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file }, cwd: wt.path });
  const bash = (command: string) => guard({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: wt.path });
  const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === "deny";
  assert.ok(denied(await edit(path.join(wt.path!, "README.md"))));
  assert.ok(denied(await edit("README.md")), "relative to the worktree");
  assert.ok(!denied(await edit(path.join(A.homeOf(t), "docs", "plan.md"))), "notes and docs outside repos are fine");
  assert.ok(denied(await bash("git add -A && git commit -m wip")));
  assert.ok(denied(await bash("git push origin HEAD")));
  assert.ok(!denied(await bash("git status && git diff")), "reading is fine");
  let layer = RU.instructionLayers(t).find((l) => l.id === "work")!.text;
  assert.match(layer, /## Plan first/);
  assert.match(layer, /call `mcp__team__submit_plan`/);

  const tools = TM.teamTools(t, fakeTask(t.id));
  await call(tools, "submit_plan", LOGGER);
  assert.match(RU.instructionLayers(t).find((l) => l.id === "work")!.text, /waiting for the owner/);
  assert.ok(denied(await edit(path.join(wt.path!, "README.md"))), "still closed while pending");
  P.decidePlan(P.plansOf(t.id)[0].id, "approve", "");
  assert.ok(!denied(await edit(path.join(wt.path!, "README.md"))));
  assert.ok(!denied(await bash("git commit -m done")));
  layer = RU.instructionLayers(t).find((l) => l.id === "work")!.text;
  assert.match(layer, /## Approved plan \(v1\): Add a logger service/);
  assert.match(layer, /Stay within it/);
  // A task without the gate is never blocked, and a delegated instance follows its root's gate.
  const free = task(coder.id, "Free");
  assert.ok(!denied(await P.planGuard(free)({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(R.worktreesRoot(), "x") }, cwd: "/" })));
  assert.equal(P.planNote(free), "");
});

// --- diff review ---------------------------------------------------------------------------------------
test("changes: committed, uncommitted, deleted and new files against the branch point, with line numbers", async () => {
  const url = makeRemote("diffy");
  R.addRepo({ url } as any, { onboard: () => {} });
  await waitFor(() => R.getRepo("diffy")!.status === "ready");
  const t = task(coder.id, "Change things");
  const wt = await R.ensureWorktree(t, "diffy");
  fs.writeFileSync(path.join(wt.path!, "README.md"), "# diffy\n\nline two, edited\nline three\n");
  sh("git", ["commit", "-qam", "edit readme"], wt.path!);
  fs.rmSync(path.join(wt.path!, "old.txt"));
  fs.writeFileSync(path.join(wt.path!, "notes.md"), "first\nsecond\n");
  fs.writeFileSync(path.join(wt.path!, "blob.bin"), Buffer.from([0, 1, 2, 3]));

  const ch = await C.taskChanges(t.id);
  assert.equal(ch.root_id, t.id);
  assert.equal(ch.repos.length, 1);
  const r = ch.repos[0];
  assert.equal(r.repo, "diffy");
  assert.equal(r.base, "origin/main");
  assert.deepEqual(r.commits.map((c) => c.subject), ["edit readme"]);
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(byPath["README.md"].status, "modified");
  assert.deepEqual([byPath["README.md"].additions, byPath["README.md"].deletions], [1, 1]);
  const lines = byPath["README.md"].lines;
  assert.equal(lines[0].t, "hunk");
  assert.deepEqual(lines.find((l) => l.t === "del"), { t: "del", s: "line two", o: 3 });
  assert.deepEqual(lines.find((l) => l.t === "add"), { t: "add", s: "line two, edited", n: 3 });
  assert.equal(byPath["old.txt"].status, "deleted");
  assert.equal(byPath["notes.md"].status, "untracked");
  assert.deepEqual(byPath["notes.md"].lines.filter((l) => l.t === "add").map((l) => [l.n, l.s]), [[1, "first"], [2, "second"]]);
  assert.equal(byPath["blob.bin"].binary, true);
  assert.equal(r.additions, 1 + 2);
  assert.equal(r.deletions, 1 + 1);
  assert.equal(r.head, sh("git", ["rev-parse", "HEAD"], wt.path!));

  // A teammate's worktree under the same task shows up too.
  const helper = A.spawnInstance(coder.id, { label: "Helper", createdBy: t.id, parentInstanceId: t.id } as any);
  await R.ensureWorktree(helper, "diffy");
  const both = await C.taskChanges(helper.id);
  assert.equal(both.root_id, t.id, "any instance in the tree reviews the whole task");
  assert.equal(both.repos.length, 2);
});

test("review: stored, shown as a card, and sent to the task with every comment; changes need a comment", async () => {
  const t = A.listAgents().find((a) => a.label === "Change things")!;
  const wt = R.worktreesFor(t.id)[0];
  await assert.rejects(C.submitReview(t.id, { verdict: "changes", note: "", comments: [] }), /Say what to change/);
  await assert.rejects(C.submitReview(t.id, { verdict: "maybe" }), /verdict/);
  const rv = await C.submitReview(t.id, {
    verdict: "changes", note: "Close, two things.",
    comments: [
      { worktree_id: wt.id, path: "README.md", line: 3, side: "new", text: "Say what changed in line two" },
      { worktree_id: wt.id, path: "old.txt", line: 1, side: "old", text: "Keep this file" },
      { worktree_id: "not-in-this-task", path: "x", line: 1, side: "new", text: "dropped" },
    ],
  });
  assert.equal(rv.comments.length, 2, "comments on other tasks' worktrees are dropped");
  assert.equal(rv.heads[wt.id], sh("git", ["rev-parse", "HEAD"], wt.path!));
  assert.equal(C.latestReview(t.id)!.id, rv.id);
  const q = queued(t.id).at(-1);
  assert.match(q.prompt, /requests changes/);
  assert.match(q.prompt, /Owner's note: Close, two things\./);
  assert.match(q.prompt, /- diffy\/README\.md:3: Say what changed in line two/);
  assert.match(q.prompt, /- diffy\/old\.txt:1 \(removed line\): Keep this file/);
  const msg = get<any>(`SELECT * FROM messages WHERE task_id = ?`, q.id);
  assert.deepEqual([msg.author, msg.content], ["review", rv.id]);
  assert.ok(events.some((e) => e.type === "review.updated" && e.review.id === rv.id));
  const ok = await C.submitReview(t.id, { verdict: "approve" });
  assert.match(queued(t.id).at(-1).prompt, /\*\*approved\*\* them.*open or update the PR/s);
  assert.equal(C.reviewsOf(t.id)[0].id, ok.id);
});

test("routes: the owner decides and reviews; the local token can't", async () => {
  const app = Fastify();
  registerReviewRoutes(app);
  const t = task(coder.id, "Routes");
  P.setGate(t.id, true);
  await call(TM.teamTools(t, fakeTask(t.id)), "submit_plan", LOGGER);
  const p = P.plansOf(t.id)[0];
  const local = { "x-agentbox-local-token": "t" };
  let r = await app.inject({ method: "POST", url: `/api/plans/${p.id}/decide`, headers: local, payload: { verdict: "approve" } });
  assert.equal(r.statusCode, 403);
  r = await app.inject({ method: "POST", url: `/api/agents/${t.id}/review`, headers: local, payload: { verdict: "approve" } });
  assert.equal(r.statusCode, 403);
  r = await app.inject({ method: "GET", url: `/api/agents/${t.id}/plans` });
  assert.equal(r.json().plans[0].id, p.id);
  assert.deepEqual(r.json().gate, { required: true, approved: null });
  r = await app.inject({ method: "POST", url: `/api/agents/${t.id}/plan-gate`, payload: { required: true } });
  assert.equal(r.json().required, true);
  r = await app.inject({ method: "POST", url: `/api/plans/${p.id}/decide`, payload: { verdict: "approve", note: "go" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, "approved");
  r = await app.inject({ method: "POST", url: `/api/plans/${p.id}/decide`, payload: { verdict: "approve" } });
  assert.equal(r.statusCode, 409);
  r = await app.inject({ method: "GET", url: `/api/agents/${t.id}/changes` });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().repos, []);
  r = await app.inject({ method: "GET", url: `/api/agents/${t.id}/changes/summary` });
  assert.equal(r.json().worktrees, 0);
  r = await app.inject({ method: "GET", url: `/api/agents/${coder.id}/changes` });
  assert.equal(r.statusCode, 404, "roles have no changes; tasks do");
  await app.close();
});
