import os from "node:os";
import { spawn } from "node:child_process";
import { all, get, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { redactSecrets } from "./redact.ts";
import { ID_RE } from "./integrations.ts";

/**
 * The Setup workspace's checklist (docs/V2-ARCHITECTURE.md › Changes (setup workspace)).
 *
 * The setup agent writes a plan for whatever the owner asked ("set up gh and aws") with set_plan /
 * update_step / add_steps (setupTools.ts). Each step has instructions, commands the owner can copy or
 * insert into the terminal, and a `check`: a shell command that exits 0 once the step is done (or, for
 * a step of a known integration, that integration's own step check through the CLI).
 *
 * The plan is stored per setup session (the setup task instance) in `setup_plans`, so it survives
 * reloads and restarts. The checker polls the CURRENT step's check every ~3 s (as the portal's user,
 * with a timeout and capped, redacted output); when it passes the step is done, the pointer moves on,
 * and the agent gets one short note in its thread (debounced; at most one automatic note per step).
 */

export type StepStatus = "pending" | "done" | "skipped" | "failed";
export type CheckResult = { ok: boolean; code: number | null; output: string; at: string; timed_out: boolean };
export type PlanStep = {
  id: string;
  title: string;
  why: string;
  instructions: string;
  commands: string[];
  check: string | null;
  /** The owner does this step (a login, a browser page); otherwise the setup agent does it. */
  human: boolean;
  /** A step of a known integration: checked through `agentbox integration status <id> --json`. */
  integration: { id: string; step: string | null } | null;
  status: StepStatus;
  done_by: "check" | "owner" | "agent" | null;
  done_at: string | null;
  note: string | null;
  last_check: CheckResult | null;
  /** The agent was told about this step automatically (at most once). */
  nudged: boolean;
};
export type Plan = { instance_id: string; title: string; steps: PlanStep[]; created_at: string; updated_at: string };
export type PlanView = Plan & {
  current: string | null;
  /** Steps whose check is running right now → since (ISO). */
  checking: Record<string, string>;
  /** When each step's check last ran (the persisted last_check only changes when its result does). */
  checked_at: Record<string, string>;
  interval_ms: number;
  done_count: number;
  total: number;
};

export const LIMITS = { steps: 40, commands: 10, title: 120, why: 300, instructions: 4000, command: 2000, check: 1000, note: 1000 };
export const STEP_ID = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const CONTROL = /[\x00-\x1f\x7f\u2028\u2029]/;
const MAX_OUTPUT = 4096;

run(`CREATE TABLE IF NOT EXISTS setup_plans (
  instance_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  steps TEXT NOT NULL,          -- JSON PlanStep[]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

// --- validation ------------------------------------------------------------------------------------

export type StepInput = {
  id?: unknown; title?: unknown; why?: unknown; instructions?: unknown; commands?: unknown; check?: unknown; human?: unknown;
  integration?: unknown; integration_step?: unknown;
};

const str = (v: unknown, field: string, max: number, required = false) => {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`${field} must be text`);
  const t = v.trim();
  if (required && !t) throw new Error(`${field} is required`);
  if (t.length > max) throw new Error(`${field} is too long (max ${max} characters)`);
  return t;
};

/** A command the owner may insert into their terminal: one line, no control characters (no Enter, no escapes). */
export function checkCommand(c: unknown, field: string) {
  const t = str(c, field, LIMITS.command, true);
  if (CONTROL.test(String(c))) throw new Error(`${field} must be a single line without control characters (the owner presses Enter themselves)`);
  return t;
}

/** A check: one line, read-only, no sudo (it runs every few seconds as the agent user). */
export function checkCheck(c: unknown, field: string): string | null {
  if (c === undefined || c === null || c === "") return null;
  const t = str(c, field, LIMITS.check);
  if (!t) return null;
  if (CONTROL.test(String(c))) throw new Error(`${field} must be a single line`);
  if (/(^|[\s;&|(`$])sudo\b/.test(t)) throw new Error(`${field} can't use sudo: checks run every few seconds without privileges and must only read state`);
  return t;
}

