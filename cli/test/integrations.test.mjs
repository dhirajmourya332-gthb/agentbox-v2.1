// The integration pieces of the agentbox CLI (docs/V2-ARCHITECTURE.md § 10, docs/MODULES.md):
// the template renderer, settings validation, the state machine, the real manifests, and the
// `integration` commands end to end against a throw-away config and module tree.
//   cd cli && npm test
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import {
  CATEGORIES, coerce, integrationState, normalizeIntegration, normalizeSchema, parseAssignments, render, renderContext, stepViews, validateSettings,
} from "../integrations.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(repo, "cli", "agentbox.mjs");

describe("render", () => {
  test("variables, dotted keys, lists, missing values", () => {
    assert.equal(render("a {{x}} {{p.q}} [{{nope}}] {{l}}", { x: 1, p: { q: "Q" }, l: ["a", "b"] }), "a 1 Q [] a, b");
    assert.equal(render("{{ x }}", { x: "spaces ok" }), "spaces ok");
    assert.equal(render("{{f}}|{{z}}", { f: false, z: 0 }), "|0");
  });
  test("sections: truthy, falsy, inverted, lists with {{.}}", () => {
    assert.equal(render("{{#a}}yes {{a}}{{/a}}{{^a}}no{{/a}}", { a: "x" }), "yes x");
    assert.equal(render("{{#a}}yes{{/a}}{{^a}}no{{/a}}", { a: "" }), "no");
    assert.equal(render("{{#a}}yes{{/a}}{{^a}}no{{/a}}", { a: "  " }), "no");
    assert.equal(render("{{#a}}yes{{/a}}{{^a}}no{{/a}}", { a: [] }), "no");
    assert.equal(render("{{#l}}<{{.}}>{{/l}}", { l: ["a", "b"] }), "<a><b>");
    assert.equal(render("{{#o}}{{k}}{{/o}}", { o: { k: "inner" } }), "inner");
    assert.equal(render("{{#l}}{{.}}@{{host}} {{/l}}", { l: ["a"], host: "h" }), "a@h ", "outer keys stay visible");
    assert.equal(render("{{#a}}{{#b}}both{{/b}}{{/a}}", { a: 1, b: 1 }), "both");
  });
  test("standalone section lines disappear; comments are dropped", () => {
    const t = "x\n{{#a}}\n- a\n{{/a}}\n{{^b}}\n- no b\n{{/b}}\n  {{! note }}\ny\n";
    assert.equal(render(t, { a: 1 }), "x\n- a\n- no b\ny\n");
  });
  test("no HTML escaping (Markdown)", () => {
    assert.equal(render("{{x}}", { x: "<a & b>" }), "<a & b>");
  });
  test("unbalanced sections throw", () => {
    assert.throws(() => render("{{#a}}x", {}), /never closed/);
    assert.throws(() => render("x{{/a}}", {}), /without an opening/);
    assert.throws(() => render("{{#a}}{{/b}}", {}), /closes/);
  });
  test("values are not re-rendered (no template injection)", () => {
    assert.equal(render("{{x}}", { x: "{{y}}", y: "boom" }), "{{y}}");
  });
});

