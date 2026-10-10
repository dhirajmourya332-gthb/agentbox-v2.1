#!/usr/bin/env node
// The agentbox command (docs/V2-ARCHITECTURE.md § 4). Installed by setup/bootstrap.sh as
// /usr/local/bin/agentbox → /opt/agentbox/cli/agentbox.mjs. Commands that change the system
// re-run themselves through sudo; reads (status, config get, module check) don't need root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, parseDocument, stringify } from "yaml";

const SELF = fileURLToPath(import.meta.url);
const CONFIG = process.env.AGENTBOX_CONFIG || "/etc/agentbox/config.yaml";
const REQUIRED = ["core", "claude", "access"];
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), yellow = (s) => c(33, s), dim = (s) => c(2, s), bold = (s) => c(1, s);

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };

// --- config ---------------------------------------------------------------------------------------

function readDoc() {
  let text;
  try { text = fs.readFileSync(CONFIG, "utf8"); } catch (e) {
    fail(`cannot read ${CONFIG} (${e.code ?? e}). Run setup/bootstrap.sh first, or set AGENTBOX_CONFIG.`);
  }
  const doc = parseDocument(text);
  if (doc.errors.length) fail(`${CONFIG}: ${doc.errors[0].message}`);
  return doc;
}
const cfg = () => readDoc().toJS() ?? {};
const keyPath = (key) => {
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(key)) fail(`bad key: ${key}`);
  return key.split(".");
};
function getIn(obj, parts) {
  let v = obj;
  for (const p of parts) {
    if (v === null || typeof v !== "object" || !(p in v)) return undefined;
    v = v[p];
  }
  return v;
}

/** Light validation for `config set`; the server re-validates everything at start. */
function validate(parts, value) {
  const [top, sub] = parts;
  const want = (ok, msg) => { if (!ok) fail(`${parts.join(".")}: ${msg}`); };
  if (top === "host") want(["cloud", "lima"].includes(value), "cloud or lima");
  else if (top === "access") want(["tailscale", "cloudflare", "ssh-tunnel"].includes(value), "tailscale, cloudflare or ssh-tunnel");
  else if (top === "user") want(typeof value === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(value), "a unix user name");
  else if (top === "agent_sudo" || top === "docker") want(typeof value === "boolean", "true or false");
  else if (top === "paths") want(typeof value === "string" && path.isAbsolute(value), "an absolute path");
  else if (top === "ports" || (top === "mobile" && sub === "serve_port")) want(Number.isInteger(value) && value > 0 && value < 65536, "a TCP port");
  else if (top === "modules") {
    want(typeof value === "boolean", "true or false");
    want(!(REQUIRED.includes(sub) && value === false), "this module is always on");
  }
}

function writeDoc(doc) {
  const tmp = `${CONFIG}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(doc), { mode: 0o644 });
  fs.renameSync(tmp, CONFIG);
}

function setValue(key, raw) {
  const parts = keyPath(key);
  let value = raw === "" ? "" : parse(raw);
  if (value === null || value === undefined) value = "";
  if (typeof value === "object") fail("set one value at a time (a scalar)");
  validate(parts, value);
  const doc = readDoc();
  doc.setIn(parts, value);
  writeDoc(doc);
}

function printValue(v) {
  if (v === undefined) return false;
  if (v !== null && typeof v === "object") process.stdout.write(stringify(v));
  else console.log(v === null ? "" : String(v));
  return true;
}

// --- privileges and helpers ----------------------------------------------------------------------

const isRoot = () => process.getuid?.() === 0;
/** Re-run this command as root (keeping the config and source locations). */
function asRoot(args) {
  if (isRoot()) return;
  const env = [`AGENTBOX_CONFIG=${CONFIG}`];
  if (process.env.AGENTBOX_SRC) env.push(`AGENTBOX_SRC=${process.env.AGENTBOX_SRC}`);
  const r = spawnSync("sudo", ["env", ...env, process.execPath, SELF, ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const agentUser = (conf) => conf.user || "agentbox";
function homeOf(user) {
  const r = spawnSync("getent", ["passwd", user], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(":")[5] : `/home/${user}`;
}
function srcDir(conf) {
  const s = process.env.AGENTBOX_SRC || conf.paths?.src;
  if (!s || !fs.existsSync(path.join(s, "setup", "modules"))) fail(`the agentbox source isn't at ${s} (paths.src in ${CONFIG})`);
  return s;
}
const has = (cmd) => spawnSync("bash", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const systemd = () => has("systemctl") && fs.existsSync("/run/systemd/system");
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
}
function systemctl(...args) {
  if (!systemd()) { console.log(dim(`  (no systemd here: skipped systemctl ${args.join(" ")})`)); return; }
  sh("systemctl", args);
}

