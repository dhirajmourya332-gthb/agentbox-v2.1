import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import { getRandomBytes } from "expo-crypto";
import { base64url, fromBase64url } from "../crypto/encoding";
import { isSafeId } from "../crypto/sign";
import { parseHttpsOrigin } from "./qr";

/**
 * Persistent storage, all in expo-secure-store (Android Keystore-encrypted; app backups are off).
 *
 * The phone can be paired with several agentboxes (one per VM, all on the same tailnet). Each
 * pairing has its own Ed25519 key in its own slot, so one agentbox can never sign as another, and
 * forgetting one leaves the rest untouched. Only one is unlocked (its key in memory) at a time.
 *
 * - KEY SLOTS (`agentbox.key.<random>`; the first pairing from before multi-agentbox keeps
 *   `agentbox.key`): an Ed25519 private key. In "biometric" mode it's saved with
 *   requireAuthentication, so the Keystore itself refuses to decrypt it without a fresh
 *   strong-biometric check. In "credential" mode (no strong biometrics, but a screen lock) it's
 *   saved WITHOUT that flag and the app gates reading it behind expo-local-authentication.
 *
 *   LIMITATION (checked in expo-secure-store 57 source): requireAuthentication can't fall back to
 *   the device PIN. Its Android code asserts BIOMETRIC_STRONG, builds the BiometricPrompt with a
 *   negative button (which Android forbids together with DEVICE_CREDENTIAL), and makes an
 *   auth-per-use Keystore key. So in credential mode the key is still Keystore-encrypted at rest,
 *   but releasing it is enforced by the app, not by the Keystore. A rooted phone or code running
 *   inside the app process could read it without the PIN. Strong biometrics avoid this.
 * - SERVERS: the non-secret details of every pairing (gateway, device id, fingerprint, name,
 *   status, key slot, the person's label for it) and which one is active.
 */

const LEGACY_KEY = "agentbox.key";
const LEGACY_PAIRING = "agentbox.pairing";
const SERVERS = "agentbox.servers";
const SLOT = /^agentbox\.key(\.[A-Za-z0-9_-]{8,64})?$/;
const MAX_SERVERS = 8;

export type KeyMode = "biometric" | "credential";

export type Pairing = {
  v: 1;
  gateway: string;
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  keyMode: KeyMode;
  status: "pending" | "active";
  claimedAt: number;
  /** Secure-store slot holding this pairing's key. Absent: the legacy single slot. */
  key?: string;
  /** What the person calls this agentbox (e.g. "GCP Mumbai"). */
  label?: string;
};

export type Servers = { active: Pairing | null; list: Pairing[] };

export class NoScreenLockError extends Error {
  constructor() { super("Set a screen lock (PIN, pattern or password) on this phone first. agentbox needs it to protect its key."); }
}
export class KeyMissingError extends Error {
  constructor() { super("This phone's key for this agentbox is gone. Forget it and pair again."); }
}

const slotOf = (p: Pairing) => p.key ?? LEGACY_KEY;

/** The name shown for a pairing: its label, else the gateway's first host label. */
export const serverName = (p: Pairing) => p.label?.trim() || p.gateway.replace(/^https:\/\//, "").split(".")[0];

/** Which protection this phone supports. Null: no screen lock at all, so we refuse to pair. */
export async function availableKeyMode(): Promise<KeyMode | null> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) return null;
  try {
    if (SecureStore.canUseBiometricAuthentication()) return "biometric";
  } catch { /* fall through */ }
  return "credential";
}

/** A fresh slot name for a new pairing's key. */
export const newKeySlot = () => `agentbox.key.${base64url(getRandomBytes(12))}`;

export async function saveKey(slot: string, privateKey: Uint8Array, mode: KeyMode) {
  if (!SLOT.test(slot)) throw new Error("Bad key slot");
  await SecureStore.setItemAsync(slot, base64url(privateKey), mode === "biometric"
    ? { requireAuthentication: true, authenticationPrompt: "Protect the agentbox key" }
    : {});
}

export async function deleteKey(slot: string) {
  if (!SLOT.test(slot)) return;
  await Promise.allSettled([SecureStore.deleteItemAsync(slot, { requireAuthentication: true }), SecureStore.deleteItemAsync(slot)]);
}

/**
 * Asks the person to authenticate and returns the pairing's key bytes. Throws if they cancel or
 * the Keystore refuses (for example after biometrics changed, which invalidates the key).
 */
