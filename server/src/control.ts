import { get, now, run } from "./db.ts";
import { publish } from "./bus.ts";

/**
 * Two owner controls over the whole team:
 * - the shared screen lock: one agent (or the owner) drives the GUI at a time;
 * - Pause all: no new turns start until the owner resumes.
 */

// --- shared screen lock --------------------------------------------------------

export type DisplayHolder = { holder: string; reason: string; since: string; last_used: string; task_id: string | null } | null;

const IDLE_RELEASE_MS = 10 * 60_000; // an agent that stops using the screen loses it after this
let display: DisplayHolder = null;

export const displayState = () => display;

function setDisplay(next: DisplayHolder) {
  display = next;
  publish({ type: "display.updated", display });
}

/**
 * Try to use the screen as `holder` (an agent id, or "owner"). Returns null when granted,
 * or the current holder when someone else has it.
 */
export function useDisplay(holder: string, reason: string, taskId: string | null): DisplayHolder {
  if (display && display.holder !== holder) {
    const idle = Date.now() - new Date(display.last_used).getTime();
    const ownerHolds = display.holder === "owner";
    if (ownerHolds || idle < IDLE_RELEASE_MS) return display;
  }
  const t = now();
  const same = display?.holder === holder;
  setDisplay({ holder, reason: same && !reason ? display!.reason : reason, since: same ? display!.since : t, last_used: t, task_id: taskId });
  return null;
}

/** The owner takes the screen, even from an agent mid-task; agents are refused until released. */
export function takeDisplay() {
  const t = now();
  setDisplay({ holder: "owner", reason: "The owner took control", since: t, last_used: t, task_id: null });
}

export function releaseDisplay(holder?: string) {
  if (!display) return;
  if (holder && display.holder !== holder) return;
  setDisplay(null);
}

// --- pause all -------------------------------------------------------------------

let paused = get<{ value: string }>(`SELECT value FROM meta WHERE key = 'paused'`)?.value === "1";
const waiters: (() => void)[] = [];

export const isPaused = () => paused;

export function setPaused(value: boolean) {
  paused = value;
  run(`INSERT INTO meta (key, value) VALUES ('paused', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, value ? "1" : "0");
  publish({ type: "paused", paused: value });
  if (!value) waiters.splice(0).forEach((w) => w());
}

/** Resolves immediately, or when the owner resumes. */
export function whenRunning(): Promise<void> {
  return paused ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve();
}
