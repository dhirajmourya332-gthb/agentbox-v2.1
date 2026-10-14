import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { enabled } from "./config.ts";

const run = promisify(execFile);

// Only the units of enabled modules (setup/modules/<id>/units/).
const SERVICES = [
  ...(enabled("display") ? ["agentbox-xvfb", "agentbox-wm", "agentbox-vnc", "agentbox-novnc", "agentbox-chromium"] : []),
  ...(enabled("terminal") ? ["agentbox-ttyd"] : []),
];

async function serviceState(name: string): Promise<string> {
  try {
    const { stdout } = await run("systemctl", ["is-active", name]);
    return stdout.trim();
  } catch (err: any) {
    return (err.stdout ?? "unknown").trim() || "unknown";
  }
}

async function browserState(): Promise<{ ok: boolean; version?: string; disabled?: true }> {
  // No display module: no shared browser, and nothing is wrong.
  if (!enabled("display")) return { ok: true, disabled: true };
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { Browser?: string };
    return { ok: true, version: body.Browser };
  } catch {
    return { ok: false };
  }
}

async function cliVersion(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 20000 });
    return stdout.split("\n")[0].trim();
  } catch {
    return null;
  }
}

// The portal polls this often. Tool versions barely change, so they're cached for 10 minutes; the
// whole answer is cached for 15 s and concurrent callers share one in-flight check.
const TOOLS_TTL_MS = 10 * 60_000;
const HEALTH_TTL_MS = 15_000;
let tools: { at: number; value: Promise<{ claude: string | null; gh: string | null; aws: string | null }> } | null = null;
let last: { at: number; value: Promise<any> } | null = null;

function toolVersions() {
  if (!tools || Date.now() - tools.at > TOOLS_TTL_MS) {
    tools = { at: Date.now(), value: Promise.all([cliVersion("claude"), cliVersion("gh"), cliVersion("aws")]).then(([claude, gh, aws]) => ({ claude, gh, aws })) };
  }
  return tools.value;
}

async function check() {
  const [services, browser, toolsNow] = await Promise.all([
    Promise.all(SERVICES.map(async (s) => [s, await serviceState(s)] as const)),
    browserState(),
    toolVersions(),
  ]);
  // gh and aws come with optional integrations: absent is fine until those are connected.
  const toolIntegrations = { gh: { id: "github", connected: enabled("github") }, aws: { id: "aws", connected: enabled("aws") } };
  return { services: Object.fromEntries(services), browser, tools: toolsNow, tool_integrations: toolIntegrations };
}

export function health() {
  if (!last || Date.now() - last.at > HEALTH_TTL_MS) {
    last = { at: Date.now(), value: check().catch((e) => { last = null; throw e; }) };
  }
  return last.value;
}
