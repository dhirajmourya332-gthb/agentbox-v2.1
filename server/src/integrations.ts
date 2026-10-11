import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { all, run } from "./db.ts";
import { publish } from "./bus.ts";
import { config, moduleOn, onModulesChange, paths, refreshModules } from "./config.ts";
import { sudoActive } from "./sudo.ts";
import { getAgent, type Agent } from "./agents.ts";

/**
 * Integrations (docs/V2-ARCHITECTURE.md §10.2, §10.3): the catalog and live status come from the
 * `agentbox integration` CLI (cli/agentbox.mjs; its JSON is documented in docs/MODULES.md); this
 * module wraps it, adapts its JSON to one shape the portal codes against (`adaptIntegration`, the
 * only place that knows the CLI's field names), keeps the role ↔ integration mapping, and builds the
 * integrations layer of every agent's instructions and its integration skills.
 */

// --- the shape the portal uses ------------------------------------------------------------------

/** `agentbox integration status --json` › state (cli/integrations.mjs › integrationState). */
export type IntegrationState = "available" | "connecting" | "connected" | "error" | "disconnected" | "unavailable";
/** The CLI's step states, plus "running" (the portal's overlay while a connect / verify runs). */
export type StepState = "pending" | "running" | "human" | "done" | "failed" | "skipped";
export type StepCheck = { ok: boolean; code: number | null; output: string | null; timed_out: boolean };
export type IntegrationStep = {
  id: string; title: string; human: boolean; state: StepState; check: StepCheck | null;
  instructions: string | null; copy: string | null;
  /** The failed check's output (the CLI keeps the last lines), for the card. */
  last_error: string | null;
};
export type SettingType = "string" | "boolean" | "list" | "enum" | "number";
export type SettingValue = string | number | boolean | string[];
/** One entry of the settings schema, with its saved value. */
export type IntegrationSetting = {
  key: string; prompt: string; type: SettingType; required: boolean;
  default: SettingValue | null; options: string[] | null; pattern: string | null; example: string | null;
  value: SettingValue | null; missing: boolean; error: string | null;
};
/** What waits for the owner (the CLI's `gates`): a setting to give, or a login / config step. */
export type IntegrationGate =
  | { kind: "setting"; key: string; title: string; command: string }
  | { kind: "step"; id: string; title: string; instructions: string | null; copy: string | null };
export type Integration = {
  id: string; title: string; description: string; category: string;
  /** False for catalog entries that can't be connected yet ("coming soon"; state "unavailable"). */
  available: boolean;
  /** `modules.<id>` in config.yaml. */
  enabled: boolean;
  state: IntegrationState;
  /** The connected account, when the CLI reports one (e.g. the GitHub login). */
  account: string | null;
  depends: string[];
  steps: IntegrationStep[];
  settings: IntegrationSetting[];
  settings_saved: boolean;
  settings_file: string | null;
  missing: string[];
  gates: IntegrationGate[];
  /** How to revoke the credentials (printed on disconnect; credentials are never touched). */
  revoke: string | null;
  instructions: { summary: string | null; summary_file: string | null; file: string | null; rendered: boolean };
  skills: string[];
  default_roles: string[];
  last: { action: string; ok: boolean | null; error: string | null; at: string | null } | null;
  checked_at: string | null;
};

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATES: IntegrationState[] = ["available", "connecting", "connected", "error", "disconnected", "unavailable"];
const STEP_STATES: StepState[] = ["pending", "human", "done", "failed", "skipped"];
const TYPES: SettingType[] = ["string", "boolean", "list", "enum", "number"];

