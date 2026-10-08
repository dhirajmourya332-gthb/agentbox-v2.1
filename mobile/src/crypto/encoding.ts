/**
 * Small, dependency-free encoders. Pure functions: they run the same in Hermes and in Node (the
 * self-test), so the bytes we sign on the phone are the bytes the test checks.
 */

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX: Record<string, number> = Object.fromEntries([...B64URL].map((c, i) => [c, i]));

/** base64url without padding (RFC 4648 §5). */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/** Decodes base64url (no padding). Throws on anything that isn't strictly base64url. */
export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("Not base64url");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = B64URL_INDEX[text[i]];
    const b = B64URL_INDEX[text[i + 1]];
    const c = i + 2 < text.length ? B64URL_INDEX[text[i + 2]] : 0;
    const d = i + 3 < text.length ? B64URL_INDEX[text[i + 3]] : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255;
    if (i + 2 < text.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < text.length) out[o++] = n & 255;
  }
  return out;
}

/** Standard base64 (with + / and padding) to base64url, for data from the image picker. */
export const base64ToBase64url = (b64: string) => b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** RFC 4648 base32, upper case, no padding. */
export function base32(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Percent-encodes everything except RFC 3986 unreserved characters. Stricter than
 * encodeURIComponent on purpose: Android's HTTP stack (OkHttp) re-encodes a few characters that
 * encodeURIComponent leaves alone (e.g. `'`), which would change the path we signed.
 */
export function strictEncode(text: string): string {
  let out = "";
  for (const b of utf8(text)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
