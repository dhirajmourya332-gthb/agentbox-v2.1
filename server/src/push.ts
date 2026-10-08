import { get, run } from "./db.ts";
import { clearPushToken, pushTargets } from "./devices.ts";

/**
 * Push notifications to paired phones through Expo's push service (docs/CONTRACTS-v2.md › D).
 *
 * - Content-free by default: title "agentbox", body "Something needs you" / "N things need you",
 *   and `data` holds only ids ({ kind, room_id, attention_id }). The portal's "Show details in
 *   notifications" (meta `push_details`) adds the attention title to the body.
 * - At most one push per device every 30 s; whatever arrives meanwhile is summed into one push.
 * - Expo tickets and, later, receipts: a token Expo reports as DeviceNotRegistered is dropped.
 * - Tokens and notification text are never logged.
 *
 * Wiring: the attention module (workstream "live") exports onAttention(cb); index.ts calls
 * `wirePush(onAttention)` once.
 */

/** Contract B. Defined here until the attention module lands; the shapes are identical. */
export type { Attention } from "./attention.ts";
import type { Attention } from "./attention.ts";

export type PushLog = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
let log: PushLog = {
  info: () => {},
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

// The env overrides exist for the rehearsal tests (server/test/) and can only shorten the windows.
const shorter = (env: string | undefined, max: number) => {
  const n = Number(env);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, max) : max;
};
export const COALESCE_MS = shorter(process.env.AGENTBOX_PUSH_COALESCE_MS, 30_000);
const RECEIPT_DELAY_MS = shorter(process.env.AGENTBOX_PUSH_RECEIPT_DELAY_MS, 15 * 60_000); // Expo suggests ~15 min
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60_000; // Expo keeps receipts for a day
const RECEIPTS_MAX = 10_000;
const TIMEOUT_MS = 10_000;
const ATTEMPTS = 4;          // 1 + 3 retries
const BACKOFF_MS = 1000;     // 1 s, 2 s, 4 s (+ jitter)
const CHUNK = 100;           // Expo accepts at most 100 messages per request
const TEST_EVERY_MS = 5000;  // "Send test notification": at most one per device every 5 s
const DEDUPE_MS = 60 * 60_000;

const DEFAULT_URL = "https://exp.host/--/api/v2/push/send";
const META_DETAILS = "push_details";

// --- settings -----------------------------------------------------------------------------

export const pushDetails = () => get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, META_DETAILS)?.value === "1";

export function setPushDetails(on: boolean) {
  run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, META_DETAILS, on ? "1" : "0");
  return on;
}

/**
 * Where to send. AGENTBOX_PUSH_URL overrides it for tests; it must be https, or http on loopback
 * (a local mock). Anything else is refused: tokens never go to an unexpected host.
 */
function endpoints(): { send: string; receipts: string; expo: boolean } | null {
  const raw = process.env.AGENTBOX_PUSH_URL || DEFAULT_URL;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback)) || u.username || u.password) return null;
  if (!u.pathname.endsWith("/push/send")) return null;
  const r = new URL(u.href);
  r.pathname = u.pathname.replace(/\/push\/send$/, "/push/getReceipts");
  return { send: u.href, receipts: r.href, expo: u.hostname === "exp.host" };
}

// --- HTTP with timeouts and retries -----------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST JSON; retries network errors, timeouts, 429 and 5xx with exponential backoff. Returns the
 * parsed body, or null. Never logs bodies: they carry tokens.
 */