function normalizeStep(x: StepInput, i: number, prev?: PlanStep): PlanStep {
  if (!x || typeof x !== "object") throw new Error(`step ${i + 1} must be an object`);
  const id = str(x.id, `step ${i + 1} id`, 40, true).toLowerCase();
  if (!STEP_ID.test(id)) throw new Error(`step id "${id}" must be lowercase letters, digits, - _ . (max 40)`);
  const where = `step "${id}"`;
  const title = str(x.title, `${where} title`, LIMITS.title, true);
  const why = str(x.why, `${where} why`, LIMITS.why);
  const instructions = str(x.instructions, `${where} instructions`, LIMITS.instructions);
  if (x.commands !== undefined && !Array.isArray(x.commands)) throw new Error(`${where} commands must be a list`);
  const commands = ((x.commands as unknown[] | undefined) ?? []).map((c, j) => checkCommand(c, `${where} command ${j + 1}`));
  if (commands.length > LIMITS.commands) throw new Error(`${where} has too many commands (max ${LIMITS.commands})`);
  const check = checkCheck(x.check, `${where} check`);
  let integration: PlanStep["integration"] = null;
  if (x.integration !== undefined && x.integration !== null && x.integration !== "") {
    const iid = str(x.integration, `${where} integration`, 40);
    if (!ID_RE.test(iid)) throw new Error(`${where} integration "${iid}" isn't an integration id`);
    const st = x.integration_step === undefined || x.integration_step === null || x.integration_step === "" ? null : str(x.integration_step, `${where} integration_step`, 40);
    if (st !== null && !STEP_ID.test(st)) throw new Error(`${where} integration_step "${st}" isn't a step id`);
    integration = { id: iid, step: st };
  }
  const human = x.human === true;
  // Keep progress when a step comes back unchanged in its check (set_plan again, or an edit of its text).
  const same = prev && prev.check === check && JSON.stringify(prev.integration) === JSON.stringify(integration);
  return {
    id, title, why, instructions, commands, check, human, integration,
    status: same ? prev!.status : "pending",
    done_by: same ? prev!.done_by : null,
    done_at: same ? prev!.done_at : null,
    note: same ? prev!.note : null,
    last_check: same ? prev!.last_check : null,
    nudged: prev?.nudged ?? false,
  };
}

function uniqueIds(steps: PlanStep[]) {
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.id)) throw new Error(`step id "${s.id}" is used twice`);
    seen.add(s.id);
  }
  if (steps.length > LIMITS.steps) throw new Error(`a plan has at most ${LIMITS.steps} steps`);
}

// --- storage -----------------------------------------------------------------------------------------

export function getPlan(instanceId: string): Plan | null {
  const r = get<{ instance_id: string; title: string; steps: string; created_at: string; updated_at: string }>(
    `SELECT * FROM setup_plans WHERE instance_id = ?`, instanceId);
  if (!r) return null;
  let steps: PlanStep[] = [];
  try { steps = JSON.parse(r.steps); } catch { /* corrupt: empty */ }
  return { instance_id: r.instance_id, title: r.title, steps, created_at: r.created_at, updated_at: r.updated_at };
}

/** Persist the plan; publish to the page unless the change is internal bookkeeping (quiet). */
function save(p: Plan, opts: { quiet?: boolean } = {}) {
  p.updated_at = now();
  run(
    `INSERT INTO setup_plans (instance_id, title, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (instance_id) DO UPDATE SET title = excluded.title, steps = excluded.steps, updated_at = excluded.updated_at`,
    p.instance_id, p.title, JSON.stringify(p.steps), p.created_at, p.updated_at,
  );
  if (!opts.quiet) publish({ type: "setup.plan", instanceId: p.instance_id, plan: planView(p.instance_id) });
  return p;
}

/** The pointer: the first step that isn't done or skipped. */
export function currentStep(p: Plan | null): PlanStep | null {
  return p?.steps.find((s) => s.status === "pending" || s.status === "failed") ?? null;
}

