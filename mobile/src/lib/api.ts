import { fetch as expoFetch } from "expo/fetch";
import * as keyring from "./keyring";
import { base64url, strictEncode } from "../crypto/encoding";
import { isSafeId } from "../crypto/sign";
import type { Agent, DisplayHolder, Group, RetiredAgent, Routine, RoomView, Task, ThreadData, Usage, WorkRoom } from "./types";

/**
 * Signed client for the mobile gateway. Every request goes to the one gateway origin we paired
 * with, under /m/v1/, with a fresh signature, via expo/fetch with redirect: "error" (the native
 * client is told not to follow redirects; any 3xx is a failure).
 *
 * A 404 on an ordinary request is NOT taken as revocation on its own (an agent can write a broken
 * image link). We then ask whoami; only if whoami also 404s is the device "not recognised", and
 * we stop making requests so the app shows the re-pair screen.
 *
 * Nothing here logs. Response bodies, keys and signatures never reach the console.
 */

let gateway: string | null = null;
let halted = false;
const haltListeners = new Set<() => void>();

export function configure(origin: string | null) {
  gateway = origin;
  halted = false;
  lastConfirmed = 0;
}

export const isHalted = () => halted;

export function onHalt(f: () => void) {
  haltListeners.add(f);
  return () => { haltListeners.delete(f); };
}

function halt() {
  if (halted) return;
  halted = true;
  haltListeners.forEach((f) => f());
}

