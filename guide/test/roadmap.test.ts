// The roadmap state machine: ○ ● ⏸ ✔ ✖ ─, and "done only when the check passes".
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModule } from "../src/manifest.ts";
import { checksToRun, computeRoadmap, gatesTurnedGreen, modulesInCommand, type Attempt, type CheckResult } from "../src/roadmap.ts";

const github = normalizeModule({
  id: "github", title: "GitHub", depends: ["core"], steps: [
    { id: "install", title: "Install", run: "install.sh", check: "command -v gh" },
    { id: "login", title: "Log in", human: true, instructions: "run `gh auth login`", copy: "gh auth login", check: "gh auth status" },
    { id: "verify", title: "Verify", run: "verify.sh", check: "gh api user" },
  ],
}, "github");
const core = normalizeModule({ id: "core", title: "core", steps: [{ id: "install", title: "i", check: "c1" }, { id: "app", title: "a", check: "c2" }] }, "core");
const claude = normalizeModule({ id: "claude", depends: ["core"], steps: [{ id: "login", title: "l", human: true, instructions: "x", check: "c3" }] }, "claude");
const access = normalizeModule({
  id: "access", depends: ["core"], steps: [
    { id: "ts", title: "ts", when: "access == tailscale", check: "ts" },
    { id: "cf", title: "cf", when: "access == cloudflare", check: "cf" },
    { id: "verify", title: "v", check: "v" },
  ],
}, "access");
const MODS = [core, claude, access, github];
const conf = { access: "tailscale", modules: { github: true } };

const ok = (at = 1): CheckResult => ({ ok: true, code: 0, output: "", at });
const bad = (output = "nope", at = 1): CheckResult => ({ ok: false, code: 1, output, at });
const run = (checks: Record<string, CheckResult>, attempts: Record<string, Attempt> = {}, active: string[] = [], c: any = conf) =>
  computeRoadmap({ modules: MODS, config: c, checks: new Map(Object.entries(checks)), attempts: new Map(Object.entries(attempts)), active: new Set(active) });
const states = (r: ReturnType<typeof run>, id: string) => r.modules.find((m) => m.id === id)!.steps.map((s) => `${s.id}:${s.state}`);

