import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base32, base64url, utf8 } from "./encoding";

/**
 * Request signing, exactly as docs/MOBILE-PROTOCOL.md §"Request signing" says. Pure: no I/O, no
 * clock, no randomness (the caller passes time and nonce), so the self-test can pin a vector.
 *
 *   AB1\n<METHOD>\n<path?query>\n<X-AB-Time>\n<X-AB-Nonce>\n<base64url(sha256(body))>
 */

export type SignInput = {
  method: string;
  /** Path including the query string, exactly as sent, e.g. /m/v1/work?x=1 */
  path: string;
  /** Unix milliseconds. */
  time: number;
  /** 16 random bytes. */
  nonce: Uint8Array;
  /** Raw body bytes; empty (or omitted) when there's no body. */
  body?: Uint8Array;
};

export type SignedHeaders = {
  "X-AB-Device": string;
  "X-AB-Time": string;
  "X-AB-Nonce": string;
  "X-AB-Sig": string;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function canonicalMessage(input: SignInput): string {
  const method = input.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error("Bad method");
  if (!input.path.startsWith("/") || /[\s\n]/.test(input.path)) throw new Error("Bad path");
  if (!Number.isSafeInteger(input.time) || input.time <= 0) throw new Error("Bad time");
  if (input.nonce.length !== 16) throw new Error("Nonce must be 16 bytes");
  return [
    "AB1",
    method,
    input.path,
    String(input.time),
    base64url(input.nonce),
    base64url(sha256(input.body ?? new Uint8Array(0))),
  ].join("\n");
}

/** Signs one request. Returns the four headers and (for tests only) the canonical message. */
export function signRequest(
  input: SignInput & { deviceId: string; privateKey: Uint8Array },
): { headers: SignedHeaders; message: string } {
  if (!SAFE_ID.test(input.deviceId)) throw new Error("Bad device id");
  if (input.privateKey.length !== 32) throw new Error("Bad key");
  const message = canonicalMessage(input);
  const sig = ed25519.sign(utf8(message), input.privateKey);
  return {
    message,
    headers: {
      "X-AB-Device": input.deviceId,
      "X-AB-Time": String(input.time),
      "X-AB-Nonce": base64url(input.nonce),
      "X-AB-Sig": base64url(sig),
    },
  };
}

export const publicKeyOf = (privateKey: Uint8Array): Uint8Array => ed25519.getPublicKey(privateKey);

/** First 10 bytes of sha256(public key), base32, in groups of 4: K3QF-7ZMA-2XWB-... */
export function fingerprint(publicKey: Uint8Array): string {
  return base32(sha256(publicKey).slice(0, 10)).match(/.{1,4}/g)!.join("-");
}

/** For comparing a fingerprint the server reports with ours, ignoring dashes and case. */
export function sameFingerprint(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/-/g, "");
  const x = norm(a);
  return /^[A-Z2-7]{16}$/.test(x) && x === norm(b);
}

export const isSafeId = (id: unknown): id is string => typeof id === "string" && SAFE_ID.test(id);
