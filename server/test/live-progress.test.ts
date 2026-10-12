/**
 * Live progress and "needs you" (docs/CONTRACTS-v2.md § A, B), in-process against a throwaway
 * database: plain-words activity, `gh pr checks` and test summaries, stall detection, progress
 * events and their throttle, and attention creation/refresh/seen. Touches nothing outside a temp
 * folder, so it's safe to run anywhere:
 *
 *   node --disable-warning=ExperimentalWarning --import tsx test/live-progress.test.ts
 *
 * The gateway side (phone allowlist, events over the portal and phone sockets) is covered by
 * test/live-gateway.test.ts against a rehearsal server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-live-"));
Object.assign(process.env, {
  AGENTBOX_DATA: path.join(tmp, "data"), AGENTBOX_AGENTS: path.join(tmp, "agents"), AGENTBOX_WORK: path.join(tmp, "work"),
  AGENTBOX_SKILLS: path.join(tmp, "skills"), AGENTBOX_STALL_MIN: "1", AGENTBOX_PROGRESS_TICK_MS: "3600000",
});

const { run, newId } = await import("../src/db.ts");
const { publish, subscribe } = await import("../src/bus.ts");
const P = await import("../src/progress.ts");
const A = await import("../src/attention.ts");

const results: { name: string; ok: boolean; note?: string }[] = [];
async function test(name: string, fn: () => unknown) {
  try { await fn(); results.push({ name, ok: true }); } catch (e: any) { results.push({ name, ok: false, note: e?.message ?? String(e) }); }
}
function eq(actual: unknown, expected: unknown, what = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const events: any[] = [];
subscribe((e) => events.push(e));
const take = (type: string) => events.filter((e) => e.type === type);

// --- fixtures: a role, an owner-started instance (task room root), a child in its room, a group --
const at = new Date().toISOString();
function agent(id: string, name: string, extra: Record<string, unknown> = {}) {
  const a = { base_agent_id: null, created_by: null, parent_instance_id: null, label: null, ...extra };
  run(`INSERT INTO agents (id, slug, name, title, color, created_at, base_agent_id, created_by, parent_instance_id, label)
       VALUES (?, ?, ?, 'T', '#888', ?, ?, ?, ?, ?)`, id, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, at,
  a.base_agent_id, a.created_by, a.parent_instance_id, a.label);
}
const thread = (id: string, kind: string, agentId: string | null, name: string | null = null) =>
  run(`INSERT INTO threads (id, kind, agent_id, name, created_at) VALUES (?, ?, ?, ?, ?)`, id, kind, agentId, name, at);
function task(id: string, agentId: string, threadId: string, status: string, startedMinAgo: number, source = "user") {
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at, started_at) VALUES (?, ?, ?, ?, 't', 'p', ?, ?, ?)`,
    id, agentId, threadId, source, status, ago(startedMinAgo), ago(startedMinAgo));
}
let seq = 0;
function step(taskId: string, kind: string, name: string, summary: string, input: unknown, o: { status?: string; startedMinAgo?: number; finishedMinAgo?: number | null; output?: string } = {}) {
  const id = newId();
  run(`INSERT INTO steps (id, task_id, seq, kind, name, summary, input, output, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, taskId, seq++, kind, name, summary, JSON.stringify(input), o.output ?? null, o.status ?? "done", ago(o.startedMinAgo ?? 0),
    o.finishedMinAgo === null || o.status === "running" ? null : ago(o.finishedMinAgo ?? 0));
  return id;
}

agent("role-tl", "tech-lead");
agent("tl1", "tech-lead#1", { base_agent_id: "role-tl", created_by: "owner", label: "Partner API keys" });
agent("role-coder", "coder");
agent("c3", "coder#3", { base_agent_id: "role-coder", created_by: "tl1", parent_instance_id: "tl1", label: "Fix tests" });
agent("rt1", "tech-lead#9", { base_agent_id: "role-tl", created_by: "routine:r1", label: "Nightly" });
thread("dm-tl1", "dm", "tl1");
thread("dm-c3", "dm", "c3");
thread("ho-c3", "handoff", "c3");
thread("dm-rt1", "dm", "rt1");
thread("grp", "group", null, "release");
run(`INSERT INTO thread_members (thread_id, agent_id) VALUES ('grp', 'role-tl'), ('grp', 'role-coder')`);
agent("g-tl", "tech-lead#5", { base_agent_id: "role-tl", created_by: "group:grp", label: "#release" });

const CHECKS_TAB = [
  "server unit tests\tfail\t3m2s\thttps://github.com/o/r/actions/runs/1",
  "Swagger drift\tfail\t1m\thttps://github.com/o/r/actions/runs/2",
  "claude-review\tfail\t40s\thttps://github.com/o/r/actions/runs/3",
  "build\tpass\t2m\thttps://github.com/o/r/actions/runs/4",
  ...["e2e", "lint", "deploy-preview", "security", "docs"].map((n) => `${n}\tpending\t0\thttps://x/${n}`),
].join("\n");

const fired: any[] = [];
A.onAttention((i) => fired.push(i));
P.startProgress();
A.startAttention();

async function main() {
  // --- plain words ------------------------------------------------------------------------------
  await test("shell activity: CI waits, checks, tests, PRs, git, fallbacks", () => {
    eq(P.shellActivity("cd /work/web-app-4950 && while true; do gh pr checks 4984; sleep 60; done"), "Waiting on CI for PR #4984");
    eq(P.shellActivity("gh pr checks 4984 --watch --interval 30"), "Waiting on CI for PR #4984");
    eq(P.shellActivity("gh pr checks https://github.com/o/r/pull/77"), "Checking CI for PR #77");
    eq(P.shellActivity("gh pr checks"), "Checking CI");
    eq(P.shellActivity("cd /work/web-app-4950 && npm test -- --run"), "Running tests in web-app-4950");
    eq(P.shellActivity("python -m pytest -q"), "Running tests");
    eq(P.shellActivity("git -C /work/agentbox-12 push -u origin feature/12-x"), "Pushing to GitHub in agentbox-12");
    eq(P.shellActivity("gh pr view 4957 --comments"), "Reviewing PR #4957");
    eq(P.shellActivity("gh pr diff 4957"), "Reviewing PR #4957");
    eq(P.shellActivity("gh pr merge 4957 --squash"), "Merging PR #4957");
    eq(P.shellActivity("gh pr create --title x --body y"), "Opening a pull request");
    eq(P.shellActivity("npm ci"), "Installing dependencies");
    eq(P.shellActivity("curl -s https://api.example.com/v1/x"), "Calling api.example.com");
    eq(P.shellActivity("sleep 300"), "Waiting");
    eq(P.shellActivity("frobnicate --all", "Rebuild the search index"), "Rebuild the search index");
    eq(P.shellActivity("frobnicate --all"), "Running frobnicate --all");
  });

  await test("step activity by kind", () => {
    eq(P.activityFor({ kind: "read", name: "Read", summary: "/work/x/src/app.ts", input: "{}" }), "Reading app.ts");
    eq(P.activityFor({ kind: "edit", name: "Edit", summary: "/work/x/src/app.ts", input: "{}" }), "Editing app.ts");
    eq(P.activityFor({ kind: "delegate", name: "Delegate", summary: "→ coder: Fix the flaky test", input: "{}" }), "Delegating to coder");
    eq(P.activityFor({ kind: "delegate", name: "Message", summary: "→ coder#3: FYI", input: "{}" }), "Messaging coder#3");
    eq(P.activityFor({ kind: "search", name: "Grep", summary: "foo", input: "{}" }), "Searching the code");
    // The full command comes from the input; the summary is only its first line.
    eq(P.activityFor({ kind: "shell", name: "Shell", summary: "set -e", input: JSON.stringify({ command: "set -e\ngh pr checks 12 --watch" }) }), "Waiting on CI for PR #12");
  });

  // --- summaries ---------------------------------------------------------------------------------
  await test("gh pr checks (tab-separated) → '3 checks failed: …; 5 pending'", () => {
    const c = P.parseChecks(CHECKS_TAB)!;
    eq(P.checksSummary(c), "3 checks failed: server unit tests, Swagger drift, claude-review; 5 pending");
  });

  await test("gh pr checks (TTY marks, watch loop: the last block wins)", () => {
    const out = "Some checks are still pending\n* build   1m  https://x\nX lint   1m  https://x\n\nAll checks were successful\n✓ build   2m  https://x\n✓ lint   1m  https://x\n";
    eq(P.checksSummary(P.parseChecks(out)!), "All 2 checks passed");
  });

  await test("gh pr checks (header counts only)", () => {
    const c = P.parseChecks("Some checks were not successful\n0 cancelled, 2 failing, 12 successful, 0 skipped, and 5 pending checks\n")!;
    eq(P.checksSummary(c, false), "2 checks failed; 5 pending");
  });

  await test("ruleSummary: checks first, then test totals, then step counts", () => {
    const sh = (command: string, output: string, status = "done") => ({ kind: "shell", name: "Shell", summary: command, input: JSON.stringify({ command }), output, status });
    eq(P.ruleSummary([sh("npm test", "Tests: 1 failed, 9 passed"), sh("gh pr checks 1", CHECKS_TAB)]),
      "3 checks failed: server unit tests, Swagger drift, claude-review; 5 pending");
    eq(P.ruleSummary([sh("npx vitest run", "Test Files  2 passed\n Tests  2 failed | 40 passed (42)")]), "Tests: 2 failed, 40 passed");
    eq(P.ruleSummary([sh("ls", "a"), { kind: "edit", name: "Edit", summary: "/a", input: "{}", output: "ok", status: "done" }, sh("make deploy", "boom", "error")]),
      "3 steps so far: 2 commands, 1 edit; last failure: make deploy");
  });

  // --- live records --------------------------------------------------------------------------------
  await test("progress for a running room task: activity, room, step, summary after 5 min", () => {
    task("t-ci", "tl1", "dm-tl1", "running", 6);
    step("t-ci", "shell", "Shell", "gh pr checks 4984", { command: "gh pr checks 4984" }, { startedMinAgo: 5, finishedMinAgo: 4.9, output: CHECKS_TAB });
    step("t-ci", "shell", "Shell", "cd /work/web-app-4950 && gh pr checks 4984 --watch",
      { command: "cd /work/web-app-4950 && gh pr checks 4984 --watch" }, { status: "running", startedMinAgo: 0.2 });
    const p = P.computeProgress("t-ci")!;
    eq(p.activity, "Waiting on CI for PR #4984", "activity");
    eq([p.root_id, p.group_id, p.state], ["tl1", null, "working"], "place/state");
    eq(p.step?.name, "Shell", "step");
    eq(p.summary, "3 checks failed: server unit tests, Swagger drift, claude-review; 5 pending", "summary");
  });

  await test("child task shows in its room; group turn shows in its group; routine has no room", () => {
    task("t-child", "c3", "ho-c3", "running", 1, "agent");
    eq([P.computeProgress("t-child")!.root_id, P.computeProgress("t-child")!.activity], ["tl1", "Thinking"]);
    task("t-grp", "g-tl", "grp", "running", 1, "group");
    const g = P.computeProgress("t-grp")!;
    eq([g.root_id, g.group_id], ["grp", "grp"]);
    task("t-rt", "rt1", "dm-rt1", "running", 1, "cron");
    eq([P.computeProgress("t-rt")!.root_id, P.computeProgress("t-rt")!.group_id], [null, null]);
  });

  await test("stalled: no step for STALL_MIN, or one shell step running that long", () => {
    task("t-idle", "c3", "dm-c3", "running", 3);
    step("t-idle", "read", "Read", "/a.ts", {}, { startedMinAgo: 2.5, finishedMinAgo: 2.4 });
    const p = P.computeProgress("t-idle")!;
    eq(p.state, "stalled");
    ok((p.stalled_for_s ?? 0) >= 140, `stalled_for_s ${p.stalled_for_s}`);
    task("t-shell", "rt1", "dm-rt1", "queued", 0); // (unused: one turn per agent)
    task("t-long", "tl1", "dm-tl1", "done", 30);
    task("t-sh", "g-tl", "grp", "running", 4, "group");
    step("t-sh", "shell", "Shell", "sleep 600", { command: "sleep 600" }, { status: "running", startedMinAgo: 1.5 });
    eq(P.computeProgress("t-sh")!.state, "stalled", "long shell step");
    // A recent heartbeat (e.g. a subagent working) doesn't save a long shell step, but does an idle turn.
    P.heartbeat("t-idle");
    eq(P.computeProgress("t-idle")!.state, "working", "heartbeat");
  });

  await test("tick publishes progress.updated (throttled per agent), attention for stalls, cleared on end", async () => {
    events.length = 0;
    P.tick();
    await sleep(2300);
    const ups = take("progress.updated").map((e) => e.progress.task_id);
    for (const id of ["t-ci", "t-child", "t-grp", "t-sh"]) ok(ups.includes(id), `no progress.updated for ${id}: ${ups}`);
    const att = take("attention.updated").map((e) => e.item);
    const stalled = att.filter((i) => i.kind === "stalled");
    ok(stalled.some((i) => i.task_id === "t-sh" && i.room_id === "grp" && /may be stuck: Waiting/.test(i.title)), `stalled items ${JSON.stringify(stalled)}`);
    // Ticking again changes nothing visible: no duplicate events or items.
    events.length = 0;
    P.tick();
    await sleep(2300);
    eq(take("progress.updated").length, 0, "duplicate progress.updated");
    eq(take("attention.updated").length, 0, "duplicate attention");
    eq(P.listProgress().length >= 5, true, "listProgress");
  });

  await test("resume clears the stall item; turn end → progress.cleared", async () => {
    events.length = 0;
    run(`UPDATE steps SET status = 'done', finished_at = ? WHERE task_id = 't-sh'`, new Date().toISOString());
    P.tick();
    const seen = take("attention.updated").map((e) => e.item).filter((i) => i.task_id === "t-sh");
    ok(seen.length === 1 && seen[0].seen_at, `stall not cleared: ${JSON.stringify(seen)}`);
    run(`UPDATE tasks SET status = 'done' WHERE id = 't-sh'`);
    publish({ type: "task.updated", task: { id: "t-sh", agent_id: "g-tl", thread_id: "grp", status: "done", source: "group", result: "NO_REPLY" } });
    const cleared = take("progress.cleared");
    ok(cleared.some((e) => e.task_id === "t-sh" && e.agent_id === "g-tl"), "no progress.cleared");
    ok(!P.listProgress().some((p) => p.task_id === "t-sh"), "still listed");
  });

  // --- attention ---------------------------------------------------------------------------------

  await test("reply: owner-started task replies → one item; a second reply refreshes it", () => {
    run(`UPDATE tasks SET status = 'done', result = 'Done: PR #1' WHERE id = 't-ci'`);
    publish({ type: "task.updated", task: { id: "t-ci", agent_id: "tl1", thread_id: "dm-tl1", status: "done", source: "user", result: "Done: PR #1" } });
    let items = A.listAttention().filter((i) => i.kind === "reply");
    eq(items.length, 1, "items");
    eq([items[0].room_id, items[0].title, items[0].seen_at], ["tl1", "tech-lead#1 replied: Partner API keys", null]);
    publish({ type: "task.updated", task: { id: "t-long", agent_id: "tl1", thread_id: "dm-tl1", status: "done", source: "result", result: "More" } });
    items = A.listAttention().filter((i) => i.kind === "reply");
    eq([items.length, items[0].task_id], [1, "t-long"], "refreshed");
    eq(fired.filter((i) => i.kind === "reply").length, 2, "onAttention calls");
  });

  await test("no reply item for: a child's report, NO_REPLY, a group reply that @mentions a member, routines", () => {
    const before = A.listAttention().length;
    publish({ type: "task.updated", task: { id: "t-child", agent_id: "c3", thread_id: "ho-c3", status: "done", source: "agent", result: "report" } });
    publish({ type: "task.updated", task: { id: "x1", agent_id: "tl1", thread_id: "dm-tl1", status: "done", source: "user", result: "NO_REPLY" } });
    publish({ type: "task.updated", task: { id: "t-grp", agent_id: "g-tl", thread_id: "grp", status: "done", source: "group", result: "@coder please run the tests" } });
    publish({ type: "task.updated", task: { id: "t-rt", agent_id: "rt1", thread_id: "dm-rt1", status: "done", source: "cron", result: "nightly ok" } });
    eq(A.listAttention().length, before);
  });

  await test("group reply addressed to nobody → reply item in the group", () => {
    publish({ type: "task.updated", task: { id: "t-grp", agent_id: "g-tl", thread_id: "grp", status: "done", source: "group", result: "All green, ready to ship." } });
    const it = A.listAttention().find((i) => i.kind === "reply" && i.room_id === "grp");
    ok(it && it.title === "tech-lead#5 replied in #release", JSON.stringify(it));
  });

  await test("failed: the owner room's lead fails → item (once); a helper's failure goes to its lead, routine failures don't", () => {
    publish({ type: "task.updated", task: { id: "t-child", agent_id: "c3", thread_id: "ho-c3", status: "failed", source: "agent", error: "boom" } });
    publish({ type: "task.updated", task: { id: "t-lead", agent_id: "tl1", thread_id: "dm-tl1", status: "failed", source: "user", error: "boom" } });
    publish({ type: "task.updated", task: { id: "t-lead", agent_id: "tl1", thread_id: "dm-tl1", status: "failed", source: "user", error: "boom" } });
    publish({ type: "task.updated", task: { id: "t-rt", agent_id: "rt1", thread_id: "dm-rt1", status: "failed", source: "cron", error: "x" } });
    const f = A.listAttention().filter((i) => i.kind === "failed");
    eq(f.map((i) => [i.room_id, i.title]), [["tl1", "tech-lead#1 failed: Partner API keys (boom)"]]);
  });

  await test("seen: one, a room, all; unseen listed first", () => {
    const all0 = A.listAttention();
    const firstSeen = all0.findIndex((i) => i.seen_at);
    ok(firstSeen === -1 || all0.slice(firstSeen).every((i) => i.seen_at), "unseen first");
    const reply = all0.find((i) => i.kind === "reply" && i.room_id === "grp")!;
    ok(A.markSeen(reply.id)?.seen_at, "markSeen");
    eq(A.markSeen("nope"), null, "unknown id");
    ok(A.markRoomSeen("tl1") >= 2, "room");
    ok(!A.listAttention().some((i) => i.room_id === "tl1" && !i.seen_at), "room items still unseen");
    A.markAllSeen();
    ok(A.listAttention().every((i) => i.seen_at), "all seen");
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `\n      ${r.note}` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main();
