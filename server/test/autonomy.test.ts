/**
 * Fewer things wait on the owner: helpers' stalls and failures go to their lead, the lead can stop a
 * helper, agents wake themselves later (schedule_wakeup), ask_owner is the one way to raise "needs you",
 * and groups no longer pause after N replies. In-process against a throwaway database; agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/autonomy.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-autonomy-")));
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

const { run, all, get, newId, now } = await import("../src/db.ts");
const { publish } = await import("../src/bus.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const AT = await import("../src/attention.ts");
const TM = await import("../src/team.ts");
const W = await import("../src/wakeups.ts");
const GR = await import("../src/groups.ts");
AT.startAttention();
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (name: string, scale = false) => {
  const a = A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
  if (scale) run(`UPDATE agents SET can_scale = 1 WHERE id = ?`, a.id);
  return A.getAgent(a.id)!;
};
const leadRole = mk("tech-lead", true);
const coder = mk("coder");
const root = A.spawnInstance(leadRole.id, { label: "Big work", createdBy: "owner", asLead: true });
const helper = A.spawnInstance(coder.id, { label: "Piece", createdBy: root.id, parentInstanceId: root.id });
const taskOf = (agentId: string, source: string, status: string, from: string | null = null) => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at, from_agent_id) VALUES (?, ?, ?, ?, 'Run the tests', 'p', ?, ?, ?)`,
    id, agentId, A.dmThreadOf(agentId), source, status, now(), from);
  return id;
};
const queued = (agentId: string) => all<any>(`SELECT * FROM tasks WHERE agent_id = ? AND status = 'queued' ORDER BY created_at`, agentId);
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
};
const tools = (agent: any, taskId: string) => {
  const ts = TM.teamTools(agent, taskId);
  return (name: string, args: any) => (ts.find((x: any) => x.name === name) as any).handler(args, {});
};
const progress = (taskId: string, agentId: string) => ({ task_id: taskId, agent_id: agentId, state: "stalled" as const, progress: { root_id: root.id, activity: "Running npm test" } as any });

test("a helper's stall goes to its lead (once), not to the owner; the lead's own stall goes to the owner", async () => {
  const ht = taskOf(helper.id, "agent", "running", root.id);
  const before = queued(root.id).length;
  AT.onTaskState(progress(ht, helper.id));
  await until(() => queued(root.id).length === before + 1);
  const notice = queued(root.id).at(-1);
  assert.match(notice.prompt, /may be stuck on "Run the tests".*stop_task.*ask_owner/s);
  assert.equal(get(`SELECT 1 FROM attention WHERE kind = 'stalled' AND task_id = ?`, ht), undefined, "no needs-you item");
  AT.onTaskState(progress(ht, helper.id));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(queued(root.id).length, before + 1, "not told twice within half an hour");
  const rt = taskOf(root.id, "user", "running");
  AT.onTaskState(progress(rt, root.id));
  assert.ok(get(`SELECT 1 FROM attention WHERE kind = 'stalled' AND task_id = ?`, rt));
});

test("a helper's failure isn't the owner's item (its lead gets the report); the lead's own failure is", () => {
  const ht = taskOf(helper.id, "agent", "running", root.id);
  run(`UPDATE tasks SET status = 'failed', error = 'boom' WHERE id = ?`, ht);
  publish({ type: "task.updated", task: get(`SELECT * FROM tasks WHERE id = ?`, ht) } as any);
  assert.equal(get(`SELECT 1 FROM attention WHERE kind = 'failed' AND task_id = ?`, ht), undefined);
  const rt = taskOf(root.id, "user", "running");
  run(`UPDATE tasks SET status = 'failed', error = 'boom' WHERE id = ?`, rt);
  publish({ type: "task.updated", task: get(`SELECT * FROM tasks WHERE id = ?`, rt) } as any);
  assert.ok(get(`SELECT 1 FROM attention WHERE kind = 'failed' AND task_id = ?`, rt));
});

test("stop_task: the lead stops a task it handed out; nobody else can", async () => {
  const ht = taskOf(helper.id, "agent", "queued", root.id);
  const other = A.spawnInstance(coder.id, { label: "Other", createdBy: "owner", asLead: true });
  let r = await tools(other, taskOf(other.id, "user", "running"))("stop_task", { task_id: ht });
  assert.ok(r.isError);
  r = await tools(root, taskOf(root.id, "user", "running"))("stop_task", { task_id: ht });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(get<any>(`SELECT status FROM tasks WHERE id = ?`, ht).status, "stopped");
});

test("ask_owner raises a question in needs-you; replies stay plain", async () => {
  const r = await tools(root, taskOf(root.id, "user", "running"))("ask_owner", { question: "Spend $40/mo on bigger CI runners? I recommend yes." });
  assert.ok(!r.isError);
  const item = get<any>(`SELECT * FROM attention WHERE kind = 'question' ORDER BY created_at DESC LIMIT 1`);
  assert.match(item.title, /tech-lead#\d+ asks: Spend \$40\/mo/);
  assert.equal(item.room_id, root.id);
});

test("schedule_wakeup: a one-time wake-up fires once; set on a delegated task, the reply goes back to the delegator", async () => {
  const ht = taskOf(helper.id, "agent", "running", root.id);
  const call = tools(helper, ht);
  assert.ok((await call("schedule_wakeup", { in_minutes: 0, note: "x" })).isError, "at least a minute");
  assert.ok((await call("schedule_wakeup", { in_minutes: 20, note: "" })).isError, "needs a note");
  const r = await call("schedule_wakeup", { in_minutes: 20, note: "Check CI on PR #12; merge if green" });
  assert.ok(!r.isError, r.content[0].text);
  const [w] = W.pendingFor(helper.id);
  assert.ok(Date.parse(w.due_at) - Date.now() > 19 * 60_000);
  assert.ok(W.listWakeups().some((x: any) => x.id === w.id && x.agent_name === helper.name));
  W.fire(w.id);
  const woke = queued(helper.id).at(-1);
  assert.match(woke.prompt, /wake-up is due.*Check CI on PR #12.*goes back to tech-lead/s);
  assert.equal(woke.source, "agent");
  assert.equal(woke.from_agent_id, root.id);
  W.fire(w.id);
  assert.equal(queued(helper.id).filter((t: any) => /wake-up is due/.test(t.prompt)).length, 1, "fires once");
  // Cancel: only its own; the owner (no agent) may cancel any.
  await call("schedule_wakeup", { in_minutes: 30, note: "Later" });
  const [w2] = W.pendingFor(helper.id);
  assert.throws(() => W.cancelWakeup(w2.id, root), /isn't yours/);
  assert.equal(W.cancelWakeup(w2.id).status, "cancelled");
  for (let i = 0; i < 5; i++) await call("schedule_wakeup", { in_minutes: 60 + i, note: `n${i}` });
  assert.match((await call("schedule_wakeup", { in_minutes: 99, note: "one too many" })).content[0].text, /already have 5/);
});

test("groups don't pause after a number of replies (no cap unless configured)", () => {
  assert.equal(GR.TURN_LIMIT, Infinity);
});