describe("settings", () => {
  const schema = normalizeSchema([
    { key: "repo", prompt: "Repo", required: true, pattern: "^[a-z]+/[a-z]+$" },
    { key: "labels", type: "list" },
    { key: "n", type: "number" },
    { key: "on", type: "boolean", default: false },
    { key: "mode", options: ["read-only", "full"], default: "read-only" },
  ]);
  test("schema normalisation", () => {
    assert.equal(schema.find((d) => d.key === "mode").type, "enum");
    assert.equal(schema.find((d) => d.key === "repo").required, true);
    assert.throws(() => normalizeSchema([{ key: "Bad-Key" }]), /lower_snake_case/);
    assert.throws(() => normalizeSchema([{ key: "a" }, { key: "a" }]), /twice/);
    assert.throws(() => normalizeSchema([{ key: "a", type: "colour" }]), /type/);
    assert.throws(() => normalizeSchema([{ key: "a", options: ["x"], default: "y" }]), /default/);
    assert.throws(() => normalizeSchema([{ key: "a", pattern: "(" }]), /regex/);
  });
  test("valid values are coerced; required ones are reported missing", () => {
    const r = validateSettings(schema, { labels: "a, b,,c", n: "3", on: "true", mode: "full" });
    assert.deepEqual(r.values, { labels: ["a", "b", "c"], n: 3, on: true, mode: "full" });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.missing, ["repo"]);
    assert.deepEqual(validateSettings(schema, { n: 1 }, { partial: true }).missing, []);
  });
  test("bad values, unknown keys, multi-line and secret-looking values are rejected", () => {
    const r = validateSettings(schema, { repo: "Not A Repo", mode: "root", n: "x", on: "maybe", nope: 1 });
    assert.deepEqual(r.errors.map((e) => e.key).sort(), ["mode", "n", "nope", "on", "repo"]);
    assert.match(coerce(schema[0], "a/b\nc/d").error, /one line/);
    assert.match(coerce({ type: "string" }, "ghp_" + "a".repeat(36)).error, /secret/);
    assert.match(coerce({ type: "string" }, "AKIA" + "A".repeat(16)).error, /secret/);
    assert.match(coerce({ type: "string" }, "x {{y}}").error, /\{\{/);
    assert.match(coerce({ type: "string" }, "x".repeat(400)).error, /at most/);
  });
  test("--set parsing; an empty value clears", () => {
    assert.deepEqual(parseAssignments(["a=1", "b=x=y", "c="]), { a: "1", b: "x=y", c: null });
    assert.throws(() => parseAssignments(["novalue"]), /key=value/);
  });
  test("render context: defaults, enum flags, paths", () => {
    const ctx = renderContext(schema, { repo: "a/b" }, { paths: { work: "/work" }, user: "u" });
    assert.equal(ctx.repo, "a/b");
    assert.deepEqual(ctx.labels, []);
    assert.equal(ctx.mode, "read-only");
    assert.equal(ctx.mode_read_only, true);
    assert.equal(ctx.mode_full, undefined);
    assert.equal(ctx.has_labels, false);
    assert.equal(ctx.paths.work, "/work");
  });
});

describe("states", () => {
  const steps = [
    { id: "install", title: "i", check: "x" },
    { id: "login", title: "l", human: true, check: "x", instructions: "run {{cmd}}" },
    { id: "verify", title: "v", check: "x" },
  ];
  const ok = { ok: true, code: 0 }, bad = { ok: false, code: 1, output: "nope" };
  const views = (r, enabled = true) => stepViews(steps, r, { enabled, renderText: (t) => t.replace("{{cmd}}", "gh auth login") });
  test("step states follow the roadmap's rules", () => {
    assert.deepEqual(views({ install: ok, login: bad, verify: bad }).map((s) => s.state), ["done", "human", "pending"]);
    assert.deepEqual(views({ install: bad, login: bad, verify: bad }).map((s) => s.state), ["failed", "pending", "pending"]);
    assert.deepEqual(views({ install: ok, login: ok, verify: ok }).map((s) => s.state), ["done", "done", "done"]);
    assert.deepEqual(views({ install: bad, login: bad, verify: bad }, false).map((s) => s.state), ["pending", "pending", "pending"]);
    assert.equal(views({}).find((s) => s.id === "login").instructions, "run gh auth login");
    assert.equal(views({ install: bad }).find((s) => s.id === "install").check.output, "nope");
    assert.equal(views({ install: ok }).find((s) => s.id === "install").check.output, undefined, "no output for a passing check");
  });
  test("integration states", () => {
    const all = views({ install: ok, login: ok, verify: ok });
    const gate = views({ install: ok, login: bad, verify: bad });
    const broke = views({ install: bad, login: bad, verify: bad });
    assert.equal(integrationState({ available: false, enabled: false, steps: [] }), "unavailable");
    assert.equal(integrationState({ enabled: false, steps: all }), "available");
    assert.equal(integrationState({ enabled: false, steps: all, last: { action: "disconnect", ok: true } }), "disconnected");
    assert.equal(integrationState({ enabled: true, steps: all, settingsSaved: true }), "connected");
    assert.equal(integrationState({ enabled: true, steps: all, settingsSaved: false }), "connecting");
    assert.equal(integrationState({ enabled: true, steps: all, settingsSaved: true, missing: ["x"] }), "connecting");
    assert.equal(integrationState({ enabled: true, steps: gate, settingsSaved: true }), "connecting");
    assert.equal(integrationState({ enabled: true, steps: broke, settingsSaved: true }), "error");
    assert.equal(integrationState({ enabled: true, steps: gate, settingsSaved: true, last: { action: "connect", ok: false } }), "error");
  });
});

describe("the real manifests", () => {
  const dir = path.join(repo, "setup", "modules");
  const all = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "module.yaml")))
    .map((d) => ({ ...parse(fs.readFileSync(path.join(dir, d, "module.yaml"), "utf8")), dir: path.join(dir, d) }));
  const base = all.filter((m) => m.kind === "base").map((m) => m.id).sort();
  const ints = all.filter((m) => m.kind === "integration");
  test("every module says what kind it is; the base is exactly the first run's", () => {
    for (const m of all) assert.ok(["base", "integration"].includes(m.kind), `${m.id}: kind`);
    assert.deepEqual(base, ["access", "claude", "core", "display", "terminal"]);
  });
  test("the catalog", () => {
    const ids = ints.map((m) => m.id).sort();
    for (const id of ["github", "gitlab", "bitbucket", "aws", "gcp", "azure", "kubernetes", "db-tunnel", "env-files", "voice", "mobile", "mobile-app", "push", "teams", "slack"]) assert.ok(ids.includes(id), id);
    assert.deepEqual(ints.filter((m) => m.available === false).map((m) => m.id).sort(), ["slack", "teams"]);
  });
  for (const raw of ints) {
    test(`${raw.id}: valid, and its templates render with no settings and with examples`, () => {
      const m = normalizeIntegration(raw);
      assert.ok(CATEGORIES.includes(m.category));
      if (!m.available) { assert.equal(m.steps.length, 0); return; }
      assert.ok(m.instructions.summary || m.id === "voice" || m.id === "mobile" || m.id === "mobile-app" || m.id === "push", "summary");
      if (m.instructions.file) assert.ok(fs.existsSync(path.join(raw.dir, m.instructions.file)), "instructions file");
      for (const s of m.steps.filter((x) => x.human)) assert.ok(s.instructions && s.check, `${s.id}: a gate needs instructions and a check`);
      for (const s of m.steps) if (s.run) assert.ok(fs.existsSync(path.join(raw.dir, s.run)), `${s.id}: ${s.run}`);
      // Every enum option and the examples, so every section is exercised.
      const samples = [{}];
      const ex = {};
      for (const d of m.settings) if (d.example && (!d.pattern || new RegExp(d.pattern).test(d.example))) ex[d.key] = d.type === "list" ? [d.example] : d.example;
      samples.push(ex);
      for (const d of m.settings.filter((x) => x.type === "enum")) for (const o of d.options) samples.push({ ...ex, [d.key]: o });
      const conf = { paths: { work: "/work", secrets: "/secrets", team: "/team" }, user: "agentbox" };
      for (const saved of samples) {
        const ctx = renderContext(m.settings, saved, conf);
        const texts = [m.instructions.summary, m.instructions.file && fs.readFileSync(path.join(raw.dir, m.instructions.file), "utf8"),
          ...m.steps.flatMap((s) => [s.instructions, s.copy])].filter(Boolean);
        for (const t of texts) {
          const out = render(t, ctx);
          assert.ok(!/\{\{|\}\}/.test(out), `${m.id}: leftover tag in ${out.slice(0, 80)}`);
        }
      }
      for (const d of m.settings) if (d.example && d.pattern) assert.match(d.example, new RegExp(d.pattern), `${d.key}: example matches its pattern`);
    });
  }
});

