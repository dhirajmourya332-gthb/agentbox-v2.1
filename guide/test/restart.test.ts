// A guide restart in the middle of setup (docs/GUIDE.md › Restarts): the session cookie still
// works, a setup agent that was working is resumed with "continue", and running steps stream their
// output (a Retry's, and the agent's through the CLI's per-module progress log).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGuide, type GuideOptions } from "../src/app.ts";
import { mintToken } from "../src/auth.ts";
import { RESUME_PROMPT, type QueryFn } from "../src/agent.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-guide-restart-"));
const src = path.resolve(import.meta.dirname, "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await sleep(10); }
}

function setup(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, "config.yaml");
  fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\nmodules: { github: true }\nports: { guide: 7699, portal: 7700 }\n`);
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const base: GuideOptions = {
    configFile, stateDir, src, webDist: path.join(dir, "no-dist"),
    // Every check green (Claude login, the profile) except github's, so the agent may start.
    runCheck: async (cmd) => ({ ok: !/gh /.test(cmd), code: 0, output: "", at: Date.now() }),
    runAdmin: async () => ({ code: 0, output: "" }),
    checkIntervalMs: 50,
    tailIntervalMs: 30,
  };
  return { dir, stateDir, base };
}
const H = { host: "localhost" };
async function login(g: Awaited<ReturnType<typeof createGuide>>, stateDir: string) {
  const t = mintToken(path.join(stateDir, "tokens"));
  const r = await g.app.inject({ url: `/?t=${t}`, headers: H, remoteAddress: "127.0.0.1" });
  assert.equal(r.statusCode, 303);
  return String(r.headers["set-cookie"]).split(";")[0];
}

/** A fake SDK whose turns hang until released (or aborted). */
function hangingQuery(session: string) {
  const calls: { prompt: string; resume?: string }[] = [];
  let release: (() => void) | null = null;
  const q: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, resume: options.resume as string | undefined });
    const abort = options.abortController as AbortController;
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: session };
      await new Promise<void>((res, rej) => { release = res; abort.signal.addEventListener("abort", () => rej(new Error("aborted"))); });
      yield { type: "result", subtype: "success", session_id: session };
    }
    const it: any = gen();
    it.interrupt = async () => abort.abort();
    return it;
  };
  return { q, calls, release: () => release?.() };
}

describe("guide restart", () => {
  test("the session cookie works after a restart", async () => {
    const { stateDir, base } = setup("cookie");
    const g1 = await createGuide(base);
    await g1.app.ready();
    const cookie = await login(g1, stateDir);
    await g1.close();
    const g2 = await createGuide(base);
    await g2.app.ready();
    const r = await g2.app.inject({ url: "/api/state", headers: { ...H, cookie }, remoteAddress: "127.0.0.1" });
    assert.equal(r.statusCode, 200);
    const bad = await g2.app.inject({ url: "/api/state", headers: H, remoteAddress: "127.0.0.1" });
    assert.equal(bad.statusCode, 401);
    assert.match(bad.json().error, /expired or the guide restarted/);
    await g2.close();
  });

  test("an agent that was working when the guide stopped is recorded, then resumed with \"continue\"", async () => {
    const { stateDir, base } = setup("resume");
    fs.writeFileSync(path.join(stateDir, "profile-confirmed"), "x");
    const f1 = hangingQuery("sess-1");
    const g1 = await createGuide({ ...base, query: f1.q });
    await g1.app.ready();
    const cookie = await login(g1, stateDir);
    await until(() => g1.runner.settled && !!g1.snapshot().claudeReady);
    const r = await g1.app.inject({ method: "POST", url: "/api/agent/start", headers: { ...H, cookie }, remoteAddress: "127.0.0.1" });
    assert.equal(r.statusCode, 200, r.body);
    await until(() => g1.agent.status === "running" && f1.calls.length === 1);
    await sleep(20); // the init message saves the session id
    await g1.close(); // SIGTERM (a restart)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.equal(saved.agentStatus, "running", "the cut-off turn is recorded");
    assert.equal(saved.sessionId, "sess-1");

    const f2 = hangingQuery("sess-1");
    const g2 = await createGuide({ ...base, query: f2.q });
    await g2.app.ready();
    await until(() => f2.calls.length === 1);
    assert.equal(f2.calls[0].resume, "sess-1");
    assert.equal(f2.calls[0].prompt, RESUME_PROMPT);
    await until(() => g2.agent.status === "running");
    const snap: any = g2.snapshot();
    assert.ok(snap.progress.agent.resumedAt, "the pane shows \"Resumed after a restart\"");
    const log = await g2.app.inject({ url: "/api/log", headers: { ...H, cookie }, remoteAddress: "127.0.0.1" });
    assert.ok(log.json().log.some((e: any) => /Resumed after a restart/.test(e.text)));
    f2.release();
    await until(() => g2.agent.status !== "running");
    assert.equal(g2.snapshot().progress.agent.resumedAt, null);
    await g2.close();
    // Not running any more → the next start doesn't resume.
    const f3 = hangingQuery("sess-1");
    const g3 = await createGuide({ ...base, query: f3.q });
    await g3.app.ready();
    await until(() => g3.runner.settled);
    await sleep(150);
    assert.equal(f3.calls.length, 0);
    await g3.close();
  });

  test("an idle or paused agent isn't resumed", async () => {
    const { stateDir, base } = setup("idle");
    fs.writeFileSync(path.join(stateDir, "profile-confirmed"), "x");
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ sessionId: "s", agentStatus: "paused", attempts: {}, log: [] }));
    const f = hangingQuery("s");
    const g = await createGuide({ ...base, query: f.q });
    await g.app.ready();
    await until(() => g.runner.settled);
    await sleep(150);
    assert.equal(f.calls.length, 0);
    assert.equal(g.agent.status, "paused");
    await g.close();
  });

  test("a Retry streams its output, with wait_for_apt's notice as `waiting`", async () => {
    const { stateDir, base } = setup("retry");
    let emit: ((s: string) => void) | undefined;
    let finish: (() => void) | undefined;
    const g = await createGuide({
      ...base,
      runAdmin: (args, onOutput) => args[0] !== "module" ? Promise.resolve({ code: 0, output: "" }) : new Promise((resolve) => {
        emit = (s) => onOutput?.(s);
        finish = () => resolve({ code: 0, output: "ok" });
      }),
    });
    await g.app.ready();
    const cookie = await login(g, stateDir);
    const r = await g.app.inject({ method: "POST", url: "/api/retry", headers: { ...H, cookie, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: { module: "github" } });
    assert.equal(r.statusCode, 200, r.body);
    const job = () => (g.snapshot() as any).progress.jobs.find((j: any) => j.module === "github");
    assert.ok(job(), "a job as soon as the Retry starts");
    assert.equal(job().by, "retry");
    emit!("==> github: install.sh\n⏳ Waiting for Ubuntu's automatic security updates to finish (unattended-upgrades is installing updates; this is normal on a new VM) — 0 s elapsed, up to 15 min\n");
    assert.match(job().waiting.text, /automatic security updates/);
    emit!("✔ The package manager is free again (waited 20 s); continuing\n--> github cli\n");
    assert.equal(job().waiting, null);
    assert.equal(job().tail.at(-1), "--> github cli");
    finish!();
    await until(() => !job());
    await g.close();
  });

  test("an install by the setup agent: its output comes from the CLI's progress log (a fresh file per run)", async () => {
    const { stateDir, base } = setup("agent-tail");
    fs.writeFileSync(path.join(stateDir, "profile-confirmed"), "x");
    const runs = path.join(stateDir, "runs");
    fs.mkdirSync(runs, { recursive: true });
    const logFile = path.join(runs, "github.log");
    fs.writeFileSync(logFile, "OLD RUN\n");
    fs.utimesSync(logFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    let release: (() => void) | undefined;
    const q: QueryFn = ({ options }) => {
      const abort = options.abortController as AbortController;
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "t1" };
        yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sudo agentbox module install github" } }] } };
        await new Promise<void>((res, rej) => { release = res; abort.signal.addEventListener("abort", () => rej(new Error("aborted"))); });
        yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "done", is_error: false }] } };
        yield { type: "result", subtype: "success", session_id: "t1" };
      }
      const it: any = gen();
      it.interrupt = async () => abort.abort();
      return it;
    };
    const g = await createGuide({ ...base, query: q });
    await g.app.ready();
    const cookie = await login(g, stateDir);
    await until(() => g.runner.settled && !!g.snapshot().claudeReady);
    await g.app.inject({ method: "POST", url: "/api/agent/start", headers: { ...H, cookie }, remoteAddress: "127.0.0.1" });
    const job = () => (g.snapshot() as any).progress.jobs.find((j: any) => j.module === "github");
    await until(() => !!job());
    assert.equal(job().by, "agent");
    assert.match((g.snapshot() as any).progress.agent.tool.command, /module install github/);
    await sleep(100);
    assert.deepEqual(job().tail, [], "the previous run's log isn't shown");
    // The CLI replaces the file (new inode) and writes as the scripts run.
    fs.rmSync(logFile);
    fs.writeFileSync(logFile, "==> github: install.sh\n");
    await until(() => job()?.tail.includes("==> github: install.sh"));
    fs.appendFileSync(logFile, "--> github cli\n");
    await until(() => job()?.tail.at(-1) === "--> github cli");
    release!();
    await until(() => !job());
    assert.equal((g.snapshot() as any).progress.agent.tool, null);
    await g.close();
  });
});