export async function unlockKey(p: Pairing): Promise<Uint8Array> {
  if (p.keyMode === "credential") {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock agentbox",
      cancelLabel: "Cancel",
      disableDeviceFallback: false,
    });
    if (!r.success) throw new Error(r.error === "user_cancel" || r.error === "system_cancel" ? "Cancelled" : "Couldn't confirm it's you");
  }
  const stored = await SecureStore.getItemAsync(slotOf(p), p.keyMode === "biometric"
    ? { requireAuthentication: true, authenticationPrompt: `Unlock ${serverName(p)}` }
    : {});
  if (!stored) throw new KeyMissingError();
  const bytes = fromBase64url(stored);
  if (bytes.length !== 32) throw new KeyMissingError();
  return bytes;
}

function valid(p: Pairing | null | undefined): p is Pairing {
  if (!p || p.v !== 1 || !isSafeId(p.deviceId) || !parseHttpsOrigin(p.gateway)) return false;
  if (p.keyMode !== "biometric" && p.keyMode !== "credential") return false;
  if (p.key !== undefined && !SLOT.test(p.key)) return false;
  return p.label === undefined || (typeof p.label === "string" && p.label.length <= 40);
}

type Stored = { v: 2; active: string | null; list: Pairing[] };

async function read(): Promise<Stored> {
  const raw = await SecureStore.getItemAsync(SERVERS);
  if (raw) {
    try {
      const s = JSON.parse(raw) as Stored;
      if (s.v === 2 && Array.isArray(s.list)) {
        const list = s.list.filter(valid).slice(0, MAX_SERVERS);
        return { v: 2, active: list.some((p) => p.deviceId === s.active) ? s.active : list[0]?.deviceId ?? null, list };
      }
    } catch { /* fall through to the legacy pairing */ }
  }
  // The single pairing from before multi-agentbox: becomes the first server, key slot unchanged.
  const legacy = await SecureStore.getItemAsync(LEGACY_PAIRING);
  let p: Pairing | null = null;
  try { p = legacy ? (JSON.parse(legacy) as Pairing) : null; } catch { p = null; }
  const s: Stored = { v: 2, active: valid(p) ? p.deviceId : null, list: valid(p) ? [p] : [] };
  if (legacy) {
    await write(s);
    await SecureStore.deleteItemAsync(LEGACY_PAIRING).catch(() => {});
  }
  return s;
}

const write = (s: Stored) => SecureStore.setItemAsync(SERVERS, JSON.stringify(s));
const view = (s: Stored): Servers => ({ active: s.list.find((p) => p.deviceId === s.active) ?? null, list: s.list });

export async function loadServers(): Promise<Servers> {
  return view(await read());
}

/** Adds or updates a pairing (matched by device id). `activate` makes it the active one. */
export async function saveServer(p: Pairing, activate = false): Promise<Servers> {
  if (!valid(p)) throw new Error("Bad pairing");
  const s = await read();
  const i = s.list.findIndex((x) => x.deviceId === p.deviceId);
  if (i === -1 && s.list.length >= MAX_SERVERS) throw new Error(`At most ${MAX_SERVERS} agentboxes.`);
  const list = i === -1 ? [...s.list, p] : s.list.map((x, j) => (j === i ? p : x));
  const next: Stored = { v: 2, active: activate || !s.active ? p.deviceId : s.active, list };
  await write(next);
  return view(next);
}

export async function setActive(deviceId: string): Promise<Servers> {
  const s = await read();
  if (!s.list.some((p) => p.deviceId === deviceId)) return view(s);
  const next = { ...s, active: deviceId };
  await write(next);
  return view(next);
}

/** Forgets one pairing here: its key and its details. The next one (if any) becomes active. */
export async function removeServer(deviceId: string): Promise<Servers> {
  const s = await read();
  const gone = s.list.find((p) => p.deviceId === deviceId);
  if (gone) await deleteKey(slotOf(gone));
  const list = s.list.filter((p) => p.deviceId !== deviceId);
  const next: Stored = { v: 2, active: s.active === deviceId ? list[0]?.deviceId ?? null : s.active, list };
  await write(next);
  return view(next);
}

/** Removes everything: every key slot and every pairing. */
export async function wipeAll() {
  const s = await read().catch(() => null);
  await Promise.allSettled([
    ...(s?.list ?? []).map((p) => deleteKey(slotOf(p))),
    deleteKey(LEGACY_KEY),
    SecureStore.deleteItemAsync(LEGACY_PAIRING),
    SecureStore.deleteItemAsync(SERVERS),
  ]);
}