async function post(url: string, expo: boolean, body: unknown): Promise<any | null> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  // Only needed when "Enhanced security for push notifications" is on for the Expo project.
  const access = process.env.EXPO_ACCESS_TOKEN;
  if (access && expo) headers.authorization = `Bearer ${access}`;
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep(BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    let status = 0;
    try {
      const res = await fetch(url, { method: "POST", headers, body: payload, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = res.status;
      if (res.ok) return await res.json();
      await res.body?.cancel().catch(() => {});
      if (status !== 429 && status < 500) {
        log.warn(`push: the push service refused the request (HTTP ${status})`);
        return null;
      }
    } catch (e: any) {
      if (status) return null; // a 2xx with a body that isn't JSON: don't resend
      log.warn(`push: request failed (${String(e?.name ?? "error").replace(/[^A-Za-z]/g, "").slice(0, 40)}), attempt ${attempt + 1}`);
      continue;
    }
    log.warn(`push: HTTP ${status}, attempt ${attempt + 1}`);
  }
  log.warn(`push: giving up after ${ATTEMPTS} attempts`);
  return null;
}

/** A provider error code like "DeviceNotRegistered", safe to log. */
const errCode = (x: any) => {
  const c = x?.details?.error;
  return typeof c === "string" && /^[A-Za-z]{1,48}$/.test(c) ? c : "unknown";
};

// --- messages ---------------------------------------------------------------------------------

type ExpoMessage = {
  to: string; title: string; body: string;
  data: { kind: string; room_id: string | null; attention_id: string | null };
  priority: "high"; channelId: "attention"; ttl: number;
};

/** Printable, single line, bounded: the title is agent-written text. */
const clean = (s: unknown, max: number) =>
  String(s ?? "").replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

const idOrNull = (s: unknown) => (typeof s === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(s) ? s : null);

export function buildMessage(token: string, count: number, latest: Attention, details: boolean): ExpoMessage {
  let body = count > 1 ? `${count} things need you` : "Something needs you";
  if (details) {
    const t = clean(latest.title, 160);
    if (t) body = count > 1 ? `${count} things need you. Latest: ${t}` : t;
  }
  return {
    to: token, title: "agentbox", body,
    data: { kind: clean(latest.kind, 16), room_id: idOrNull(latest.room_id), attention_id: idOrNull(latest.id) },
    priority: "high", channelId: "attention", ttl: 24 * 60 * 60,
  };
}

// --- delivery, tickets and receipts ----------------------------------------------------------

type Outgoing = { deviceId: string; token: string; message: ExpoMessage };
const receipts = new Map<string, { deviceId: string; token: string; at: number }>(); // receipt id → where it went

/** Send, then read the tickets. Returns each message's outcome ("ok" or an error code). */
async function deliver(list: Outgoing[]): Promise<string[]> {
  const ep = endpoints();
  if (!ep) {
    log.error("push: AGENTBOX_PUSH_URL is not an allowed push endpoint; nothing sent");
    return list.map(() => "not_configured");
  }
  const out: string[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const res = await post(ep.send, ep.expo, part.map((o) => o.message));
    const tickets: any[] = Array.isArray(res?.data) ? res.data : [];
    part.forEach((o, j) => {
      const t = tickets[j];
      if (t?.status === "ok" && typeof t.id === "string" && t.id.length <= 128) {
        receipts.set(t.id, { deviceId: o.deviceId, token: o.token, at: Date.now() });
        out.push("ok");
      } else if (t?.status === "error") {
        const code = errCode(t);
        if (code === "DeviceNotRegistered") clearPushToken(o.deviceId, o.token);
        log.warn(`push: ticket error ${code}`);
        out.push(code);
      } else {
        out.push(res ? "no_ticket" : "failed");
      }
    });
  }
  while (receipts.size > RECEIPTS_MAX) receipts.delete(receipts.keys().next().value!);
  return out;
}

let checking = false;
/** Fetch receipts that are due; drop tokens Expo says are dead. */
export async function checkReceipts(force = false) {
  if (checking) return;
  checking = true;
  try {
    const t = Date.now();
    for (const [id, r] of receipts) if (t - r.at > RECEIPT_MAX_AGE_MS) receipts.delete(id);
    const due = [...receipts].filter(([, r]) => force || t - r.at >= RECEIPT_DELAY_MS).map(([id]) => id);
    const ep = endpoints();
    if (!due.length || !ep) return;
    for (let i = 0; i < due.length; i += 1000) {
      const ids = due.slice(i, i + 1000);
      const res = await post(ep.receipts, ep.expo, { ids });
      const data = res?.data && typeof res.data === "object" ? res.data : null;
      if (!data) continue; // try again on the next round
      for (const id of ids) {
        const r = data[id];
        if (!r) continue; // not ready yet
        const sent = receipts.get(id);
        receipts.delete(id);
        if (r.status === "error") {
          const code = errCode(r);
          if (code === "DeviceNotRegistered" && sent) clearPushToken(sent.deviceId, sent.token);
          log.warn(`push: receipt error ${code}`);
        }
      }
    }
  } finally {
    checking = false;
  }
}

// --- coalescing ---------------------------------------------------------------------------------

type Slot = { lastSent: number; count: number; latest: Attention | null; timer: NodeJS.Timeout | null };
const slots = new Map<string, Slot>();
const queued = new Map<string, number>(); // attention id → when; an item is pushed once

/** Send what each of these devices has waiting, in one request. */
async function flush(ids: string[]) {
  const tokens = new Map(pushTargets().map((d) => [d.id, d.push_token]));
  const details = pushDetails();
  const list: Outgoing[] = [];
  for (const id of ids) {
    const s = slots.get(id);
    if (!s) continue;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const { count, latest } = s;
    s.count = 0;
    s.latest = null;
    const token = tokens.get(id);
    if (!token) { slots.delete(id); continue; } // revoked, forgotten or turned off meanwhile
    if (!count || !latest) continue;
    s.lastSent = Date.now();
    list.push({ deviceId: id, token, message: buildMessage(token, count, latest, details) });
  }
  if (list.length) await deliver(list);
}

/**
 * A new attention item: push to every active device with a token, at most once per device per
 * 30 s. Resolves once anything sendable right away has been handed to Expo.
 */
export async function sendAttentionPush(item: Attention) {
  if (!item || typeof item.id !== "string" || item.seen_at) return;
  const t = Date.now();
  for (const [id, at] of queued) if (t - at > DEDUPE_MS) queued.delete(id);
  const key = `${item.id}@${item.created_at}`; // a refreshed reply keeps its id but gets a new time
  if (queued.has(key)) return;
  queued.set(key, t);
  const now: string[] = [];
  for (const d of pushTargets()) {
    let s = slots.get(d.id);
    if (!s) slots.set(d.id, (s = { lastSent: 0, count: 0, latest: null, timer: null }));
    s.count++;
    s.latest = item;
    if (s.timer) continue; // already waiting for its window
    const wait = s.lastSent + COALESCE_MS - t;
    if (wait <= 0) now.push(d.id);
    else {
      const id = d.id;
      s.timer = setTimeout(() => { flush([id]).catch((e) => log.error(`push: ${e?.message ?? e}`)); }, wait);
      s.timer.unref();
    }
  }
  if (now.length) await flush(now);
}

/** The portal's "Send test notification". Not coalesced, but limited to one per device per 5 s. */
const lastTest = new Map<string, number>();
export async function sendTestPush(deviceId: string): Promise<{ ok: boolean; error?: string; status: number }> {
  const token = pushTargets().find((d) => d.id === deviceId)?.push_token;
  if (!token) return { ok: false, status: 409, error: "This phone hasn't turned on notifications." };
  if (Date.now() - (lastTest.get(deviceId) ?? 0) < TEST_EVERY_MS) return { ok: false, status: 429, error: "Wait a few seconds before sending another." };
  lastTest.set(deviceId, Date.now());
  const message: ExpoMessage = {
    to: token, title: "agentbox", body: "Test notification",
    data: { kind: "test", room_id: null, attention_id: null }, priority: "high", channelId: "attention", ttl: 60 * 60,
  };
  const [outcome] = await deliver([{ deviceId, token, message }]);
  if (outcome === "ok") return { ok: true, status: 200 };
  const why: Record<string, string> = {
    DeviceNotRegistered: "The phone is no longer registered for notifications; it was turned off. Open the app to turn them on again.",
    not_configured: "The push endpoint is misconfigured (AGENTBOX_PUSH_URL).",
    failed: "Couldn't reach the push service.",
  };
  return { ok: false, status: 502, error: why[outcome] ?? `The push service said: ${outcome}` };
}

// --- wiring ---------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
/** Start the receipt checker. Called once from index.ts. */
export function startPush(logger?: PushLog) {
  if (logger) log = logger;
  if (timer) return;
  timer = setInterval(() => { checkReceipts().catch((e) => log.error(`push: receipts: ${e?.message ?? e}`)); }, Math.min(60_000, RECEIPT_DELAY_MS));
  timer.unref();
}

/** Connect to the attention module's hook: `wirePush(onAttention)`. */
export function wirePush(onAttention: (cb: (item: Attention) => void) => unknown) {
  onAttention((item) => { sendAttentionPush(item).catch((e) => log.error(`push: ${e?.message ?? e}`)); });
}
