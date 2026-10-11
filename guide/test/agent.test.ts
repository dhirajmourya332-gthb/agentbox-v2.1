// The setup agent's wiring with a fake Agent SDK query(): session persistence, waiting at a gate,
// "continue" when the gate turns green, pause / resume, the command guard, and following modules.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSetupAgent, forbiddenReason, systemPrompt, type QueryFn } from "../src/agent.ts";
import { normalizeModule } from "../src/manifest.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeQuery(script: (prompt: string, n: number) => any[], opts: { hang?: boolean } = {}) {
  const calls: { prompt: string; options: any }[] = [];
  const q: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const msgs = script(prompt, calls.length);
    const abort = options.abortController as AbortController;
    async function* gen() {
      for (const m of msgs) { if (abort.signal.aborted) throw new Error("aborted"); yield m; await sleep(1); }
      if (opts.hang) await new Promise((_r, rej) => abort.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    }
    const it: any = gen();
    it.interrupt = async () => abort.abort();
    return it;
  };
  return { q, calls };
}

const turn = (session: string, extra: any[] = []) => [
  { type: "system", subtype: "init", session_id: session },
  ...extra,
  { type: "result", subtype: "success", session_id: session, total_cost_usd: 0.01 },
];

function harness(query: QueryFn, gate: { open: boolean }, initial: string | null = null) {
  let session: string | null = initial;
  const statuses: string[] = [];
  const logs: string[] = [];
  const tools: string[] = [];
  const agent = createSetupAgent({
    query, cwd: "/tmp", env: {}, prompt: () => "SYSTEM",
    loadSession: () => session, saveSession: (id) => { session = id; },
    onLog: (e) => logs.push(`${e.kind}:${e.text}`), onStatus: (s) => statuses.push(s), onUsage: () => {},
    onTool: (ev) => tools.push(`${ev.phase}:${ev.command}${ev.isError ? ":err" : ""}`),
    gateOpen: () => gate.open,
  });
  return { agent, statuses, logs, tools, session: () => session };
}

describe("setup agent", () => {
  test("a turn: system prompt appended to Claude Code's, permissions bypassed, session saved, waits at an open gate", async () => {
    const { q, calls } = fakeQuery(() => turn("s1", [
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Installing github." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "sudo agentbox module install github" } }] } },
      { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done", is_error: false }] } },
    ]));
    const h = harness(q, { open: true });
    await h.agent.start();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.systemPrompt, { type: "preset", preset: "claude_code", append: "SYSTEM" });
    assert.equal(calls[0].options.permissionMode, "bypassPermissions");
    assert.equal(calls[0].options.resume, undefined);
    assert.equal(h.session(), "s1");
    assert.deepEqual(h.tools, ["start:sudo agentbox module install github", "end:sudo agentbox module install github"]);
    assert.equal(h.agent.status, "waiting");
    assert.ok(h.logs.some((l) => l === "text:Installing github."));
  });

  test("a gate turning green sends \"continue\" and resumes the same session", async () => {
    const gate = { open: true };
    const { q, calls } = fakeQuery((_p, n) => turn(`s1`, n === 1 ? [] : []));
    const h = harness(q, gate);
    await h.agent.start();
    assert.equal(h.agent.status, "waiting");
    gate.open = false;
    await h.agent.gateGreen("Log in to GitHub");
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /^continue/);
    assert.equal(calls[1].options.resume, "s1");
    assert.equal(h.agent.status, "idle");
    // Not waiting → a green gate doesn't start a turn.
    await h.agent.gateGreen("x");
    assert.equal(calls.length, 2);
  });

  test("pause stops the turn; nothing continues until resume", async () => {
    const { q, calls } = fakeQuery(() => [{ type: "system", subtype: "init", session_id: "s2" }], { hang: true });
    const h = harness(q, { open: true });
    const running = h.agent.start();
    await sleep(20);
    assert.equal(h.agent.status, "running");
    await h.agent.pause();
    await running;
    assert.equal(h.agent.status, "paused");
    await h.agent.gateGreen("x");
    assert.equal(calls.length, 1, "a paused agent ignores green gates");
    const again = h.agent.resume();
    await sleep(20);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.resume, "s2");
    await h.agent.pause();
    await again;
  });

  test("an unresumable session starts fresh", async () => {
    const resumes: (string | undefined)[] = [];
    const q: QueryFn = ({ options }) => {
      resumes.push(options.resume as string | undefined);
      if (options.resume) return (async function* () { throw new Error("No conversation found with session ID stale"); })() as any;
      return (async function* () { yield* turn("s3"); })() as any;
    };
    const h = harness(q, { open: false }, "stale");
    await h.agent.start();
    assert.deepEqual(resumes, ["stale", undefined]);
    assert.equal(h.session(), "s3");
    assert.equal(h.agent.status, "idle");
  });

  test("the guard refuses logins, secrets and Docker", () => {
    for (const c of ["gh auth login", "sudo docker run x", "tailscale up --ssh", "claude /login", "aws configure sso", "eas login",
      "agentbox secret set zai.env", "cat /secrets/zai.env", "cat ~/.claude/.credentials.json", "cat /opt/agentbox/data/local-token",
      "glab auth login", "gcloud auth login --no-launch-browser", "az login --use-device-code",
      "sudo agentbox integration connect github"]) {
      assert.ok(forbiddenReason(c), c);
    }
    for (const c of ["sudo agentbox module install github", "agentbox module check github", "gh auth status", "systemctl status agentbox-web", "journalctl -u agentbox-web -n 50", "ls -ld /secrets"]) {
      assert.equal(forbiddenReason(c), null, c);
    }
  });

  test("the system prompt carries the rules, the profile and the gates' instructions", () => {
    const mods = [normalizeModule({ id: "github", title: "GitHub", steps: [{ id: "login", title: "Log in", human: true, instructions: "Run `gh auth login`", check: "gh auth status" }] }, "github")];
    const p = systemPrompt(mods, ["github"], { host: "cloud", access: "tailscale", user: "agentbox" });
    assert.match(p, /never perform logins/);
    assert.match(p, /HUMAN GATE/);
    assert.match(p, /gh auth login/);
    assert.match(p, /Don't run Docker/);
    assert.match(p, /BASE only/);
    assert.match(p, /Never run `agentbox integration connect`/);
  });
});
