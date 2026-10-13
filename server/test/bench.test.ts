/**
 * The device bridge (bench.ts), in-process against a throwaway config: off → 404; a bridge with the
 * wrong token is refused ("token"), with the module off it's told to wait ("off"); a bridge's devices
 * become 127.0.0.1 ports whose bytes (all 256 values) relay both ways; the installer carries the
 * portal and token; turning the module off drops the bridge without a restart. The fake bridge here
 * echoes raw bytes (the real one runs RFC 2217 next to the port; that's covered by its own run).
 *
 *   node --disable-warning=ExperimentalWarning --import tsx test/bench.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-bench-")));
for (const d of ["data", "secrets", "integrations"]) fs.mkdirSync(path.join(tmp, d));
const configFile = path.join(tmp, "config.yaml");
const writeConfig = (on: boolean) => fs.writeFileSync(configFile,
  `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { src: ${path.resolve(import.meta.dirname, "../..")}, data: ${tmp}/data, secrets: ${tmp}/secrets, integrations: ${tmp}/integrations }\nports: { bench: 7871 }\nmodules: { bench: ${on} }\n`);
writeConfig(false);
Object.assign(process.env, { AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: `${tmp}/data`, AGENTBOX_SECRETS: `${tmp}/secrets`, AGENTBOX_INTEGRATIONS: `${tmp}/integrations` });

const { default: Fastify } = await import("fastify");
const { default: fastifyWebsocket } = await import("@fastify/websocket");
const { default: WebSocket } = await import("ws");
const { registerBench } = await import("../src/bench.ts");

const app = Fastify();
await app.register(fastifyWebsocket);
registerBench(app);
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const TOKEN = "t".repeat(40);
const get = (p: string) => fetch(`http://${base}${p}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake bridge: says hello, shares `devices`, and echoes every channel's bytes. */
function fakeBridge(token: string, devices: string[]) {
  const ws = new WebSocket(`ws://${base}/api/bench/connect`, { headers: { "x-agentbox-bench-token": token } });
  const seen: any[] = [];
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", version: 1, host: "bench-test", os: "test", capabilities: { serial: true } })));
  ws.on("message", (raw: Buffer, binary: boolean) => {
    if (binary) return ws.send(raw); // echo: same channel header, same bytes
    const m = JSON.parse(raw.toString());
    seen.push(m);
    if (m.type === "welcome") ws.send(JSON.stringify({ type: "devices", devices: devices.map((id) => ({ id, kind: "serial", path: "x", description: id, manufacturer: "", vid: "", pid: "", serial_number: "" })) }));
    if (m.type === "open") ws.send(JSON.stringify({ type: "opened", channel: m.channel }));
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", nonce: m.nonce }));
  });
  return { ws, seen, closed: new Promise<void>((r) => ws.on("close", () => r())) };
}

test("off: every bench route is a 404, and a bridge is told to wait", async () => {
  assert.equal((await get("/api/bench/status")).status, 404);
  assert.equal((await get("/api/bench/install.sh")).status, 404);
  const b = fakeBridge(TOKEN, []);
  await b.closed;
  assert.equal(b.seen[0]?.type, "refused");
  assert.equal(b.seen[0]?.reason, "off");
});

test("on: a wrong token is refused for good; the installer carries the portal and the token", async () => {
  writeConfig(true);
  await wait(1100); // the portal re-reads module switches at most once a second
  fs.writeFileSync(path.join(tmp, "secrets", "bench.token"), TOKEN, { mode: 0o600 });
  const b = fakeBridge("wrong", []);
  await b.closed;
  assert.equal(b.seen[0]?.reason, "token");
  const inst = await (await get("/api/bench/install.sh")).text();
  assert.match(inst, new RegExp(`"portal": "http://${base}"`));
  assert.ok(inst.includes(TOKEN));
  assert.match(await (await get("/api/bench/bridge.py")).text(), /agentbox bench bridge/);
});

test("devices become local ports; bytes relay both ways; status and test report them", async () => {
  const b = fakeBridge(TOKEN, ["loopback", "usbserial-0001"]);
  for (let i = 0; i < 50 && !(await (await get("/api/bench/status")).json() as any).devices?.length; i++) await wait(50);
  const st = await (await get("/api/bench/status")).json() as any;
  assert.equal(st.connected, true);
  assert.equal(st.bridge.host, "bench-test");
  assert.deepEqual(st.devices.map((d: any) => d.id).sort(), ["loopback", "usbserial-0001"]);
  const dev = st.devices.find((d: any) => d.id === "usbserial-0001");
  assert.match(dev.url, /^rfc2217:\/\/127\.0\.0\.1:78\d\d$/);

  const payload = Buffer.from([...Array(256).keys()]);
  const got = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const s = net.connect(dev.port, "127.0.0.1", () => s.write(payload));
    s.on("data", (d) => { chunks.push(d); if (Buffer.concat(chunks).length >= 256) { s.destroy(); resolve(Buffer.concat(chunks)); } });
    s.on("error", reject);
  });
  assert.deepEqual(got, payload);

  const r = await (await fetch(`http://${base}/api/bench/test`, { method: "POST" })).json() as any;
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.ok(r.steps.find((s: any) => s.name === "serial relay").detail.includes("echoed"));
  b.ws.close();
  await b.closed;
});

test("a device keeps its port across reconnects", async () => {
  const first = fakeBridge(TOKEN, ["usbserial-0001"]);
  for (let i = 0; i < 50 && !(await (await get("/api/bench/status")).json() as any).devices?.length; i++) await wait(50);
  const p1 = ((await (await get("/api/bench/status")).json()) as any).devices[0].port;
  first.ws.close();
  await first.closed;
  const second = fakeBridge(TOKEN, ["usbserial-0001"]);
  for (let i = 0; i < 50 && !(await (await get("/api/bench/status")).json() as any).devices?.length; i++) await wait(50);
  assert.equal(((await (await get("/api/bench/status")).json()) as any).devices[0].port, p1);
  second.ws.close();
  await second.closed;
});