/** Run a read-only check as the agent user: bash -lc, 10 s timeout. True when it exits 0. */
function runCheck(conf, check) {
  const user = agentUser(conf);
  const me = os.userInfo().username;
  const [cmd, args] = me === user ? ["bash", ["-lc", check]] : ["sudo", ["-n", "-H", "-u", user, "--", "bash", "-lc", check]];
  const r = spawnSync("timeout", ["10", cmd, ...args], { stdio: "ignore" });
  return r.status === 0;
}

// --- modules ---------------------------------------------------------------------------------------

function modulesDir(conf) { return path.join(srcDir(conf), "setup", "modules"); }
function loadModule(conf, id) {
  if (!/^[a-z0-9-]+$/.test(id)) fail(`bad module id: ${id}`);
  const dir = path.join(modulesDir(conf), id);
  const file = path.join(dir, "module.yaml");
  if (!fs.existsSync(file)) fail(`no such module: ${id} (${file})`);
  const m = parse(fs.readFileSync(file, "utf8"));
  return { ...m, dir, depends: m.depends ?? [], steps: m.steps ?? [], units: m.units ?? [] };
}
function allModules(conf) {
  return fs.readdirSync(modulesDir(conf), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(modulesDir(conf), d.name, "module.yaml")))
    .map((d) => loadModule(conf, d.name));
}
const isEnabled = (conf, id) => REQUIRED.includes(id) || conf.modules?.[id] === true;

/** Dependency order (depends first). */
function ordered(conf, ids) {
  const out = [];
  const seen = new Set();
  const visit = (id, chain = []) => {
    if (seen.has(id)) return;
    if (chain.includes(id)) fail(`dependency cycle: ${[...chain, id].join(" → ")}`);
    let m;
    try { m = loadModule(conf, id); } catch (e) { if (id === "access") return; throw e; } // access: its own workstream
    for (const d of m.depends) visit(d, [...chain, id]);
    seen.add(id);
    out.push(m);
  };
  for (const id of ids) visit(id);
  return out;
}

function scriptEnv(conf, m) {
  const user = agentUser(conf);
  return {
    ...process.env,
    PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    DEBIAN_FRONTEND: "noninteractive",
    AGENTBOX_CONFIG: CONFIG,
    AGENTBOX_SRC: srcDir(conf),
    AGENTBOX_MODULE: m.id,
    AGENTBOX_MODULE_DIR: m.dir,
    AGENTBOX_USER: user,
    AGENTBOX_HOME: homeOf(user),
  };
}
function runScript(conf, m, name) {
  const file = path.join(m.dir, name);
  if (!fs.existsSync(file)) return false;
  console.log(bold(`==> ${m.id}: ${name}`));
  sh("bash", [file], { cwd: m.dir, env: scriptEnv(conf, m) });
  return true;
}

/** Fill @PLACEHOLDERS@ in a unit file from the config. */
function renderUnit(conf, text) {
  const user = agentUser(conf);
  const p = conf.paths ?? {}, ports = conf.ports ?? {};
  const vars = {
    USER: user, HOME: homeOf(user), APP: p.app, DATA: p.data, SRC: srcDir(conf), SECRETS: p.secrets, WORK: p.work,
    PORTAL_PORT: ports.portal, SCREEN_PORT: ports.screen, TERMINAL_PORT: ports.terminal, GATEWAY_PORT: ports.gateway,
    GUIDE_PORT: ports.guide, CONFIG,
  };
  return text.replace(/@([A-Z_]+)@/g, (all, k) => {
    if (vars[k] === undefined || vars[k] === null) fail(`unit placeholder ${all} has no value (check ${CONFIG})`);
    return String(vars[k]);
  });
}

