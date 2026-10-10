// The check runner: bounded parallelism, no overlap, intervals, timeouts that kill the process group.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import os from "node:os";
import { CheckRunner, shellRunner, type RunCommand } from "../src/checks.ts";
import type { CheckResult } from "../src/roadmap.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CheckRunner", () => {
  test("never runs more than `concurrency` checks at once, nor a check twice at once", async () => {
    let running = 0, peak = 0;
    const perKey = new Map<string, number>();
    const run: RunCommand = async (cmd) => {
      running++; peak = Math.max(peak, running);
      perKey.set(cmd, (perKey.get(cmd) ?? 0) + 1);
      assert.ok(perKey.get(cmd)! <= 1, `${cmd} overlapped`);
      await sleep(30);
      perKey.set(cmd, perKey.get(cmd)! - 1);
      running--;
      return { ok: true, code: 0, output: "", at: Date.now() };
    };
    const r = new CheckRunner({ run, concurrency: 3, intervalMs: 1 });
    r.setSpecs(Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, check: `c${i}` })));
    r.tick(); r.tick(); r.tick();
    await sleep(200);
    assert.equal(peak, 3);
    assert.equal(r.results.size, 10);
    assert.ok(r.settled);
  });

  test("failing checks are due every interval; passing ones only every doneInterval", () => {
    let t = 1000;
    const r = new CheckRunner({ run: async () => ({ ok: true, code: 0, output: "", at: 0 }), intervalMs: 3000, doneIntervalMs: 30000, now: () => t });
    const okSpec = { key: "a", check: "a" }, badSpec = { key: "b", check: "b" };
    r.setSpecs([okSpec, badSpec]);
    r.results.set("a", { ok: true, code: 0, output: "", at: 1000 });
    r.results.set("b", { ok: false, code: 1, output: "", at: 1000 });
    t = 1000 + 3000;
    assert.equal(r.due(okSpec), false);
    assert.equal(r.due(badSpec), true);
    t = 1000 + 30000;
    assert.equal(r.due(okSpec), true);
  });

  test("reports changes (ok flips, or a different failure)", async () => {
    let n = 0;
    const seq: CheckResult[] = [
      { ok: false, code: 1, output: "x", at: 0 }, { ok: false, code: 1, output: "x", at: 0 }, { ok: true, code: 0, output: "", at: 0 },
    ];
    const r = new CheckRunner({ run: async () => seq[Math.min(n++, 2)], intervalMs: 1 });
    const changes: boolean[] = [];
    r.onResult((_k, _r, changed) => changes.push(changed));
    r.setSpecs([{ key: "k", check: "k" }]);
    for (let i = 0; i < 3; i++) { r.recheck(); await sleep(10); }
    assert.deepEqual(changes, [true, false, true]);
  });

  test("a check whose text changed starts over; removed specs drop their results", () => {
    const r = new CheckRunner({ run: async () => ({ ok: true, code: 0, output: "", at: 0 }) });
    r.setSpecs([{ key: "a", check: "x" }, { key: "b", check: "y" }]);
    r.results.set("a", { ok: true, code: 0, output: "", at: 1 });
    r.results.set("b", { ok: true, code: 0, output: "", at: 1 });
    r.setSpecs([{ key: "a", check: "x2" }]);
    assert.equal(r.results.has("a"), false);
    assert.equal(r.results.has("b"), false);
  });

  test("a throwing runner is a failed check, not a crash", async () => {
    const r = new CheckRunner({ run: async () => { throw new Error("boom"); } });
    r.setSpecs([{ key: "k", check: "k" }]);
    r.tick();
    await sleep(10);
    assert.equal(r.results.get("k")?.ok, false);
    assert.match(r.results.get("k")!.output, /boom/);
  });
});

describe("shellRunner (bash -lc as this user)", () => {
  const run = shellRunner(os.userInfo().username);
  test("exit 0 is ok; anything else isn't; output is kept", async () => {
    assert.equal((await run("true", 5000)).ok, true);
    const r = await run("echo nope; exit 3", 5000);
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.match(r.output, /nope/);
  });
  test("a check that hangs times out, and its whole process group is killed", async () => {
    const marker = `guide-check-${process.pid}-${Date.now()}`;
    const t0 = Date.now();
    const r = await run(`sleep 30 & sleep 31; echo ${marker}`, 300);
    assert.ok(Date.now() - t0 < 3000, "returned promptly");
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    await sleep(200);
    const left = execSync(`ps -Ao pid,command | grep -c "[s]leep 3[01]" || true`).toString().trim();
    assert.equal(left, "0", "no sleeps left behind");
    void marker;
  });
});