export class NotRecognizedError extends Error {
  constructor() { super("This phone isn't paired any more."); }
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Builds /m/v1/<rest>. Every dynamic segment must be a safe id. */
const seg = (id: string) => {
  if (!isSafeId(id)) throw new Error("Bad id");
  return id;
};

const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const WHOAMI = "/m/v1/whoami";

type Res = Awaited<ReturnType<typeof expoFetch>>;

/** One signed request, no interpretation of the status beyond refusing redirects. */
async function rawSigned(method: "GET" | "POST", path: string, body?: unknown, timeout = TIMEOUT_MS): Promise<Res> {
  if (halted) throw new NotRecognizedError();
  if (!gateway) throw new keyring.LockedError();
  if (!path.startsWith("/m/v1/")) throw new Error("Refusing a path outside /m/v1/");
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { ...keyring.sign(method, path, text), accept: "application/json" };
  if (text !== undefined) headers["content-type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res: Res;
  try {
    res = await expoFetch(gateway + path, { method, headers, body: text, credentials: "omit", redirect: "error", signal: ctrl.signal });
  } catch {
    throw new Error(ctrl.signal.aborted ? "agentbox didn't answer in time." : "Can't reach agentbox. Is Tailscale on?");
  } finally {
    clearTimeout(timer);
  }
  if (res.redirected || (res.status >= 300 && res.status < 400)) throw new Error("Unexpected redirect; refusing the response.");
  return res;
}

// whoami confirmations are shared and briefly cached, so a page of broken images makes one call.
let confirming: Promise<void> | null = null;
let lastConfirmed = 0;

/** After a 404: is this device still recognised? Halts (and throws) only if whoami 404s too. */
async function confirmRecognized(): Promise<void> {
  if (Date.now() - lastConfirmed < 10_000) return;
  confirming ??= (async () => {
    try {
      const res = await rawSigned("GET", WHOAMI);
      if (res.status === 404) { halt(); return; }
      if (res.ok) lastConfirmed = Date.now();
    } catch {
      // Network trouble: not evidence of revocation.
    }
  })().finally(() => { confirming = null; });
  await confirming;
  if (halted) throw new NotRecognizedError();
}

async function signedFetch(method: "GET" | "POST", path: string, body?: unknown, timeout = TIMEOUT_MS): Promise<Res> {
  const res = await rawSigned(method, path, body, timeout);
  if (res.status === 404) {
    if (path === WHOAMI) { halt(); throw new NotRecognizedError(); }
    await confirmRecognized();
    throw new HttpError(404, "Not found.");
  }
  if (res.status === 410) throw new HttpError(410, "Not found. It may have been removed.");
  return res;
}

async function json<T>(method: "GET" | "POST", path: string, body?: unknown, timeout?: number): Promise<T> {
  const res = await signedFetch(method, path, body, timeout);
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error.slice(0, 300)
      : `Request failed (${res.status})`;
    throw new HttpError(res.status, msg);
  }
  return data as T;
}

/**
 * Best effort: tell the gateway to delete this device (204) before we wipe locally. Never halts,
 * never throws. Needs the key in memory, so it only runs while unlocked.
 */
export async function forgetDevice(): Promise<boolean> {
  if (!keyring.isLoaded() || halted) return false;
  try {
    const res = await rawSigned("POST", "/m/v1/device/forget", undefined, 8_000);
    return res.status === 204 || res.ok;
  } catch {
    return false;
  }
}

const q = (path: string) => `?path=${strictEncode(path)}`;

export const api = {
  whoami: () => json<{ status: "pending" } | { status: "active"; device_id: string; name: string }>("GET", "/m/v1/whoami"),
  state: () => json<{ agents: Agent[]; usage: Usage | null; groups: Group[]; paused: boolean; display: DisplayHolder; retired: RetiredAgent[] }>("GET", "/m/v1/state"),
  work: () => json<{ live: WorkRoom[]; done: WorkRoom[] }>("GET", "/m/v1/work"),
  room: (rootId: string) => json<RoomView>("GET", `/m/v1/work/${seg(rootId)}`),
  thread: (id: string) => json<ThreadData>("GET", `/m/v1/threads/${seg(id)}`),
  routines: () => json<Routine[]>("GET", "/m/v1/routines"),
  control: () => json<{ paused: boolean; display: DisplayHolder; running: number }>("GET", "/m/v1/control"),
  newTask: (roleId: string, text: string, title?: string, images?: string[]) =>
    json<Agent>("POST", "/m/v1/work", { role_id: roleId, text, title, images }),
  send: (threadId: string, text: string, images?: string[]) =>
    json<unknown>("POST", `/m/v1/threads/${seg(threadId)}/messages`, { text, images }),
  stop: (taskId: string) => json<unknown>("POST", `/m/v1/tasks/${seg(taskId)}/stop`),
  finishTask: (instanceId: string) => json<{ finished: number }>("POST", `/m/v1/agents/${seg(instanceId)}/done`),
  pauseAll: (stopRunning: boolean) => json<unknown>("POST", "/m/v1/pause", { stopRunning }),
  resumeAll: () => json<unknown>("POST", "/m/v1/resume"),
  runRoutine: (id: string) => json<{ started: boolean; routine: Routine }>("POST", `/m/v1/routines/${seg(id)}/run`),
  upload: (name: string, type: string, data: string) =>
    json<{ path: string; name: string; size: number }>("POST", "/m/v1/uploads", { name, type, data }, UPLOAD_TIMEOUT_MS),
};

export type { Task };

// --- images -----------------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, string>();
const CACHE_MAX = 24;
keyring.onWipe(() => cache.clear());

/**
 * Loads a file from /m/v1/file with a signed GET and returns a data: URI. We fetch it ourselves
 * instead of handing signed headers to <Image>, so each load gets a fresh signature, redirects are
 * refused, the image never lands in the image library's disk cache, and a 404 (e.g. an agent's
 * broken link) just shows a placeholder after the whoami check.
 * The in-memory cache is wiped when the app locks.
 */
export async function loadImage(filePath: string): Promise<string> {
  const hit = cache.get(filePath);
  if (hit) return hit;
  const res = await signedFetch("GET", `/m/v1/file${q(filePath)}`);
  if (!res.ok) throw new HttpError(res.status, "Couldn't load the image");
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error("Not an image");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("Image too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image too large");
  const b64 = base64url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  const uri = `data:${type};base64,${b64}${"=".repeat((4 - (b64.length % 4)) % 4)}`;
  if (!keyring.isLoaded()) throw new keyring.LockedError(); // locked while loading: don't cache
  cache.set(filePath, uri);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return uri;
}

// --- live events ------------------------------------------------------------------------------

export type EventSocket = { close: () => void };

/** React Native's WebSocket takes a third argument with headers (the DOM typings don't know). */
const RNWebSocket = WebSocket as unknown as new (url: string, protocols: string[], options: { headers: Record<string, string> }) => WebSocket;

/**
 * The signed WebSocket for live events. Reconnects with backoff; each attempt is signed afresh.
 * After a drop we ask whoami, so a revoked device is noticed (404 → halt) instead of retrying.
 */
export function connectEvents(handlers: {
  onEvent: (e: { type: string; [k: string]: unknown }) => void;
  onOpen: () => void;
  onClose: () => void;
}): EventSocket {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed || halted || !gateway) return;
    const path = "/m/v1/events";
    let headers: Record<string, string>;
    try {
      headers = { ...keyring.sign("GET", path) };
    } catch {
      return; // locked
    }
    // React Native's Android WebSocket adds `Origin: https://<host>` unless one is given. The
    // gateway refuses requests with an Origin, so send it empty (see the protocol notes).
    headers.origin = "";
    const socket = new RNWebSocket(gateway.replace(/^https:/, "wss:") + path, [], { headers });
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      handlers.onOpen();
    };
    socket.onmessage = (m) => {
      if (typeof m.data !== "string" || m.data.length > 4_000_000) return;
      try {
        const e = JSON.parse(m.data);
        if (e && typeof e === "object" && typeof e.type === "string") handlers.onEvent(e);
      } catch { /* ignore malformed */ }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      handlers.onClose();
      if (closed || halted) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
      timer = setTimeout(() => {
        api.whoami().then(open, (err) => { if (!(err instanceof NotRecognizedError)) open(); });
      }, delay);
    };
  };
  open();
  return {
    close: () => {
      closed = true;
      clearTimeout(timer);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}

// --- pairing (the one unsigned request) -------------------------------------------------------

export async function claimPairing(origin: string, body: { code: string; public_key: string; device_name: string; app_version: string }) {
  const url = `${origin}/m/pair/claim`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Res;
  try {
    res = await expoFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      signal: ctrl.signal,
    });
  } catch {
    throw new Error("Can't reach agentbox at that address. Is Tailscale on, on this phone?");
  } finally {
    clearTimeout(timer);
  }
  if (res.redirected || (res.status >= 300 && res.status < 400)) throw new Error("Unexpected redirect; refusing.");
  if (res.status !== 202) {
    throw new Error("That pairing code didn't work. Codes last 2 minutes and work once; make a new one in the portal.");
  }
  const data = (await res.json().catch(() => null)) as { device_id?: unknown; fingerprint?: unknown; status?: unknown } | null;
  if (!data || !isSafeId(data.device_id) || typeof data.fingerprint !== "string") {
    throw new Error("agentbox sent an unexpected reply.");
  }
  return { deviceId: data.device_id, fingerprint: data.fingerprint };
}