describe("roadmap states", () => {
  test("nothing checked yet: pending, and the gate isn't your turn before install", () => {
    assert.deepEqual(states(run({}), "github"), ["install:pending", "login:pending", "verify:pending"]);
  });
  test("done only when the check passes", () => {
    const r = run({ "github.install": ok() }, { github: { status: "ok", what: "install", at: 1 } });
    assert.deepEqual(states(r, "github"), ["install:done", "login:human", "verify:pending"]);
    // An attempt that "succeeded" doesn't make anything done by itself.
    const r2 = run({ "github.install": bad() }, { github: { status: "ok", what: "install", at: 1 } });
    assert.equal(r2.modules.find((m) => m.id === "github")!.steps[0].state, "failed");
  });
  test("a step after an open gate waits (pending), not failed", () => {
    const r = run({ "github.install": ok(), "github.verify": bad() }, { github: { status: "ok", what: "verify", at: 1 } });
    assert.deepEqual(states(r, "github"), ["install:done", "login:human", "verify:pending"]);
  });
  test("the gate turning green opens the next step; a checked step is done even out of order", () => {
    const r = run({ "github.install": ok(), "github.login": ok(), "github.verify": ok() });
    assert.deepEqual(states(r, "github"), ["install:done", "login:done", "verify:done"]);
    assert.equal(r.modules.find((m) => m.id === "github")!.state, "done");
  });
  test("running: only the first unfinished step of the module the agent is on", () => {
    const r = run({}, {}, ["github"]);
    assert.deepEqual(states(r, "github"), ["install:running", "login:pending", "verify:pending"]);
    const r2 = run({}, { github: { status: "running", what: "install", at: 1 } });
    assert.equal(r2.modules.find((m) => m.id === "github")!.state, "running");
  });
  test("failed shows the install's error once, with the module failed", () => {
    const r = run({}, { github: { status: "failed", what: "install", at: 1, error: "E: Unable to locate package gh" } });
    const g = r.modules.find((m) => m.id === "github")!;
    assert.equal(g.steps[0].state, "failed");
    assert.match(g.steps[0].error!, /Unable to locate/);
    assert.equal(g.state, "failed");
  });
  test("failed without an install error explains the check", () => {
    const r = run({ "github.install": bad("gh: not found") }, { github: { status: "ok", what: "install", at: 1 } });
    assert.match(r.modules.find((m) => m.id === "github")!.steps[0].error!, /gh: not found/);
    const t = run({ "github.install": { ok: false, code: null, output: "", at: 1, timedOut: true } }, { github: { status: "ok", what: "install", at: 1 } });
    assert.match(t.modules.find((m) => m.id === "github")!.steps[0].error!, /timed out/);
  });
  test("disabled modules: every step ─", () => {
    const r = run({ "github.install": ok() }, {}, [], { access: "tailscale", modules: { github: false } });
    const g = r.modules.find((m) => m.id === "github")!;
    assert.equal(g.enabled, false);
    assert.equal(g.state, "disabled");
    assert.ok(g.steps.every((s) => s.state === "disabled"));
    assert.equal(r.modules.at(-1)!.id, "github", "off modules come last");
  });
  test("when: hides steps of other access modes (and their checks aren't run)", () => {
    const r = run({});
    assert.deepEqual(r.modules.find((m) => m.id === "access")!.steps.map((s) => s.id), ["ts", "verify"]);
    const keys = checksToRun(MODS, conf).map((c) => c.key);
    assert.ok(keys.includes("access.ts") && !keys.includes("access.cf"));
    assert.ok(!checksToRun(MODS, { access: "tailscale", modules: { github: false } }).some((c) => c.key.startsWith("github.")));
  });
  test("allDone, nextHuman and counts", () => {
    const all = { "core.install": ok(), "core.app": ok(), "claude.login": ok(), "access.ts": ok(), "access.verify": ok(), "github.install": ok(), "github.login": ok(), "github.verify": ok() };
    assert.equal(run(all).allDone, true);
    const { "github.login": _, ...rest } = all;
    const r = run(rest);
    assert.equal(r.allDone, false);
    assert.equal(r.nextHuman?.key, "github.login");
    assert.equal(r.counts.human, 1);
  });
  test("gatesTurnedGreen finds human steps that just became done", () => {
    const before = run({ "github.install": ok() });
    const after = run({ "github.install": ok(), "github.login": ok() });
    assert.deepEqual(gatesTurnedGreen(before, after).map((s) => s.key), ["github.login"]);
    assert.deepEqual(gatesTurnedGreen(after, after), []);
    assert.deepEqual(gatesTurnedGreen(null, after), []);
  });
});

describe("following the agent's commands", () => {
  const known = ["core", "github", "aws"];
  test("install / verify / enable with ids", () => {
    assert.deepEqual(modulesInCommand("sudo agentbox module install github", known), { verb: "install", ids: ["github"] });
    assert.deepEqual(modulesInCommand("cd /x && sudo agentbox module install core github 2>&1 | tail", known), { verb: "install", ids: ["core", "github"] });
    assert.deepEqual(modulesInCommand("agentbox module verify aws", known), { verb: "verify", ids: ["aws"] });
    assert.deepEqual(modulesInCommand("sudo agentbox module install --enabled", known)?.ids, known);
  });
  test("not a module command", () => {
    assert.equal(modulesInCommand("agentbox module check github", known), null);
    assert.equal(modulesInCommand("agentbox module install nope", known), null);
    assert.equal(modulesInCommand("echo hi", known), null);
  });
});
