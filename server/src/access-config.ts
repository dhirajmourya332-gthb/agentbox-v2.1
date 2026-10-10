import fs from "node:fs";
import { parse } from "yaml";

/**
 * The slice of /etc/agentbox/config.yaml (docs/V2-ARCHITECTURE.md § 2) that portal auth needs.
 *
 * MERGE NOTE: the platform workstream owns server/src/config.ts. When it lands, replace the body of
 * getAccessConfig() with a projection of its config object onto this interface (same yaml keys) and
 * delete the file reader below. Nothing else in access.ts reads the file.
 */
export type AccessMode = "tailscale" | "cloudflare" | "ssh-tunnel";

export interface AccessConfig {
  access: AccessMode;
  /** `tailscale.hostname`: the node's full MagicDNS name, e.g. `ab-x7k2q.tail1234.ts.net`. */
  tailscale: { hostname: string };
  /** `cloudflare.*`: the public hostname, the Zero Trust team domain (`<team>.cloudflareaccess.com`), the Access AUD tag. */
  cloudflare: { hostname: string; team_domain: string; aud: string };
  owner: { tailscale_login: string; email: string };
  /** `ports.screen` (websockify/noVNC) and `ports.terminal` (ttyd), both on 127.0.0.1. */
  ports: { screen: number; terminal: number };
}

/** Today's behaviour: localhost only. Used when there is no config file (dev) or a key is absent. */
export const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  access: "ssh-tunnel",
  tailscale: { hostname: "" },
  cloudflare: { hostname: "", team_domain: "", aud: "" },
  owner: { tailscale_login: "", email: "" },
  ports: { screen: 7701, terminal: 7702 },
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const port = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536 ? (v as number) : d);

/** Project a parsed config document onto AccessConfig. Unknown `access` values are kept so validation fails closed. */
export function toAccessConfig(doc: any): AccessConfig {
  const d = DEFAULT_ACCESS_CONFIG;
  const mode = doc?.access === undefined || doc?.access === null ? d.access : String(doc.access);
  return {
    access: mode as AccessMode,
    tailscale: { hostname: str(doc?.tailscale?.hostname) },
    cloudflare: { hostname: str(doc?.cloudflare?.hostname), team_domain: str(doc?.cloudflare?.team_domain), aud: str(doc?.cloudflare?.aud) },
    owner: { tailscale_login: str(doc?.owner?.tailscale_login), email: str(doc?.owner?.email) },
    ports: { screen: port(doc?.ports?.screen, d.ports.screen), terminal: port(doc?.ports?.terminal, d.ports.terminal) },
  };
}

let cached: AccessConfig | null = null;

/**
 * The access config, read once at start (`AGENTBOX_CONFIG`, default /etc/agentbox/config.yaml).
 * A missing file means the dev defaults (ssh-tunnel). A file that exists but can't be read or parsed
 * is an error: falling back to defaults could silently change who may log in.
 */
export function getAccessConfig(): AccessConfig {
  if (cached) return cached;
  const file = process.env.AGENTBOX_CONFIG ?? "/etc/agentbox/config.yaml";
  let text: string | null = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e: any) {
    if (e?.code !== "ENOENT") throw new Error(`Can't read ${file}: ${e?.message ?? e}`);
  }
  cached = text === null ? DEFAULT_ACCESS_CONFIG : toAccessConfig(parse(text));
  return cached;
}