const s = (v: unknown, d = "") => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const sn = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") as string[] : []);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {});
function settingValue(v: unknown): SettingValue | null {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(String);
  return null;
}
/** A setting's value as text, for cards and the setup agent. */
export function settingText(v: SettingValue | null | undefined): string {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/**
 * The one adapter from `agentbox integration status [<id>] --json` (cli/agentbox.mjs ›
 * integrationView; docs/MODULES.md) to the portal's shape. It follows the CLI's JSON exactly
 * (`settings: {file, saved, schema, values, missing, errors}`, steps with `check`, `gates`, `revoke`,
 * `available: false` → "unavailable") and defaults anything missing, so a `list --json` entry (no
 * steps, no settings) adapts too.
 */
export function adaptIntegration(raw: any): Integration {
  if (!raw || typeof raw !== "object" || !ID_RE.test(s(raw.id))) throw new Error("integration without a valid id");
  const available = raw.available !== false;
  const enabled = raw.enabled === true;
  const state: IntegrationState = !available ? "unavailable"
    : STATES.includes(raw.state) ? raw.state
    : enabled ? "connecting" : "available";

  const st = obj(raw.settings);
  const values = obj(st.values);
  const missing = strs(st.missing);
  const errors = new Map((Array.isArray(st.errors) ? st.errors : []).filter((e: any) => e && typeof e.key === "string").map((e: any) => [e.key, s(e.error, "invalid")]));
  const settings: IntegrationSetting[] = (Array.isArray(st.schema) ? st.schema : []).filter((d: any) => d && typeof d.key === "string").map((d: any) => ({
    key: d.key, prompt: s(d.prompt, d.key), type: TYPES.includes(d.type) ? d.type : "string", required: d.required === true,
    default: settingValue(d.default), options: Array.isArray(d.options) ? strs(d.options) : null,
    pattern: sn(d.pattern), example: sn(d.example),
    value: settingValue(values[d.key]), missing: missing.includes(d.key), error: errors.get(d.key) ?? null,
  }));

  const steps: IntegrationStep[] = (Array.isArray(raw.steps) ? raw.steps : []).filter((x: any) => x && typeof x.id === "string").map((x: any) => {
    const c = x.check && typeof x.check === "object" ? x.check : null;
    const check: StepCheck | null = c ? { ok: c.ok === true, code: typeof c.code === "number" ? c.code : null, output: sn(c.output), timed_out: c.timed_out === true } : null;
    const state = (STEP_STATES.includes(x.state) ? x.state : "pending") as StepState;
    return {
      id: x.id, title: s(x.title, x.id), human: x.human === true, state, check,
      instructions: sn(x.instructions), copy: sn(x.copy),
      last_error: state === "failed" ? (check?.timed_out ? "the check timed out" : check?.output ?? null) : null,
    };
  });

  const gates: IntegrationGate[] = (Array.isArray(raw.gates) ? raw.gates : []).flatMap((g: any): IntegrationGate[] => {
    if (g?.kind === "setting" && typeof g.key === "string") return [{ kind: "setting", key: g.key, title: s(g.title, g.key), command: s(g.command) }];
    if (g?.kind === "step" && typeof g.id === "string") return [{ kind: "step", id: g.id, title: s(g.title, g.id), instructions: sn(g.instructions), copy: sn(g.copy) }];
    return [];
  });

  const ins = obj(raw.instructions);
  const last = raw.last && typeof raw.last === "object"
    ? { action: s(raw.last.action), ok: typeof raw.last.ok === "boolean" ? raw.last.ok : null, error: sn(raw.last.error), at: sn(raw.last.at) }
    : null;
  return {
    id: raw.id, title: s(raw.title, raw.id), description: s(raw.description), category: s(raw.category, "extras"),
    available, enabled, state, account: sn(raw.account), depends: strs(raw.depends),
    steps, settings, settings_saved: st.saved === true || (st.saved === undefined && settings.length === 0),
    settings_file: sn(st.file), missing, gates, revoke: sn(raw.revoke),
    instructions: { summary: sn(ins.summary), summary_file: sn(ins.summary_file), file: sn(ins.file), rendered: ins.rendered === true },
    skills: strs(raw.skills), default_roles: strs(raw.default_roles), last, checked_at: sn(raw.checked_at),
  };
}

// --- the CLI ------------------------------------------------------------------------------------

export const cliPath = () => process.env.AGENTBOX_CLI ?? "agentbox";

export type CliResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; json: any };

/**
 * Run `agentbox integration <args…>` (with `--json` when `json`: list, status, settings; connect,
 * verify and disconnect have no JSON output, so their exit code and output are the result). Output
 * lines go to `onLine` as they arrive (stdout and stderr), so long runs stream into the chat.
 * Killed after `timeoutMs`. Commands that write re-run themselves through `sudo -n` in the CLI
 * (cli/agentbox.mjs › asRoot), which works only while the setup agent holds its temporary grant
 * (sudo.ts) or with agent_sudo.
 */