/** Install every file under units/ (drop-in dirs included) into /etc/systemd/system. */
function installUnits(conf, m) {
  const dir = path.join(m.dir, "units");
  if (!fs.existsSync(dir)) return;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { walk(r); continue; }
      const dest = path.join("/etc/systemd/system", r);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, renderUnit(conf, fs.readFileSync(path.join(dir, r), "utf8")), { mode: 0o644 });
      console.log(dim(`  unit ${dest}`));
    }
  };
  walk("");
  systemctl("daemon-reload");
}
function removeUnits(m) {
  const dir = path.join(m.dir, "units");
  if (!fs.existsSync(dir)) return;
  if (m.units.length) {
    if (systemd()) spawnSync("systemctl", ["disable", "--now", ...m.units], { stdio: "inherit" });
  }
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { walk(r); continue; }
      fs.rmSync(path.join("/etc/systemd/system", r), { force: true });
    }
  };
  walk("");
  if (systemd()) spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
}

/** Copy team-rule examples to /team (never overwriting the owner's edits). */
function copyTeam(conf, m) {
  const dir = path.join(m.dir, "team");
  if (!fs.existsSync(dir)) return;
  const team = conf.paths?.team ?? "/team";
  const user = agentUser(conf);
  fs.mkdirSync(team, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    const dest = path.join(team, f);
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(path.join(dir, f), dest);
    spawnSync("chown", [`${user}:${user}`, dest]);
    console.log(dim(`  team rule example ${dest} (edit it to fit your team)`));
  }
}

function installModule(conf, m) {
  console.log(bold(`\n### ${m.id}: ${m.title ?? ""}`));
  runScript(conf, m, "install.sh");
  installUnits(conf, m);
  runScript(conf, m, "configure.sh");
  copyTeam(conf, m);
  if (m.units.length) {
    systemctl("enable", ...m.units);
    systemctl("restart", ...m.units);
  }
  const pending = m.steps.filter((s) => s.human && s.check && !runCheck(conf, s.check));
  for (const s of pending) {
    console.log(yellow(`  YOUR TURN: ${s.title}`));
    for (const line of String(s.instructions ?? "").trim().split("\n")) console.log(`    ${line}`);
  }
  return pending.length;
}

function stepStates(conf, m) {
  return m.steps.map((s) => {
    if (!s.check) return { ...s, state: "-" };
    const okNow = runCheck(conf, s.check);
    return { ...s, state: okNow ? "ok" : s.human ? "you" : "fail" };
  });
}

// --- the portal ------------------------------------------------------------------------------------

async function busyCount(conf) {
  const port = conf.ports?.portal ?? 7700;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { n: 0, known: false };
    const tasks = await r.json();
    return { n: tasks.filter((t) => t.status === "running" || t.status === "queued").length, known: true };
  } catch { return { n: 0, known: false }; }
}
async function refuseIfBusy(conf, force, what) {
  if (force) return;
  const { n, known } = await busyCount(conf);
  if (n > 0) fail(`${n} agent task(s) running or queued; ${what} would interrupt them. Wait, use Pause all, or rerun with --force.`);
  if (!known) console.log(dim("  (couldn't ask the portal whether agents are busy; it may be stopped)"));
}

/** Units of every enabled module, core's web service last on start (first on stop). */
function enabledUnits(conf) {
  const mods = ordered(conf, Object.keys({ ...Object.fromEntries(REQUIRED.map((id) => [id, true])), ...(conf.modules ?? {}) }).filter((id) => isEnabled(conf, id)));
  const units = mods.flatMap((m) => m.units);
  return [...units.filter((u) => u !== "agentbox-web.service"), ...units.filter((u) => u === "agentbox-web.service")];
}

