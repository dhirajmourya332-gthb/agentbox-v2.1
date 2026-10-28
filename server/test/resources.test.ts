/**
 * VM disk and memory warnings (server/src/resources.ts).
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/resources.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
const R = await import("../src/resources.ts");

const GB = 1024 ** 3;
const disk = (usedPct: number, total = 100 * GB, inodes: number | null = 10) =>
  ({ mount: "/", paths: ["/", "/work"], total, free: total * (1 - usedPct / 100), used_pct: usedPct, inodes_used_pct: inodes });
const mem = (usedPct: number, total = 8 * GB, swapPct = 0) =>
  ({ total, available: total * (1 - usedPct / 100), used_pct: usedPct, swap_total: 2 * GB, swap_free: 2 * GB * (1 - swapPct / 100) });

test("disk: quiet under 85%, warn from 85% or under 5 GB free, critical from 95% or under 1 GB", () => {
  assert.deepEqual(R.assess([disk(70)], []), []);
  assert.equal(R.assess([disk(86)], [])[0].level, "warn");
  assert.equal(R.assess([disk(96)], [])[0].level, "critical");
  // A small disk: 40 GB at 80% leaves 8 GB (fine); at 90% leaves 4 GB (warn by both rules).
  assert.deepEqual(R.assess([disk(80, 40 * GB)], []), []);
  // A big disk: 2 TB at 99.97% still has 600 MB: critical by free space.
  const a = R.assess([disk(99.97, 2000 * GB)], [])[0];
  assert.equal(a.level, "critical");
  assert.equal(a.id, "disk:/");
  assert.match(a.title, /Disk almost full: \d+ MB left/);
  assert.match(a.detail, /The disk at \/ is 100% used/);
});

test("inodes: a disk with space but no file slots warns on its own", () => {
  const alerts = R.assess([disk(40, 100 * GB, 98)], []);
  assert.deepEqual(alerts.map((a) => [a.id, a.level]), [["inodes:/", "critical"]]);
});

test("memory: one low sample is a spike; two in a row warn, at the milder of the two levels", () => {
  assert.deepEqual(R.assess([], [mem(99)]), [], "a single sample never warns");
  assert.deepEqual(R.assess([], [mem(50), mem(99)]), [], "a spike after a normal reading");
  assert.equal(R.assess([], [mem(92), mem(93)])[0].level, "warn");
  assert.equal(R.assess([], [mem(92), mem(99)])[0].level, "warn");
  const c = R.assess([], [mem(98), mem(99)])[0];
  assert.equal(c.level, "critical");
  assert.equal(c.id, "memory");
  // A small VM: 2 GB with 400 MB available is 80% used but under 512 MB free.
  assert.equal(R.assess([], [mem(80, 2 * GB), mem(80, 2 * GB)])[0].level, "warn");
});

test("swap: heavy swapping warns separately", () => {
  const alerts = R.assess([], [mem(60, 8 * GB, 70), mem(60, 8 * GB, 85)]);
  assert.deepEqual(alerts.map((a) => [a.id, a.level]), [["swap", "warn"]]);
  assert.deepEqual(R.assess([], [mem(60, 8 * GB, 90), mem(60, 8 * GB, 85)]).map((a) => a.level), ["critical"]);
});

test("disks(): folders on one device are one disk, missing folders are skipped", () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const a = fs.mkdtempSync(`${tmp}/res-a-`), b = fs.mkdtempSync(`${tmp}/res-b-`);
  const list = R.disks([a, b, `${tmp}/does-not-exist-${Date.now()}`]);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].paths, [a, b]);
  assert.ok(list[0].total > 0 && list[0].free > 0 && list[0].free <= list[0].total);
  assert.ok(list[0].used_pct >= 0 && list[0].used_pct <= 100);
});

test("resources(): readings plus alerts, memory needs a second sample", () => {
  const r = R.resources();
  assert.ok(r.disks.length >= 1);
  // Linux reads /proc/meminfo; elsewhere there's no reading at all.
  if (fs.existsSync("/proc/meminfo")) assert.ok(r.memory && r.memory.total > 0);
  else assert.equal(r.memory, null);
  assert.ok(Array.isArray(r.alerts));
  assert.ok(!r.alerts.some((a) => a.id === "memory"), "one sample so far");
});
