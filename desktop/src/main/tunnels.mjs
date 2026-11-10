import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { portOpen, sleep, start, stop, which } from "./env.mjs";
import * as gcloud from "./gcloud.mjs";

/**
 * Ways to reach a portal that isn't on the tailnet: an IAP tunnel (gcloud start-iap-tunnel) to a
 * cloud VM in ssh-tunnel access mode, or the CLI's Lima ssh forward. A tunnel listens on this
 * computer's localhost only, and stays up while the app runs (restarted if it drops).
 */

export const tunnelEvents = new EventEmitter();
const live = new Map(); // key → { child, state, error, port, wanted, lines }

const emit = (key) => tunnelEvents.emit("tunnel", { key, ...statusOf(key) });

export function statusOf(key) {
  const t = live.get(key);
  return t ? { state: t.state, error: t.error, port: t.port, lines: t.lines.slice(-20) } : { state: "off", error: null, port: null, lines: [] };
}

/** What a box needs: null (reached directly), or how to open its tunnel. */
export function tunnelFor(box) {
  const url = new URL(box.url);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (!local) return null;
  const port = Number(url.port || 80);
  if (box.tunnel && box.cloud) return { kind: "iap", port, vmPort: box.tunnel.vmPort ?? 7700, cloud: box.cloud };
  if (box.lima) return { kind: "lima", port, vmPort: box.lima.port ?? 7720, lima: box.lima };
  return { kind: "local", port }; // something else opens it (e.g. the owner's own ssh -L)
}

function spawnFor(key, spec, t) {
  const onLine = (line) => { t.lines.push(line); if (t.lines.length > 200) t.lines.shift(); };
  const onExit = (code) => {
    if (t.child && t.child.exitCode === null) return;
    t.child = null;
    if (!t.wanted) { t.state = "off"; emit(key); return; }
    t.state = "reconnecting";
    t.error = t.lines.slice(-1)[0] ?? `exited (${code})`;
    emit(key);
    // Back off a little, then try again for as long as it's wanted.
    setTimeout(() => { if (t.wanted && !t.child) { t.child = spawnFor(key, spec, t); } }, Math.min(30_000, 2000 * 2 ** Math.min(t.retries++, 4))).unref?.();
  };
  if (spec.kind === "iap") return gcloud.tunnel(spec.cloud, spec.vmPort, spec.port, { onLine, onExit });
  const home = spec.lima.home || process.env.LIMA_HOME || path.join(os.homedir(), ".lima");
  const sshConfig = path.join(home, spec.lima.vm, "ssh.config");
  if (!fs.existsSync(sshConfig)) throw new Error(`${sshConfig} is missing: is the Lima VM ${spec.lima.vm} running?`);
  const ssh = which("ssh");
  if (!ssh) throw new Error("ssh isn't installed on this computer");
  return start(ssh, ["-F", sshConfig, "-N", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
    "-L", `${spec.port}:127.0.0.1:${spec.vmPort}`, `lima-${spec.lima.vm}`], { onLine, onExit });
}

/** Make sure a box's portal answers on its localhost port, opening its tunnel if it has one. */
export async function ensure(box) {
  const spec = tunnelFor(box);
  if (!spec) return { direct: true };
  if (await portOpen(spec.port)) {
    const t = live.get(box.name);
    if (t && t.state !== "up") { t.state = "up"; t.error = null; emit(box.name); }
    return { port: spec.port };
  }
  if (spec.kind === "local") throw new Error(`Nothing answers on localhost:${spec.port}. Open your tunnel to the agentbox first.`);
  let t = live.get(box.name);
  if (!t) { t = { child: null, state: "starting", error: null, port: spec.port, wanted: true, lines: [], retries: 0 }; live.set(box.name, t); }
  t.wanted = true;
  if (!t.child) {
    t.state = "starting"; t.error = null; emit(box.name);
    t.child = spawnFor(box.name, spec, t);
  }
  // gcloud first tests the IAP connection, which can take most of a minute.
  for (let i = 0; i < 180; i++) {
    if (await portOpen(spec.port)) { t.state = "up"; t.retries = 0; emit(box.name); return { port: spec.port }; }
    if (!t.child && t.state !== "reconnecting") break;
    await sleep(500);
  }
  t.state = "error";
  t.error = t.lines.slice(-3).join(" · ") || "the tunnel didn't open";
  emit(box.name);
  throw new Error(`Couldn't open the tunnel to ${box.name}: ${t.error}`);
}

/** A one-off tunnel (the setup guide's port while it's being set up). */
export async function open(key, cloud, vmPort, localPort) {
  close(key);
  const t = { child: null, state: "starting", error: null, port: localPort, wanted: true, lines: [], retries: 0 };
  live.set(key, t);
  t.child = spawnFor(key, { kind: "iap", cloud, vmPort, port: localPort }, t);
  for (let i = 0; i < 180; i++) {
    if (await portOpen(localPort)) { t.state = "up"; emit(key); return localPort; }
    await sleep(500);
  }
  close(key);
  throw new Error(`The IAP tunnel to port ${vmPort} didn't open: ${t.lines.slice(-3).join(" · ") || "no output"}`);
}

export function close(key) {
  const t = live.get(key);
  if (!t) return;
  t.wanted = false;
  stop(t.child);
  t.child = null;
  t.state = "off";
  live.delete(key);
  emit(key);
}

export function closeAll() { for (const k of [...live.keys()]) close(k); }