export function runCli(args: string[], opts: { timeoutMs: number; json?: boolean; onLine?: (line: string, stream: "out" | "err") => void }): Promise<CliResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const env = { ...process.env, AGENTBOX_INTEGRATIONS_DIR: paths.integrations, NO_COLOR: "1" };
    try {
      // Its own process group, so a timeout also stops sudo's child (an apt-get, a curl…).
      child = spawn(cliPath(), ["integration", ...args, ...(opts.json === false ? [] : ["--json"])], { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
    } catch (e: any) {
      return resolve({ code: null, stdout: "", stderr: String(e?.message ?? e), timedOut: false, json: null });
    }
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const lines = (stream: "out" | "err") => {
      let buf = "";
      return (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (stream === "out") stdout += text; else stderr += text;
        if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
        buf += text;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop() ?? "";
        for (const l of parts) opts.onLine?.(l, stream);
      };
    };
    child.stdout!.on("data", lines("out"));
    child.stderr!.on("data", lines("err"));
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 3000).unref(); }, opts.timeoutMs);
    const done = (code: number | null, err?: string) => {
      clearTimeout(timer);
      if (err) stderr += err;
      resolve({ code, stdout, stderr, timedOut, json: opts.json === false ? null : parseJsonOutput(stdout) });
    };
    child.on("error", (e) => done(null, String(e.message)));
    child.on("close", (code) => done(code));
  });
}

/**
 * The JSON a command printed: the whole output, or, when progress lines came first (`settings`
 * prints "rendered …" before its result), the JSON document starting at the last line that opens
 * one (`{` or `[` at the start of a line; the CLI pretty-prints).
 */
export function parseJsonOutput(out: string): any {
  const t = out.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* progress lines before the result */ }
  const starts: number[] = [];
  const re = /(^|\n)[{[]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) starts.push(m.index + m[1].length);
  for (const i of starts.reverse()) { try { return JSON.parse(t.slice(i)); } catch { /* not this one */ } }
  return null;
}

const TIMEOUTS = { list: 90_000, status: 30_000, settings: 60_000, verify: 10 * 60_000, connect: 45 * 60_000, disconnect: 10 * 60_000 };
export const CLI_TIMEOUTS = TIMEOUTS;

/** The CLI's own message ("agentbox: …" on stderr), else the tail of its output. */
const cliError = (r: CliResult, what: string) => {
  if (r.timedOut) return new Error(`${what} timed out`);
  const msg = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ").replace(/^agentbox:\s*/, "");
  return new Error(`${what} failed${r.code !== null ? ` (exit ${r.code})` : ""}: ${msg || "no output"}`);
};

// --- sudo for the CLI's writes ---------------------------------------------------------------------

/**
 * connect / verify / disconnect / settings write as root: the CLI re-runs itself with `sudo -n`.
 * That works only while a setup turn holds the temporary grant (sudo.ts), or with agent_sudo, or
 * as root, or without sudo at all (AGENTBOX_NO_SUDO=1: the CLI's tests).
 */
export function cliCanWrite(): boolean {
  return process.env.AGENTBOX_NO_SUDO === "1" || process.getuid?.() === 0 || config.agent_sudo || sudoActive();
}
function mustWrite(what: string) {
  if (!cliCanWrite()) {
    throw new Error(`${what} needs root, which the setup agent has only while one of its turns runs (agent_sudo is off). Ask the setup agent, or run \`sudo agentbox integration ${what}\` in the terminal.`);
  }
}

// --- the catalog cache (the instruction layer needs "connected" every turn without a CLI call) ------

let cache: { at: number; list: Integration[] } | null = null;
let modulesDirty = false;
let inflight: Promise<Integration[]> | null = null;
export const cachedIntegrations = () => cache?.list ?? null;
const cachedOne = (id: string) => cache?.list.find((x) => x.id === id) ?? null;

// `agentbox integration connect|disconnect` flips modules.<id> without restarting the portal.
onModulesChange((ids) => {
  modulesDirty = true;
  for (const id of ids) publish({ type: "integration.updated", integrationId: id });
});

