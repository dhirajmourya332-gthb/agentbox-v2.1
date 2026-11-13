import { all, get, now } from "./db.ts";
import { health } from "./health.ts";
import { raiseAttention } from "./attention.ts";
import { ownerRequest, startRequest, OPEN, type SetupRequest } from "./setupRequests.ts";

/**
 * The watchdog: when an agentbox service (the shared display, VNC, the browser, the terminal) is down,
 * or the shared browser hangs (its service runs but it doesn't answer on CDP), agentbox starts a
 * helper (setup agent) session by itself to troubleshoot it. No click: the owner gets a "needs you"
 * item saying it started. The request completes when every check passes again.
 *
 * Calm by design: a problem must be seen on two checks in a row (restarts and updates pass), one
 * watchdog session at a time, at least 30 minutes between new ones, at most 6 a day.
 */

export type Problem = { key: string; title: string; detail: string; check: string };
export type WatchdogDeps = {
  probe: () => Promise<Problem[]>;
  start: (problems: Problem[]) => { request: SetupRequest; instance_id: string } | null;
  at: () => number;
};
export const WATCHDOG = { confirmChecks: 2, cooldownMs: 30 * 60_000, perDay: 6 };

const UNIT = /^agentbox-[a-z0-9-]+$/;
const BROWSER_CHECK = "curl -sf -m 5 http://127.0.0.1:9222/json/version >/dev/null";

/** What's wrong now, from the health check (services of enabled modules, the browser's CDP). */
export async function probe(): Promise<Problem[]> {
  const h = await health();
  const out: Problem[] = [];
  for (const [unit, state] of Object.entries(h.services as Record<string, string>)) {
    if (state === "active" || !UNIT.test(unit)) continue;
    out.push({ key: `service:${unit}`, title: `${unit} is ${state}`, detail: `systemd unit ${unit} is "${state}" (expected "active").`, check: `systemctl is-active --quiet ${unit}` });
  }
  if (h.browser && !h.browser.ok && !h.browser.disabled && !out.some((p) => p.key === "service:agentbox-chromium")) {
    out.push({ key: "browser", title: "the shared browser doesn't respond", detail: "agentbox-chromium runs, but the browser doesn't answer on CDP (http://127.0.0.1:9222/json/version, 1.5 s): it's hung or crashed inside.", check: BROWSER_CHECK });
  }
  return out;
}

const openWatchdog = () => all<SetupRequest>(`SELECT * FROM setup_requests WHERE source = 'watchdog' AND status IN (${OPEN.map(() => "?").join(",")})`, ...OPEN);
const lastWatchdogAt = () => get<{ at: string }>(`SELECT MAX(created_at) AS at FROM setup_requests WHERE source = 'watchdog'`)?.at ?? null;
const watchdogSince = (iso: string) => (get<{ n: number }>(`SELECT COUNT(*) AS n FROM setup_requests WHERE source = 'watchdog' AND created_at >= ?`, iso)?.n ?? 0) as number;

/** Opens the request and starts the helper on it. */
export function startHelper(problems: Problem[]) {
  const list = problems.map((p) => `- ${p.detail}`).join("\n");
  const request = ownerRequest({
    title: `Fix: ${problems.map((p) => p.title).join("; ")}`.slice(0, 120),
    why: "agentbox's watchdog found this on two checks in a row. Agents that need it (the shared browser, the screen, the terminal) are stuck until it's fixed.",
    for_setup_agent: `Troubleshoot and fix these on the VM:
${list}

How:
- Read the logs first: \`journalctl -u <unit> -n 100 --no-pager\`, \`systemctl status <unit>\`; for the browser also memory/disk (\`free -m\`, \`df -h\`) and stray Chromium processes.
- Fix the cause, then restart what's broken (\`sudo systemctl restart <unit>\`; the display stack is agentbox-xvfb → agentbox-wm → agentbox-vnc → agentbox-novnc, and agentbox-chromium needs the display). A hung browser: restart agentbox-chromium.
- An agent may be using the shared browser (the screen's holder): restarting it is still right when it doesn't answer.
- Don't change agentbox's configuration, security or modules to make it pass. If the fix needs the owner (a login, a decision, a reinstall), ask them in a short message.
- When it's healthy, call complete_setup_request with the cause and what you did (this request also completes by itself once every check passes).`,
    check: problems.map((p) => p.check).join(" && "),
  }, "watchdog");
  const started = startRequest(request.id);
  raiseAttention("question", started.instance_id, null, null, `agentbox started a helper: ${problems.map((p) => p.title).join("; ")}`.slice(0, 200));
  return { request: started.request, instance_id: started.instance_id };
}

const defaults: WatchdogDeps = { probe, start: startHelper, at: () => Date.now() };

/** One check. Returns what it did (for tests and the log). */
export function createWatchdog(deps: Partial<WatchdogDeps> = {}) {
  const d = { ...defaults, ...deps };
  let seen = new Map<string, number>(); // problem key → consecutive checks it was seen on
  return async function tick(): Promise<{ action: "none" | "waiting" | "busy" | "cooldown" | "limit" | "started"; problems: Problem[]; instance_id?: string }> {
    const problems = await d.probe();
    const next = new Map<string, number>();
    for (const p of problems) next.set(p.key, (seen.get(p.key) ?? 0) + 1);
    seen = next;
    if (!problems.length) return { action: "none", problems };
    const confirmed = problems.filter((p) => (seen.get(p.key) ?? 0) >= WATCHDOG.confirmChecks);
    if (!confirmed.length) return { action: "waiting", problems };
    if (openWatchdog().length) return { action: "busy", problems: confirmed };
    const t = d.at();
    const last = lastWatchdogAt();
    if (last && t - Date.parse(last) < WATCHDOG.cooldownMs) return { action: "cooldown", problems: confirmed };
    if (watchdogSince(new Date(t - 24 * 3600_000).toISOString()) >= WATCHDOG.perDay) return { action: "limit", problems: confirmed };
    const r = d.start(confirmed);
    return { action: "started", problems: confirmed, instance_id: r?.instance_id };
  };
}

let timer: NodeJS.Timeout | null = null;
export function startWatchdog(opts: { log?: (m: string) => void } = {}) {
  if (process.env.AGENTBOX_WATCHDOG === "0") return { stop() {} };
  const log = opts.log ?? ((m: string) => console.log(m));
  const tick = createWatchdog();
  const every = Number(process.env.AGENTBOX_WATCHDOG_MS ?? 60_000);
  let lastAction = "";
  const run = () => void tick().then((r) => {
    if (r.action === "started") log(`watchdog: started a helper (${r.instance_id}) for ${r.problems.map((p) => p.title).join("; ")} at ${now()}`);
    else if (r.action !== lastAction && (r.action === "limit" || r.action === "cooldown")) log(`watchdog: ${r.action}, not starting another helper for ${r.problems.map((p) => p.title).join("; ")}`);
    lastAction = r.action;
  }).catch((e) => log(`watchdog: ${e?.message ?? e}`));
  if (timer) clearInterval(timer);
  // The first check waits for the services to come up after a (re)start.
  const first = setTimeout(() => { run(); timer = setInterval(run, every); timer.unref(); }, Number(process.env.AGENTBOX_WATCHDOG_DELAY_MS ?? 2 * 60_000));
  first.unref();
  return { stop: () => { clearTimeout(first); if (timer) clearInterval(timer); timer = null; } };
}
