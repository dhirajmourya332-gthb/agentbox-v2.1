// The setup scripts' restart- and wait-safety, run with bash: wait_for_apt (setup/lib/apt-wait.sh)
// against a test lock holder, and deploy-app.sh leaving a running guide alone.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-scripts-"));
const hasFuser = spawnSync("bash", ["-c", "command -v fuser"]).status === 0;

/** Hold `lock` open from a process named `name` for `secs` seconds. */
function holdLock(lock: string, secs: number, name = "sleep") {
  fs.writeFileSync(lock, "");
  let exe = "sleep";
  if (name !== "sleep") {
    // A symlink named like the real holder: the process's comm is the name it was run by.
    exe = path.join(tmp, name);
    const real = spawnSync("bash", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
    fs.rmSync(exe, { force: true });
    fs.symlinkSync(real, exe);
  }
  const child = spawn("bash", ["-c", `exec 9<>"$1"; exec "$2" "$3"`, "holder", lock, exe, String(secs)], { stdio: "ignore" });
  return child;
}

function waitForApt(env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; err: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const c = spawn("bash", ["-c", `set -euo pipefail; . "$1"; wait_for_apt`, "t", path.join(repo, "setup/lib/apt-wait.sh")], {
      env: { ...process.env, AGENTBOX_APT_WAIT_EVERY: "1", AGENTBOX_APT_WAIT_POLL: "0.2", ...env },
    });
    let out = "", err = "";
    c.stdout.on("data", (b) => (out += b));
    c.stderr.on("data", (b) => (err += b));
    c.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("wait_for_apt", { skip: !hasFuser && "no fuser here" }, () => {
  test("no lock held: returns at once, silently", async () => {
    const lock = path.join(tmp, "free.lock");
    fs.writeFileSync(lock, "");
    const r = await waitForApt({ AGENTBOX_APT_LOCKS: lock });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  });

  test("unattended-upgrades holds the lock: ⏳ lines with the package being installed, then continues", async () => {
    const lock = path.join(tmp, "uu.lock");
    const uuLog = path.join(tmp, "uu-dpkg.log");
    fs.writeFileSync(uuLog, "Log started: 2026-10-11\nPreparing to unpack .../libssl3t64_3.0.13_amd64.deb ...\nUnpacking libssl3t64:amd64 (3.0.13-0ubuntu3.5) over (3.0.13-0ubuntu3.4) ...\nSetting up libssl3t64:amd64 (3.0.13-0ubuntu3.5) ...\n");
    const holder = holdLock(lock, 2, "unattended-upgrade");
    await sleep(300);
    const r = await waitForApt({ AGENTBOX_APT_LOCKS: lock, AGENTBOX_APT_UU_LOG: uuLog });
    holder.kill();
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n");
    const waits = lines.filter((l) => l.startsWith("⏳ "));
    assert.ok(waits.length >= 1, r.out);
    assert.match(waits[0], /^⏳ Waiting for Ubuntu's automatic security updates to finish \(unattended-upgrades is installing updates; this is normal on a new VM\) — \d+ s elapsed, up to 15 min · now: Setting up libssl3t64:amd64 \(3\.0\.13-0ubuntu3\.5\)$/);
    assert.match(lines.at(-1)!, /^✔ The package manager is free again \(waited \d+ s\); continuing$/);
    assert.ok(r.ms >= 1200, `it waited (${r.ms} ms)`);
  });

  test("another process: says who; gives up after the limit with an actionable error", async () => {
    const lock = path.join(tmp, "other.lock");
    const holder = holdLock(lock, 10);
    await sleep(300);
    const r = await waitForApt({ AGENTBOX_APT_LOCKS: lock, AGENTBOX_APT_WAIT_MAX: "1" });
    holder.kill();
    assert.equal(r.code, 1);
    assert.match(r.out, /^⏳ Waiting for another package manager to finish \(sleep holds the apt\/dpkg lock\)/);
    assert.match(r.err, /error: the package manager has been busy for/);
    assert.match(r.err, /then Retry/);
  });
});

describe("deploy-app.sh and the setup guide", () => {
  function run(guideActive: boolean, installed: boolean) {
    const src = path.join(tmp, `src-${guideActive}-${installed}`);
    fs.mkdirSync(path.join(src, "guide"), { recursive: true });
    const marker = path.join(src, "installed");
    fs.writeFileSync(path.join(src, "guide", "install.sh"), `touch '${marker}'\n`);
    const unit = path.join(src, "agentbox-guide.service");
    if (installed) fs.writeFileSync(unit, "");
    const runDir = path.join(tmp, "run-systemd");
    fs.mkdirSync(runDir, { recursive: true });
    const r = spawnSync("bash", ["-c", `
      systemctl() { [ "$1 $2 $3" = "is-active --quiet agentbox-guide" ] && [ "$GUIDE_ACTIVE" = 1 ]; }
      . "$1"
      SRC="$2" AGENT_USER=nobody
      sync_guide`, "t", path.join(repo, "setup/lib/deploy-app.sh"), src], {
      encoding: "utf8",
      env: { ...process.env, GUIDE_ACTIVE: guideActive ? "1" : "0", AGENTBOX_SYSTEMD_RUN: runDir, AGENTBOX_GUIDE_UNIT: unit },
    });
    return { code: r.status, out: r.stdout + r.stderr, reinstalled: fs.existsSync(marker) };
  }

  test("a running guide isn't updated or restarted (core's install runs this mid-setup)", () => {
    const r = run(true, true);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.reinstalled, false);
    assert.match(r.out, /the setup guide is running: not updated now/);
    assert.match(r.out, /agentbox guide restart/);
  });
  test("a stopped, installed guide is updated (guide/install.sh)", () => {
    const r = run(false, true);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.reinstalled, true);
  });
  test("no guide installed: nothing", () => {
    const r = run(false, false);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.reinstalled, false);
  });
  test("sourcing the script runs nothing but defines its functions", () => {
    const r = spawnSync("bash", ["-c", `. "$1"; type sync_guide >/dev/null && echo ok`, "t", path.join(repo, "setup/lib/deploy-app.sh")], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "ok", r.stderr);
  });
});
