// `when:` evaluation, profile dependency resolution and the profile toggles.
//   cd guide && npm test
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { baseOnly, evalWhen, isOn, loadModules, resolveProfile, normalizeModule, type ModuleDef } from "../src/manifest.ts";
import { ACCESS_MODES, isAccessMode } from "../src/profile.ts";

const mod = (id: string, depends: string[] = [], kind = "base", steps: any[] = [{ id: "install", title: "Install", check: "true" }]): ModuleDef =>
  normalizeModule({ id, kind, title: id, depends, steps }, id);

const MODS = [
  mod("core"), mod("claude", ["core"]), mod("access", ["core"]), mod("display", ["core"]), mod("terminal", ["core"]),
  mod("github", ["core"], "integration"), mod("aws", ["core"], "integration"), mod("kubernetes", ["aws"], "integration"),
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
  test("every base module is in, required first; integrations never", () => {
    const p = resolveProfile(baseOnly(MODS), { modules: { github: true } });
    assert.deepEqual(p.order, ["core", "claude", "access", "terminal", "display"]);
    assert.deepEqual(p.implied, []);
  });
  test("a base module is off only when the config says false; required ones never", () => {
    const p = resolveProfile(baseOnly(MODS), { modules: { display: false, core: false } });
    assert.ok(!p.order.includes("display"));
    assert.ok(p.order.includes("core"));
    assert.equal(isOn({ modules: {} }, { id: "display", kind: "base" }), true);
    assert.equal(isOn({ modules: {} }, { id: "github", kind: "integration" }), false);
    assert.equal(isOn({ modules: { github: true } }, { id: "github", kind: "integration" }), true);
  });
  test("a manifest without kind is base; kind: integration is kept", () => {
    assert.equal(normalizeModule({ id: "x" }, "x").kind, "base");
    assert.equal(normalizeModule({ id: "x", kind: "integration" }, "x").kind, "integration");
    assert.deepEqual(baseOnly(MODS).map((m) => m.id), ["core", "claude", "access", "display", "terminal"]);
  });
  test("missing dependencies and cycles are reported, not fatal", () => {
    const p = resolveProfile([...MODS, mod("x", ["nope"]), mod("a", ["b"]), mod("b", ["a"])], { modules: {} });
    assert.deepEqual(p.missing, ["nope"]);
    assert.ok(p.cycles.length > 0);
    assert.ok(p.order.includes("a") && p.order.includes("b"));
  });
  test("the access choices", () => {
    assert.deepEqual(ACCESS_MODES.map((m) => m.id), ["tailscale", "cloudflare", "ssh-tunnel"]);
    assert.equal(isAccessMode("cloudflare"), true);
    assert.equal(isAccessMode("funnel"), false);
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
  test("the first run is the base: core, claude, access, display, terminal", () => {
    const base = baseOnly(mods);
    assert.deepEqual(base.map((m) => m.id).sort(), ["access", "claude", "core", "display", "terminal"]);
    const p = resolveProfile(base, { access: "ssh-tunnel", modules: { display: true, terminal: true, github: true } });
    assert.deepEqual(p.missing, []);
    assert.deepEqual(p.order, ["core", "claude", "access", "terminal", "display"]);
  });
  test("every other module is an integration", () => {
    for (const m of mods.filter((x) => x.kind === "integration")) assert.ok(!["core", "claude", "access", "display", "terminal"].includes(m.id), m.id);
    assert.ok(mods.some((m) => m.id === "github" && m.kind === "integration"));
  });
});
