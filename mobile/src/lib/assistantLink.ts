import { getRandomBytes } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { utf8 } from "../crypto/encoding";
import { signRequest } from "../crypto/sign";
import { HttpError } from "./api";
import { serverName, unlockKey, type Pairing } from "./vault";

/**
 * The voice assistant's own way to each agentbox. Hands-free has to keep working while the app's
 * screens are locked and on whichever agentbox the owner names, so turning it on unlocks each
 * paired agentbox's key once (fingerprint) and keeps a copy here, apart from the app's keyring.
 * They are zeroed when hands-free is turned off, when the owner forgets an agentbox, and when the
 * process ends; they never touch disk. Requests are made exactly like lib/api.ts: one gateway
 * origin per pairing, only under /m/v1/, fresh signature, redirects refused, nothing logged.
 */

type Link = { deviceId: string; gateway: string; name: string; key: Uint8Array };

const links = new Map<string, Link>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

export function onLinksChanged(f: () => void) {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** The agentboxes the assistant can reach right now. */
export const linked = () => [...links.values()].map((l) => ({ deviceId: l.deviceId, name: l.name }));
export const isLinked = (deviceId: string) => links.has(deviceId);

/**
 * Unlocks every active pairing (one prompt each). Returns the names that didn't unlock (cancelled,
 * key gone). Already-linked ones are kept and not asked again.
 */
export async function linkAll(servers: Pairing[]): Promise<string[]> {
  const failed: string[] = [];
  for (const p of servers) {
    if (p.status !== "active") continue;
    const had = links.get(p.deviceId);
    if (had) { had.name = serverName(p); continue; }
    try {
      const key = await unlockKey(p);
      links.set(p.deviceId, { deviceId: p.deviceId, gateway: p.gateway, name: serverName(p), key: Uint8Array.from(key) });
      key.fill(0);
    } catch {
      failed.push(serverName(p));
    }
  }
  changed();
  return failed;
}

/** Forget one agentbox's copy (it was forgotten or re-paired), or all of them. */
export function unlink(deviceId?: string) {
  for (const l of links.values()) {
    if (deviceId && l.deviceId !== deviceId) continue;
    l.key.fill(0);
    links.delete(l.deviceId);
  }
  changed();
}

/** Names, refreshed from the saved pairings (renames), and drops any that are gone. */
export function syncLinks(servers: Pairing[]) {
  for (const l of [...links.values()]) {
    const p = servers.find((x) => x.deviceId === l.deviceId && x.status === "active");
    if (!p) { l.key.fill(0); links.delete(l.deviceId); } else l.name = serverName(p);
  }
  changed();
}

const TIMEOUT_MS = 20_000;

/** One signed JSON call to `deviceId`'s gateway. */
export async function linkCall<T>(deviceId: string, method: "GET" | "POST", path: string, body?: unknown, timeout = TIMEOUT_MS): Promise<T> {
  const l = links.get(deviceId);
  if (!l) throw new Error("That agentbox isn't unlocked for the assistant. Turn hands-free off and on again.");
  if (!path.startsWith("/m/v1/")) throw new Error("Refusing a path outside /m/v1/");
  const text = body === undefined ? undefined : JSON.stringify(body);
  const { headers: sig } = signRequest({
    method, path, body: text === undefined ? undefined : utf8(text), time: Date.now(), nonce: getRandomBytes(16),
    deviceId: l.deviceId, privateKey: l.key,
  });
  const headers: Record<string, string> = { ...sig, accept: "application/json" };
  if (text !== undefined) headers["content-type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(l.gateway + path, { method, headers, body: text, credentials: "omit", redirect: "error", signal: ctrl.signal });
  } catch {
    throw new Error(ctrl.signal.aborted ? `${l.name} didn't answer in time.` : `Can't reach ${l.name}. Is Tailscale on?`);
  } finally {
    clearTimeout(timer);
  }
  if (res.redirected || (res.status >= 300 && res.status < 400)) throw new Error("Unexpected redirect; refusing the response.");
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error.slice(0, 300)
      // The gateway's bare 404: not allowed (an older agentbox) or this phone isn't paired any more.
      : res.status === 404 ? `${l.name} refused that. It may need an update, or no longer knows this phone.` : `Request failed (${res.status})`;
    throw new HttpError(res.status, msg);
  }
  return data as T;
}