export function planView(instanceId: string): PlanView | null {
  const p = getPlan(instanceId);
  if (!p) return null;
  const c = checker;
  const checking: Record<string, string> = {};
  const checkedAt: Record<string, string> = {};
  for (const s of p.steps) {
    const l = c?.liveOf(instanceId, s.id);
    if (l?.since && l.shown) checking[s.id] = new Date(l.since).toISOString(); // background polls stay invisible
    if (l?.at) checkedAt[s.id] = new Date(l.at).toISOString();
    else if (s.last_check) checkedAt[s.id] = s.last_check.at;
  }
  return {
    ...p, current: currentStep(p)?.id ?? null, checking, checked_at: checkedAt, interval_ms: c?.intervalMs ?? 3000,
    done_count: p.steps.filter((s) => s.status === "done" || s.status === "skipped").length, total: p.steps.length,
  };
}

export function setPlan(instanceId: string, title: unknown, steps: unknown): Plan {
  const t = str(title, "title", LIMITS.title, true);
  if (!Array.isArray(steps) || !steps.length) throw new Error("steps must be a non-empty list");
  const prev = getPlan(instanceId);
  const old = new Map((prev?.steps ?? []).map((s) => [s.id, s]));
  const next = steps.map((x, i) => normalizeStep(x as StepInput, i, old.get(String((x as any)?.id ?? "").trim().toLowerCase())));
  uniqueIds(next);
  return save({ instance_id: instanceId, title: t, steps: next, created_at: prev?.created_at ?? now(), updated_at: now() });
}

export function addSteps(instanceId: string, steps: unknown, after?: string | null): Plan {
  const p = getPlan(instanceId);
  if (!p) throw new Error("There's no plan yet: call set_plan first");
  if (!Array.isArray(steps) || !steps.length) throw new Error("steps must be a non-empty list");
  const add = steps.map((x, i) => normalizeStep(x as StepInput, i));
  let at = p.steps.length;
  if (after) {
    const i = p.steps.findIndex((s) => s.id === after);
    if (i < 0) throw new Error(`No step "${after}" in the plan`);
    at = i + 1;
  }
  const next = [...p.steps.slice(0, at), ...add, ...p.steps.slice(at)];
  uniqueIds(next);
  p.steps = next;
  return save(p);
}

export type StepPatch = StepInput & { status?: unknown; note?: unknown };

/** The agent edits a step (any field, or its status with a note). */
export function updateStep(instanceId: string, id: string, patch: StepPatch): Plan {
  const p = getPlan(instanceId);
  if (!p) throw new Error("There's no plan yet: call set_plan first");
  const i = p.steps.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`No step "${id}" in the plan (steps: ${p.steps.map((s) => s.id).join(", ")})`);
  const cur = p.steps[i];
  const merged: StepInput = {
    id: cur.id,
    title: patch.title ?? cur.title, why: patch.why ?? cur.why, instructions: patch.instructions ?? cur.instructions,
    commands: patch.commands ?? cur.commands, check: patch.check === undefined ? cur.check : patch.check,
    human: patch.human === undefined ? cur.human : patch.human,
    integration: patch.integration === undefined ? cur.integration?.id : patch.integration,
    integration_step: patch.integration_step === undefined ? cur.integration?.step : patch.integration_step,
  };
  const next = normalizeStep(merged, i, cur);
  if (patch.status !== undefined) {
    const st = String(patch.status);
    if (!["pending", "done", "skipped", "failed"].includes(st)) throw new Error("status is pending, done, skipped or failed");
    next.status = st as StepStatus;
    next.done_by = st === "done" || st === "skipped" ? "agent" : null;
    next.done_at = st === "done" || st === "skipped" ? now() : null;
  }
  if (patch.note !== undefined) next.note = str(patch.note, "note", LIMITS.note) || null;
  p.steps[i] = next;
  return save(p);
}

/** Record a check result on a step; marks it done when it passed. Returns whether it just turned done. */
function recordCheck(instanceId: string, stepId: string, r: CheckResult, opts: { explicit: boolean }) {
  const p = getPlan(instanceId);
  const s = p?.steps.find((x) => x.id === stepId);
  if (!p || !s) return { turnedDone: false, step: null as PlanStep | null, plan: p };
  const prev = s.last_check;
  let changed = !prev || prev.ok !== r.ok || prev.output !== r.output || prev.timed_out !== r.timed_out;
  let turnedDone = false;
  if (r.ok && (s.status === "pending" || s.status === "failed")) {
    s.status = "done"; s.done_by = "check"; s.done_at = r.at; turnedDone = true; changed = true;
  } else if (!r.ok && opts.explicit && s.status === "pending") {
    // The owner pressed "Check now" and it isn't done: show it as failed (the poll keeps going).
    s.status = "failed"; changed = true;
  }
  if (changed) {
    s.last_check = r;
    save(p);
  }
  return { turnedDone, step: s, plan: p };
}

