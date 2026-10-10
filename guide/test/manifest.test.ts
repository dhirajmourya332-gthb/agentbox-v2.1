// `when:` evaluation, profile dependency resolution and the profile toggles.
//   cd guide && npm test
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { evalWhen, loadModules, planProfile, resolveProfile, toggleModule, normalizeModule, type ModuleDef } from "../src/manifest.ts";

const mod = (id: string, depends: string[] = [], steps: any[] = [{ id: "install", title: "Install", check: "true" }]): ModuleDef =>
  normalizeModule({ id, title: id, depends, steps }, id);

const MODS = [
  mod("core"), mod("claude", ["core"]), mod("access", ["core"]), mod("display", ["core"]), mod("terminal", ["core"]),
  mod("github", ["core"]), mod("aws", ["core"]), mod("kubernetes", ["aws"]), mod("mobile", ["core", "access"]),
  mod("mobile-app", ["mobile"]), mod("push", ["mobile-app"]),
];

describe("when:", () => {
  const conf = { access: "tailscale", host: "lima", modules: { mobile: true }, ports: { guide: 7699 } };
  test("no condition is true", () => {
    assert.equal(evalWhen(conf, undefined), true);
    assert.equal(evalWhen(conf, ""), true);
  });
  test("== and !=, quoted or not, nested keys", () => {
    assert.equal(evalWhen(conf, "access == tailscale"), true);
    assert.equal(evalWhen(conf, 'access == "tailscale"'), true);
    assert.equal(evalWhen(conf, "access == cloudflare"), false);
    assert.equal(evalWhen(conf, "access != cloudflare"), true);
    assert.equal(evalWhen(conf, "host != lima"), false);
    assert.equal(evalWhen(conf, "modules.mobile == true"), true);
    assert.equal(evalWhen(conf, "ports.guide == 7699"), true);
  });
  test("a missing key compares as empty", () => {
    assert.equal(evalWhen(conf, "tailscale.hostname == "), true);
    assert.equal(evalWhen(conf, "nope.x != something"), true);
  });
  test("an unparseable condition hides the step instead of throwing", () => {
    assert.equal(evalWhen(conf, "access = tailscale"), false);
    assert.equal(evalWhen(conf, "rm -rf /"), false);
  });
});

describe("profile", () => {
  test("required modules are always in, dependencies first", () => {
    const p = resolveProfile(MODS, { modules: {} });
    assert.deepEqual(p.order, ["core", "claude", "access"]);
    assert.deepEqual(p.implied, []);
  });
  test("an enabled module pulls in its dependencies (transitively)", () => {
    const p = resolveProfile(MODS, { modules: { push: true, kubernetes: true } });
    assert.deepEqual(p.order, ["core", "claude", "access", "aws", "kubernetes", "mobile", "mobile-app", "push"]);
    assert.deepEqual(p.implied.sort(), ["aws", "mobile", "mobile-app"]);
    for (const m of MODS) {
      const i = p.order.indexOf(m.id);
      if (i < 0) continue;
      for (const d of m.depends) assert.ok(p.order.indexOf(d) < i, `${d} before ${m.id}`);
    }
  });
  test("false and missing entries are off", () => {
    const p = resolveProfile(MODS, { modules: { github: false, display: true } });
    assert.ok(!p.order.includes("github"));
    assert.ok(p.order.includes("display"));
  });
  test("missing dependencies and cycles are reported, not fatal", () => {
    const p = resolveProfile([...MODS, mod("x", ["nope"]), mod("a", ["b"]), mod("b", ["a"])], { modules: { x: true, a: true } });
    assert.deepEqual(p.missing, ["nope"]);
    assert.ok(p.cycles.length > 0);
    assert.ok(p.order.includes("a") && p.order.includes("b"));
  });
  test("toggling on brings dependencies, toggling off drops dependents", () => {
    const cur = { display: false, terminal: true, github: false, aws: false, kubernetes: false, mobile: false, "mobile-app": false, push: false };
    const on = toggleModule(MODS, cur, "push", true);
    assert.equal(on.push && on["mobile-app"] && on.mobile, true);
    const off = toggleModule(MODS, on, "mobile", false);
    assert.equal(off.mobile || off["mobile-app"] || off.push, false);
    assert.equal(toggleModule(MODS, cur, "core", false).core, undefined, "required modules aren't toggles");
  });
  test("planProfile: disables dependents first, enables dependencies first, never leaves a dependency off", () => {
    const conf = { modules: { aws: true, kubernetes: true, github: true } };
    const plan = planProfile(MODS, conf, { aws: false, kubernetes: false, push: true });
    const ids = plan.changes.map((c) => `${c.on ? "+" : "-"}${c.id}`);
    assert.deepEqual(ids, ["-kubernetes", "-aws", "+mobile", "+mobile-app", "+push"]);
    // kubernetes on without aws: aws comes back on.
    const p2 = planProfile(MODS, { modules: {} }, { kubernetes: true, aws: false });
    assert.deepEqual(p2.changes.map((c) => c.id), ["aws", "kubernetes"]);
    // Required modules can't be switched off.
    assert.deepEqual(planProfile(MODS, { modules: {} }, { core: false, claude: false }).changes, []);
  });
});

describe("the real manifests", () => {
  const src = path.resolve(import.meta.dirname, "../..");
  const mods = loadModules(src);
  test("load, and every module's dependencies exist", () => {
    assert.ok(mods.length >= 10);
    const ids = new Set(mods.map((m) => m.id));
    for (const m of mods) for (const d of m.depends) assert.ok(ids.has(d), `${m.id} needs ${d}`);
    for (const id of ["core", "claude", "access"]) assert.ok(ids.has(id));
  });
  test("every step's when: parses", () => {
    for (const m of mods) for (const s of m.steps) {
      if (!s.when) continue;
      assert.match(s.when, /^\s*[A-Za-z0-9_.-]+\s*(==|!=)/, `${m.id}.${s.id}`);
    }
  });
  test("every human gate has instructions and a check", () => {
    for (const m of mods) for (const s of m.steps.filter((x) => x.human)) {
      assert.ok(s.instructions, `${m.id}.${s.id} instructions`);
      assert.ok(s.check, `${m.id}.${s.id} check`);
    }
  });
  test("the default profile (lima / ssh-tunnel) resolves", () => {
    const p = resolveProfile(mods, { access: "ssh-tunnel", modules: { display: true, terminal: true, github: true } });
    assert.deepEqual(p.missing, []);
    assert.deepEqual(p.order.slice(0, 3), ["core", "claude", "access"]);
  });
});
