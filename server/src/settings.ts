import type { FastifyInstance } from "fastify";
import { get, now, run } from "./db.ts";
import { publish } from "./bus.ts";

/**
 * The owner's settings (portal → Settings). For now one: how many tasks may be live at once
 * (every live instance is a Claude session and a process tree on this VM, so the cap protects its
 * memory and the Claude plan). Stored in the database, read on every check, so a change applies
 * straight away.
 */

run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);

export const DEFAULT_LIVE_TASKS = 40;
export const MIN_LIVE_TASKS = 5;
export const MAX_LIVE_TASKS = 1000;

const read = (key: string) => get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key)?.value ?? null;
const write = (key: string, value: string) =>
  run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, value, now());

/** How many tasks (live instances) may run at once. */
export function liveTaskLimit(): number {
  const n = Number(read("max_live_tasks"));
  return Number.isInteger(n) && n >= MIN_LIVE_TASKS && n <= MAX_LIVE_TASKS ? n : DEFAULT_LIVE_TASKS;
}

export const liveTaskCount = () =>
  (get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents WHERE base_agent_id IS NOT NULL AND retired_at IS NULL`)?.n ?? 0) as number;

/** Starting one more task would pass the limit. `reason` lets the portal link to Settings. */
export class LiveLimitError extends Error {
  statusCode = 409;
  reason = "live_task_limit";
  constructor(public live: number, public limit: number) {
    super(`There are already ${live} live tasks, the limit (${limit}). Finish some, or raise the limit in Settings.`);
  }
}

export function settingsView() {
  return {
    max_live_tasks: liveTaskLimit(), default_max_live_tasks: DEFAULT_LIVE_TASKS, min_live_tasks: MIN_LIVE_TASKS, limit_live_tasks: MAX_LIVE_TASKS,
    live_tasks: liveTaskCount(),
  };
}

export function updateSettings(body: any) {
  const httpError = (m: string) => Object.assign(new Error(m), { statusCode: 400 });
  if (body?.max_live_tasks !== undefined) {
    const n = Number(body.max_live_tasks);
    if (!Number.isInteger(n) || n < MIN_LIVE_TASKS || n > MAX_LIVE_TASKS) throw httpError(`The live task limit must be a whole number from ${MIN_LIVE_TASKS} to ${MAX_LIVE_TASKS}`);
    write("max_live_tasks", String(n));
  }
  const view = settingsView();
  publish({ type: "settings.updated", settings: view } as any);
  return view;
}

export function registerSettingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => settingsView());
  app.put("/api/settings", async (req) => updateSettings(req.body));
}
