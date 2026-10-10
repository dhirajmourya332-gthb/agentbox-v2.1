import { all, get } from "./db.ts";
import { publish, subscribe } from "./bus.ts";
import { getAgent, rootOf } from "./agents.ts";

/**
 * Live progress (docs/CONTRACTS-v2.md § A, backlog 11): one record per running task, saying in
 * plain words what the agent is doing now, whether it looks stuck, and (for long turns) a short
 * rule-based summary. Derived from the task's steps in the database plus an in-memory heartbeat
 * from the runner, so it also works for rows it didn't see being written.
 */

export type Progress = {
  agent_id: string; task_id: string; root_id: string | null;
  group_id: string | null;
  activity: string;
  step: { name: string; summary: string; started_at: string } | null;
  started_at: string;
  last_step_at: string;
  state: "working" | "stalled";
  stalled_for_s: number | null;
  summary: string | null;
  /** Routine work only (contract G): the routine run this task belongs to. */
  run_id?: string | null;
};

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** Minutes without a step starting or finishing (or one shell step running) before a task counts as stalled. */
export const STALL_MIN = num(process.env.AGENTBOX_STALL_MIN ?? process.env.STALL_MIN, 10);
const STALL_MS = STALL_MIN * 60_000;
const TICK_MS = num(process.env.AGENTBOX_PROGRESS_TICK_MS, 30_000);
const SUMMARY_AFTER_MS = num(process.env.AGENTBOX_SUMMARY_AFTER_S, 300) * 1000; // turns longer than 5 min
const SUMMARY_EVERY_MS = num(process.env.AGENTBOX_SUMMARY_EVERY_S, 180) * 1000; // at most one every 3 min
const THROTTLE_MS = 2000; // at most one progress.updated per agent every 2 s

type StepRow = { id: string; seq: number; kind: string; name: string; summary: string; input: string | null; output: string | null;
  status: string; started_at: string; finished_at: string | null };

// ---------------------------------------------------------------------------------------------
// Plain words for a step.

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function parseInput(step: Pick<StepRow, "input">): any {
  try { return step.input ? JSON.parse(step.input) : {}; } catch { return {}; }
}

