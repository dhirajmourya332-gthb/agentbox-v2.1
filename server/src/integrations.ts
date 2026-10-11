import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { all, run } from "./db.ts";
import { publish } from "./bus.ts";
import { paths } from "./config.ts";
import { getAgent, type Agent } from "./agents.ts";

/**
 * Integrations (docs/V2-ARCHITECTURE.md §10.2, §10.3): the catalog and live status come from the
 * `agentbox integration … --json` CLI (integrations workstream); this module wraps it, adapts its
 * JSON to one shape the portal codes against (`adaptIntegration`, the only place that knows the
 * CLI's field names), keeps the role ↔ integration mapping, and builds the integrations layer of
 * every agent's instructions.
 */

// --- the shape the portal uses ------------------------------------------------------------------

export type IntegrationState = "available" | "connecting" | "connected" | "error" | "disconnected";
export type StepState = "pending" | "running" | "human" | "done" | "failed" | "disabled";
export type IntegrationStep = {
  id: string; title: string; human: boolean; instructions: string | null; copy: string | null;
  state: StepState; last_error: string | null;
};
export type IntegrationSetting = { key: string; prompt: string; required: boolean; value: string | null };
export type Integration = {
  id: string; title: string; category: string; kind: string; description: string;
  state: IntegrationState;
  /** False for catalog entries that can't be connected yet ("coming soon"). */
  available: boolean;
  /** The connected account, when the CLI reports one (e.g. the GitHub login). */
  account: string | null;
  settings: IntegrationSetting[];
  steps: IntegrationStep[];
  default_roles: string[];
  skills: string[];
};

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATES: IntegrationState[] = ["available", "connecting", "connected", "error", "disconnected"];

const s = (v: unknown, d = "") => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const sn = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") as string[] : []);

function stepState(raw: any): StepState {
  const v = String(raw?.state ?? raw?.status ?? "").toLowerCase();
  if (raw?.ok === true || ["done", "ok", "pass", "passed", "green", "connected"].includes(v)) return "done";
  if (["running", "working", "active", "in_progress"].includes(v)) return "running";
  if (["failed", "fail", "error", "red"].includes(v) || raw?.ok === false && v !== "pending" && !raw?.human) return "failed";
  if (["disabled", "skipped", "off"].includes(v)) return "disabled";
  if (v === "human" || v === "waiting" || v === "your_turn") return "human";
  return raw?.human ? "human" : "pending";
}

/**
 * The one adapter from the CLI's JSON (minimal agreed shape:
 * `{id, title, category, kind, state, available, settings, steps:[{id,title,human,instructions,copy,state,last_error}],
 * default_roles, skills}`) to the portal's. Tolerant on purpose: settings may be a list of
 * `{key, prompt, required, value}` or a plain `{key: value}` map, step states may be words or `ok`
 * booleans, and missing fields get safe defaults. Adjust here when the CLI's shape settles.
 */
export function adaptIntegration(raw: any): Integration {
  if (!raw || typeof raw !== "object" || !ID_RE.test(s(raw.id))) throw new Error("integration without a valid id");
  const state = (STATES.includes(raw.state) ? raw.state : raw.connected === true ? "connected" : "available") as IntegrationState;
  let settings: IntegrationSetting[] = [];
  const values = raw.values && typeof raw.values === "object" ? raw.values : {};
  if (Array.isArray(raw.settings)) {
    settings = raw.settings.filter((x: any) => x && typeof x.key === "string").map((x: any) => ({
      key: x.key, prompt: s(x.prompt, x.key), required: !!x.required,
      value: sn(x.value) ?? sn(values[x.key]),
    }));
  } else if (raw.settings && typeof raw.settings === "object") {
    settings = Object.entries(raw.settings).map(([key, v]) => ({ key, prompt: key, required: false, value: sn(v) }));
  }
  const steps: IntegrationStep[] = (Array.isArray(raw.steps) ? raw.steps : []).filter((x: any) => x && typeof x.id === "string").map((x: any) => {
    let st = stepState(x);
    // A human gate that isn't done yet is the owner's turn.
    if (x.human && (st === "pending" || st === "failed")) st = st === "failed" && x.last_error ? "failed" : "human";
    return {
      id: x.id, title: s(x.title, x.id), human: !!x.human, instructions: sn(x.instructions), copy: sn(x.copy),
      state: st, last_error: sn(x.last_error ?? x.error),
    };
  });
  return {
    id: raw.id, title: s(raw.title, raw.id), category: s(raw.category, "extras"), kind: s(raw.kind, "integration"),
    description: s(raw.description), state,
    available: raw.available !== false && raw.coming_soon !== true,
    account: sn(raw.account),
    settings, steps, default_roles: strs(raw.default_roles), skills: strs(raw.skills),
  };
}

