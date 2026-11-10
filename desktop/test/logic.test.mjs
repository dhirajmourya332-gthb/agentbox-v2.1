// The desktop app's logic that doesn't need Electron: finding programs, profiles shared with the CLI,
// the gcloud commands it builds, and what it reads from the VM.   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-desktop-"));
process.env.AGENTBOX_CLIENT_DIR = path.join(tmp, "cfg");

const env = await import("../src/main/env.mjs");
const store = await import("../src/main/store.mjs");
const gcloud = await import("../src/main/gcloud.mjs");
const flows = await import("../src/main/flows.mjs");
const tunnels = await import("../src/main/tunnels.mjs");

test("which finds programs on a PATH (and not plain files)", () => {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const exe = path.join(bin, env.isWin ? "tool.cmd" : "tool");
  fs.writeFileSync(exe, "echo hi", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "notexec"), "x", { mode: 0o644 });
  assert.equal(env.which("tool", bin), exe);
  if (!env.isWin) assert.equal(env.which("notexec", bin), null);
  assert.equal(env.which("nope", bin), null);
});

test("run streams lines and reports the exit code", async () => {
  const lines = [];
  const r = await env.run(process.execPath, ["-e", "console.log('a\\nb'); console.error('c'); process.exit(3)"], { onLine: (l) => lines.push(l) });
  assert.equal(r.code, 3);
  assert.deepEqual(lines.sort(), ["a", "b", "c"]);
});

test("profiles are the CLI's file: saved 0600, URL cleaned, the app's fields kept", () => {
  assert.throws(() => store.saveBox("bad name", { url: "https://x.ts.net" }), /name/);
  assert.throws(() => store.saveBox("x", { url: "http://example.com" }), /Plain http/);
  assert.throws(() => store.saveBox("x", { url: "ftp://x" }), /https/);
  const b = store.saveBox("mumbai", { url: "https://agentbox-mumbai.tail1.ts.net/some/path/" });
  assert.equal(b.url, "https://agentbox-mumbai.tail1.ts.net");
  assert.equal(b.default, true);
  store.saveBox("gcp2", { url: "http://localhost:8722", cloud: { provider: "gcp", zone: "asia-south1-c", instance: "agentbox-gcp2", configuration: "gcp2" }, tunnel: { vmPort: 7700, localPort: 8722 } });
  const file = path.join(process.env.AGENTBOX_CLIENT_DIR, "profiles.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.default, "mumbai");
  assert.deepEqual(raw.profiles.gcp2.tunnel, { vmPort: 7700, localPort: 8722 });
  if (!env.isWin) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // A field the CLI wrote survives the app's save; null removes the app's own.
  raw.profiles.mumbai.lima = { vm: "x" };
  fs.writeFileSync(file, JSON.stringify(raw));
  store.saveBox("mumbai", { url: "https://agentbox-mumbai.tail1.ts.net", cloud: null });
  assert.deepEqual(store.getBox("mumbai").lima, { vm: "x" });
  assert.equal("cloud" in JSON.parse(fs.readFileSync(file, "utf8")).profiles.mumbai, false);
  store.removeBox("mumbai");
  assert.equal(store.readProfiles().default, "gcp2");
});

test("which boxes need a tunnel", () => {
  assert.equal(tunnels.tunnelFor({ name: "a", url: "https://a.ts.net" }), null);
  assert.deepEqual(tunnels.tunnelFor({ name: "b", url: "http://localhost:8722", cloud: { instance: "vm", zone: "asia-south1-c" }, tunnel: { vmPort: 7700, localPort: 8722 } }),
    { kind: "iap", port: 8722, vmPort: 7700, cloud: { instance: "vm", zone: "asia-south1-c" } });
  assert.equal(tunnels.tunnelFor({ name: "c", url: "http://localhost:8720", lima: { vm: "v" } }).kind, "lima");
  assert.equal(tunnels.tunnelFor({ name: "d", url: "http://localhost:9000" }).kind, "local");
});

test("gcloud: checked names, IAP-only firewall, a VM with no open ports", () => {
  assert.throws(() => gcloud.checkCloud({ instance: "Bad_Name", zone: "asia-south1-c" }), /VM's name/);
  assert.throws(() => gcloud.checkCloud({ instance: "ok", zone: "mumbai" }), /zone/);
  assert.throws(() => gcloud.checkCloud({ instance: "ok", zone: "asia-south1-c", project: "x; rm -rf /" }), /project/);
  const cloud = { instance: "agentbox-new", zone: "asia-south1-c", project: "my-proj-123", configuration: "gcp2" };
  const steps = gcloud.createSteps(cloud);
  assert.deepEqual(steps[0].args.slice(0, 4), ["--configuration", "gcp2", "--project", "my-proj-123"]);
  const fw = steps.find((s) => s.firewall).args;
  assert.ok(fw.includes("35.235.240.0/20") && fw.includes("tcp:22") && !fw.includes("0.0.0.0/0"));
  const vm = steps.at(-1).args;
  for (const x of ["agentbox-new", "ubuntu-2404-lts-amd64", "60GB", "e2-standard-4", "--shielded-secure-boot"]) assert.ok(vm.includes(x), x);
  assert.throws(() => gcloud.createSteps(cloud, { diskGb: 10 }), /Disk/);
  // The portal listens on the VM's loopback: an SSH forward through IAP, not an IAP TCP tunnel.
  const fwd = gcloud.forwardArgs(cloud, 7700, 18777);
  assert.ok(fwd.includes("--tunnel-through-iap") && fwd.includes("ssh") && fwd.includes("-N"));
  assert.ok(fwd.some((a) => /18777:127\.0\.0\.1:7700$/.test(a)));
  assert.throws(() => gcloud.forwardArgs(cloud, 7700, 80), /port/);
  assert.throws(() => gcloud.createSteps(cloud, { machineType: "$(x)" }), /machine type/);
});

test("flows: the install command, the guide's link, the access settings", () => {
  const cmd = flows.installCommand("https://github.com/owner/agentbox-v2.1");
  assert.match(cmd, /git clone 'https:\/\/github.com\/owner\/agentbox-v2.1' \/opt\/agentbox\/src/);
  assert.match(cmd, /bootstrap.sh --host cloud/);
  assert.throws(() => flows.installCommand("https://x.com/a'; rm -rf /"), /https/);
  assert.equal(flows.guideToken("  One-time link (valid 30 minutes), once port 7699 is forwarded:\n    http://localhost:7699/?t=AbC_def-1234567890xyz\n"), "AbC_def-1234567890xyz");
  assert.equal(flows.guideToken("no link here"), null);
  assert.deepEqual(flows.parseAccess("ACCESS=tailscale\nTS=agentbox-x.tail.ts.net\nCF=\n"), { access: "tailscale", tailscale: "agentbox-x.tail.ts.net", cloudflare: null });
  assert.deepEqual(flows.parseAccess("ACCESS=\nTS=\nCF=\n"), { access: null, tailscale: null, cloudflare: null });
});