/** The work folder a command runs in: /work/web-app-4950/... → "web-app-4950". */
function workDir(cmd: string) {
  const m = cmd.match(/(?:\bcd\s+|\s-C\s+|--prefix[ =]|--cwd[ =]|--dir(?:ectory)?[ =])["']?\/work\/([A-Za-z0-9._-]+)/);
  return m?.[1] ?? null;
}

const prNumber = (cmd: string, verb: string) =>
  cmd.match(new RegExp(`\\bgh\\s+pr\\s+${verb}\\s+(?:[^|;&\\n]*?\\s)??#?(\\d+)\\b`))?.[1] ??
  cmd.match(new RegExp(`\\bgh\\s+pr\\s+${verb}\\b[^|;&\\n]*?/pull/(\\d+)`))?.[1] ?? null;

/** A shell command in plain words. */
export function shellActivity(cmd: string, description?: string): string {
  const c = cmd.trim();
  const where = workDir(c);
  const inWhere = where ? ` in ${where}` : "";
  const waits = /--watch\b|\b(while|until|sleep)\b/.test(c);
  let pr: string | null;
  if ((pr = prNumber(c, "checks")) !== null || /\bgh\s+pr\s+checks\b/.test(c)) {
    const target = pr ? ` for PR #${pr}` : "";
    return waits ? `Waiting on CI${target}` : `Checking CI${target}`;
  }
  if (/\bgh\s+run\s+watch\b/.test(c)) return "Waiting on CI";
  if (/\bgh\s+run\s+(view|list)\b/.test(c)) return "Checking CI runs";
  if ((pr = prNumber(c, "merge")) !== null || /\bgh\s+pr\s+merge\b/.test(c)) return pr ? `Merging PR #${pr}` : "Merging a pull request";
  if (/\bgh\s+pr\s+create\b/.test(c)) return "Opening a pull request";
  if ((pr = prNumber(c, "(?:view|diff|review)")) !== null || /\bgh\s+pr\s+(view|diff|review)\b/.test(c)) return pr ? `Reviewing PR #${pr}` : "Reviewing a pull request";
  if ((pr = prNumber(c, "comment")) !== null) return `Commenting on PR #${pr}`;
  if (/\bgh\s+issue\s+create\b/.test(c)) return "Filing an issue";
  const issue = c.match(/\bgh\s+issue\s+(?:view|comment|edit)\s+#?(\d+)/)?.[1];
  if (issue) return `Reading issue #${issue}`;
  if (/\bgh\s+api\b/.test(c)) return "Calling the GitHub API";
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnpx\s+(vitest|jest|playwright\s+test|mocha)\b|\b(pytest|vitest|jest|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmake\s+(test|check)\b|\bnode\s+--test\b|\bpython\d?\s+-m\s+(pytest|unittest)\b|\b(mvn|gradlew?)\b[^|;&]*\btest\b/.test(c)) {
    return `Running tests${inWhere}`;
  }
  if (/\b(npm|pnpm|yarn)\s+(install|ci|add)\b|\bpip3?\s+install\b|\bpoetry\s+install\b|\bbundle\s+install\b|\bgo\s+mod\s+download\b/.test(c)) return `Installing dependencies${inWhere}`;
  if (/\b(eslint|ruff|flake8|prettier|golangci-lint|rubocop)\b|\b(npm|pnpm|yarn)\s+(run\s+)?lint\b/.test(c)) return `Linting${inWhere}`;
  if (/\bdocker\s+(build|buildx)\b|\b(npm|pnpm|yarn)\s+(run\s+)?build\b|\b(tsc|vite\s+build|webpack)\b|\b(cargo|go)\s+build\b/.test(c)) return `Building${inWhere}`;
  if (/\bdocker(-compose|\s+compose)\b[^|;&]*\bup\b|\bdocker\s+run\b/.test(c)) return `Starting containers${inWhere}`;
  const git = (sub: string) => new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:${sub})\\b`).test(c);
  if (git("push")) return `Pushing to GitHub${inWhere}`;
  if (git("commit")) return `Committing changes${inWhere}`;
  if (git("clone")) return "Cloning a repository";
  if (git("worktree\\s+add")) return "Setting up a worktree";
  if (git("rebase|merge|cherry-pick")) return `Merging branches${inWhere}`;
  if (git("pull|fetch")) return `Updating from GitHub${inWhere}`;
  if (/\baws\s/.test(c)) return "Running an AWS command";
  if (/\b(psql|mysql|sqlite3)\b/.test(c)) return "Querying a database";
  if (/\bssh\s/.test(c)) return "Working on a remote machine";
  const host = c.match(/\bcurl\b[^|;&]*?https?:\/\/([^/\s"':]+)/)?.[1];
  if (host) return `Calling ${host}`;
  if (/^(sleep\s+\d+|while\b|until\b)/.test(c)) return "Waiting";
  if (description?.trim()) return short(cap(description.trim()), 80);
  if (/^(ls|cat|head|tail|find|grep|rg|wc|tree)\b/.test(c.replace(/^cd\s+\S+\s*&&\s*/, ""))) return `Looking through files${inWhere}`;
  return `Running ${short(c.split("\n")[0], 60)}`;
}

/** A step in plain words: "Waiting on CI for PR #4984", "Running tests in web-app-4950", "Reading app.ts". */
export function activityFor(step: Pick<StepRow, "kind" | "name" | "summary" | "input">): string {
  const input = parseInput(step);
  const s = step.summary ?? "";
  switch (step.kind) {
    case "shell": return shellActivity(typeof input.command === "string" ? input.command : s, input.description);
    case "read": return s ? `Reading ${base(s)}` : "Reading files";
    case "edit": return s ? `${step.name === "Write" ? "Writing" : "Editing"} ${base(s)}` : "Editing files";
    case "search": return "Searching the code";
    case "browser": return s ? `In the browser: ${short(s, 60)}` : "Using the browser";
    case "web": return step.name === "WebSearch" ? `Searching the web${s ? ` for "${short(s, 50)}"` : ""}` : `Reading ${s.match(/^https?:\/\/([^/]+)/)?.[1] ?? "a web page"}`;
    case "plan": return "Planning";
    case "skill": return step.name === "Propose" ? "Proposing a skill" : `Using the ${s || "a"} skill`;
    case "routine": return "Scheduling a routine";
    case "delegate": {
      const to = s.match(/^→\s*([^:]+):/)?.[1]?.trim();
      return step.name === "Message" ? `Messaging ${to ?? "a teammate"}` : `Delegating to ${to ?? "a teammate"}`;
    }
    case "agent": return step.name === "Retire" ? `Closing ${s || "a task"}` : `Running a subagent${s ? `: ${short(s, 50)}` : ""}`;
    case "meta": return step.name === "Check task" ? "Checking on a delegated task" : step.name === "Tool search" ? "Looking up tools" : "Checking the team";
    default: return `Using ${step.name}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Rule-based summaries for long turns.

type Check = { name: string; status: "pass" | "fail" | "pending" | "skip" };
const CHECK_WORD: Record<string, Check["status"]> = {
  pass: "pass", fail: "fail", pending: "pending", skipping: "skip", skipped: "skip", cancel: "fail", cancelled: "fail",
};
const CHECK_MARK: Record<string, Check["status"]> = { "✓": "pass", "X": "fail", "✗": "fail", "×": "fail", "*": "pending", "-": "skip" };

/** `gh pr checks` output (non-TTY tab-separated, or TTY with ✓/X/* marks). Later blocks win (watch loops). */
export function parseChecks(output: string): Check[] | null {
  const found = new Map<string, Check["status"]>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    const tab = line.split("\t");
    if (tab.length >= 2 && CHECK_WORD[tab[1].trim().toLowerCase()]) {
      found.set(tab[0].trim(), CHECK_WORD[tab[1].trim().toLowerCase()]);
      continue;
    }
    const m = line.match(/^\s*([✓X✗×*-])\s+(.+?)(?:\s{2,}|\t|$)/);
    if (m && m[2] && !/^-+$/.test(m[2])) found.set(m[2].trim(), CHECK_MARK[m[1]]);
  }
  if (found.size) return [...found].map(([name, status]) => ({ name, status }));
  // Just the TTY header: "0 cancelled, 3 failing, 12 successful, 0 skipped, and 5 pending checks".
  const n = (re: RegExp) => Number(output.match(re)?.[1] ?? 0);
  const fail = n(/(\d+)\s+failing/) + n(/(\d+)\s+cancelled/), pend = n(/(\d+)\s+pending/), pass = n(/(\d+)\s+successful/);
  if (fail + pend + pass === 0) return null;
  return [
    ...Array.from({ length: fail }, (_, i) => ({ name: `check ${i + 1}`, status: "fail" as const })),
    ...Array.from({ length: pend }, (_, i) => ({ name: `pending ${i + 1}`, status: "pending" as const })),
    ...Array.from({ length: pass }, (_, i) => ({ name: `passed ${i + 1}`, status: "pass" as const })),
  ];
}

export function checksSummary(checks: Check[], named = true): string {
  const failed = checks.filter((c) => c.status === "fail");
  const pending = checks.filter((c) => c.status === "pending").length;
  const passed = checks.filter((c) => c.status === "pass").length;
  const parts: string[] = [];
  if (failed.length) {
    const names = named ? failed.slice(0, 3).map((c) => c.name).join(", ") + (failed.length > 3 ? ` and ${failed.length - 3} more` : "") : "";
    parts.push(`${failed.length} check${failed.length === 1 ? "" : "s"} failed${names ? `: ${names}` : ""}`);
  }
  if (pending) parts.push(`${pending} pending`);
  if (!parts.length) return `All ${passed} checks passed`;
  if (!failed.length && passed) parts.push(`${passed} passed`);
  return parts.join("; ");
}

/** Test-runner totals: jest/vitest/pytest/mocha style "2 failed, 40 passed". */
function testsSummary(output: string): string | null {
  const tail = output.slice(-3000);
  const failed = [...tail.matchAll(/(\d+)\s+(?:failed|failing|failures?)\b/gi)].pop()?.[1];
  const passed = [...tail.matchAll(/(\d+)\s+(?:passed|passing)\b/gi)].pop()?.[1];
  if (failed === undefined && passed === undefined) return null;
  const f = Number(failed ?? 0), p = Number(passed ?? 0);
  return f ? `Tests: ${f} failed, ${p} passed` : `Tests: all ${p} passed`;
}

/** A short summary of a long turn from its recent steps (newest last). */
export function ruleSummary(steps: Pick<StepRow, "kind" | "name" | "summary" | "input" | "output" | "status">[]): string | null {
  const recent = steps.slice(-15).reverse();
  for (const s of recent) {
    if (s.kind !== "shell" || !s.output) continue;
    const cmd = String(parseInput(s).command ?? s.summary);
    if (/\bgh\s+pr\s+checks\b/.test(cmd)) {
      const checks = parseChecks(s.output);
      if (checks) return checksSummary(checks, !checks.every((c) => /^(check|pending|passed) \d+$/.test(c.name)));
    }
  }
  for (const s of recent) {
    if (s.kind !== "shell" || !s.output) continue;
    if (shellActivity(String(parseInput(s).command ?? s.summary)).startsWith("Running tests")) {
      const t = testsSummary(s.output);
      if (t) return t;
    }
  }
  const visible = steps.filter((s) => s.kind !== "meta");
  if (!visible.length) return null;
  const count = (k: string) => visible.filter((s) => s.kind === k).length;
  const bits = [
    [count("shell"), "command"], [count("edit"), "edit"], [count("read") + count("search"), "read"], [count("delegate"), "handoff"],
  ].filter(([n]) => (n as number) > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  let text = `${visible.length} step${visible.length === 1 ? "" : "s"} so far${bits.length ? `: ${bits.join(", ")}` : ""}`;
  const failed = steps.slice(-10).reverse().find((s) => s.status === "error" && s.kind === "shell");
  if (failed) text += `; last failure: ${short(failed.summary, 60)}`;
  return text;
}

// ---------------------------------------------------------------------------------------------
// The live records.

type Cached = { p: Progress; key: string; summaryAt: number; sent?: string };
const cache = new Map<string, Cached>();          // task id → last computed progress
const heartbeats = new Map<string, number>();     // task id → last SDK message of any kind (ms)
const textAt = new Map<string, number>();         // task id → last streamed text (ms)
const lastEmit = new Map<string, number>();       // agent id → last progress.updated (ms)
const trailing = new Map<string, ReturnType<typeof setTimeout>>(); // agent id → pending throttled emit
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

type StateListener = (e: { task_id: string; agent_id: string; state: "working" | "stalled" | "cleared"; progress: Progress | null }) => void;
const stateListeners: StateListener[] = [];
/** Called when a task becomes stalled, resumes working, or its turn ends. */
export function onProgressState(cb: StateListener) { stateListeners.push(cb); }
const notify = (e: Parameters<StateListener>[0]) => {
  for (const cb of stateListeners) { try { cb(e); } catch (err) { console.error("progress listener failed", err); } }
};

/** The runner calls this on every SDK message (including a subagent's), so long thinking or subagent work isn't "stalled". */
export function heartbeat(taskId: string) {
  heartbeats.set(taskId, Date.now());
}

/** Where a task shows: its task room (root instance) or its group. */
function placeOf(task: { thread_id: string | null; thread_kind: string | null; agent_id: string }) {
  if (task.thread_kind === "group" && task.thread_id) return { root_id: task.thread_id, group_id: task.thread_id };
  const agent = getAgent(task.agent_id);
  if (!agent?.base_agent_id) return { root_id: null, group_id: null };
  const root = rootOf(agent);
  const by = root.created_by ?? "";
  if (by.startsWith("group:")) return { root_id: by.slice(6), group_id: by.slice(6) };
  if (by.startsWith("routine:")) {
    let run_id: string | null = null;
    // The routine's latest started run (routineRuns.ts); a working task keeps that run active.
    try {
      run_id = get<{ id: string }>(
        `SELECT id FROM routine_runs WHERE routine_id = ? AND outcome = 'started' ORDER BY at DESC LIMIT 1`, by.slice(8),
      )?.id ?? null;
    } catch { /* no routine tables (tests that load progress alone) */ }
    return { root_id: null, group_id: null, run_id };
  }
  return { root_id: root.id, group_id: null };
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);
const iso = (t: number) => new Date(t).toISOString();

function compute(taskId: string, at: number): { p: Progress; summaryAt: number } | null {
  const task = get<{ id: string; agent_id: string; thread_id: string | null; thread_kind: string | null; status: string; started_at: string | null; created_at: string }>(
    `SELECT tasks.id, tasks.agent_id, tasks.thread_id, tasks.status, tasks.started_at, tasks.created_at, threads.kind AS thread_kind
     FROM tasks LEFT JOIN threads ON threads.id = tasks.thread_id WHERE tasks.id = ?`, taskId,
  );
  if (!task || task.status !== "running") return null;
  const started = task.started_at ?? task.created_at;
  const running = get<StepRow>(
    `SELECT id, seq, kind, name, summary, input, status, started_at, finished_at FROM steps
     WHERE task_id = ? AND status = 'running' AND kind != 'meta' ORDER BY seq DESC LIMIT 1`, taskId,
  ) ?? get<StepRow>(
    `SELECT id, seq, kind, name, summary, input, status, started_at, finished_at FROM steps
     WHERE task_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1`, taskId,
  );
  const times = get<{ s: string | null; f: string | null }>(`SELECT MAX(started_at) AS s, MAX(finished_at) AS f FROM steps WHERE task_id = ?`, taskId);
  const lastStep = Math.max(ms(times?.s), ms(times?.f), ms(started));
  const lastFinished = ms(times?.f);

  let activity: string;
  if (running) activity = activityFor(running);
  else if ((textAt.get(taskId) ?? 0) > Math.max(lastFinished, ms(times?.s))) activity = "Writing reply";
  else activity = "Thinking";

  // Stalled: nothing happened for STALL_MIN (no step started or finished, no SDK message), or one
  // shell step has run that long.
  const lastSign = Math.max(lastStep, heartbeats.get(taskId) ?? 0);
  const idleFor = at - lastSign;
  const shellFor = running?.kind === "shell" ? at - ms(running.started_at) : 0;
  const stalled = idleFor >= STALL_MS || shellFor >= STALL_MS;
  const prev = cache.get(taskId);

  // Summary: for long turns, recomputed at most every SUMMARY_EVERY_MS.
  let summary = prev?.p.summary ?? null;
  let summaryAt = prev?.summaryAt ?? 0;
  if (at - ms(started) >= SUMMARY_AFTER_MS && (!summaryAt || at - summaryAt >= SUMMARY_EVERY_MS)) {
    const recent = all<StepRow>(
      `SELECT * FROM (SELECT id, seq, kind, name, summary, input, output, status, started_at, finished_at FROM steps
       WHERE task_id = ? ORDER BY seq DESC LIMIT 60) ORDER BY seq`, taskId,
    );
    const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM steps WHERE task_id = ?`, taskId)?.n ?? recent.length;
    let s = ruleSummary(recent);
    if (s && total > recent.length) s = s.replace(/^\d+ steps? so far/, `${total} steps so far`);
    summary = s;
    summaryAt = at;
  }

  const place = placeOf(task);
  const p: Progress = {
    agent_id: task.agent_id, task_id: task.id, root_id: place.root_id, group_id: place.group_id,
    activity,
    step: running ? { name: running.name, summary: running.summary, started_at: running.started_at } : null,
    started_at: started,
    last_step_at: iso(lastStep),
    state: stalled ? "stalled" : "working",
    stalled_for_s: stalled ? Math.round(Math.max(idleFor, shellFor) / 1000) : null,
    summary,
    ...("run_id" in place ? { run_id: place.run_id } : {}),
  };
  return { p, summaryAt };
}

/** A running task's progress, computed from the database (null when it isn't running). */
export const computeProgress = (taskId: string, at = Date.now()) => compute(taskId, at)?.p ?? null;

const keyOf = (p: Progress) => JSON.stringify([p.activity, p.state, p.summary, p.step?.started_at ?? null, p.root_id, p.group_id, p.run_id ?? null]);

function emit(agentId: string) {
  trailing.delete(agentId);
  lastEmit.set(agentId, Date.now());
  for (const c of cache.values()) {
    if (c.p.agent_id !== agentId || c.key === c.sent) continue;
    c.sent = c.key;
    publish({ type: "progress.updated", progress: c.p });
  }
}

/** Publish a change, at most once per agent every THROTTLE_MS (the latest state wins). */
function schedule(agentId: string) {
  if (trailing.has(agentId)) return;
  const wait = THROTTLE_MS - (Date.now() - (lastEmit.get(agentId) ?? 0));
  if (wait <= 0) emit(agentId);
  else trailing.set(agentId, setTimeout(() => emit(agentId), wait));
}

function clear(taskId: string) {
  heartbeats.delete(taskId);
  textAt.delete(taskId);
  const c = cache.get(taskId);
  if (!c) return;
  cache.delete(taskId);
  publish({ type: "progress.cleared", agent_id: c.p.agent_id, task_id: taskId });
  notify({ task_id: taskId, agent_id: c.p.agent_id, state: "cleared", progress: null });
}

/** Recompute one task; publish if what the owner sees changed. */
function refresh(taskId: string, at = Date.now()) {
  const r = compute(taskId, at);
  if (!r) return clear(taskId);
  const prev = cache.get(taskId);
  const next: Cached = { p: r.p, key: keyOf(r.p), summaryAt: r.summaryAt, sent: prev?.sent };
  cache.set(taskId, next);
  if (prev ? prev.p.state !== r.p.state : r.p.state === "stalled") {
    notify({ task_id: taskId, agent_id: r.p.agent_id, state: r.p.state, progress: r.p });
  }
  if (next.key !== next.sent) schedule(r.p.agent_id);
}

function markDirty(taskId: string) {
  dirty.add(taskId);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      try { refresh(id); } catch (e) { console.error("progress refresh failed", id, e); }
    }
  }, 250);
}

/** Every 30 s: stalls, summaries, and tasks that started or ended without an event. */
export function tick(at = Date.now()) {
  const running = new Set(all<{ id: string }>(`SELECT id FROM tasks WHERE status = 'running'`).map((r) => r.id));
  for (const id of [...cache.keys()]) if (!running.has(id)) clear(id);
  for (const id of running) {
    try { refresh(id, at); } catch (e) { console.error("progress refresh failed", id, e); }
  }
}

/** Every running task's progress (GET /api/progress), oldest first. */
export function listProgress(): Progress[] {
  tick();
  return [...cache.values()].map((c) => c.p).sort((a, b) => a.started_at.localeCompare(b.started_at));
}

let started = false;
export function startProgress() {
  if (started) return;
  started = true;
  subscribe((e) => {
    switch (e.type) {
      case "step.updated":
        if (e.step?.task_id) { heartbeat(e.step.task_id); markDirty(e.step.task_id); }
        break;
      case "turn.delta": {
        textAt.set(e.taskId, Date.now());
        heartbeat(e.taskId);
        const c = cache.get(e.taskId);
        // Only recompute when the words would change (to "Writing reply") or a stall ends.
        if (!c || c.p.state === "stalled" || (!c.p.step && c.p.activity !== "Writing reply")) markDirty(e.taskId);
        break;
      }
      case "task.updated":
        if (!e.task?.id) break;
        if (e.task.status === "running") markDirty(e.task.id);
        else if (e.task.status !== "queued") clear(e.task.id);
        break;
    }
  });
  const timer = setInterval(() => { try { tick(); } catch (e) { console.error("progress tick failed", e); } }, TICK_MS);
  timer.unref();
  tick();
}
