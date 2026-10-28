import fs from "node:fs";
import os from "node:os";
import { paths } from "./config.ts";

/**
 * Disk and memory headroom of the VM, and the warnings the portal shows when it runs low.
 *
 * A full disk or memory starvation stalls every agent at once (2026-10-12), so the portal warns
 * before it happens. Disk is read on demand (cheap). Memory is sampled every 30 s and only warned
 * about when it has stayed low for two samples, so a short spike (a build, a test run) isn't news.
 */

export type Level = "warn" | "critical";
export type Disk = { mount: string; paths: string[]; total: number; free: number; used_pct: number; inodes_used_pct: number | null };
export type Memory = { total: number; available: number; used_pct: number; swap_total: number; swap_free: number };
export type Alert = { id: string; level: Level; title: string; detail: string };

const GB = 1024 ** 3;
export const LIMITS = {
  disk: { warn: { pct: 85, free: 5 * GB }, critical: { pct: 95, free: 1 * GB } },
  inodes: { warn: 90, critical: 97 },
  memory: { warn: { pct: 90, available: 512 * 1024 ** 2 }, critical: { pct: 96, available: 200 * 1024 ** 2 } },
  swap: { warn: 50, critical: 80 },
};

/** The folders agents write to; folders on the same device are one disk. */
function watched(): string[] {
  return [...new Set(["/", paths.data, paths.work, paths.agents].filter((p) => p && fs.existsSync(p)))];
}

export function disks(dirs = watched()): Disk[] {
  const byDev = new Map<number, Disk>();
  for (const dir of dirs) {
    try {
      const dev = fs.statSync(dir).dev;
      const seen = byDev.get(dev);
      if (seen) { seen.paths.push(dir); continue; }
      const s = fs.statfsSync(dir);
      const total = s.blocks * s.bsize;
      // `bavail` is what a non-root process can still write: that's what agents run into.
      const free = s.bavail * s.bsize;
      const usedPct = total ? ((total - free) / total) * 100 : 0;
      const inodes = s.files > 0 ? ((s.files - s.ffree) / s.files) * 100 : null;
      byDev.set(dev, { mount: dir, paths: [dir], total, free, used_pct: round(usedPct), inodes_used_pct: inodes === null ? null : round(inodes) });
    } catch { /* unreadable: skip it */ }
  }
  return [...byDev.values()];
}

/** Linux's own view of memory. Elsewhere (a dev Mac) free memory excludes the page cache, so it
 * looks nearly full all the time: no reading, no warning. */
export function memory(): Memory | null {
  let text: string;
  try { text = fs.readFileSync("/proc/meminfo", "utf8"); } catch { return null; }
  const info: Record<string, number> = Object.fromEntries(
    text.split("\n").map((l) => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((m) => [m![1], Number(m![2]) * 1024]),
  );
  const total = info.MemTotal ?? os.totalmem();
  const available = info.MemAvailable ?? info.MemFree ?? os.freemem();
  return { total, available, used_pct: round(((total - available) / total) * 100), swap_total: info.SwapTotal ?? 0, swap_free: info.SwapFree ?? 0 };
}

const round = (n: number) => Math.round(n * 10) / 10;
export const size = (b: number) => (b >= GB ? `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/**
 * The warnings for these readings. `memSamples` is the recent memory readings, newest last: memory
 * warns at the level both of the last two reached, so one spike doesn't.
 */
export function assess(diskList: Disk[], memSamples: Memory[]): Alert[] {
  const alerts: Alert[] = [];
  for (const d of diskList) {
    const L = LIMITS.disk;
    const level: Level | null =
      d.used_pct >= L.critical.pct || d.free < L.critical.free ? "critical"
      : d.used_pct >= L.warn.pct || d.free < L.warn.free ? "warn" : null;
    if (level) {
      alerts.push({
        id: `disk:${d.mount}`, level,
        title: level === "critical" ? `Disk almost full: ${size(d.free)} left` : `Disk getting full: ${size(d.free)} left`,
        detail: `The disk at ${d.mount} is ${Math.round(d.used_pct)}% used (${size(d.total - d.free)} of ${size(d.total)}). When it fills, agents' writes, builds and git fail.`,
      });
    }
    const ip = d.inodes_used_pct;
    const iLevel: Level | null = ip === null ? null : ip >= LIMITS.inodes.critical ? "critical" : ip >= LIMITS.inodes.warn ? "warn" : null;
    if (iLevel) {
      alerts.push({
        id: `inodes:${d.mount}`, level: iLevel,
        title: `Disk running out of file slots (${Math.round(ip!)}% used)`,
        detail: `The disk at ${d.mount} has room left but almost no inodes: usually many small files (node_modules, caches). New files will fail.`,
      });
    }
  }
  const last2 = memSamples.slice(-2);
  if (last2.length === 2) {
    const memLevel = (m: Memory): Level | null => {
      const L = LIMITS.memory;
      return m.used_pct >= L.critical.pct || m.available < L.critical.available ? "critical"
        : m.used_pct >= L.warn.pct || m.available < L.warn.available ? "warn" : null;
    };
    const level = lowest(last2.map(memLevel));
    const m = last2[last2.length - 1];
    if (level) {
      alerts.push({
        id: "memory", level,
        title: level === "critical" ? `Memory almost exhausted: ${size(m.available)} free` : `Memory running low: ${size(m.available)} free`,
        detail: `${Math.round(m.used_pct)}% of ${size(m.total)} in use. Agents, builds and the browser slow down, then get killed.`,
      });
    }
    const swapPct = (x: Memory) => (x.swap_total ? ((x.swap_total - x.swap_free) / x.swap_total) * 100 : 0);
    const swapLevel = lowest(last2.map((x) => (swapPct(x) >= LIMITS.swap.critical ? "critical" : swapPct(x) >= LIMITS.swap.warn ? "warn" : null)));
    if (swapLevel) {
      alerts.push({
        id: "swap", level: swapLevel,
        title: `Swapping heavily (${Math.round(swapPct(m))}% of swap in use)`,
        detail: `The VM is short of memory and moving it to disk (${size(m.swap_total - m.swap_free)} of ${size(m.swap_total)}). Everything gets slow.`,
      });
    }
  }
  return alerts;
}

/** The milder of the levels; null if any is null (the condition didn't hold every time). */
function lowest(levels: (Level | null)[]): Level | null {
  if (levels.some((l) => l === null)) return null;
  return levels.every((l) => l === "critical") ? "critical" : "warn";
}

// Memory samples, newest last. Sampling starts with the first call to resources().
const SAMPLE_MS = 30_000;
const samples: Memory[] = [];
let timer: NodeJS.Timeout | null = null;
function sample() {
  const m = memory();
  if (!m) return;
  samples.push(m);
  if (samples.length > 2) samples.shift();
}

export function resources() {
  if (!timer) {
    sample();
    timer = setInterval(sample, SAMPLE_MS);
    timer.unref();
  }
  const diskList = disks();
  return { disks: diskList, memory: samples[samples.length - 1] ?? null, alerts: assess(diskList, samples) };
}
