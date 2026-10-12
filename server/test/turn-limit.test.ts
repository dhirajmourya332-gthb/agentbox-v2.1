/**
 * A turn that hits the step limit (max_turns) carries on by itself, up to 3 times, instead of failing.
 * In-process against a throwaway database, with the SDK's query faked (no Claude is run).
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/turn-limit.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-turns-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\nmodules: { display: false }\n`);
Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", NO_COLOR: "1",
});

const { all, get } = await import("../src/db.ts");
const { setPaused } = await import("../src/control.ts");
const A = await import("../src/agents.ts");
const RU = await import("../src/runner.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake query: each call answers with the next scripted result. */
function script(results: string[]) {
  const prompts: string[] = [];
  let n = 0;
  RU.setQueryForTests(((args: any) => {
    prompts.push(String(args.prompt));
    const subtype = results[Math.min(n++, results.length - 1)];
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      if (subtype === "success") yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "All done." }] } };
      yield { type: "result", subtype, session_id: "s1", result: subtype === "success" ? "All done." : "", total_cost_usd: 0 };
    })();
  }) as any);
  return prompts;
}
const until = async (fn: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); }
};
const coder = A.createAgent({ name: "coder", title: "Coder", summary: "codes", model: "sonnet", instructions: "# coder\n", interview: {} });
setPaused(false);
const notes = (threadId: string) => all<any>(`SELECT content FROM messages WHERE thread_id = ? AND author = 'system'`, threadId).map((m) => m.content);

test("the step limit continues the turn in the same session, then finishes", async () => {
  const prompts = script(["error_max_turns", "error_max_turns", "success"]);
  const t = A.spawnInstance(coder.id, { label: "Long test run", createdBy: "owner", asLead: true });
  const thread = A.dmThreadOf(t.id)!;
  const task = RU.enqueueTask({ agentId: t.id, threadId: thread, source: "user", title: "Run the suite", prompt: "run it" });
  await until(() => ["done", "failed"].includes(get<any>(`SELECT status FROM tasks WHERE id = ?`, task.id).status));
  const row = get<any>(`SELECT * FROM tasks WHERE id = ?`, task.id);
  assert.equal(row.status, "done", row.error);
  assert.equal(prompts.length, 3);
  assert.equal(prompts[0], "run it");
  assert.match(prompts[1], /reached the step limit.*Carry on where you left off/s);
  assert.deepEqual(notes(thread).filter((n) => /step limit/.test(n)).length, 2);
});

test("after 3 continuations it stops, with a reason that says what to do", async () => {
  const prompts = script(["error_max_turns"]);
  const t = A.spawnInstance(coder.id, { label: "Endless", createdBy: "owner", asLead: true });
  const thread = A.dmThreadOf(t.id)!;
  const task = RU.enqueueTask({ agentId: t.id, threadId: thread, source: "user", title: "Loop", prompt: "go" });
  await until(() => ["done", "failed"].includes(get<any>(`SELECT status FROM tasks WHERE id = ?`, task.id).status));
  const row = get<any>(`SELECT * FROM tasks WHERE id = ?`, task.id);
  assert.equal(row.status, "failed");
  assert.equal(prompts.length, 4, "the first run plus 3 continuations");
  assert.match(row.error, /step limit 4 times in a row.*Split the work/);
});