// --- running checks -----------------------------------------------------------------------------------

export type RunCommand = (cmd: string, timeoutMs: number) => Promise<{ ok: boolean; code: number | null; output: string; timedOut: boolean }>;

/** The environment checks run with: the essentials, never the portal's secrets. */
export function checkEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TERM: "dumb", NO_COLOR: "1", GH_PROMPT_DISABLED: "1", AWS_PAGER: "", PAGER: "cat" };
  for (const k of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TZ", "AGENTBOX_CONFIG", "XDG_RUNTIME_DIR"]) if (from[k] !== undefined) env[k] = from[k];
  return env;
}

/** `bash -lc <cmd>` as the portal's own user (the agent user); the process group dies at the timeout. */
export const shellCheck: RunCommand = (cmd, timeoutMs) => new Promise((resolve) => {
  const child = spawn("bash", ["-lc", cmd], { env: checkEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: process.env.HOME ?? os.homedir() });
  let out = "";
  const take = (b: Buffer) => { if (out.length < MAX_OUTPUT * 2) out += b.toString("utf8"); };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, timeoutMs);
  const done = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ ok: !timedOut && code === 0, code: timedOut ? null : code, output: out, timedOut });
  };
  child.on("error", (e) => { out += String(e.message); done(127); });
  child.on("close", (code) => done(code));
});

