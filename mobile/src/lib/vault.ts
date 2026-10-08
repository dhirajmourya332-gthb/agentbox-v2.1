import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import { base64url, fromBase64url } from "../crypto/encoding";
import { isSafeId } from "../crypto/sign";
import { parseHttpsOrigin } from "./qr";

/**
 * Persistent storage, all in expo-secure-store (Android Keystore-encrypted; app backups are off).
 *
 * - KEY: the Ed25519 private key. In "biometric" mode it's saved with requireAuthentication, so
 *   the Keystore itself refuses to decrypt it without a fresh strong-biometric check.
 *   In "credential" mode (no strong biometrics, but a screen lock) it's saved WITHOUT that flag
 *   and the app gates reading it behind expo-local-authentication (PIN / pattern / biometric).
 *
 *   LIMITATION (checked in expo-secure-store 57 source): requireAuthentication can't fall back to
 *   the device PIN. Its Android code asserts BIOMETRIC_STRONG, builds the BiometricPrompt with a
 *   negative button (which Android forbids together with DEVICE_CREDENTIAL), and makes an
 *   auth-per-use Keystore key. So in credential mode the key is still Keystore-encrypted at rest,
 *   but releasing it is enforced by the app, not by the Keystore. A rooted phone or code running
 *   inside the app process could read it without the PIN. Strong biometrics avoid this.
 * - PAIRING: non-secret details (gateway, device id, fingerprint, name, status).
 */

const KEY = "agentbox.key";
const PAIRING = "agentbox.pairing";

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
};

export class NoScreenLockError extends Error {
  constructor() { super("Set a screen lock (PIN, pattern or password) on this phone first. agentbox needs it to protect its key."); }
}

/** Which protection this phone supports. Null: no screen lock at all, so we refuse to pair. */
export async function availableKeyMode(): Promise<KeyMode | null> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) return null;
  try {
    if (SecureStore.canUseBiometricAuthentication()) return "biometric";
  } catch { /* fall through */ }
  return "credential";
}

export async function saveKey(privateKey: Uint8Array, mode: KeyMode) {
  await SecureStore.setItemAsync(KEY, base64url(privateKey), mode === "biometric"
    ? { requireAuthentication: true, authenticationPrompt: "Protect the agentbox key" }
    : {});
}

/**
 * Asks the person to authenticate and returns the key bytes. Throws if they cancel or the
 * Keystore refuses (for example after biometrics changed, which invalidates the key).
 */
export async function unlockKey(mode: KeyMode): Promise<Uint8Array> {
  if (mode === "credential") {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock agentbox",
      cancelLabel: "Cancel",
      disableDeviceFallback: false,
    });
    if (!r.success) throw new Error(r.error === "user_cancel" || r.error === "system_cancel" ? "Cancelled" : "Couldn't confirm it's you");
  }
  const stored = await SecureStore.getItemAsync(KEY, mode === "biometric"
    ? { requireAuthentication: true, authenticationPrompt: "Unlock agentbox" }
    : {});
  if (!stored) throw new KeyMissingError();
  const bytes = fromBase64url(stored);
  if (bytes.length !== 32) throw new KeyMissingError();
  return bytes;
}

export class KeyMissingError extends Error {
  constructor() { super("This phone's agentbox key is gone. Pair it again."); }
}

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(PAIRING);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Pairing;
    if (p.v !== 1 || !isSafeId(p.deviceId) || !parseHttpsOrigin(p.gateway)) return null;
    if (p.keyMode !== "biometric" && p.keyMode !== "credential") return null;
    return p;
  } catch {
    return null;
  }
}

export const savePairing = (p: Pairing) => SecureStore.setItemAsync(PAIRING, JSON.stringify(p));

/** Forget this device: remove the key and every pairing detail. */
export async function wipeAll() {
  await Promise.allSettled([
    SecureStore.deleteItemAsync(KEY, { requireAuthentication: true }),
    SecureStore.deleteItemAsync(KEY),
    SecureStore.deleteItemAsync(PAIRING),
  ]);
}
