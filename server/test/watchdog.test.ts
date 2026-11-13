/**
 * The watchdog (server/src/watchdog.ts): a service down or the browser hung starts a helper session by
 * itself, only after two checks in a row, one at a time, with a cooldown and a daily cap; the request
 * completes when the checks pass. Throwaway database; agents stay paused (Claude never starts).
 *
 *   cd server && node --disable-warning=ExperimentalWarning --import tsx --test test/watchdog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-watchdog-"));
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

const { all, run } = await import("../src/db.ts");
const A = await import("../src/agents.ts");
const S = await import("../src/setup.ts");
const R = await import("../src/setupRequests.ts");
const W = await import("../src/watchdog.ts");
const { setPaused } = await import("../src/control.ts");
setPaused(true);
S.ensureSetupRole();

const hung: W.Problem = { key: "browser", title: "the shared browser doesn't respond", detail: "CDP doesn't answer.", check: "false" };
const vnc: W.Problem = { key: "service:agentbox-vnc", title: "agentbox-vnc is failed", detail: "unit failed", check: "false" };

test("a problem seen twice in a row starts a helper by itself; a blip doesn't", async () => {
  let problems: W.Problem[] = [hung];
  let t = Date.now();
  const tick = W.createWatchdog({ probe: async () => problems, at: () => t });
  assert.equal((await tick()).action, "waiting");     // first sighting
  problems = [];
  assert.equal((await tick()).action, "none");        // it recovered: nothing
  problems = [hung];
  assert.equal((await tick()).action, "waiting");
  const r = await tick();                               // second in a row
  assert.equal(r.action, "started");
  const inst = A.getAgent(r.instance_id!)!;
  assert.ok(S.isSetupAgent(inst), "a helper (setup agent) session");
  const req = all<any>(`SELECT * FROM setup_requests WHERE source = 'watchdog'`)[0];
  assert.equal(req.status, "in_progress");
  assert.equal(req.setup_instance_id, inst.id);
  assert.match(req.title, /browser/);
  assert.match(R.setupPrompt(req), /watchdog raised this itself/);
  const prompt = all<{ content: string }>(`SELECT content FROM messages WHERE thread_id = ? ORDER BY created_at`, A.dmThreadOf(inst.id))
    .map((m) => m.content).join("\n");
  assert.match(prompt, /CDP doesn't answer/);
  assert.ok(all(`SELECT 1 FROM attention WHERE title LIKE 'agentbox started a helper%'`).length, "the owner hears about it");

  // While it's open: no second helper, even for a new problem.
  problems = [hung, vnc];
  await tick();
  assert.equal((await tick()).action, "busy");

  // Fixed: the request completes when its check passes.
  run(`UPDATE setup_requests SET check_cmd = 'true' WHERE id = ?`, req.id);
  await R.checkRequests({}, { force: true });
  assert.equal(R.getRequest(req.id)!.status, "done");

  // Broken again soon after: the cooldown holds it back; later it starts again; the daily cap stops it.
  assert.equal((await tick()).action, "cooldown");
  t += W.WATCHDOG.cooldownMs + 1000;
  const again = await tick();
  assert.equal(again.action, "started");
  assert.notEqual(again.instance_id, inst.id);
  const ids = all<{ id: string }>(`SELECT id FROM setup_requests WHERE source = 'watchdog'`).map((x) => x.id);
  for (const id of ids) run(`UPDATE setup_requests SET status = 'done', created_at = ? WHERE id = ?`, new Date(t - 3600_000).toISOString(), id);
  for (let i = 0; i < W.WATCHDOG.perDay; i++) run(`INSERT INTO setup_requests (id, title, for_setup_agent, status, source, created_at, updated_at) VALUES (?, 'x', 'x', 'done', 'watchdog', ?, ?)`, `cap${i}`, new Date(t - 3600_000).toISOString(), new Date(t - 3600_000).toISOString());
  assert.equal((await tick()).action, "limit");
});
