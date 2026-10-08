import { getRandomBytes } from "expo-crypto";
import { signRequest, type SignedHeaders } from "../crypto/sign";
import { utf8 } from "../crypto/encoding";

/**
 * The only place the private key lives in memory, and only while the app is unlocked. Nothing
 * outside this module can read it; callers ask for signatures. `wipe()` zeroes the bytes.
 */

let key: Uint8Array | null = null;
let deviceId: string | null = null;
const wipeListeners = new Set<() => void>();

export function load(privateKey: Uint8Array, id: string) {
  wipe();
  key = Uint8Array.from(privateKey);
  privateKey.fill(0);
  deviceId = id;
}

export function wipe() {
  if (key) key.fill(0);
  key = null;
  deviceId = null;
  wipeListeners.forEach((f) => f());
}

export const isLoaded = () => key !== null;

/** Called on every wipe (lock, forget), e.g. to drop cached images. */
export function onWipe(f: () => void) {
  wipeListeners.add(f);
  return () => { wipeListeners.delete(f); };
}

export class LockedError extends Error {
  constructor() { super("The app is locked"); }
}

/** Fresh time and nonce for every call: never reuse a signature. */
export function sign(method: string, path: string, body?: string): SignedHeaders {
  if (!key || !deviceId) throw new LockedError();
  return signRequest({
    method,
    path,
    body: body === undefined ? undefined : utf8(body),
    time: Date.now(),
    nonce: getRandomBytes(16),
    deviceId,
    privateKey: key,
  }).headers;
}
