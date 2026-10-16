/**
 * Hosting (hosting.ts): agents host a static folder or a command; the gateway serves it at /<name>/.
 * In-process against a throwaway database and a real gateway on a spare port. Agents stay paused.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/hosting.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-hosting-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const APPS = 20000 + Math.floor(Math.random() * 20000);
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\nports: { apps: ${APPS} }\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\n`);
Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", NO_COLOR: "1",
});

const { setPaused } = await import("../src/control.ts");
setPaused(true);
const A = await import("../src/agents.ts");
const W = await import("../src/work.ts");
const TM = await import("../src/team.ts");
const H = await import("../src/hosting.ts");
const gateway = await H.startHosting({ log: () => {} });
after(async () => {
  for (const s of H.running()) await H.stopService(s, "test over");
  await gateway.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mk = (name: string, extra: any = {}) => A.getAgent(A.createAgent({ name, title: name, summary: name, model: "sonnet", instructions: `# ${name}\n`, interview: {}, ...extra }).id)!;
const leadRole = mk("robotics-lead", { can_scale: true });
const ctlRole = mk("controls");
const lead = A.spawnInstance(leadRole.id, { label: "Arm", createdBy: "owner" });
const helper = A.spawnInstance(ctlRole.id, { label: "Dashboard", createdBy: lead.id, parentInstanceId: lead.id });
const other = A.spawnInstance(ctlRole.id, { label: "Other work", createdBy: "owner" });

const call = async (agent: any, name: string, args: any) => {
  const t = TM.teamTools(agent, "t-" + agent.id).find((x: any) => x.name === name)!;
  const r: any = await (t as any).handler(args, {});
  return { text: r.content.map((c: any) => c.text).join("\n"), error: !!r.isError };
};
const get = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
  http.get({ host: "127.0.0.1", port: APPS, path: p, headers: { host: `localhost:${APPS}`, ...headers } }, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
  }).on("error", reject);
});

const site = path.join(dirs.work, "site");
fs.mkdirSync(path.join(site, "sub"), { recursive: true });
fs.writeFileSync(path.join(site, "index.html"), "<h1>dash</h1>");
fs.writeFileSync(path.join(site, "app.js"), "console.log(1)");
fs.writeFileSync(path.join(site, "sub", "index.html"), "sub page");
fs.writeFileSync(path.join(dirs.work, "secret.txt"), "nope");
// An echo server: replies with what it received (path, cookie, host) as JSON.
const echo = path.join(dirs.work, "echo");
fs.mkdirSync(echo);
fs.writeFileSync(path.join(echo, "server.js"), `require("http").createServer((q, s) => {
  if (q.url === "/go") { s.writeHead(302, { location: "/landed" }); return s.end(); }
  s.setHeader("content-type", "application/json");
  s.end(JSON.stringify({ url: q.url, cookie: q.headers.cookie || null, host: q.headers.host, prefix: q.headers["x-forwarded-prefix"], env: { base: process.env.BASE_PATH, secret: process.env.AGENTBOX_TEST_SECRET || null } }));
}).listen(Number(process.env.PORT), "127.0.0.1");`);
process.env.AGENTBOX_TEST_SECRET = "s3cret"; // the portal's own env must not reach services

test("a static folder is served at /<name>/ with index, sub-folders and a SPA fallback", async () => {
  const r = await call(helper, "host_start", { name: "arm-dash", dir: site });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, new RegExp(`http://localhost:${APPS}/arm-dash/`));
  assert.equal((await get("/arm-dash")).status, 302);
  assert.equal((await get("/arm-dash/")).body, "<h1>dash</h1>");
  assert.equal((await get("/arm-dash/app.js")).body, "console.log(1)");
  assert.equal((await get("/arm-dash/sub/")).body, "sub page");
  assert.equal((await get("/arm-dash/some/route")).body, "<h1>dash</h1>", "SPA fallback");
  // Nothing outside the folder.
  assert.equal((await get("/arm-dash/../secret.txt")).status, 404);
  assert.equal((await get("/arm-dash/%2e%2e/secret.txt")).status, 404);
  assert.equal((await get("/arm-dash/missing.js")).status, 404);
  // Absolute asset paths are routed by the page they came from.
  assert.equal((await get("/app.js", { referer: `http://localhost:${APPS}/arm-dash/` })).body, "console.log(1)");
  assert.match((await get("/")).body, /arm-dash/);
});

test("a command gets $PORT, a clean environment, the prefix stripped, and no portal cookie", async () => {
  const r = await call(helper, "host_start", { name: "echo", dir: echo, command: "node server.js" });
  assert.equal(r.error, false, r.text);
  const res = await get("/echo/api/x?y=1", { cookie: "__Host-agentbox_session=abc; theme=dark" });
  const j = JSON.parse(res.body);
  assert.equal(j.url, "/api/x?y=1");
  assert.equal(j.cookie, "theme=dark");
  assert.equal(j.prefix, "/echo");
  assert.equal(j.env.base, "/echo/");
  assert.equal(j.env.secret, null);
  assert.match(j.host, /^127\.0\.0\.1:\d+$/);
  // Redirects stay inside the service's path.
  assert.equal((await get("/echo/go")).headers.location, "/echo/landed");
});

test("the gateway refuses other hosts (DNS rebinding) in ssh-tunnel mode", async () => {
  assert.equal((await get("/arm-dash/", { host: "evil.example" })).status, 403);
});

test("a failed start reports the output and leaves nothing running", async () => {
  const r = await call(helper, "host_start", { name: "broken", dir: echo, command: "echo boom-output; exit 3" });
  assert.equal(r.error, true);
  assert.match(r.text, /exited/);
  assert.match(r.text, /boom-output/);
  assert.equal(H.serviceByName("broken"), undefined);
});

test("bad input is refused", async () => {
  assert.equal((await call(helper, "host_start", { name: "Bad Name", dir: site })).error, true);
  assert.equal((await call(helper, "host_start", { name: "x", dir: "/etc" })).error, true);
  assert.equal((await call(helper, "host_start", { name: "x", dir: path.join(site, "index.html") })).error, true);
});

test("control: the starter and the lead may stop; other work may not take or stop the name", async () => {
  const taken = await call(other, "host_start", { name: "arm-dash", dir: site });
  assert.equal(taken.error, true);
  assert.match(taken.text, /already in use/);
  assert.equal((await call(other, "host_stop", { name: "arm-dash" })).error, true);
  // Lead lists and stops a helper's service.
  assert.match((await call(lead, "host_list", {})).text, /arm-dash: running/);
  assert.equal((await call(lead, "host_stop", { name: "arm-dash" })).error, false);
  assert.equal((await get("/arm-dash/")).status, 404);
  // Restarting under the same name (by the same task) replaces it.
  assert.equal((await call(helper, "host_start", { name: "arm-dash", dir: site })).error, false);
  assert.equal((await call(helper, "host_start", { name: "arm-dash", dir: site })).error, false);
  assert.equal(H.running().filter((s) => s.name === "arm-dash").length, 1);
});

test("a helper finishing keeps the services; the work marked done stops them all", async () => {
  A.retireReplica(helper.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(H.serviceByName("echo")?.status, "running");
  const pid = H.serviceByName("echo")!.pid!;
  W.finishTree(lead.id);
  for (let i = 0; i < 50 && H.running().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(H.running().length, 0);
  assert.throws(() => process.kill(pid, 0), "the process is gone");
  assert.match((await call(lead, "host_list", {})).text, /work was marked done/);
});
