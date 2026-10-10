import { evalWhen, isOn, resolveProfile, type ModuleDef, type StepDef } from "./manifest.ts";

/**
 * The roadmap state machine (docs/SETUP-PLAN.md § 4). Pure: it turns the manifests, the config,
 * the latest check results and what is being worked on into the state of every step.
 *
 *   pending ○   not started, or waiting for an earlier step
 *   running ●   the setup agent (or a Retry) is installing / verifying this module right now
 *   human   ⏸   a gate whose earlier steps are done and whose check isn't green yet: your turn
 *   done    ✔   its check passed. Nothing else ever marks a step done.
 *   failed  ✖   an install / verify of this module finished, and this step's check still fails
 *   disabled ─  the module isn't in the profile
 */

export type StepState = "pending" | "running" | "human" | "done" | "failed" | "disabled";

export type CheckResult = { ok: boolean; code: number | null; output: string; at: number; timedOut?: boolean };

/** The latest install / verify of a module (by the setup agent or a Retry). */
export type Attempt = { status: "running" | "ok" | "failed"; what: string; error?: string; at: number };

export type StepView = {
  key: string; // `${module}.${step}`
  module: string;
  id: string;
  title: string;
  human: boolean;
  state: StepState;
  check?: string;
  instructions?: string;
  copy?: string;
  /** Why it failed (the install's error, or the check's output). */
  error?: string;
  checkedAt?: number;
};

export type ModuleView = {
  id: string;
  title: string;
  description: string;
  optional: boolean;
  depends: string[];
  enabled: boolean;
  /** On only because something enabled depends on it. */
  implied: boolean;
  state: StepState;
  steps: StepView[];
};

export type RoadmapInput = {
  modules: ModuleDef[];
  config: any;
  checks: Map<string, CheckResult>;
  attempts: Map<string, Attempt>;
  /** The modules the agent is running a command for right now. */
  active?: Set<string>;
};

export const stepKey = (m: string, s: string) => `${m}.${s}`;

/** The steps of a module that apply under this config (`when:` true). */
export const applicableSteps = (m: ModuleDef, conf: any) => m.steps.filter((s) => evalWhen(conf, s.when));

/** Every check the runner should poll: the applicable steps of the modules in the profile. */
export function checksToRun(mods: ModuleDef[], conf: any): { key: string; check: string }[] {
  const order = resolveProfile(mods, conf).order;
  const byId = new Map(mods.map((m) => [m.id, m]));
  const out: { key: string; check: string }[] = [];
  for (const id of order) {
    const m = byId.get(id)!;
    for (const s of applicableSteps(m, conf)) if (s.check) out.push({ key: stepKey(m.id, s.id), check: s.check });
  }
  return out;
}

const clip = (s: string, n = 1200) => (s.length > n ? `…${s.slice(-n)}` : s);

function moduleSteps(m: ModuleDef, conf: any, inp: RoadmapInput, inProfile: boolean): StepView[] {
  const attempt = inp.attempts.get(m.id);
  const working = inp.active?.has(m.id) || attempt?.status === "running";
  const out: StepView[] = [];
  let blocked = false; // an earlier step isn't done yet
  let gateOpen = false; // an earlier human gate is still waiting
  let runningShown = false;
  let failShown = false; // only the first step that's still false after an attempt shows the failure
  for (const s of applicableSteps(m, conf)) {
    const key = stepKey(m.id, s.id);
    const r = inp.checks.get(key);
    const base: StepView = {
      key, module: m.id, id: s.id, title: s.title, human: !!s.human, state: "pending",
      check: s.check, instructions: s.instructions, copy: s.copy, checkedAt: r?.at,
    };
    if (!inProfile) { out.push({ ...base, state: "disabled" }); continue; }
    if (r?.ok) { out.push({ ...base, state: "done" }); continue; }
    out.push({ ...base, ...stateOf(s, r, { blocked, gateOpen, working: !!working && !runningShown, attempt: failShown ? undefined : attempt }) });
    const last = out[out.length - 1];
    if (last.state === "running") runningShown = true;
    if (last.state === "failed") failShown = true;
    if (s.human) gateOpen = true;
    blocked = true;
  }
  return out;
}

