// Live progress (src/progress.ts): output tail, wait_for_apt notices, elapsed time and the heartbeat.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { addOutput, fmtDuration, heartbeat, HEARTBEAT_MS, jobView, newJob, runningLabel, TAIL_LINES, waitNotice } from "../src/progress.ts";

describe("progress", () => {
  test("keeps the last lines, across chunk boundaries, \\r redraws and ANSI colours", () => {
    const j = newJob("display", "install", "retry", 1000);
    addOutput(j, "==> display: inst", 1100);
    addOutput(j, "all.sh\n\x1b[32m--> chromium\x1b[0m\r\n", 1200);
    addOutput(j, "Progress 10%\rProgress 50%\r", 1300);
    const v = jobView(j);
    assert.deepEqual(v.tail, ["==> display: install.sh", "--> chromium", "Progress 10%", "Progress 50%"]);
    assert.equal(v.lastOutputAt, 1300);
    for (let i = 0; i < 50; i++) addOutput(j, `line ${i}\n`, 2000 + i);
    assert.equal(jobView(j).tail.length, TAIL_LINES);
    assert.equal(jobView(j).tail.at(-1), "line 49");
  });

  test("a partial line shows as the newest line until it ends", () => {
    const j = newJob("core", "install", "agent", 0);
    addOutput(j, "done\nnpm install…", 10);
    assert.deepEqual(jobView(j).tail, ["done", "npm install…"]);
  });

  test("wait_for_apt's ⏳ lines set `waiting`; the next ordinary line clears it", () => {
    const j = newJob("display", "install", "agent", 0);
    const notice = "⏳ Waiting for Ubuntu's automatic security updates to finish (unattended-upgrades is installing updates; this is normal on a new VM) — 3 min elapsed, up to 15 min · now: Setting up libssl3t64:amd64 (3.0.13)";
    addOutput(j, `--> apt-get install chromium\n${notice}\n`, 500);
    const v = jobView(j);
    assert.ok(v.waiting);
    assert.match(v.waiting!.text, /^Waiting for Ubuntu's automatic security updates/);
    assert.match(v.waiting!.text, /now: Setting up libssl3t64/);
    assert.equal(waitNotice("plain line"), null);
    addOutput(j, "✔ The package manager is free again (waited 3 min 10 s); continuing\n", 600);
    assert.equal(jobView(j).waiting, null);
  });

  test("elapsed time and the heartbeat", () => {
    assert.equal(fmtDuration(45_000), "45 s");
    assert.equal(fmtDuration(134_000), "2 min 14 s");
    assert.equal(fmtDuration(3_780_000), "1 h 3 min");
    assert.equal(runningLabel("install", 0, 134_000), "Installing… 2 min 14 s");
    assert.equal(runningLabel("verify", 0, 5_000), "Verifying… 5 s");
    assert.equal(heartbeat(0, HEARTBEAT_MS - 1), null, "quiet for less than 20 s: nothing");
    assert.equal(heartbeat(0, 45_000), "Still working: no new output for 45 s. Some steps take several minutes on a small VM.");
  });
});