// --- the commands, end to end ---------------------------------------------------------------------------------

function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-int-"));
  const src = path.join(t, "src");
  const mods = path.join(src, "setup", "modules");
  fs.mkdirSync(path.join(src, "setup", "lib"), { recursive: true });
  fs.copyFileSync(path.join(repo, "setup/lib/common.sh"), path.join(src, "setup/lib/common.sh"));
  fs.copyFileSync(path.join(repo, "setup/lib/apt-wait.sh"), path.join(src, "setup/lib/apt-wait.sh"));
  const mk = (id, yaml, files = {}) => {
    fs.mkdirSync(path.join(mods, id), { recursive: true });
    fs.writeFileSync(path.join(mods, id, "module.yaml"), yaml);
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(mods, id, f), c);
  };
  mk("core", "id: core\nkind: base\ntitle: core\ndepends: []\nsteps: [{ id: ok, title: ok, check: 'true' }]\n");
  mk("demo", `id: demo
kind: integration
category: code-hosting
title: Demo
description: a test integration
depends: [core]
settings:
  - { key: repo, prompt: "Repo", required: true, pattern: '^[a-z]+/[a-z]+$' }
  - { key: labels, type: list, prompt: "Labels" }
  - { key: mode, prompt: "Mode", options: [read-only, full], default: read-only }
instructions:
  summary: "Demo: repo {{repo}}{{#has_labels}}, labels {{labels}}{{/has_labels}}."
  file: instructions.md
skills: [open-pr]
default_roles: [coder]
account: "echo demo-user"
revoke: "demo logout"
steps:
  - { id: install, title: Install, run: install.sh, check: "test -f \\"$DEMO_DIR/installed\\"" }
  - { id: login, title: Log in, human: true, instructions: "run demo login {{repo}}", copy: "demo login {{repo}}", check: "test -f \\"$DEMO_DIR/login\\"" }
  - { id: verify, title: Verify, check: "test -f \\"$DEMO_DIR/login\\"" }
`, {
    "install.sh": "#!/usr/bin/env bash\nset -euo pipefail\ntouch \"$DEMO_DIR/installed\"\necho installed\n",
    "disable.sh": "#!/usr/bin/env bash\ntouch \"$DEMO_DIR/disabled\"\n",
    "instructions.md": "# Demo\n\nRepo: `{{repo}}`\n{{#mode_full}}\nFull access.\n{{/mode_full}}\n{{^mode_full}}\nRead only.\n{{/mode_full}}\n",
  });
  mk("soon", "id: soon\nkind: integration\ncategory: chat\ntitle: Soon\navailable: false\nsteps: []\n");
  const conf = path.join(t, "config.yaml");
  fs.writeFileSync(conf, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { src: ${src}, team: ${t}/team, work: /work, secrets: ${t}/secrets, data: ${t}/data }\nmodules: { demo: false }\n`);
  const env = { ...process.env, AGENTBOX_CONFIG: conf, AGENTBOX_INTEGRATIONS_DIR: path.join(t, "int"), AGENTBOX_NO_SUDO: "1", DEMO_DIR: t, NO_COLOR: "1" };
  // Checks run `bash -lc` as this user: put a fake `agentbox` on PATH is not needed (the demo checks don't call it).
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { t, run };
}

describe("agentbox integration", () => {
  const { t, run } = sandbox();
  test("list --json: the catalog with categories and availability", () => {
    const r = run("integration", "list", "--json");
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.integrations.map((i) => [i.id, i.category, i.available, i.enabled]), [["demo", "code-hosting", true, false], ["soon", "chat", false, false]]);
  });
  test("module commands refuse integrations; module list shows the base only", () => {
    assert.match(run("module", "enable", "demo").err, /is an integration: use `agentbox integration connect demo`/);
    assert.match(run("module", "install", "demo").err, /integration connect demo/);
    const l = run("module", "list");
    assert.match(l.out, /core/);
    assert.doesNotMatch(l.out, /demo/);
    assert.match(run("integration", "status", "core").err, /base module/);
  });
  test("status --json before connecting: available, the schema, nothing rendered", () => {
    const j = JSON.parse(run("integration", "status", "demo", "--json").out);
    assert.equal(j.state, "available");
    assert.equal(j.enabled, false);
    assert.deepEqual(j.steps.map((s) => s.state), ["pending", "pending", "pending"]);
    assert.deepEqual(j.settings.missing, ["repo"]);
    assert.equal(j.settings.saved, false);
    assert.equal(j.instructions.rendered, false);
    assert.deepEqual(j.gates, []);
    assert.equal(JSON.parse(run("integration", "status", "soon", "--json").out).state, "unavailable");
  });
  test("settings are validated; nothing is written on an error", () => {
    const bad = run("integration", "settings", "demo", "--set", "repo=Not Valid");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /demo.repo: must match/);
    assert.ok(!fs.existsSync(path.join(t, "int", "demo.yaml")));
    assert.match(run("integration", "settings", "demo", "--set", "nope=1").err, /not a setting/);
    assert.match(run("integration", "settings", "demo", "--set", "repo=ghp_" + "x".repeat(36)).err, /looks like a secret/);
  });
  test("connect: installs, saves settings, renders, and lists what waits for the owner", () => {
    const r = run("integration", "connect", "demo", "--set", "repo=acme/web", "--set", "labels=bug,feature");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /installed/);
    assert.match(r.out, /Waiting for you/);
    assert.match(r.out, /run demo login acme\/web/);
    assert.match(fs.readFileSync(path.join(t, "config.yaml"), "utf8"), /demo: true/);
    assert.deepEqual(parse(fs.readFileSync(path.join(t, "int", "demo.yaml"), "utf8")), { repo: "acme/web", labels: ["bug", "feature"] });
    const md = fs.readFileSync(path.join(t, "team", "integrations", "demo.md"), "utf8");
    assert.match(md, /Generated by agentbox/);
    assert.match(md, /Repo: `acme\/web`\nRead only\.\n/);
    assert.equal(fs.readFileSync(path.join(t, "int", "demo.summary.md"), "utf8"), "Demo: repo acme/web, labels bug, feature.\n");
  });
  test("status --json while a gate is open: connecting, with the gate", () => {
    const j = JSON.parse(run("integration", "status", "demo", "--json").out);
    assert.equal(j.state, "connecting");
    assert.deepEqual(j.steps.map((s) => s.state), ["done", "human", "pending"]);
    assert.deepEqual(j.gates.map((g) => [g.kind, g.id]), [["step", "login"]]);
    assert.equal(j.gates[0].copy, "demo login acme/web");
    assert.equal(j.last.action, "connect");
    assert.equal(j.last.ok, true);
  });
  test("after the gate: connected, with the account; verify records it", () => {
    fs.writeFileSync(path.join(t, "login"), "");
    const v = run("integration", "verify", "demo");
    assert.equal(v.code, 0, v.err + v.out);
    const j = JSON.parse(run("integration", "status", "demo", "--json").out);
    assert.equal(j.state, "connected");
    assert.equal(j.account, "demo-user");
    assert.equal(j.last.action, "verify");
    assert.deepEqual(j.gates, []);
    // The exact top-level shape the portal relies on.
    assert.deepEqual(Object.keys(j), ["id", "title", "description", "category", "available", "enabled", "state", "account", "depends", "steps", "settings", "instructions", "skills", "default_roles", "revoke", "gates", "last", "checked_at"]);
    assert.deepEqual(Object.keys(j.settings), ["file", "saved", "schema", "values", "missing", "errors"]);
    assert.deepEqual(Object.keys(j.instructions), ["summary", "summary_file", "file", "rendered"]);
    assert.deepEqual(Object.keys(j.steps[0]), ["id", "title", "human", "state", "check", "instructions", "copy"]);
    assert.equal(j.instructions.summary, "Demo: repo acme/web, labels bug, feature.");
    const all = JSON.parse(run("integration", "status", "--json").out);
    assert.deepEqual(all.integrations.map((i) => i.id), ["demo", "soon"]);
    assert.ok(all.checked_at);
  });
  test("settings change re-renders; --get prints the effective value", () => {
    assert.equal(run("integration", "settings", "demo", "--set", "mode=full").code, 0);
    assert.match(fs.readFileSync(path.join(t, "team", "integrations", "demo.md"), "utf8"), /Full access\./);
    assert.equal(run("integration", "settings", "demo", "--get", "mode").out.trim(), "full");
    assert.equal(run("integration", "settings", "demo", "--get", "labels").out.trim(), "bug,feature");
    const j = JSON.parse(run("integration", "settings", "demo", "--json").out);
    assert.deepEqual(j.values, { repo: "acme/web", labels: ["bug", "feature"], mode: "full" });
    run("integration", "settings", "demo", "--unset", "labels");
    assert.equal(fs.readFileSync(path.join(t, "int", "demo.summary.md"), "utf8"), "Demo: repo acme/web.\n");
  });
  test("render re-renders the connected ones", () => {
    fs.rmSync(path.join(t, "team", "integrations", "demo.md"));
    const r = run("integration", "render");
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(t, "team", "integrations", "demo.md")));
  });
  test("disconnect removes the rendered files, runs disable.sh, keeps the settings, says how to revoke", () => {
    const r = run("integration", "disconnect", "demo");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /demo logout/);
    assert.ok(!fs.existsSync(path.join(t, "team", "integrations", "demo.md")));
    assert.ok(!fs.existsSync(path.join(t, "int", "demo.summary.md")));
    assert.ok(fs.existsSync(path.join(t, "disabled")));
    assert.ok(fs.existsSync(path.join(t, "int", "demo.yaml")));
    assert.match(fs.readFileSync(path.join(t, "config.yaml"), "utf8"), /demo: false/);
    assert.equal(JSON.parse(run("integration", "status", "demo", "--json").out).state, "disconnected");
    run("integration", "disconnect", "demo", "--forget");
    assert.ok(!fs.existsSync(path.join(t, "int", "demo.yaml")));
  });
  test("coming-soon entries can't be connected", () => {
    assert.match(run("integration", "connect", "soon").err, /coming soon/);
  });
});
