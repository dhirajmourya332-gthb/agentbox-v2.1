import { spawn } from "node:child_process";
import os from "node:os";
import type { CheckResult } from "./roadmap.ts";

/**
 * Runs the steps' `check` commands (docs/V2-ARCHITECTURE.md § 3: read-only shell, as the agent user,
 * 10 s timeout, exit 0 = done). Steps that aren't done yet are polled every `intervalMs` (3 s);
 * done ones every `doneIntervalMs`, so a step that regresses (a service stopped) turns back. At most
 * `concurrency` checks run at once and a check never overlaps itself.
 */

export type RunCommand = (cmd: string, timeoutMs: number) => Promise<CheckResult>;

const MAX_OUTPUT = 4096;

/**
 * `bash -lc <cmd>` as `user`: directly when we already are that user, else through `sudo -n -u`.
 * The whole process group is killed on timeout (a check can't leave `sleep`s or curls behind).
 */
export function shellRunner(user: string, env: NodeJS.ProcessEnv = process.env): RunCommand {
  const me = os.userInfo().username;
  return (cmd, timeoutMs) => new Promise((resolve) => {
    const [file, args] = me === user
      ? ["bash", ["-lc", cmd]]
      : ["sudo", ["-n", "-H", "-u", user, "--", "bash", "-lc", cmd]];
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: os.homedir() });
    let out = "";
    const take = (b: Buffer) => { if (out.length < MAX_OUTPUT) out += b.toString("utf8"); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    const done = (code: number | null) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code: timedOut ? null : code, output: out.slice(0, MAX_OUTPUT), at: Date.now(), timedOut });
    };
    child.on("error", (e) => { out += String(e.message); done(127); });
    child.on("close", (code) => done(code));
  });
}

export type CheckSpec = { key: string; check: string };

export class CheckRunner {
  readonly results = new Map<string, CheckResult>();
  private specs: CheckSpec[] = [];
  private inflight = new Set<string>();
  private queue: CheckSpec[] = [];
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(key: string, r: CheckResult, changed: boolean) => void>();

  constructor(private opts: {
    run: RunCommand;
    concurrency?: number;
    timeoutMs?: number;
    intervalMs?: number;
    doneIntervalMs?: number;
    now?: () => number;
  }) {}

  get concurrency() { return this.opts.concurrency ?? 4; }
  get timeoutMs() { return this.opts.timeoutMs ?? 10_000; }
  get intervalMs() { return this.opts.intervalMs ?? 3_000; }
  get doneIntervalMs() { return this.opts.doneIntervalMs ?? 30_000; }
  private now() { return (this.opts.now ?? Date.now)(); }

  onResult(fn: (key: string, r: CheckResult, changed: boolean) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The checks to poll. A step whose check text changed is re-run right away. */
  setSpecs(specs: CheckSpec[]) {
    const old = new Map(this.specs.map((s) => [s.key, s.check]));
    this.specs = specs;
    const keep = new Set(specs.map((s) => s.key));
    for (const k of [...this.results.keys()]) if (!keep.has(k)) this.results.delete(k);
    for (const s of specs) if (old.get(s.key) !== undefined && old.get(s.key) !== s.check) this.results.delete(s.key);
  }

  /** Is this check due? Never-run and failing: every interval; passing: every doneInterval. */
  due(spec: CheckSpec) {
    if (this.inflight.has(spec.key)) return false;
    const r = this.results.get(spec.key);
    if (!r) return true;
    return this.now() - r.at >= (r.ok ? this.doneIntervalMs : this.intervalMs) - 50;
  }

  /** Queue every due check (once) and start as many as the concurrency allows. */
  tick() {
    for (const s of this.specs) {
      if (this.due(s) && !this.queue.some((q) => q.key === s.key)) this.queue.push(s);
    }
    this.pump();
  }

  /** Re-run these (or all) checks now, e.g. after an install finished or "Re-check all". */
  recheck(keys?: string[]) {
    for (const s of this.specs) {
      if (keys && !keys.includes(s.key)) continue;
      const r = this.results.get(s.key);
      if (r) this.results.set(s.key, { ...r, at: 0 });
    }
    this.tick();
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const spec = this.queue.shift()!;
      if (this.inflight.has(spec.key)) continue;
      this.inflight.add(spec.key);
      this.running++;
      this.opts.run(spec.check, this.timeoutMs)
        .catch((e): CheckResult => ({ ok: false, code: null, output: String(e?.message ?? e), at: this.now() }))
        .then((r) => {
          this.running--;
          this.inflight.delete(spec.key);
          // The spec may have been removed or changed while it ran.
          const cur = this.specs.find((s) => s.key === spec.key);
          if (cur && cur.check === spec.check) {
            const prev = this.results.get(spec.key);
            const res = { ...r, at: this.now() };
            this.results.set(spec.key, res);
            const changed = !prev || prev.ok !== res.ok || (!res.ok && prev.output !== res.output);
            for (const fn of this.listeners) fn(spec.key, res, changed);
          }
          this.pump();
        });
    }
  }

  /** Whether every check has a result at least once (the first full pass is over). */
  get settled() { return this.specs.every((s) => this.results.has(s.key)); }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), Math.min(1000, this.intervalMs));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
  }

  get inFlight() { return this.running; }
}
