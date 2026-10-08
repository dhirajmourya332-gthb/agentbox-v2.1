import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Request signing for the mobile gateway (docs/MOBILE-PROTOCOL.md › Request signing). Pure: no
 * database or server imports, so tests can check vectors against exactly this code.
 */

/** Strict base64url (no padding) that decodes to exactly `len` bytes; null otherwise. */
export function b64urlBytes(s: unknown, len: number): Buffer | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.length === len && buf.toString("base64url") === s ? buf : null;
}

export const bodyHash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("base64url");

/**
 * The signed message. `url` is the raw, undecoded request target (path + query) exactly as sent;
 * `raw` is the request body bytes before any parsing (empty when there is none).
 */
export function canonicalMessage(method: string, url: string, time: string, nonce: string, raw: Uint8Array) {
  return Buffer.from(["AB1", method.toUpperCase(), url, time, nonce, bodyHash(raw)].join("\n"), "utf8");
}

/** Verify a base64url Ed25519 signature against a base64url public key. Never throws. */
export function verifySignature(publicKeyB64u: string, sigB64u: unknown, message: Uint8Array) {
  const sig = b64urlBytes(sigB64u, 64);
  const pub = b64urlBytes(publicKeyB64u, 32);
  if (!sig || !pub) return false;
  try {
    return ed25519.verify(sig, message, pub, { zip215: false });
  } catch {
    return false;
  }
}