// --- the CLI ------------------------------------------------------------------------------------

export const cliPath = () => process.env.AGENTBOX_CLI ?? "agentbox";

export type CliResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; json: any };

/**
 * Run `agentbox integration <args…> --json`. Output lines go to `onLine` as they arrive (stdout and
 * stderr), so long runs (connect, verify) stream into the chat. Killed after `timeoutMs`.
 */
export function runCli(args: string[], opts: { timeoutMs: number; onLine?: (line: string, stream: "out" | "err") => void }): Promise<CliResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliPath(), ["integration", ...args, "--json"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (e: any) {
      return resolve({ code: null, stdout: "", stderr: String(e?.message ?? e), timedOut: false, json: null });
    }
    const lines = (stream: "out" | "err") => {
      let buf = "";
      return (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (stream === "out") stdout += text; else stderr += text;
        if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
        buf += text;
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const l of parts) opts.onLine?.(l, stream);
      };
    };
    child.stdout!.on("data", lines("out"));
    child.stderr!.on("data", lines("err"));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); }, opts.timeoutMs);
    const done = (code: number | null, err?: string) => {
      clearTimeout(timer);
      if (err) stderr += err;
      resolve({ code, stdout, stderr, timedOut, json: parseJsonOutput(stdout) });
    };
    child.on("error", (e) => done(null, String(e.message)));
    child.on("close", (code) => done(code));
  });
}

/** The JSON a command printed: the whole output, or its last line when progress lines came first. */
export function parseJsonOutput(out: string): any {
  const t = out.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* progress lines before the result */ }
  const last = t.split("\n").filter((l) => l.trim()).at(-1) ?? "";
  try { return JSON.parse(last); } catch { return null; }
}

const TIMEOUTS = { list: 20_000, status: 20_000, settings: 30_000, verify: 5 * 60_000, connect: 20 * 60_000, disconnect: 5 * 60_000 };
export const CLI_TIMEOUTS = TIMEOUTS;

const cliError = (r: CliResult, what: string) =>
  new Error(r.timedOut ? `${what} timed out` : `${what} failed${r.code !== null ? ` (exit ${r.code})` : ""}: ${(r.json?.error ?? r.stderr ?? "").toString().trim().split("\n").slice(-3).join(" ") || "no output"}`);

// --- catalog cache (the instruction layer needs "connected" every turn without a CLI call) ---------

let cache: { at: number; list: Integration[] } | null = null;
export const cachedIntegrations = () => cache?.list ?? null;

export async function listIntegrations(opts: { maxAgeMs?: number } = {}): Promise<Integration[]> {
  if (cache && opts.maxAgeMs !== undefined && Date.now() - cache.at < opts.maxAgeMs) return cache.list;
  const r = await runCli(["list"], { timeoutMs: TIMEOUTS.list });
  if (r.code !== 0) throw cliError(r, "agentbox integration list");
  const raw = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.integrations) ? r.json.integrations : null;
  if (!raw) throw new Error("agentbox integration list: unexpected output");
  const list: Integration[] = [];
  for (const x of raw) { try { list.push(adaptIntegration(x)); } catch { /* skip malformed entries */ } }
  cache = { at: Date.now(), list };
  return list;
}

/** Refresh the cache if older than maxAgeMs; never throws (the cache keeps its last good value). */
export async function refreshIntegrations(maxAgeMs = 60_000) {
  try { await listIntegrations({ maxAgeMs }); } catch { /* CLI unavailable: keep what we had */ }
}