/** The catalog with live state: `status --json` (every integration, checks included). */
export async function listIntegrations(opts: { maxAgeMs?: number } = {}): Promise<Integration[]> {
  refreshModules();
  if (cache && !modulesDirty && opts.maxAgeMs !== undefined && Date.now() - cache.at < opts.maxAgeMs) return cache.list;
  if (inflight) return inflight;
  inflight = (async () => {
    const dirty = modulesDirty;
    modulesDirty = false;
    try {
      const r = await runCli(["status"], { timeoutMs: TIMEOUTS.list });
      const raw = Array.isArray(r.json?.integrations) ? r.json.integrations : null;
      if (!raw) throw r.code !== 0 ? cliError(r, "agentbox integration status") : new Error("agentbox integration status: unexpected output");
      const list: Integration[] = [];
      for (const x of raw) { try { list.push(adaptIntegration(x)); } catch { /* skip malformed entries */ } }
      cache = { at: Date.now(), list };
      return list;
    } catch (e) {
      if (dirty) modulesDirty = true;
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Refresh the cache if older than maxAgeMs (or the module switches changed); never throws. */
export async function refreshIntegrations(maxAgeMs = 60_000) {
  try { await listIntegrations({ maxAgeMs }); } catch { /* CLI unavailable: keep what we had */ }
}

/**
 * Before a turn: wait for the CLI only when nothing is known yet or `modules.*` changed; otherwise
 * use the cache and refresh it in the background when it's older than maxAgeMs.
 */
export async function integrationsForTurn(maxAgeMs = 60_000) {
  refreshModules(0);
  if (!cache || modulesDirty) return refreshIntegrations(0);
  if (Date.now() - cache.at >= maxAgeMs) void refreshIntegrations(maxAgeMs);
}

function remember(it: Integration) {
  if (!cache) return;
  cache.list = cache.list.some((x) => x.id === it.id) ? cache.list.map((x) => (x.id === it.id ? it : x)) : [...cache.list, it];
}

export async function integrationStatus(id: string): Promise<Integration> {
  if (!ID_RE.test(id)) throw new Error("Unknown integration id");
  refreshModules();
  const r = await runCli(["status", id], { timeoutMs: TIMEOUTS.status });
  // `status <id>` exits 1 when the integration isn't connected; the JSON is the answer either way.
  if (!r.json?.id) throw cliError(r, `agentbox integration status ${id}`);
  const it = adaptIntegration(r.json);
  remember(it);
  return it;
}

// --- connect / verify / disconnect runs (the steps card's live progress) ---------------------------

export type IntegrationJob = {
  action: "connect" | "verify" | "disconnect";
  running: boolean; started_at: string; ended_at: string | null; last_output_at: string;
  ok: boolean | null; code: number | null; timed_out: boolean;
  lines: { line: string; at: string }[];
};
const jobs = new Map<string, IntegrationJob>();
/** The last (or running) connect / verify / disconnect of an integration. */
export const jobOf = (id: string) => jobs.get(id) ?? null;
export const outputOf = (id: string) => jobs.get(id)?.lines ?? [];
const jobSummary = (j: IntegrationJob) => ({ ...j, lines: undefined });
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** connect | verify | disconnect: streamed, with the output kept for the card and returned. */
export async function integrationAction(action: "connect" | "verify" | "disconnect", id: string, ctx: { taskId?: string } = {}) {
  if (!ID_RE.test(id)) throw new Error("Unknown integration id");
  if (jobs.get(id)?.running) throw new Error(`${id}: a ${jobs.get(id)!.action} is already running; wait for it to finish`);
  mustWrite(`${action} ${id}`);
  const at = new Date().toISOString();
  const job: IntegrationJob = { action, running: true, started_at: at, ended_at: null, last_output_at: at, ok: null, code: null, timed_out: false, lines: [] };
  jobs.set(id, job);
  publish({ type: "integration.job", integrationId: id, job: jobSummary(job) });
  let r: CliResult;
  try {
    r = await runCli([action, id], {
      json: false,
      timeoutMs: TIMEOUTS[action],
      onLine: (raw) => {
        const line = raw.replace(ANSI, "").replace(/\s+$/, "");
        job.last_output_at = new Date().toISOString();
        if (!line.trim()) return;
        const entry = { line: line.length > 400 ? `${line.slice(0, 400)}…` : line, at: job.last_output_at };
        job.lines.push(entry);
        if (job.lines.length > 300) job.lines.splice(0, job.lines.length - 300);
        publish({ type: "integration.output", integrationId: id, taskId: ctx.taskId ?? null, line: entry.line });
      },
    });
  } finally {
    job.running = false;
    job.ended_at = new Date().toISOString();
  }
  job.ok = r.code === 0 && !r.timedOut;
  job.code = r.code;
  job.timed_out = r.timedOut;
  // The CLI flipped modules.<id> (connect / disconnect): pick it up now, not at the next look.
  refreshModules(0);
  if (cache) cache.at = 0;
  publish({ type: "integration.job", integrationId: id, job: jobSummary(job) });
  publish({ type: "integration.updated", integrationId: id });
  const tail = job.lines.slice(-60).map((l) => l.line);
  return { ok: job.ok, code: r.code, timedOut: r.timedOut, tail, stderr: r.stderr.slice(-2000) };
}

/**
 * Save settings: `agentbox integration settings <id> --values '<json>' --json`. The CLI validates
 * against the schema (types, patterns, options) and refuses token-like values; nothing is written
 * on an error. Returns the saved values and what's still missing.
 */
export async function saveSettings(id: string, values: Record<string, unknown>) {
  if (!ID_RE.test(id)) throw new Error("Unknown integration id");
  const it = await integrationStatus(id);
  const known = new Set(it.settings.map((x) => x.key));
  const clean: Record<string, SettingValue | null> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!known.has(k)) throw new Error(`${it.title} has no setting "${k}". Settings: ${[...known].join(", ") || "none"}`);
    if (v === null || v === "") { clean[k] = null; continue; } // clears it
    const val = settingValue(v);
    if (val === null) throw new Error(`"${k}": a text, number, true/false or a list of texts`);
    clean[k] = val;
  }
  if (!Object.keys(clean).length) throw new Error("No settings given");
  mustWrite(`settings ${id}`);
  const r = await runCli(["settings", id, "--values", JSON.stringify(clean)], { timeoutMs: TIMEOUTS.settings });
  if (r.code !== 0) throw cliError(r, `agentbox integration settings ${id}`);
  if (cache) cache.at = 0;
  publish({ type: "integration.updated", integrationId: id });
  const j = obj(r.json);
  return { values: obj(j.values) as Record<string, SettingValue>, missing: strs(j.missing), saved: Object.keys(clean) };
}

// --- role ↔ integration mapping (§10.3) ---------------------------------------------------------

run(`CREATE TABLE IF NOT EXISTS role_integrations (
  role_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  PRIMARY KEY (role_id, integration_id)
)`);

const roleIdOf = (agentId: string) => {
  const a = getAgent(agentId);
  return a ? (a.base_agent_id ?? a.id) : agentId;
};

/** Integrations mapped to a role (an instance uses its role's). */
export const mappedIntegrations = (agentId: string) =>
  all<{ integration_id: string }>(`SELECT integration_id FROM role_integrations WHERE role_id = ? ORDER BY integration_id`, roleIdOf(agentId))
    .map((r) => r.integration_id);
export const rolesFor = (integrationId: string) =>
  all<{ role_id: string }>(`SELECT role_id FROM role_integrations WHERE integration_id = ? ORDER BY role_id`, integrationId).map((r) => r.role_id);
export const allMappings = () => all<{ role_id: string; integration_id: string }>(`SELECT role_id, integration_id FROM role_integrations`);

function mustRole(id: string) {
  const a = getAgent(id);
  if (!a || a.retired_at) throw new Error(`No such agent: ${id}`);
  if (a.base_agent_id) throw new Error("Map integrations to agents (roles), not to their tasks");
  return a;
}

export function setRoleIntegrations(roleId: string, ids: string[]) {
  mustRole(roleId);
  const want = [...new Set(ids)];
  for (const id of want) if (!ID_RE.test(id)) throw new Error(`Bad integration id "${id}"`);
  const before = mappedIntegrations(roleId);
  run(`DELETE FROM role_integrations WHERE role_id = ?`, roleId);
  for (const id of want) run(`INSERT INTO role_integrations (role_id, integration_id) VALUES (?, ?)`, roleId, id);
  for (const id of new Set([...before, ...want])) publish({ type: "integration.mapping", integrationId: id, roles: rolesFor(id) });
  return mappedIntegrations(roleId);
}

export function setIntegrationRoles(integrationId: string, roleIds: string[]) {
  if (!ID_RE.test(integrationId)) throw new Error(`Bad integration id "${integrationId}"`);
  const want = [...new Set(roleIds)];
  for (const r of want) mustRole(r);
  run(`DELETE FROM role_integrations WHERE integration_id = ?`, integrationId);
  for (const r of want) run(`INSERT INTO role_integrations (role_id, integration_id) VALUES (?, ?)`, r, integrationId);
  publish({ type: "integration.mapping", integrationId, roles: rolesFor(integrationId) });
  return rolesFor(integrationId);
}

// --- the instruction layer and skills ------------------------------------------------------------

export const summaryPath = (id: string) => path.join(paths.integrations, `${id}.summary.md`);
export const rulesPath = (id: string) => path.join(paths.team, "integrations", `${id}.md`);

/**
 * Connected (§10.2): `modules.<id>` on in config.yaml (re-read when the file changes) AND the CLI's
 * last report says connected (every check green, settings saved). Before the CLI ever answered, an
 * enabled integration with a rendered summary counts.
 */
export function isConnected(id: string): boolean {
  if (!moduleOn(id)) return false;
  const it = cachedOne(id);
  if (it) return it.state === "connected";
  if (cache) return false; // the CLI answered and doesn't know it
  return fs.existsSync(summaryPath(id));
}

/** Integrations an agent sees: mapped to its role AND connected. Unmapped ones are invisible. */
export const visibleIntegrations = (agent: Agent) => mappedIntegrations(agent.id).filter(isConnected);

function readSummary(id: string) {
  try { return fs.readFileSync(summaryPath(id), "utf8").trim().slice(0, 2000); } catch { return ""; }
}

/**
 * Layer 2 of the instructions (§10.3): for each integration that is connected AND mapped to the
 * role, the summary the CLI rendered (`<paths.integrations>/<id>.summary.md`) and, when it exists,
 * where the detailed rules are (`/team/integrations/<id>.md`, read on demand).
 */
export function integrationsLayer(agent: Agent): string {
  const ids = visibleIntegrations(agent);
  if (!ids.length) return "";
  const parts = ids.map((id) => {
    const it = cachedOne(id);
    const title = it?.title ?? id;
    const summary = readSummary(id) || `${title} is connected on this computer.`;
    const file = it?.instructions.file ?? rulesPath(id);
    const pointer = fs.existsSync(file) && !summary.includes(file) ? `\nDetailed rules: ${file} (read it before work that uses ${title}).` : "";
    return `### ${title}\n${summary}${pointer}`;
  });
  return `## Integrations
These are connected on this computer and part of your job. Credentials are already set up: never log out,
switch accounts, or re-authenticate; if one stops working, tell the owner (the setup agent repairs it).

${parts.join("\n\n")}`;
}

/** Skills that come with the agent's visible integrations (only while connected and mapped). */
export function integrationSkills(agent: Agent): string[] {
  const list = cachedIntegrations() ?? [];
  const ids = new Set(visibleIntegrations(agent));
  return [...new Set(list.filter((x) => ids.has(x.id)).flatMap((x) => x.skills))].sort();
}

/**
 * The skills a turn gets (§10.2 `skills:`): the role's assigned skills plus its visible integrations'
 * skills, minus skills that belong to integrations it doesn't see (e.g. a tech lead assigned
 * review-pr while GitHub is disconnected or unmapped). A skill shared by several integrations stays
 * while any of them is visible.
 */
export function effectiveSkills(agent: Agent, assigned: string[]): string[] {
  const list = cachedIntegrations() ?? [];
  const mine = new Set(integrationSkills(agent));
  const gated = new Set(list.flatMap((x) => x.skills).filter((k) => !mine.has(k)));
  return [...new Set([...assigned.filter((k) => !gated.has(k)), ...mine])].sort();
}
