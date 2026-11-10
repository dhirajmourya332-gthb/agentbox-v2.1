import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { run, start, stop, which, isWin } from "./env.mjs";

/**
 * The device bridge (docs/BENCH.md), switched on and off from the app instead of a terminal. It's the
 * same bridge the installer sets up (agentbox-bench.py, downloaded from the portal): the app writes
 * its settings into a folder of its own per agentbox, runs it with Python, and shows what it says.
 * It dials out to the portal and opens no port here. Off stops it: nothing is shared.
 */

export const bridgeEvents = new EventEmitter();
const bridges = new Map(); // box name → { child, state, detail, devices, lines, wanted }
let baseDir = null;
export function initBridges(dir) { baseDir = path.join(dir, "bench"); }

const emit = (name) => bridgeEvents.emit("bridge", { name, ...bridgeStatus(name) });

export function bridgeStatus(name) {
  const b = bridges.get(name);
  return b ? { state: b.state, detail: b.detail, devices: b.devices, lines: b.lines.slice(-30) } : { state: "off", detail: null, devices: [], lines: [] };
}

/** A Python 3.9+ to run it with: python3, python, or Windows' py -3. */
export async function findPython() {
  const tries = isWin ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]];
  for (const [name, pre] of tries) {
    const exe = which(name);
    if (!exe) continue;
    const r = await run(exe, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { timeout: 15_000 });
    const [maj, min] = r.out.trim().split(".").map(Number);
    if (r.code === 0 && (maj > 3 || (maj === 3 && min >= 9))) return { exe, pre, version: r.out.trim() };
  }
  return null;
}

/** The bridge's settings from the portal: /api/bench/config, or (older agentboxes) the installer's JSON. */
async function fetchConfig(fetcher, url) {
  const r = await fetcher(`${url}/api/bench/config`);
  if (r.ok) return r.json();
  if (r.status === 404) {
    const inst = await fetcher(`${url}/api/bench/install.sh`);
    if (inst.status === 404) throw new Error("The Device bridge integration is off on this agentbox. Connect it in Integrations → Device bridge first.");
    if (!inst.ok) throw new Error((await inst.json().catch(() => ({}))).error ?? `the portal said ${inst.status}`);
    const m = /<<'JSON'\n([\s\S]*?)\nJSON\n/.exec(await inst.text());
    if (!m) throw new Error("Couldn't read the bridge settings from this agentbox (update it)");
    return JSON.parse(m[1]);
  }
  throw new Error((await r.json().catch(() => ({}))).error ?? `the portal said ${r.status}`);
}

function parseLine(b, line) {
  b.lines.push(line);
  if (b.lines.length > 300) b.lines.shift();
  let m;
  if ((m = /connected to (\S+) \((.*)\)/.exec(line))) { b.state = "connected"; b.detail = `Connected · ${m[2]}`; }
  else if ((m = /sharing (\d+) device\(s\): (.*)/.exec(line))) { b.devices = m[1] === "0" ? [] : m[2].split(/,\s*/); }
  else if (/disconnected \((.*)\); retrying/.test(line)) { b.state = "reconnecting"; b.detail = line.replace(/^agentbox-bench: /, ""); }
  else if (/waiting for it to be turned on/.test(line)) { b.state = "waiting"; b.detail = "The Device bridge is off on the agentbox; waiting for it"; }
  else if (/first run, creating/.test(line)) { b.state = "starting"; b.detail = "First run: installing pyserial and websockets…"; }
}

/** Switch a box's bridge on: settings and script from its portal, then run it. */
export async function startBridge(box, fetcher) {
  if (bridges.get(box.name)?.child) return bridgeStatus(box.name);
  const b = { child: null, state: "starting", detail: "Getting the bridge from the portal…", devices: [], lines: [], wanted: true };
  bridges.set(box.name, b);
  emit(box.name);
  try {
    const py = await findPython();
    if (!py) throw new Error("The device bridge needs Python 3.9 or newer on this computer (python.org). Install it, then switch the bridge on again.");
    const cfg = await fetchConfig(fetcher, box.url);
    const script = await fetcher(`${box.url}/api/bench/bridge.py`);
    if (!script.ok) throw new Error(`Couldn't download the bridge (${script.status})`);
    const code = await script.text();
    // Each agentbox gets its own folder (its own token); a bridge too old for that uses ~/.agentbox-bench.
    const perBox = code.includes("AGENTBOX_BENCH_HOME");
    const dir = perBox ? path.join(baseDir, box.name.replace(/[^A-Za-z0-9._-]/g, "_")) : path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agentbox-bench");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The portal address the bridge dials is the one this app reaches (a tunnel's localhost too).
    const conf = path.join(dir, "config.json");
    let mine = {};
    try { mine = JSON.parse(fs.readFileSync(conf, "utf8")); } catch { /* first time */ }
    fs.writeFileSync(conf, JSON.stringify({ ...cfg, portal: box.url, devices: mine.devices ?? cfg.devices ?? [], ...(mine.extra_devices ? { extra_devices: mine.extra_devices } : {}) }, null, 2), { mode: 0o600 });
    const file = path.join(dir, "agentbox-bench.py");
    fs.writeFileSync(file, code, { mode: 0o700 });
    if (!b.wanted) return bridgeStatus(box.name);
    b.detail = "Starting…";
    emit(box.name);
    b.child = start(py.exe, [...py.pre, file], {
      env: { AGENTBOX_BENCH_HOME: dir, PYTHONUNBUFFERED: "1" },
      onLine: (line) => { parseLine(b, line); emit(box.name); },
      onExit: (code) => {
        b.child = null;
        if (!b.wanted) { b.state = "off"; b.detail = null; b.devices = []; }
        else { b.state = "error"; b.detail = b.lines.slice(-1)[0]?.replace(/^agentbox-bench: /, "") ?? `stopped (${code})`; }
        emit(box.name);
      },
    });
  } catch (e) {
    b.state = "error"; b.detail = String(e.message ?? e);
    emit(box.name);
  }
  return bridgeStatus(box.name);
}

export function stopBridge(name) {
  const b = bridges.get(name);
  if (!b) return bridgeStatus(name);
  b.wanted = false;
  if (b.child) stop(b.child);
  else { b.state = "off"; b.detail = null; b.devices = []; }
  emit(name);
  return bridgeStatus(name);
}

export function stopAllBridges() { for (const n of bridges.keys()) stopBridge(n); }