function stateOf(
  s: StepDef, r: CheckResult | undefined,
  ctx: { blocked: boolean; gateOpen: boolean; working: boolean; attempt: Attempt | undefined },
): Pick<StepView, "state" | "error"> {
  if (s.human) {
    // Your turn only once everything before the gate in this module is done (no gh login before gh).
    return { state: ctx.blocked ? "pending" : "human" };
  }
  if (ctx.gateOpen) return { state: "pending" }; // waits for the gate (e.g. verify after a login)
  if (ctx.working) return { state: "running" };
  const a = ctx.attempt;
  if (a && a.status !== "running") {
    // The module's install / verify ran and this step still isn't true: that's a failure.
    const why = a.status === "failed" && a.error ? a.error : r ? checkWhy(r) : "its check hasn't run yet";
    return { state: "failed", error: clip(why) };
  }
  return { state: "pending" };
}

export function checkWhy(r: CheckResult) {
  if (r.timedOut) return "the check timed out";
  const out = r.output.trim();
  return out ? `check failed (exit ${r.code}): ${out}` : `check failed (exit ${r.code})`;
}

const rollup = (steps: StepView[], enabled: boolean): StepState => {
  if (!enabled) return "disabled";
  const has = (s: StepState) => steps.some((x) => x.state === s);
  if (steps.length && steps.every((x) => x.state === "done")) return "done";
  if (has("running")) return "running";
  if (has("failed")) return "failed";
  if (has("human")) return "human";
  return "pending";
};

/** The whole roadmap: modules in the profile (dependency order), then the ones that are off. */
export function computeRoadmap(inp: RoadmapInput) {
  const conf = inp.config;
  const profile = resolveProfile(inp.modules, conf);
  const byId = new Map(inp.modules.map((m) => [m.id, m]));
  const views: ModuleView[] = [];
  const mk = (m: ModuleDef, inProfile: boolean): ModuleView => {
    const steps = moduleSteps(m, conf, inp, inProfile);
    return {
      id: m.id, title: m.title, description: m.description, optional: m.optional, depends: m.depends,
      enabled: inProfile, implied: inProfile && !isOn(conf, m.id), state: rollup(steps, inProfile), steps,
    };
  };
  for (const id of profile.order) views.push(mk(byId.get(id)!, true));
  for (const m of inp.modules) if (!profile.order.includes(m.id)) views.push(mk(m, false));
  const active = views.filter((v) => v.enabled);
  const steps = active.flatMap((v) => v.steps);
  return {
    modules: views,
    profile,
    /** The first step that needs the owner. */
    nextHuman: steps.find((s) => s.state === "human") ?? null,
    allDone: steps.length > 0 && steps.every((s) => s.state === "done"),
    counts: {
      total: steps.length,
      done: steps.filter((s) => s.state === "done").length,
      human: steps.filter((s) => s.state === "human").length,
      failed: steps.filter((s) => s.state === "failed").length,
    },
  };
}

export type Roadmap = ReturnType<typeof computeRoadmap>;

/** Human gates that just turned green between two roadmaps (the server then tells the agent "continue"). */
export function gatesTurnedGreen(before: Roadmap | null, after: Roadmap): StepView[] {
  if (!before) return [];
  const was = new Map(before.modules.flatMap((m) => m.steps).map((s) => [s.key, s.state]));
  return after.modules.flatMap((m) => m.steps).filter((s) => s.human && s.state === "done" && was.has(s.key) && was.get(s.key) !== "done");
}

/** Matches `agentbox module install|verify|enable <id>…` in a shell command (the agent's Bash calls). */
export function modulesInCommand(cmd: string, known: string[]): { verb: string; ids: string[] } | null {
  const m = /\bagentbox\s+module\s+(install|verify|enable)\s+([^;&|\n]*)/.exec(cmd);
  if (!m) return null;
  const words = m[2].trim().split(/\s+/).filter(Boolean);
  if (words.includes("--enabled")) return { verb: m[1], ids: known };
  const ids = words.filter((w) => known.includes(w));
  return ids.length ? { verb: m[1], ids } : null;
}
