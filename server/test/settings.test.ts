/**
 * The owner's settings (server/src/settings.ts): the live task limit, in-process against a
 * throwaway database. Agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/settings.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-settings-")));
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
const ST = await import("../src/settings.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const lead = A.getAgent(A.createAgent({ name: "lead", title: "lead", summary: "lead", model: "sonnet", instructions: "# lead\n", interview: {} }).id)!;

test("the live task limit: default, validation, and the error the portal links to Settings from", () => {
  assert.equal(ST.liveTaskLimit(), 40);
  assert.throws(() => ST.updateSettings({ max_live_tasks: 2 }), /from 5 to 1000/);
  assert.throws(() => ST.updateSettings({ max_live_tasks: 5.5 }), /whole number/);
  assert.equal(ST.updateSettings({ max_live_tasks: 5 }).max_live_tasks, 5);

  for (let i = 0; i < 5; i++) A.spawnInstance(lead.id, { label: `t${i}`, createdBy: "owner" });
  let err: any;
  try { A.spawnInstance(lead.id, { label: "one too many", createdBy: "owner" }); } catch (e) { err = e; }
  assert.ok(err instanceof ST.LiveLimitError);
  assert.equal(err.statusCode, 409);
  assert.equal(err.reason, "live_task_limit");
  assert.match(err.message, /5 live tasks, the limit \(5\).*raise the limit in Settings/);

  // Raised: the next one starts straight away.
  const v = ST.updateSettings({ max_live_tasks: 300 });
  assert.deepEqual([v.max_live_tasks, v.live_tasks], [300, 5]);
  assert.ok(A.spawnInstance(lead.id, { label: "now fine", createdBy: "owner" }).id);
});
