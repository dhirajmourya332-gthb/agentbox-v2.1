/**
 * Pairing QR payload: {"v":1,"u":"https://<host>.ts.net","c":"<code>","n":"agentbox"}.
 * Pure and strict: v must be 1; only the keys v, u, c, n; u a bare https origin (no path, query,
 * userinfo or IP literal); c exactly 32 bytes of base64url. The app always asks the person to
 * confirm the host; hosts outside *.ts.net get an extra warning (`trusted: false`).
 */

export type PairingPayload = {
  /** Normalised origin, e.g. https://agentbox.tail1234.ts.net (no trailing slash, no path). */
  gateway: string;
  host: string;
  code: string;
  name: string;
};

export type QrResult =
  | { ok: true; payload: PairingPayload; trusted: boolean }
  | { ok: false; reason: string };

const ALLOWED_KEYS = new Set(["v", "u", "c", "n"]);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Parses an https origin by hand (React Native's URL polyfill is incomplete). */
export function parseHttpsOrigin(raw: string): { origin: string; host: string } | null {
  const m = /^https:\/\/([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?\/?$/.exec(raw);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  // No IP literals: a top-level label is never all digits (IPv6 brackets already fail the regex).
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  let port = "";
  if (m[2] !== undefined) {
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    if (n !== 443) port = `:${n}`;
  }
  return { origin: `https://${host}${port}`, host };
}

export const isTailnetHost = (host: string) => host.endsWith(".ts.net") && host.split(".").length >= 3;

export function parsePairingQr(raw: string): QrResult {
  const no = (reason: string): QrResult => ({ ok: false, reason });
  if (typeof raw !== "string" || raw.length > 1024) return no("This isn't an agentbox pairing code.");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return no("This isn't an agentbox pairing code.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return no("This isn't an agentbox pairing code.");
  const d = data as Record<string, unknown>;
  if (Object.keys(d).some((k) => !ALLOWED_KEYS.has(k))) return no("This isn't an agentbox pairing code.");
  if (d.v !== 1) return no("This pairing code is from a different version of agentbox.");
  if (d.n !== undefined && typeof d.n !== "string") return no("The pairing code is malformed.");
  if (typeof d.u !== "string") return no("The pairing code has no gateway address.");
  const origin = parseHttpsOrigin(d.u);
  if (!origin) return no("The gateway address must be a plain https:// address.");
  // Exactly 32 bytes, base64url without padding: 43 characters, the last one carrying 2 zero bits.
  if (typeof d.c !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(d.c)) return no("The pairing code is malformed.");
  const name = typeof d.n === "string" ? d.n.replace(/[^\x20-\x7E]/g, "").slice(0, 40) : "agentbox";
  return {
    ok: true,
    trusted: isTailnetHost(origin.host),
    payload: { gateway: origin.origin, host: origin.host, code: d.c, name: name || "agentbox" },
  };
}
