import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/**
 * The agentbox config (docs/V2-ARCHITECTURE.md § 2): /etc/agentbox/config.yaml, or the file named by
 * AGENTBOX_CONFIG. Read once at start; it holds no secrets.
 *
 * Without a config file (development, the in-process tests) the built-in defaults reproduce the
 * pre-v2 behaviour: data in ./data, every module on, the usual ports.
 *
 * The older per-path env overrides (AGENTBOX_DATA, AGENTBOX_AGENTS, AGENTBOX_WORK, AGENTBOX_SKILLS,
 * PORT, AGENTBOX_MOBILE_PORT) still win over the file, so the tests can point everything at a temp
 * folder.
 */

export const MODULE_IDS = [
  "core", "claude", "access", "display", "terminal", "github", "aws", "kubernetes", "db-tunnel", "env-files",
  "voice", "mobile", "mobile-app", "push",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
/** Always on, whatever the file says. */
export const REQUIRED_MODULES: ModuleId[] = ["core", "claude", "access"];

export type AccessMode = "tailscale" | "cloudflare" | "ssh-tunnel";

export type Config = {
  host: "cloud" | "lima";
  access: AccessMode;
  /** The unix user agents run as. */
  user: string;
  /** Passwordless sudo for the agent user (audit H3: selftest warns while true). */
  agent_sudo: boolean;
  paths: {
    src: string; app: string; data: string; work: string; agents: string; team: string; skills: string; secrets: string;
    /** Integration settings and rendered prompt summaries (§10.2): <id>.yaml, <id>.summary.md. */
    integrations: string;
  };
  ports: { portal: number; screen: number; terminal: number; gateway: number; guide: number };
  modules: Record<ModuleId, boolean>;
  tailscale: { hostname: string };
  cloudflare: { hostname: string; team_domain: string; aud: string };
  owner: { tailscale_login: string; email: string };
  mobile: { serve_port: number };
  /** Where this config came from: a file path, or "defaults". */
  source: string;
};

/** Defaults for keys a config file leaves out (the values bootstrap writes). */
const FILE_DEFAULTS: Omit<Config, "source"> = {
  host: "cloud",
  access: "tailscale",
  user: "agentbox",
  agent_sudo: true,
  paths: {
    src: "/opt/agentbox/src", app: "/opt/agentbox/app", data: "/opt/agentbox/data", work: "/work", agents: "/agents",
    team: "/team", skills: "/skills", secrets: "/secrets", integrations: "/etc/agentbox/integrations",
  },
  ports: { portal: 7700, screen: 7701, terminal: 7702, gateway: 7710, guide: 7699 },
  modules: {
    core: true, claude: true, access: true, display: true, terminal: true, github: true, aws: false, kubernetes: false,
    "db-tunnel": false, "env-files": false, voice: false, mobile: false, "mobile-app": false, push: false,
  },
  tailscale: { hostname: "" },
  cloudflare: { hostname: "", team_domain: "", aud: "" },
  owner: { tailscale_login: "", email: "" },
  mobile: { serve_port: 8443 },
};

/** No config file: today's behaviour (everything on, data next to the server). */
function devDefaults(): Omit<Config, "source"> {
  const d = structuredClone(FILE_DEFAULTS);
  d.access = "ssh-tunnel";
  d.user = process.env.USER ?? "agentbox";
  d.paths.data = path.resolve("data");
  for (const id of MODULE_IDS) d.modules[id] = true;
  d.mobile.serve_port = 443; // pre-v2: the gateway owned tailscale serve :443
  return d;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, fallback: string) {
  return typeof v === "string" ? v : fallback;
}
function absPath(v: unknown, fallback: string, key: string) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string" || !path.isAbsolute(v)) throw new Error(`config: paths.${key} must be an absolute path`);
  return path.normalize(v);
}
function port(v: unknown, fallback: number, key: string) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`config: ports.${key} must be a TCP port`);
  return n;
}
function bool(v: unknown, fallback: boolean, key: string) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new Error(`config: ${key} must be true or false`);
  return v;
}