// --- commands ----------------------------------------------------------------------------------------

const USAGE = `usage: agentbox <command>
  status [--json]                      modules (checks), services, listeners
  config get [<key>]                   e.g. agentbox config get paths.secrets
  config set <key> <value>             e.g. agentbox config set modules.voice true (root)
  module list
  module check <id>                    run the module's checks (read-only)
  module install <id>... | --enabled   install.sh, units, configure.sh, team examples (root)
  module enable <id>                   turn on (and its dependencies), install, restart the portal
  module disable <id>                  turn off, remove its units, restart the portal
  module verify <id>                   verify.sh and every check
  secret set <name>                    stdin → <secrets>/<name>, 0600, owned by the agent user
  update [--force]                     pull (cloud) or sync (lima), build, restart
  start | stop [--force] | restart [--force]
  selftest                             the security self-test
  guide                                the setup guide`;

async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case undefined: case "help": case "-h": case "--help":
      console.log(USAGE); return 0;

    case "config": {
      if (sub === "get") {
        const conf = cfg();
        if (!rest[0]) { process.stdout.write(stringify(conf)); return 0; }
        return printValue(getIn(conf, keyPath(rest[0]))) ? 0 : 1;
      }
      if (sub === "set") {
        if (rest.length !== 2) fail("usage: agentbox config set <key> <value>");
        asRoot(argv);
        setValue(rest[0], rest[1]);
        console.log(`${rest[0]} = ${rest[1]}  (restart to apply: agentbox restart)`);
        return 0;
      }
      fail("usage: agentbox config get|set <key> [value]");
    }

    case "module": {
      const conf = cfg();
      if (sub === "list") {
        for (const m of allModules(conf)) {
          const on = isEnabled(conf, m.id);
          console.log(`${on ? green("on ") : dim("off")}  ${m.id.padEnd(12)} ${m.title ?? ""}${m.depends.length ? dim(`  (needs ${m.depends.join(", ")})`) : ""}`);
        }
        return 0;
      }
      if (sub === "check") {
        const m = loadModule(conf, rest[0] ?? fail("usage: agentbox module check <id>"));
        let bad = 0;
        for (const s of stepStates(conf, m)) {
          if (s.state === "-") continue;
          if (s.state !== "ok") bad++;
          console.log(`${s.state === "ok" ? green("✔") : s.state === "you" ? yellow("⏸") : red("✖")} ${s.id.padEnd(12)} ${s.title}`);
        }
        return bad ? 1 : 0;
      }
      if (sub === "install") {
        asRoot(argv);
        const ids = rest.includes("--enabled")
          ? allModules(conf).map((m) => m.id).filter((id) => isEnabled(conf, id))
          : rest;
        if (!ids.length) fail("usage: agentbox module install <id>... | --enabled");
        let waiting = 0;
        // With explicit ids, only those (dependencies must already be installed).
        const mods = rest.includes("--enabled") ? ordered(conf, ids) : ids.map((id) => loadModule(conf, id));
        for (const m of mods) waiting += installModule(conf, m);
        console.log(waiting ? yellow(`\n${waiting} step(s) wait for you (above).`) : green("\ndone"));
        return 0;
      }
      if (sub === "enable") {
        asRoot(argv);
        const id = rest[0] ?? fail("usage: agentbox module enable <id>");
        const mods = ordered(conf, [id]);
        const fresh = new Set();
        for (const m of mods) {
          if (!isEnabled(conf, m.id)) { setValue(`modules.${m.id}`, "true"); fresh.add(m.id); console.log(`modules.${m.id} = true`); }
        }
        const conf2 = cfg();
        // The module itself (re-run if already on) and any dependency that was off until now.
        for (const m of mods) if (m.id === id || fresh.has(m.id)) installModule(conf2, m);
        restartPortalIfUp();
        return 0;
      }
      if (sub === "disable") {
        asRoot(argv);
        const id = rest[0] ?? fail("usage: agentbox module disable <id>");
        if (REQUIRED.includes(id)) fail(`${id} is always on`);
        const m = loadModule(conf, id);
        const users = allModules(conf).filter((x) => x.id !== id && isEnabled(conf, x.id) && x.depends.includes(id));
        if (users.length) fail(`${users.map((x) => x.id).join(", ")} need(s) ${id}; disable those first`);
        runScript(conf, m, "disable.sh");
        removeUnits(m);
        setValue(`modules.${id}`, "false");
        console.log(`modules.${id} = false  (packages stay installed; units removed)`);
        restartPortalIfUp();
        return 0;
      }
      if (sub === "verify") {
        const m = loadModule(conf, rest[0] ?? fail("usage: agentbox module verify <id>"));
        if (fs.existsSync(path.join(m.dir, "verify.sh"))) {
          console.log(bold(`==> ${m.id}: verify.sh`));
          const user = agentUser(conf);
          const env = scriptEnv(conf, m);
          // verify.sh runs as the agent user, like the checks; it may sudo for root-only reads.
          const me = os.userInfo().username;
          const r = me === user
            ? spawnSync("bash", [path.join(m.dir, "verify.sh")], { stdio: "inherit", env, cwd: m.dir })
            : spawnSync("sudo", ["-H", "-u", user, "env", ...Object.entries(env).filter(([k]) => k.startsWith("AGENTBOX_") || k === "PATH").map(([k, v]) => `${k}=${v}`), "bash", path.join(m.dir, "verify.sh")], { stdio: "inherit", cwd: m.dir });
          if (r.status !== 0) { console.log(red(`✖ ${m.id}: verify.sh failed`)); return 1; }
        }
        return main(["module", "check", m.id]);
      }
      fail("usage: agentbox module list|check|install|enable|disable|verify <id>");
    }

    case "secret": {
      if (sub !== "set" || !rest[0]) fail("usage: agentbox secret set <name>   (reads the value from stdin)");
      const name = rest[0];
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) || name.split("/").some((p) => p === "." || p === "..")) fail(`bad secret name: ${name}`);
      const conf = cfg();
      const user = agentUser(conf);
      const me = os.userInfo().username;
      if (!isRoot() && me !== user) asRoot(argv); // stdin is inherited through sudo
      if (process.stdin.isTTY) process.stderr.write(`Paste the value for ${name}, then press Ctrl-D:\n`);
      const value = fs.readFileSync(0);
      if (!value.length) fail("nothing on stdin; nothing saved");
      const root = conf.paths?.secrets ?? "/secrets";
      const file = path.join(root, name);
      if (!file.startsWith(root + path.sep)) fail("bad secret name");
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, value, { mode: 0o600 });
      fs.renameSync(tmp, file);
      if (isRoot()) {
        // Every directory from the secrets root down to the file belongs to the agent user, 0700.
        let d = path.dirname(file);
        const dirs = [];
        while (d.startsWith(root)) { dirs.push(d); if (d === root) break; d = path.dirname(d); }
        for (const x of dirs) { spawnSync("chown", [`${user}:${user}`, x]); fs.chmodSync(x, 0o700); }
        spawnSync("chown", [`${user}:${user}`, file]);
      }
      fs.chmodSync(file, 0o600);
      console.log(`saved ${file} (${value.length} bytes, 0600)`);
      return 0;
    }

    case "update": {
      asRoot(argv);
      const conf = cfg();
      await refuseIfBusy(conf, argv.includes("--force"), "an update restarts the portal and");
      const src = srcDir(conf);
      const env = { ...process.env, AGENTBOX_CONFIG: CONFIG, AGENTBOX_SRC: src, AGENTBOX_USER: agentUser(conf) };
      const script = conf.host === "cloud" ? path.join(src, "host", "cloud", "deploy.sh") : path.join(src, "setup", "lib", "deploy-app.sh");
      sh("bash", [script], { env });
      return 0;
    }

    case "start": case "stop": case "restart": {
      asRoot(argv);
      const conf = cfg();
      if (cmd !== "start") await refuseIfBusy(conf, argv.includes("--force"), `${cmd === "stop" ? "stopping" : "restarting"}`);
      const units = enabledUnits(conf);
      if (cmd === "stop") systemctl("stop", ...units.slice().reverse());
      else systemctl(cmd, ...units);
      console.log(`${cmd}: ${units.join(" ")}`);
      return 0;
    }

    case "status": return status(argv.includes("--json"));

    case "selftest": {
      asRoot(argv);
      const conf = cfg();
      const r = spawnSync("bash", [path.join(srcDir(conf), "setup", "selftest.sh")], {
        stdio: "inherit", env: { ...process.env, AGENTBOX_CONFIG: CONFIG, AGENTBOX_SRC: srcDir(conf) },
      });
      return r.status ?? 1;
    }

    case "guide": {
      const conf = cfg();
      const hook = path.join(srcDir(conf), "guide", "agentbox-guide.sh");
      if (fs.existsSync(hook)) {
        const r = spawnSync("bash", [hook, ...argv.slice(1)], { stdio: "inherit", env: { ...process.env, AGENTBOX_CONFIG: CONFIG } });
        return r.status ?? 1;
      }
      console.log("agentbox guide: the guide workstream provides this (guide/agentbox-guide.sh).");
      console.log("Meanwhile: agentbox module list · sudo agentbox module install --enabled · agentbox status");
      return 0;
    }
  }
  fail(`unknown command: ${cmd}\n${USAGE}`);
}

