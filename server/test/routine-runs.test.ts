/**
 * Routine runs, active vs. archive (docs/CONTRACTS-v2.md § G), in-process against a throwaway
 * database: a run stays active while the routine's lead works on after the routine agent is done,
 * closes when everything is, failed / stopped / skipped statuses, the backfill of rows from before
 * run tracking, windowing (nothing from another run leaks in), paging, progress `run_id`, and the
 * phone allowlist. Touches nothing outside a temp folder:
 *
 *   node --disable-warning=ExperimentalWarning --import tsx test/routine-runs.test.ts
 *
 * With PORTAL and GATEWAY set (a REHEARSAL server, never the live one), it instead checks the two
 * routes through the phone gateway with signed requests (see docs/MOBILE-SETUP.md › Testing):
 *
 *   PORTAL=http://127.0.0.1:7792 GATEWAY=http://127.0.0.1:7793 \
 *     node --disable-warning=ExperimentalWarning --import tsx test/routine-runs.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.GATEWAY) {
  const { assert, client, json, report, test } = await import("./gateway-client.ts");
  const { portal, paired } = client(process.env.PORTAL ?? "http://127.0.0.1:7792", process.env.GATEWAY);
  const g = await portal("PUT", "/api/devices/gateway", { url: "https://agentbox.rehearsal.ts.net" });
  assert(g.status === 200, `set manual url: ${g.status}`);
  const phone = await paired("Routine runs phone");
  await test("phone: GET routine-runs with state, routine_id, before and limit", async () => {
    for (const q of ["", "?state=active", "?state=archive&limit=5", `?state=archive&routine_id=x&before=${encodeURIComponent(new Date().toISOString())}&limit=100`]) {
      const r = await phone.call("GET", `/m/v1/routine-runs${q}`);
      assert(r.status === 200, `routine-runs${q} → ${r.status} ${r.body}`);
      assert(Array.isArray(json(r).runs), `routine-runs${q}: no runs array`);
    }
  });
  await test("phone: GET routine-runs/:id reaches the API (unknown id → its 404, as 410)", async () => {
    const r = await phone.call("GET", "/m/v1/routine-runs/no-such-run");
    assert(r.status === 410 || r.status === 404, `routine-runs/:id → ${r.status}`);
  });
  await test("phone: writes to routine-runs stay off", async () => {
    const r = await phone.call("POST", "/m/v1/routine-runs", {});
    assert(r.status === 404, `POST routine-runs → ${r.status}`);
  });
  process.exit(report() ? 1 : 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-runs-"));
Object.assign(process.env, {
  AGENTBOX_DATA: path.join(tmp, "data"), AGENTBOX_AGENTS: path.join(tmp, "agents"), AGENTBOX_WORK: path.join(tmp, "work"),
  AGENTBOX_SKILLS: path.join(tmp, "skills"), AGENTBOX_PROGRESS_TICK_MS: "3600000",
});

const { run, newId } = await import("../src/db.ts");
const { publish, subscribe } = await import("../src/bus.ts");
await import("../src/routines.ts"); // tables and the additive migration
const R = await import("../src/routineRuns.ts");
const P = await import("../src/progress.ts");
const { allowedRoute } = await import("../src/mobile.ts");

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

// --- fixtures: a role, a routine on its own instance, the routine's lead ----------------------
function agent(id: string, name: string, extra: Record<string, unknown> = {}) {
  const a = { base_agent_id: null, created_by: null, parent_instance_id: null, label: null, ...extra };
  run(`INSERT INTO agents (id, slug, name, title, color, created_at, base_agent_id, created_by, parent_instance_id, label)
       VALUES (?, ?, ?, 'T', '#888', ?, ?, ?, ?, ?)`, id, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, ago(120),
  a.base_agent_id, a.created_by, a.parent_instance_id, a.label);
}
const thread = (id: string, kind: string, agentId: string) =>
  run(`INSERT INTO threads (id, kind, agent_id, created_at) VALUES (?, ?, ?, ?)`, id, kind, agentId, ago(120));
function task(id: string, agentId: string, threadId: string, status: string, createdMin: number, finishedMin: number | null, source = "cron") {
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, 't', 'p', ?, ?, ?, ?)`, id, agentId, threadId, source, status, ago(createdMin), ago(createdMin),
  finishedMin === null ? null : ago(finishedMin));
}
const msg = (threadId: string, author: string, content: string, min: number, taskId: string | null = null) =>
  run(`INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`, newId(), threadId, author, taskId, content, ago(min));
/** A run row; `legacy` writes it the way rows were written before run tracking (no status). */
function runRow(id: string, atMin: number, outcome: string, taskId: string | null, o: { legacy?: boolean; reason?: string; routine?: string; trigger?: string } = {}) {
  run(`INSERT INTO routine_runs (id, routine_id, at, trigger, outcome, reason, task_id, status, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, o.routine ?? "r1", ago(atMin), o.trigger ?? "schedule", outcome, o.reason ?? null, taskId,
    o.legacy ? null : outcome === "skipped" ? "skipped" : "running", !o.legacy && outcome === "skipped" ? ago(atMin) : null);
}

agent("role-w", "watcher");
agent("role-tl", "tech-lead");
agent("inst", "watcher#1", { base_agent_id: "role-w", created_by: "routine:r1", label: "PR watch" });
agent("lead", "tech-lead#3", { base_agent_id: "role-tl", created_by: "lead:inst", parent_instance_id: "inst", label: "Lead · PR watch" });
agent("inst2", "watcher#2", { base_agent_id: "role-w", created_by: "routine:r2", label: "Nightly" });
thread("th", "routine", "inst");
thread("th-lead", "dm", "lead");
thread("th2", "routine", "inst2");
for (const [id, name, inst, th] of [["r1", "PR watch", "inst", "th"], ["r2", "Nightly", "inst2", "th2"]]) {
  run(`INSERT INTO routines (id, agent_id, thread_id, name, cron, timezone, prompt, enabled, created_by, created_at, instance_id)
       VALUES (?, 'role-w', ?, ?, '0 */2 * * *', 'UTC', 'p', 0, 'owner', ?, ?)`, id, th, name, ago(120), inst);
}

// Legacy rows: an old run (agent replied, lead merged later), an old skip. Logged a moment after
// the task was queued, as before run tracking.
task("t-old", "inst", "th", "done", 100, 95);
msg("th", "routine", "**PR watch** · scheduled", 100, "t-old");
msg("th", "inst", "Reviewed 3 PRs;\n\n  handed #12 to the lead.", 95, "t-old");
task("t-old-lead", "lead", "th-lead", "done", 96, 80, "agent");
msg("th-lead", "lead", "Merged #12.", 80, "t-old-lead");
runRow("run-old", 99.99, "started", "t-old", { legacy: true });
runRow("skip-old", 70, "skipped", null, { legacy: true, reason: "The previous run is still going" });

async function main() {
  await test("backfill: legacy rows get status, finished_at and summary", () => {
    eq(R.backfillRuns(), 2, "backfilled rows");
    const old = R.getRun("run-old")!;
    eq([old.status, old.tasks], ["done", 2]);
    ok(old.finished_at && Math.abs(new Date(old.finished_at).getTime() - new Date(ago(80)).getTime()) < 5000, `finished_at ${old.finished_at}`);
    eq(old.summary, "Reviewed 3 PRs; handed #12 to the lead.", "summary");
    ok(old.duration_s! > 1000, `duration ${old.duration_s}`);
    eq(old.members.map((m) => [m.id, m.status]), [["inst", "done"], ["lead", "done"]], "members");
    const skip = R.getRun("skip-old")!;
    eq([skip.status, skip.reason, skip.duration_s, skip.tasks], ["skipped", "The previous run is still going", null, 0]);
    eq(R.backfillRuns(), 0, "second backfill");
  });

  // A live run: the routine agent finishes and hands off; the lead is still merging.
  R.startRoutineRuns();
  task("t1", "inst", "th", "done", 30, 25);
  msg("th", "routine", "**PR watch** · run now", 30, "t1");
  msg("th", "inst", "Nothing new except #13, handed to the lead.", 25, "t1");
  task("t1-lead", "lead", "th-lead", "running", 26, null, "agent");
  msg("th-lead", "inst", "Please merge #13", 26, "t1-lead");
  runRow("run1", 30.01, "started", "t1", { trigger: "manual" });
  R.runLogged("run1");

  await test("active while the lead is still working after the routine agent finished", () => {
    const r = R.getRun("run1")!;
    eq([r.status, r.finished_at, r.summary, r.duration_s, r.trigger], ["running", null, null, null, "manual"]);
    eq(r.members.map((m) => [m.id, m.status]), [["inst", "done"], ["lead", "working"]]);
    eq(R.listRuns({ state: "active" }).map((x) => x.id), ["run1"]);
    ok(events.some((e) => e.type === "routine-run.updated" && e.run.id === "run1" && e.run.status === "running"), "start event");
  });

  await test("progress for routine-tree work carries run_id; other work doesn't", () => {
    eq(P.computeProgress("t1-lead")?.run_id, "run1");
    agent("solo", "watcher#9", { base_agent_id: "role-w", created_by: "owner", label: "Other" });
    thread("th-solo", "dm", "solo");
    task("t-solo", "solo", "th-solo", "running", 1, null, "user");
    ok(!("run_id" in (P.computeProgress("t-solo") ?? {})), "run_id on non-routine work");
    run(`UPDATE tasks SET status = 'done', finished_at = ? WHERE id = 't-solo'`, ago(0));
  });

  await test("windowing: the run's detail has only its own messages and tasks", () => {
    const d = R.runDetail("run1")!;
    eq(d.tasks.map((t: any) => t.id), ["t1", "t1-lead"]);
    const texts = d.messages.map((m: any) => m.content);
    ok(texts.includes("Nothing new except #13, handed to the lead.") && texts.includes("Please merge #13"), "own messages missing");
    ok(!texts.some((t: string) => /Reviewed 3 PRs|Merged #12/.test(t)), "a previous run's messages leaked in");
    eq(d.members.map((m: any) => m.id), ["inst", "lead"], "members");
    ok(d.members.every((m: any) => "role_id" in m && "current" in m), "members are instance summaries");
    ok(d.threads.every((t: any) => Object.keys(t).join() === "id,agent_id,kind"), "threads shape");
    const old = R.runDetail("run-old")!;
    eq(old.tasks.map((t: any) => t.id).sort(), ["t-old", "t-old-lead"], "old run tasks");
    ok(!old.messages.some((m: any) => /#13/.test(m.content)), "a later run's messages leaked into the old one");
  });

  await test("closes when everything is done (on the task's finish event)", async () => {
    events.length = 0;
    run(`UPDATE tasks SET status = 'done', finished_at = ? WHERE id = 't1-lead'`, ago(1));
    msg("th-lead", "lead", "Merged #13.", 1, "t1-lead");
    publish({ type: "task.updated", task: { id: "t1-lead", agent_id: "lead", thread_id: "th-lead", status: "done" } });
    await sleep(500);
    const r = R.getRun("run1")!;
    eq([r.status, r.summary], ["done", "Nothing new except #13, handed to the lead."]);
    ok(Math.abs(new Date(r.finished_at!).getTime() - new Date(ago(1)).getTime()) < 5000, `finished_at ${r.finished_at}`);
    ok(events.some((e) => e.type === "routine-run.updated" && e.run.id === "run1" && e.run.status === "done"), "finish event");
    eq(R.listRuns({ state: "active" }).length, 0, "active");
  });

  await test("failed and stopped: from the run's own task", async () => {
    task("t2", "inst", "th", "failed", 20, 19);
    runRow("run2", 20, "started", "t2");
    task("t3", "inst", "th", "running", 15, null);
    runRow("run3", 15, "started", "t3");
    R.runLogged("run2");
    R.runLogged("run3");
    eq(R.getRun("run2")!.status, "failed");
    eq(R.getRun("run3")!.status, "running");
    run(`UPDATE tasks SET status = 'stopped', finished_at = ? WHERE id = 't3'`, ago(14));
    R.settleOpenRuns(); // the safety net, without an event
    eq(R.getRun("run3")!.status, "stopped");
  });

  await test("skipped: logged with its reason, counted as finished", () => {
    runRow("skip1", 10, "skipped", null, { reason: "Claude plan rate-limited" });
    R.runLogged("skip1");
    const s = R.getRun("skip1")!;
    eq([s.status, s.reason, s.finished_at === s.started_at], ["skipped", "Claude plan rate-limited", true]);
  });

  await test("paging: archive newest first by started_at, before, limit, routine filter", () => {
    task("t-n", "inst2", "th2", "done", 5, 4);
    runRow("run-n", 5, "started", "t-n", { routine: "r2" });
    R.runLogged("run-n");
    const all = R.listRuns({ state: "archive", limit: 100 }).map((r) => r.id);
    eq(all, ["run-n", "skip1", "run3", "run2", "run1", "skip-old", "run-old"]);
    const p1 = R.listRuns({ state: "archive", limit: 3 });
    eq(p1.map((r) => r.id), ["run-n", "skip1", "run3"]);
    const p2 = R.listRuns({ state: "archive", limit: 3, before: p1.at(-1)!.started_at });
    eq(p2.map((r) => r.id), ["run2", "run1", "skip-old"]);
    const p3 = R.listRuns({ state: "archive", limit: 3, before: p2.at(-1)!.started_at });
    eq(p3.map((r) => r.id), ["run-old"]);
    eq(R.listRuns({ state: "archive", routine_id: "r2" }).map((r) => r.id), ["run-n"]);
    eq(R.listRuns({ state: "archive", routine_id: "r2" })[0].routine_name, "Nightly");
  });

  await test("phone allowlist: both reads on, writes off", () => {
    ok(allowedRoute("GET", "routine-runs"), "list");
    ok(allowedRoute("GET", "routine-runs/run1"), "detail");
    ok(!allowedRoute("POST", "routine-runs"), "post");
    ok(!allowedRoute("GET", "routine-runs/run1/x"), "sub path");
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `\n      ${r.note}` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main();
