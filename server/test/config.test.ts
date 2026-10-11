/**
 * config.ts (docs/V2-ARCHITECTURE.md § 2) and the module feature flags. Part 1 is in-process
 * (parsing, defaults, validation, env overrides). Part 2 starts a real server on throwaway ports
 * with a temp config (mobile, voice, push and display off) and checks the routes 404 and the
 * gateway isn't listening. Touches nothing outside a temp folder:
 *
 *   node --disable-warning=ExperimentalWarning --import tsx test/config.test.ts
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromObject, loadConfig } from "../src/config.ts";

const results: { name: string; ok: boolean; note?: string }[] = [];
async function test(name: string, fn: () => unknown) {
  try { await fn(); results.push({ name, ok: true }); } catch (e: any) { results.push({ name, ok: false, note: e?.message ?? String(e) }); }
}
function ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-config-"));
const write = (name: string, text: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };

await test("no file: dev defaults (every module on, data in ./data)", () => {
  const c = loadConfig({ AGENTBOX_CONFIG: "" , HOME: "/x" } as any);
  // AGENTBOX_CONFIG empty → the default path, which doesn't exist on a dev machine.
  if (fs.existsSync("/etc/agentbox/config.yaml")) return; // on a real box: skip
  ok(c.source === "defaults", `source ${c.source}`);
  ok(Object.values(c.modules).every(Boolean), "all modules on");
  ok(c.paths.data === path.resolve("data"), `data ${c.paths.data}`);
  ok(c.ports.portal === 7700 && c.ports.gateway === 7710, "ports");
});

await test("file: contract defaults for missing keys; required modules forced on", () => {
  const c = fromObject({ modules: { core: false, voice: true } });
  ok(c.modules.core && c.modules.claude && c.modules.access, "required on");
  ok(c.modules.voice && c.modules.display && !c.modules.github && !c.modules.gitlab && !c.modules.slack && !c.modules.mobile, "module defaults (integrations off until connected)");
  ok(c.paths.data === "/opt/agentbox/data" && c.paths.agents === "/agents", "paths");
  ok(c.host === "cloud" && c.access === "tailscale" && c.user === "agentbox", "host/access/user");
});

await test("file: invalid values are refused", () => {
  for (const bad of [{ host: "aws" }, { access: "open" }, { ports: { portal: 0 } }, { paths: { work: "rel/path" } }, { modules: { voice: "yes" } }, { user: "Bad User" }, "text"]) {
    let threw = false;
    try { fromObject(bad); } catch { threw = true; }
    ok(threw, `accepted ${JSON.stringify(bad)}`);
  }
});

await test("AGENTBOX_CONFIG: read from the named file; env path overrides still win", () => {
  const f = write("a.yaml", "host: lima\nuser: dev\npaths: { work: /srv/work, data: /srv/data }\nports: { portal: 8700 }\nmodules: { mobile: true }\n");
  const c = loadConfig({ AGENTBOX_CONFIG: f, AGENTBOX_DATA: "/tmp/d" } as any);
  ok(c.source === f && c.host === "lima" && c.user === "dev", "file values");
  ok(c.paths.work === "/srv/work" && c.paths.data === "/tmp/d" && c.ports.portal === 8700, "merged");
  ok(c.modules.mobile, "mobile on");
});

await test("AGENTBOX_CONFIG: a missing named file is an error", () => {
  let threw = false;
  try { loadConfig({ AGENTBOX_CONFIG: path.join(tmp, "nope.yaml") } as any); } catch { threw = true; }
  ok(threw, "no error");
});

// --- part 2: a real server with modules off ------------------------------------------------------

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const portal = await freePort();
const gateway = await freePort();
const cfg = write("off.yaml", `host: cloud
access: ssh-tunnel
paths: { data: ${tmp}/data, agents: ${tmp}/agents, work: ${tmp}/work, skills: ${tmp}/skills, team: ${tmp}/team, secrets: ${tmp}/secrets }
ports: { portal: ${portal}, gateway: ${gateway} }
modules: { display: false, voice: false, mobile: false, push: false }
`);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, AGENTBOX_CONFIG: cfg };
for (const k of ["PORT", "AGENTBOX_MOBILE_PORT", "AGENTBOX_DATA", "AGENTBOX_AGENTS", "AGENTBOX_WORK", "AGENTBOX_SKILLS"]) delete env[k];
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${portal}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`${base}/api/config/public`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}

await test("server: GET /api/config/public reports the modules, host and access", async () => {
  ok(up, `server didn't start:\n${log.slice(-2000)}`);
  const j: any = await (await fetch(`${base}/api/config/public`)).json();
  ok(j.host === "cloud" && j.access === "ssh-tunnel", JSON.stringify(j));
  ok(j.modules.core && !j.modules.mobile && !j.modules.voice && !j.modules.push && !j.modules.display && !j.modules.github, JSON.stringify(j.modules));
  ok(!("paths" in j) && !("owner" in j), "no paths or owner");
});

await test("server: modules.<id> changes in the file are picked up without a restart", async () => {
  // What `agentbox integration connect github` does to the file (it never restarts the portal).
  fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace("modules: {", "modules: { github: true,"));
  await new Promise((r) => setTimeout(r, 1200)); // the re-read is throttled to once a second
  const j: any = await (await fetch(`${base}/api/config/public`)).json();
  ok(j.modules.github === true, JSON.stringify(j.modules));
});

await test("server: disabled modules' routes 404 (devices, voice, display)", async () => {
  const json = { "content-type": "application/json" };
  for (const [method, p] of [["GET", "/api/devices"], ["GET", "/api/devices/gateway"], ["POST", "/api/devices/pairings"], ["POST", "/api/voice/clean"], ["POST", "/api/voice/transcribe"], ["POST", "/api/display/take"]]) {
    const r = await fetch(`${base}${p}`, { method, headers: json, body: method === "POST" ? "{}" : undefined });
    ok(r.status === 404, `${method} ${p} → ${r.status}`);
  }
  const s: any = await (await fetch(`${base}/api/state`)).json();
  ok(s.display === null, "state.display should be null");
  const h: any = await (await fetch(`${base}/api/health`)).json();
  ok(!("agentbox-xvfb" in h.services) && h.browser.disabled, JSON.stringify(h));
});

await test("server: the gateway isn't listening", async () => {
  const open = await new Promise<boolean>((resolve) => {
    const s = net.connect(gateway, "127.0.0.1", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
  ok(!open, `something answers on the gateway port ${gateway}`);
});

child.kill();
fs.rmSync(tmp, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `  (${r.note})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