function restartPortalIfUp() {
  if (!systemd()) return;
  if (spawnSync("systemctl", ["is-active", "--quiet", "agentbox-web"]).status === 0) {
    console.log("restarting the portal so it picks up the module change");
    spawnSync("systemctl", ["restart", "agentbox-web"], { stdio: "inherit" });
  }
}

function status(json) {
  const conf = cfg();
  const mods = allModules(conf).map((m) => {
    const on = isEnabled(conf, m.id);
    return { id: m.id, title: m.title, enabled: on, steps: on ? stepStates(conf, m).map((s) => ({ id: s.id, title: s.title, state: s.state, human: !!s.human })) : [] };
  });
  const units = enabledUnits(conf).map((u) => {
    const r = spawnSync("systemctl", ["is-active", u], { encoding: "utf8" });
    return { unit: u, state: (r.stdout ?? "").trim() || "unknown" };
  });
  const ss = spawnSync("ss", ["-Hltn"], { encoding: "utf8" });
  const listeners = (ss.stdout ?? "").split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/)[3]).filter(Boolean)
    .map((addr) => ({ addr, loopback: /^(127\.[\d.]+|\[::1\]):\d+$/.test(addr) }));
  if (json) { console.log(JSON.stringify({ host: conf.host, access: conf.access, modules: mods, units, listeners }, null, 2)); return 0; }
  console.log(bold(`agentbox · host ${conf.host} · access ${conf.access} · user ${agentUser(conf)}`));
  console.log(bold("\nmodules"));
  for (const m of mods) {
    if (!m.enabled) { console.log(dim(`  ─ ${m.id.padEnd(12)} off`)); continue; }
    const bad = m.steps.filter((s) => s.state === "fail").length, you = m.steps.filter((s) => s.state === "you").length;
    const mark = bad ? red("✖") : you ? yellow("⏸") : green("✔");
    const note = [...m.steps.filter((s) => s.state === "fail").map((s) => red(s.title)), ...m.steps.filter((s) => s.state === "you").map((s) => yellow(`your turn: ${s.title}`))].join(" · ");
    console.log(`  ${mark} ${m.id.padEnd(12)} ${note}`);
  }
  console.log(bold("\nservices"));
  for (const u of units) console.log(`  ${u.state === "active" ? green("●") : red("●")} ${u.unit.padEnd(40)} ${u.state}`);
  console.log(bold("\nlisteners (TCP)"));
  for (const l of listeners) console.log(`  ${l.loopback ? green("loopback") : yellow("NOT loopback")}  ${l.addr}`);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0), (e) => {
  if (e instanceof Fail) { console.error(`agentbox: ${e.message}`); process.exit(1); }
  console.error(e);
  process.exit(1);
});