export async function integrationStatus(id: string): Promise<Integration> {
  if (!ID_RE.test(id)) throw new Error("Unknown integration id");
  const r = await runCli(["status", id], { timeoutMs: TIMEOUTS.status });
  if (r.code !== 0 && !r.json?.id) throw cliError(r, `agentbox integration status ${id}`);
  const it = adaptIntegration(r.json);
  if (cache) cache.list = cache.list.map((x) => (x.id === it.id ? { ...x, state: it.state } : x));
  return it;
}

// Recent output of connect/verify/disconnect per integration, for the steps card.
const outputs = new Map<string, { line: string; at: string }[]>();
export const outputOf = (id: string) => outputs.get(id) ?? [];

/** connect | verify | disconnect: streamed, with the output kept for the card and returned. */
export async function integrationAction(action: "connect" | "verify" | "disconnect", id: string, ctx: { taskId?: string } = {}) {
  if (!ID_RE.test(id)) throw new Error("Unknown integration id");
  const log: { line: string; at: string }[] = [];
  outputs.set(id, log);
  const r = await runCli([action, id], {
    timeoutMs: TIMEOUTS[action],
    onLine: (line) => {
      if (/^\s*[{[]/.test(line) && parseJsonOutput(line)) return; // the final JSON result, not output
      const entry = { line: line.slice(0, 400), at: new Date().toISOString() };
      log.push(entry);
      if (log.length > 300) log.splice(0, log.length - 300);
      publish({ type: "integration.output", integrationId: id, taskId: ctx.taskId ?? null, line: entry.line });
    },
  });
  cache = cache ? { ...cache, at: 0 } : null; // state changed: refetch on next use
  publish({ type: "integration.updated", integrationId: id });
  return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, result: r.json, tail: log.slice(-60).map((l) => l.line), stderr: r.stderr.slice(-2000) };
}

/** Save settings (validated against the integration's schema first). */
export async function saveSettings(id: string, values: Record<string, unknown>) {
  const it = await integrationStatus(id);
  const known = new Map(it.settings.map((x) => [x.key, x]));
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!known.has(k)) throw new Error(`${it.title} has no setting "${k}". Settings: ${[...known.keys()].join(", ") || "none"}`);
    const val = String(v ?? "").trim();
    if (val.length > 500 || /[\r\n\0]/.test(val)) throw new Error(`"${k}" must be one line, at most 500 characters`);
    clean[k] = val;
  }
  for (const x of it.settings) {
    if (x.required && !(clean[x.key] ?? x.value)) throw new Error(`"${x.key}" is required (${x.prompt})`);
  }
  if (!Object.keys(clean).length) throw new Error("No settings given");
  const args = ["settings", id];
  for (const [k, v] of Object.entries(clean)) args.push("--set", `${k}=${v}`);
  const r = await runCli(args, { timeoutMs: TIMEOUTS.settings });
  if (r.code !== 0) throw cliError(r, `agentbox integration settings ${id}`);
  publish({ type: "integration.updated", integrationId: id });
  return clean;
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

/** Connected per the CLI's last report; before the CLI ever answered, a rendered summary counts. */
export function isConnected(id: string): boolean {
  const list = cachedIntegrations();
  if (list) return list.find((x) => x.id === id)?.state === "connected";
  return fs.existsSync(summaryPath(id));
}

/** Integrations an agent sees: mapped to its role AND connected. Unmapped ones are invisible. */
export const visibleIntegrations = (agent: Agent) => mappedIntegrations(agent.id).filter(isConnected);

function readSummary(id: string) {
  try { return fs.readFileSync(summaryPath(id), "utf8").trim().slice(0, 2000); } catch { return ""; }
}

/** Layer 2 of the instructions (§10.3): the rendered summaries plus where the full rules are. */
export function integrationsLayer(agent: Agent): string {
  const ids = visibleIntegrations(agent);
  if (!ids.length) return "";
  const titles = new Map((cachedIntegrations() ?? []).map((x) => [x.id, x.title]));
  const parts = ids.map((id) => {
    const summary = readSummary(id) || `${titles.get(id) ?? id} is connected.`;
    return `### ${titles.get(id) ?? id}\n${summary}\nDetailed rules: ${rulesPath(id)} (read it before work that uses ${titles.get(id) ?? id}).`;
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