/** Output as stored and shown: redacted, ANSI-free, the last MAX_OUTPUT characters. */
export function capOutput(s: string) {
  const clean = redactSecrets(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n")).trimEnd();
  return clean.length > MAX_OUTPUT ? `…${clean.slice(-MAX_OUTPUT)}` : clean;
}

export type CheckerDeps = {
  run?: RunCommand;
  /** An integration step's (or the whole integration's) state from the CLI. */
  integrationCheck?: (id: string, step: string | null) => Promise<{ ok: boolean; output: string }>;
  /** Tell the agent (queue a short note in its thread). */
  nudge: (instanceId: string, display: string, prompt: string) => void;
  /** Setup sessions whose plans are polled (live, not retired). */
  liveInstances?: () => string[];
  intervalMs?: number;
  timeoutMs?: number;
  debounceMs?: number;
  concurrency?: number;
  clock?: () => number;
};

type Live = { since: number | null; at: number | null; shown?: boolean };

export type PlanChecker = ReturnType<typeof createPlanChecker>;

export function createPlanChecker(deps: CheckerDeps) {
  const runCmd = deps.run ?? shellCheck;
  const intervalMs = deps.intervalMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const debounceMs = deps.debounceMs ?? 4000;
  const concurrency = deps.concurrency ?? 4;
  const clock = deps.clock ?? Date.now;
  const live = new Map<string, Live>();
  const key = (i: string, s: string) => `${i}\u0000${s}`;
  let running = 0;
  let timer: NodeJS.Timeout | null = null;
  const pendingNudges = new Map<string, { steps: { id: string; how: "check" | "owner-done" | "owner-skip" }[]; timer: NodeJS.Timeout }>();

  const defaultLive = () => all<{ instance_id: string }>(
    `SELECT p.instance_id FROM setup_plans p JOIN agents a ON a.id = p.instance_id WHERE a.retired_at IS NULL`,
  ).map((r) => r.instance_id);

  async function runOne(instanceId: string, step: PlanStep): Promise<CheckResult> {
    if (step.integration && !step.check) {
      if (!deps.integrationCheck) return { ok: false, code: null, output: "integration checks aren't available", at: new Date(clock()).toISOString(), timed_out: false };
      try {
        const r = await deps.integrationCheck(step.integration.id, step.integration.step);
        return { ok: r.ok, code: r.ok ? 0 : 1, output: capOutput(r.output), at: new Date(clock()).toISOString(), timed_out: false };
      } catch (e: any) {
        return { ok: false, code: null, output: capOutput(String(e?.message ?? e)), at: new Date(clock()).toISOString(), timed_out: false };
      }
    }
    const r = await runCmd(step.check!, timeoutMs).catch((e: any) => ({ ok: false, code: null, output: String(e?.message ?? e), timedOut: false }));
    return {
      ok: r.ok, code: r.code, timed_out: r.timedOut, at: new Date(clock()).toISOString(),
      output: capOutput(r.timedOut ? `${r.output}\n(the check timed out after ${Math.round(timeoutMs / 1000)} s)` : r.output),
    };
  }

  const checkable = (s: PlanStep | null | undefined): s is PlanStep => !!s && (!!s.check || !!s.integration);

  /** Run one step's check now and record it. explicit: the owner asked (a failure shows as failed). */
  async function check(instanceId: string, stepId: string, opts: { explicit?: boolean; quiet?: boolean } = {}) {
    const k = key(instanceId, stepId);
    const l = live.get(k) ?? { since: null, at: null };
    const p = getPlan(instanceId);
    const step = p?.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`No step "${stepId}"`);
    if (!checkable(step)) throw new Error("This step has no check; mark it done instead");
    if (l.since) return { result: step.last_check, turnedDone: false, busy: true };
    l.since = clock();
    // Only a check the owner asked for is shown as "checking"; the background poll is silent and the
    // page changes only when a result changes the step (recordCheck saves, and publishes, only then).
    l.shown = !!opts.explicit;
    live.set(k, l);
    running++;
    if (l.shown) publish({ type: "setup.check", instanceId, stepId, running: true, at: new Date(l.since).toISOString() });
    let res: CheckResult;
    try {
      res = await runOne(instanceId, step);
    } finally {
      running--;
      l.since = null;
      l.at = clock();
    }
    // The step may have changed (a new check) while this one ran: drop a stale result.
    const fresh = getPlan(instanceId)?.steps.find((s) => s.id === stepId);
    let turnedDone = false;
    if (fresh && fresh.check === step.check && JSON.stringify(fresh.integration) === JSON.stringify(step.integration)) {
      turnedDone = recordCheck(instanceId, stepId, res, { explicit: !!opts.explicit }).turnedDone;
      if (turnedDone && !opts.quiet) scheduleNudge(instanceId, stepId, "check");
    }
    if (l.shown) publish({ type: "setup.check", instanceId, stepId, running: false, at: new Date(l.at!).toISOString(), ok: res.ok });
    l.shown = false;
    return { result: res, turnedDone, busy: false };
  }

  /** Every pending step's check once (after set_plan): steps already done get ticked. No nudges. */
  async function initialPass(instanceId: string, budgetMs = 15_000) {
    const p = getPlan(instanceId);
    if (!p) return [];
    const todo = p.steps.filter((s) => checkable(s) && (s.status === "pending" || s.status === "failed") && !s.last_check);
    const results: { id: string; ok: boolean; output: string }[] = [];
    const work = (async () => {
      for (let i = 0; i < todo.length; i += concurrency) {
        const batch = todo.slice(i, i + concurrency);
        const rs = await Promise.all(batch.map((s) => check(instanceId, s.id, { quiet: true }).catch(() => null)));
        rs.forEach((r, j) => { if (r?.result) results.push({ id: batch[j].id, ok: r.result.ok, output: r.result.output }); });
      }
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, budgetMs).unref?.())]);
    // Steps that passed now were never waited on: no automatic note for them later.
    const after = getPlan(instanceId);
    if (after) {
      let dirty = false;
      for (const r of results) {
        const s = after.steps.find((x) => x.id === r.id);
        if (r.ok && s && !s.nudged) { s.nudged = true; dirty = true; }
      }
      if (dirty) save(after, { quiet: true }); // the nudge flag isn't shown
    }
    return results;
  }

  /** One poll: the current step of every live plan, when due. */
  function tick() {
    const ids = (deps.liveInstances ?? defaultLive)();
    for (const instanceId of ids) {
      if (running >= concurrency) return;
      const step = currentStep(getPlan(instanceId));
      if (!checkable(step)) continue;
      const l = live.get(key(instanceId, step.id));
      if (l?.since) continue;
      if (l?.at && clock() - l.at < intervalMs - 50) continue;
      void check(instanceId, step.id).catch(() => {});
    }
  }

  // --- telling the agent (debounced, at most once per step) ------------------------------------------
  function scheduleNudge(instanceId: string, stepId: string, how: "check" | "owner-done" | "owner-skip") {
    const p = getPlan(instanceId);
    const s = p?.steps.find((x) => x.id === stepId);
    if (!p || !s || s.nudged) return false;
    s.nudged = true; // claimed now, so a second pass or click can't queue another
    save(p, { quiet: true }); // bookkeeping only: nothing on the page changes
    const cur = pendingNudges.get(instanceId);
    if (cur) clearTimeout(cur.timer);
    const steps = [...(cur?.steps ?? []), { id: stepId, how }];
    const t = setTimeout(() => fire(instanceId), debounceMs);
    t.unref?.();
    pendingNudges.set(instanceId, { steps, timer: t });
    return true;
  }

  function fire(instanceId: string) {
    const pending = pendingNudges.get(instanceId);
    pendingNudges.delete(instanceId);
    const p = getPlan(instanceId);
    if (!pending || !p) return;
    const items = pending.steps.map((x) => ({ ...x, step: p.steps.find((s) => s.id === x.id) })).filter((x) => x.step);
    if (!items.length) return;
    const next = currentStep(p);
    const verb = (how: string) => (how === "check" ? "passed its check" : how === "owner-skip" ? "was skipped by the owner" : "was marked done by the owner");
    const display = [
      ...items.map((x) => `${x.how === "owner-skip" ? "─" : "✔"} ${x.step!.title} ${verb(x.how)}${x.how === "check" && x.step!.check ? ` (${x.step!.check})` : ""}.`),
      next ? `Next: ${next.title}.` : "Every step of the plan is done.",
    ].join("\n");
    const prompt = [
      `[agentbox setup] Plan update for "${p.title}":`,
      ...items.map((x) => `- Step "${x.id}" (${x.step!.title}) ${verb(x.how)}.${x.how === "check" && x.step!.last_check?.output ? ` Check output: ${x.step!.last_check.output.split("\n").slice(-3).join(" | ")}` : ""}`),
      next
        ? `The pointer is now on step "${next.id}" (${next.title})${next.human ? ", which the owner does" : ", which is yours to do"}.`
        : "Every step is done or skipped.",
      next
        ? "Reply briefly: confirm what just finished and guide the owner through the next step (or do it, if it's yours). Read the terminal only if you need to."
        : "Reply briefly: verify the end result (e.g. integration verify), propose role mappings if relevant, and summarize.",
    ].join("\n");
    try { deps.nudge(instanceId, display, prompt); } catch { /* the session may be gone */ }
  }

  /** The owner's buttons: Check now, Skip, Mark done, Reopen. */
  async function ownerAction(instanceId: string, stepId: string, action: string) {
    const p = getPlan(instanceId);
    if (!p) throw new Error("This setup session has no plan");
    const s = p.steps.find((x) => x.id === stepId);
    if (!s) throw new Error(`No step "${stepId}"`);
    if (action === "check") return (await check(instanceId, stepId, { explicit: true })).result;
    if (action === "skip" || action === "done") {
      s.status = action === "skip" ? "skipped" : "done";
      s.done_by = "owner"; s.done_at = now();
      save(p);
      scheduleNudge(instanceId, stepId, action === "skip" ? "owner-skip" : "owner-done");
      return null;
    }
    if (action === "reopen") {
      s.status = "pending"; s.done_by = null; s.done_at = null; s.last_check = null;
      save(p);
      return null;
    }
    throw new Error("action is check, skip, done or reopen");
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, Math.min(1000, intervalMs));
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const n of pendingNudges.values()) clearTimeout(n.timer);
    pendingNudges.clear();
  }

  return {
    tick, check, initialPass, ownerAction, scheduleNudge, start, stop, intervalMs,
    liveOf: (instanceId: string, stepId: string) => live.get(key(instanceId, stepId)) ?? null,
    /** Fire pending notes now (tests). */
    flush: () => { for (const id of [...pendingNudges.keys()]) { clearTimeout(pendingNudges.get(id)!.timer); fire(id); } },
  };
}

let checker: PlanChecker | null = null;
export const setPlanChecker = (c: PlanChecker | null) => { checker?.stop(); checker = c; };
export const planChecker = () => checker;
