/**
 * Hosting gateway sign-in in tailscale mode (hosting.ts gatewayRefusal): owner only, via tailscale serve.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/hosting-tailscale.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-hosting-ts-")));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: cloud\naccess: tailscale\nuser: ${os.userInfo().username}\ntailscale: { hostname: node.tail1.ts.net }\nowner: { tailscale_login: Owner@Example.com }\npaths: { data: ${tmp} }\n`);
Object.assign(process.env, { AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: tmp, AGENTBOX_CLI: "/nonexistent/agentbox" });
const H = await import("../src/hosting.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const req = (host: string, peer: string, login?: string) => ({
  headers: { host, ...(login === undefined ? {} : { "tailscale-user-login": login }) }, socket: { remoteAddress: peer },
});

test("owner through tailscale serve: allowed on the hosting port", () => {
  assert.equal(H.gatewayRefusal(req("node.tail1.ts.net:10000", "127.0.0.1", "owner@example.com")), null);
  assert.equal(H.gatewayRefusal(req("node.tail1.ts.net", "127.0.0.1", "owner@example.com")), null);
});
test("someone else, no login, a forged header from off-box, or another host: refused", () => {
  assert.notEqual(H.gatewayRefusal(req("node.tail1.ts.net:10000", "127.0.0.1", "intruder@example.com")), null);
  assert.notEqual(H.gatewayRefusal(req("node.tail1.ts.net:10000", "127.0.0.1")), null);
  assert.notEqual(H.gatewayRefusal(req("node.tail1.ts.net:10000", "100.64.0.9", "owner@example.com")), null);
  assert.notEqual(H.gatewayRefusal(req("evil.example", "127.0.0.1", "owner@example.com")), null);
  // A loopback Host can't be combined with a Tailscale identity header to dodge the owner check.
  assert.notEqual(H.gatewayRefusal(req("localhost:7790", "127.0.0.1", "intruder@example.com")), null);
});
test("local processes (agents testing their app) on localhost: allowed", () => {
  assert.equal(H.gatewayRefusal(req("127.0.0.1:7790", "127.0.0.1")), null);
  assert.notEqual(H.gatewayRefusal(req("127.0.0.1:7790", "10.0.0.5")), null);
});
test("the owner's link uses the hosting port", () => {
  assert.equal(H.publicUrl("arm-dash"), "https://node.tail1.ts.net:10000/arm-dash/");
});
