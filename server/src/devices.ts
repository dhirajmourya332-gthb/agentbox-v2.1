import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { all, db, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { b64urlBytes } from "./signing.ts";

/**
 * Paired phones: pairing codes, the device registry and what the portal's Devices page shows.
 * The gateway that phones actually talk to is mobile.ts. Contract: docs/MOBILE-PROTOCOL.md.
 */

// The env overrides exist for the rehearsal tests (server/test/) and can only shorten the windows.
const shorter = (env: string | undefined, max: number) => {
  const n = Number(env);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, max) : max;
};
export const PAIRING_TTL_MS = shorter(process.env.AGENTBOX_PAIRING_TTL_MS, 2 * 60_000);
export const PENDING_TTL_MS = shorter(process.env.AGENTBOX_PENDING_TTL_MS, 5 * 60_000);

export type Device = {
  id: string; name: string; public_key: string; fingerprint: string; app_version: string | null;
  tailnet_login: string | null; status: "pending" | "active"; created_at: string; approved_at: string | null;
  last_seen_at: string | null;
  /** Expo push token (push.ts). Never returned to the portal: it only sees `push: boolean`. */
  push_token?: string | null; push_token_at?: string | null;
};

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes: Uint8Array) {
  let out = "", bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** First 10 bytes of sha256(public key), base32, in groups of 4: K3QF-7ZMA-2XWB-9QPL. */
export function fingerprint(publicKey: Uint8Array) {
  return base32(sha256(publicKey).subarray(0, 10)).match(/.{1,4}/g)!.join("-");
}


/** Printable, single-line, trimmed, bounded; no bidi overrides or zero-width characters (\p{Cf}). */
function cleanText(s: unknown, max: number): string {
  return String(s ?? "").replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export const changed = () => publish({ type: "devices.changed" });

// --- pairing -------------------------------------------------------------------

/** A new single-use code. Any earlier unused code stops working: one live QR at a time. */
export function createPairing() {
  const code = randomBytes(32).toString("base64url");
  const id = newId();
  const created = Date.now();
  const expires = new Date(created + PAIRING_TTL_MS).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    run(`DELETE FROM device_pairings WHERE used_at IS NULL`);
    run(`INSERT INTO device_pairings (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      id, sha256(code).toString("hex"), new Date(created).toISOString(), expires);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { id, code, expires_at: expires };
}

/** Invalidate any code still on screen (e.g. the owner navigated away). */
export function cancelPairings() {
  run(`DELETE FROM device_pairings WHERE used_at IS NULL`);
}

/**
 * The phone's claim. One atomic step: find the live pairing by sha256(code) with a constant-time
 * compare, burn it whatever happens next, then register a pending device. Returns null for any
 * failure; the gateway turns that into an empty 404.
 */
export function claimPairing(body: any, tailnetLogin: string) {
  if (!body || typeof body !== "object" || typeof body.code !== "string" || body.code.length > 128) return null;
  const hash = sha256(body.code);
  const t = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const live = all<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM device_pairings WHERE used_at IS NULL AND expires_at > ?`, t);
    let match: string | null = null;
    for (const p of live) {
      const stored = Buffer.from(p.code_hash, "hex");
      // Compare every candidate (no early exit), so timing doesn't depend on which one matched.
      if (stored.length === hash.length && timingSafeEqual(stored, hash) && !match) match = p.id;
    }
    if (!match) {
      db.exec("COMMIT");
      return null;
    }
    // Burn the code first: a claim with a bad key still uses it up.
    if (Number(run(`UPDATE device_pairings SET used_at = ? WHERE id = ? AND used_at IS NULL`, t, match).changes) !== 1) {
      db.exec("COMMIT");
      return null;
    }
    const pub = b64urlBytes(body.public_key, 32);
    let validPoint = false;
    if (pub) {
      try { ed25519.Point.fromBytes(pub); validPoint = true; } catch { /* not a curve point */ }
    }
    const name = cleanText(body.device_name, 64) || "Phone";
    const appVersion = cleanText(body.app_version, 32) || null;
    if (!pub || !validPoint || get(`SELECT 1 FROM devices WHERE public_key = ?`, pub.toString("base64url"))) {
      db.exec("COMMIT");
      return null;
    }
    const id = newId();
    const fp = fingerprint(pub);
    run(
      `INSERT INTO devices (id, name, public_key, fingerprint, app_version, tailnet_login, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id, name, pub.toString("base64url"), fp, appVersion, tailnetLogin, t,
    );
    db.exec("COMMIT");
    changed();
    return { device_id: id, fingerprint: fp, status: "pending" as const };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  }
}

// --- devices ----------------------------------------------------------------------

const pendingExpired = (d: Pick<Device, "status" | "created_at">) =>
  d.status === "pending" && Date.now() - new Date(d.created_at).getTime() > PENDING_TTL_MS;

/** A device that may make requests: active, or pending and not yet expired. */
export function liveDevice(id: string): Device | null {
  const d = get<Device>(`SELECT * FROM devices WHERE id = ?`, id);
  if (!d) return null;
  if (pendingExpired(d)) {
    removeDevice(d.id);
    return null;
  }
  return d.status === "active" || d.status === "pending" ? d : null;
}

export function touchDevice(id: string) {
  run(`UPDATE devices SET last_seen_at = ? WHERE id = ?`, now(), id);
}

// The gateway registers this so a revoke closes the device's sockets immediately.
let onRemoved: (id: string) => void = () => {};
export const setOnRemoved = (fn: (id: string) => void) => { onRemoved = fn; };

function removeDevice(id: string) {
  run(`DELETE FROM devices WHERE id = ?`, id);
  onRemoved(id);
  changed();
}

export function listDevices() {
  sweep();
  const rows = all<Device>(`SELECT * FROM devices ORDER BY created_at DESC`);
  const view = ({ public_key: _pk, push_token, push_token_at: _pt, ...d }: Device) => ({
    ...d,
    push: !!push_token,
    expires_at: d.status === "pending" ? new Date(new Date(d.created_at).getTime() + PENDING_TTL_MS).toISOString() : null,
  });
  return { pending: rows.filter((d) => d.status === "pending").map(view), active: rows.filter((d) => d.status === "active").map(view) };
}

// --- push tokens (push.ts sends; the gateway's /m/v1/device/push-token sets them) ---------------

/** ExponentPushToken[…] or ExpoPushToken[…], URL-safe characters only, bounded. */
export const PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

/** Store the calling (active) device's token. A token belongs to one device: any older copy goes. */
export function setPushToken(id: string, token: string) {
  if (!PUSH_TOKEN.test(token)) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    run(`UPDATE devices SET push_token = NULL, push_token_at = NULL WHERE push_token = ? AND id <> ?`, token, id);
    const ok = Number(run(`UPDATE devices SET push_token = ?, push_token_at = ? WHERE id = ? AND status = 'active'`, token, now(), id).changes) === 1;
    db.exec("COMMIT");
    if (ok) changed();
    return ok;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* closed */ }
    throw e;
  }
}

/** Remove a device's token; with `onlyIf`, only while it is still that token (Expo said it's dead). */
export function clearPushToken(id: string, onlyIf?: string) {
  const r = onlyIf === undefined
    ? run(`UPDATE devices SET push_token = NULL, push_token_at = NULL WHERE id = ? AND push_token IS NOT NULL`, id)
    : run(`UPDATE devices SET push_token = NULL, push_token_at = NULL WHERE id = ? AND push_token = ?`, id, onlyIf);
  const ok = Number(r.changes) > 0;
  if (ok) changed();
  return ok;
}

/** Active devices that have notifications on. */
export const pushTargets = () =>
  all<{ id: string; push_token: string }>(`SELECT id, push_token FROM devices WHERE status = 'active' AND push_token IS NOT NULL`);

export function approveDevice(id: string) {
  const d = liveDevice(id);
  if (!d || d.status !== "pending") return false;
  run(`UPDATE devices SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'`, now(), id);
  changed();
  return true;
}

export function denyDevice(id: string) {
  const d = get<Device>(`SELECT * FROM devices WHERE id = ? AND status = 'pending'`, id);
  if (!d) return false;
  removeDevice(id);
  return true;
}

export function revokeDevice(id: string) {
  if (!get(`SELECT 1 FROM devices WHERE id = ?`, id)) return false;
  removeDevice(id);
  return true;
}

export function revokeAll() {
  const ids = all<{ id: string }>(`SELECT id FROM devices`).map((r) => r.id);
  run(`DELETE FROM devices`);
  cancelPairings();
  ids.forEach((id) => onRemoved(id));
  changed();
  return ids.length;
}

/** Drop expired pending devices and stale pairings. Runs on a timer and before listing. */
export function sweep() {
  const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  for (const d of all<{ id: string }>(`SELECT id FROM devices WHERE status = 'pending' AND created_at <= ?`, cutoff)) removeDevice(d.id);
  run(`DELETE FROM device_pairings WHERE expires_at <= ?`, new Date(Date.now() - 60 * 60_000).toISOString());
}

// --- audit -------------------------------------------------------------------------

const AUDIT_TITLES: [RegExp, string][] = [
  [/^work$/, "started a task"],
  [/^threads\/[^/]+\/messages$/, "sent a message"],
  [/^tasks\/[^/]+\/stop$/, "stopped a task"],
  [/^pause$/, "paused all agents"],
  [/^resume$/, "resumed the agents"],
  [/^routines\/[^/]+\/run$/, "ran a routine"],
  [/^agents\/[^/]+\/done$/, "marked a task done"],
  [/^uploads$/, "attached an image"],
  [/^device\/forget$/, "unpaired the phone"],
  [/^file$/, "opened a file"],
  [/^device\/push-token\/on$/, "turned on notifications"],
  [/^device\/push-token\/off$/, "turned off notifications"],
];
export const auditTitle = (path: string) => AUDIT_TITLES.find(([re]) => re.test(path))?.[1] ?? `called ${path}`;

export function audit(device: Pick<Device, "id" | "name">, method: string, path: string, status: number, refId: string | null) {
  run(
    `INSERT INTO device_audit (id, ts, device_id, device_name, method, path, status, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), now(), device.id, device.name, method, path, status, refId,
  );
  changed();
}

// --- gateway URL and Tailscale status --------------------------------------------------

const exec = promisify(execFile);
const META_URL = "mobile_url";

export const manualUrl = () => get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, META_URL)?.value ?? null;

/** https://host[:port] only: no path, query, credentials or fragment. */
export function setManualUrl(input: unknown) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    run(`DELETE FROM meta WHERE key = ?`, META_URL);
    return null;
  }
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("That isn't a URL"); }
  if (u.protocol !== "https:") throw new Error("The URL must start with https://");
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new Error("Just the address, e.g. https://agentbox.example.ts.net");
  }
  const clean = u.origin;
  run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, META_URL, clean);
  return clean;
}

export type GatewayStatus = {
  tailscale: {
    installed: boolean; backend_state: string | null; dns_name: string | null; url: string | null;
    serve_target: string | null;
    /** Funnel switched on in the serve config, or listed by `tailscale funnel status`. */
    funnel: boolean | null;
    /** The tailnet policy grants this node the funnel capability (nodeAttrs); it shouldn't. */
    funnel_capable: boolean | null;
    error?: string;
  };
  /** The in-VM tailnet firewall (vm/bin/agentbox-tailnet-guard): present with its drop rules. */
  guard: { present: boolean | null; detail: string };
  manual_url: string | null;
  url: string | null;
  port: number;
};

let cached: { at: number; value: GatewayStatus } | null = null;

export async function gatewayStatus(port: number, fresh = false): Promise<GatewayStatus> {
  if (!fresh && cached && Date.now() - cached.at < 5000) return { ...cached.value, manual_url: manualUrl(), url: cached.value.tailscale.url ?? manualUrl() };
  const ts: GatewayStatus["tailscale"] = {
    installed: false, backend_state: null, dns_name: null, url: null, serve_target: null, funnel: null, funnel_capable: null,
  };
  try {
    const { stdout } = await exec("tailscale", ["status", "--json"], { timeout: 3000, maxBuffer: 4 << 20 });
    ts.installed = true;
    const s = JSON.parse(stdout);
    ts.backend_state = typeof s.BackendState === "string" ? s.BackendState : null;
    const dns = typeof s.Self?.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "") : "";
    if (dns && /^[a-z0-9.-]+$/i.test(dns)) ts.dns_name = dns;
    if (ts.backend_state === "Running" && ts.dns_name) ts.url = `https://${ts.dns_name}`;
    ts.funnel_capable = funnelCapable(s.Self);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      ts.installed = true;
      ts.error = "tailscale status failed";
      // `tailscale status` exits non-zero when stopped/logged out but still prints JSON.
      try {
        const s = JSON.parse(String(e?.stdout ?? ""));
        ts.backend_state = typeof s.BackendState === "string" ? s.BackendState : null;
        ts.funnel_capable = funnelCapable(s.Self);
        delete ts.error;
      } catch { /* keep the error */ }
    }
  }
  if (ts.installed) {
    try {
      const { stdout } = await exec("tailscale", ["serve", "status", "--json"], { timeout: 3000, maxBuffer: 1 << 20 });
      const cfg = stdout.trim() ? JSON.parse(stdout) : {};
      ts.funnel = Object.values(cfg.AllowFunnel ?? {}).some(Boolean);
      for (const [hostPort, web] of Object.entries<any>(cfg.Web ?? {})) {
        if (!hostPort.endsWith(":443")) continue;
        const proxy = web?.Handlers?.["/"]?.Proxy;
        if (typeof proxy === "string") ts.serve_target = proxy;
      }
    } catch { /* unknown */ }
    try {
      const { stdout } = await exec("tailscale", ["funnel", "status"], { timeout: 3000, maxBuffer: 1 << 20 });
      if (/funnel on/i.test(stdout)) ts.funnel = true;
    } catch { /* older CLI or not running */ }
  }
  const value: GatewayStatus = { tailscale: ts, guard: await guardStatus(), manual_url: manualUrl(), url: ts.url ?? manualUrl(), port };
  cached = { at: Date.now(), value };
  return value;
}

/** Self.CapMap (and older Self.Capabilities) keys that grant Funnel, e.g. ".../cap/funnel", "funnel-ports?…". */
function funnelCapable(self: any): boolean | null {
  if (!self || typeof self !== "object") return null;
  const keys = [...Object.keys(self.CapMap ?? {}), ...(Array.isArray(self.Capabilities) ? self.Capabilities.map(String) : [])];
  return keys.some((k) => /funnel/i.test(k));
}

/**
 * Whether the tailnet firewall table is loaded with both drop rules. Reading nftables needs root:
 * `sudo -n` (the VM user has passwordless sudo); null when that isn't possible.
 */
async function guardStatus(): Promise<GatewayStatus["guard"]> {
  try {
    const { stdout } = await exec("sudo", ["-n", "/usr/sbin/nft", "list", "table", "inet", "agentbox_tailnet"], { timeout: 3000 });
    const input = /iifname "tailscale0"[^\n]*drop/.test(stdout);
    const output = /oifname "tailscale0"[^\n]*drop/.test(stdout);
    if (input && output) return { present: true, detail: "loaded" };
    return { present: false, detail: "table loaded without its drop rules" };
  } catch (e: any) {
    const err = String(e?.stderr ?? "");
    if (/^sudo:|password/im.test(err) || e?.code === "ENOENT") return { present: null, detail: "couldn't check (needs passwordless sudo)" };
    if (/No such file or directory|does not exist/i.test(err)) return { present: false, detail: "not loaded" };
    return { present: null, detail: "couldn't check" };
  }
}