/** Merge a parsed file over the defaults, validating as we go. Unknown keys are ignored. */
export function fromObject(raw: unknown, base: Omit<Config, "source"> = FILE_DEFAULTS): Omit<Config, "source"> {
  const c = structuredClone(base);
  if (raw === null || raw === undefined) return c;
  if (!isObj(raw)) throw new Error("config: the file must be a YAML mapping");
  if (raw.host !== undefined) {
    if (raw.host !== "cloud" && raw.host !== "lima") throw new Error("config: host must be cloud or lima");
    c.host = raw.host;
  }
  if (raw.access !== undefined) {
    if (!["tailscale", "cloudflare", "ssh-tunnel"].includes(raw.access as string)) throw new Error("config: access must be tailscale, cloudflare or ssh-tunnel");
    c.access = raw.access as AccessMode;
  }
  if (raw.user !== undefined) {
    if (typeof raw.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(raw.user)) throw new Error("config: user must be a unix user name");
    c.user = raw.user;
  }
  c.agent_sudo = bool(raw.agent_sudo, c.agent_sudo, "agent_sudo");
  if (isObj(raw.paths)) for (const k of Object.keys(c.paths) as (keyof Config["paths"])[]) c.paths[k] = absPath(raw.paths[k], c.paths[k], k);
  if (isObj(raw.ports)) for (const k of Object.keys(c.ports) as (keyof Config["ports"])[]) c.ports[k] = port(raw.ports[k], c.ports[k], k);
  if (isObj(raw.modules)) for (const id of MODULE_IDS) c.modules[id] = bool(raw.modules[id], c.modules[id], `modules.${id}`);
  if (isObj(raw.tailscale)) c.tailscale.hostname = str(raw.tailscale.hostname, c.tailscale.hostname);
  if (isObj(raw.cloudflare)) for (const k of ["hostname", "team_domain", "aud"] as const) c.cloudflare[k] = str(raw.cloudflare[k], c.cloudflare[k]);
  if (isObj(raw.owner)) for (const k of ["tailscale_login", "email"] as const) c.owner[k] = str(raw.owner[k], c.owner[k]);
  if (isObj(raw.mobile)) c.mobile.serve_port = port(raw.mobile.serve_port, c.mobile.serve_port, "mobile.serve_port");
  for (const id of REQUIRED_MODULES) c.modules[id] = true;
  return c;
}

/** Load the config: the file (if any), then the env overrides. Throws on an invalid file. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.AGENTBOX_CONFIG || "/etc/agentbox/config.yaml";
  let c: Omit<Config, "source">;
  let source = "defaults";
  let text: string | null = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e: any) {
    // An explicitly named file must exist; the default location is optional (dev).
    if (env.AGENTBOX_CONFIG || e?.code !== "ENOENT") throw new Error(`config: cannot read ${file}: ${e?.code ?? e}`);
  }
  if (text !== null) {
    c = fromObject(parse(text));
    source = file;
  } else {
    c = devDefaults();
  }
  if (env.AGENTBOX_DATA) c.paths.data = path.resolve(env.AGENTBOX_DATA);
  if (env.AGENTBOX_AGENTS) c.paths.agents = path.resolve(env.AGENTBOX_AGENTS);
  if (env.AGENTBOX_WORK) c.paths.work = path.resolve(env.AGENTBOX_WORK);
  if (env.AGENTBOX_SKILLS) c.paths.skills = path.resolve(env.AGENTBOX_SKILLS);
  if (env.AGENTBOX_TEAM) c.paths.team = path.resolve(env.AGENTBOX_TEAM);
  if (env.AGENTBOX_SECRETS) c.paths.secrets = path.resolve(env.AGENTBOX_SECRETS);
  if (env.AGENTBOX_INTEGRATIONS) c.paths.integrations = path.resolve(env.AGENTBOX_INTEGRATIONS);
  if (env.PORT) c.ports.portal = port(env.PORT, c.ports.portal, "portal (PORT)");
  if (env.AGENTBOX_MOBILE_PORT) c.ports.gateway = port(env.AGENTBOX_MOBILE_PORT, c.ports.gateway, "gateway (AGENTBOX_MOBILE_PORT)");
  return { ...c, source };
}

export const config: Config = loadConfig();
export const paths = config.paths;
export const ports = config.ports;

/**
 * Whether a module's features are on. Dependencies count: push needs mobile, mobile-app needs
 * mobile, kubernetes needs aws.
 */
export function enabled(id: ModuleId): boolean {
  if (!config.modules[id]) return false;
  if (id === "push" || id === "mobile-app") return config.modules.mobile;
  if (id === "mobile") return config.access === "tailscale" || config.source === "defaults";
  return true;
}

/** GET /api/config/public: what the UI needs to show or hide features. No secrets, no paths. */
export function publicConfig() {
  return {
    host: config.host,
    access: config.access,
    modules: Object.fromEntries(MODULE_IDS.map((id) => [id, enabled(id)])) as Record<ModuleId, boolean>,
  };
}

/**
 * What the access layer (server/src/access-config.ts, access workstream) needs: the mode, the
 * identities it trusts and the ports it proxies (/term/, /screen/, /setup/). Wired in at merge.
 */
export function accessProjection() {
  return {
    access: config.access,
    tailscale: { hostname: config.tailscale.hostname },
    cloudflare: { hostname: config.cloudflare.hostname, team_domain: config.cloudflare.team_domain, aud: config.cloudflare.aud },
    owner: { tailscale_login: config.owner.tailscale_login, email: config.owner.email },
    ports: { screen: config.ports.screen, terminal: config.ports.terminal, guide: config.ports.guide },
  };
}
