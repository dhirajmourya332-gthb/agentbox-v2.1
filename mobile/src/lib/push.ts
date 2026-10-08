import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { isSafeId } from "../crypto/sign";
import { setPushToken } from "./api";

/**
 * Push notifications (contract D), client side.
 *
 * - Notifications are content-free ("Something needs you"); `data` carries only ids
 *   `{ kind, room_id, attention_id }`. Tapping one opens the app, which still has to be unlocked;
 *   the ids are validated, held in memory, and only used to navigate (and fetch) after unlock.
 * - Permission is asked for once, with an explanation, after pairing or on the first unlock.
 * - The Expo push token is registered with a signed POST on each unlock when it changed, and
 *   removed with a signed DELETE on Forget. No background fetch, no background tasks.
 */

export const CHANNEL = "attention";
const ASKED = "agentbox.push.asked";
const SENT = "agentbox.push.token";

export type PushTarget = { kind: string | null; roomId: string | null; attentionId: string | null };

const KINDS = new Set(["reply", "failed", "stalled", "question"]);

/** Only well-formed ids get through; everything else in `data` is ignored. */
export function parseTarget(data: unknown): PushTarget | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const roomId = isSafeId(d.room_id) ? d.room_id : null;
  const attentionId = isSafeId(d.attention_id) ? d.attention_id : null;
  const kind = typeof d.kind === "string" && KINDS.has(d.kind) ? d.kind : null;
  if (!roomId && !attentionId) return null;
  return { kind, roomId, attentionId };
}

// --- tapped notifications ---------------------------------------------------------------------

let pending: PushTarget | null = null;
const handled = new Set<string>();
const listeners = new Set<() => void>();

function take(r: Notifications.NotificationResponse | null) {
  if (!r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const id = r.notification.request.identifier;
  if (handled.has(id)) return;
  handled.add(id);
  Notifications.clearLastNotificationResponseAsync().catch(() => {});
  const t = parseTarget(r.notification.request.content.data);
  if (!t) return;
  pending = t;
  listeners.forEach((f) => f());
}

/** The target from the last tapped notification, once. */
export function takePending(): PushTarget | null {
  const t = pending;
  pending = null;
  return t;
}
export function onPending(f: () => void) {
  listeners.add(f);
  return () => { listeners.delete(f); };
}
export function clearPending() {
  pending = null;
}

/** Call once at startup (outside the lock gate): listens for taps, including the one that launched the app. */
export function initPush(): () => void {
  if (Platform.OS !== "android") return () => {};
  // While the app is open it updates live, so don't pop a banner; keep it in the shade only.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
  ensureChannel().catch(() => {});
  const sub = Notifications.addNotificationResponseReceivedListener(take);
  Notifications.getLastNotificationResponseAsync().then(take, () => {});
  return () => sub.remove();
}

async function ensureChannel() {
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: "Needs you",
    description: "When an agent replies, fails or looks stuck. No details are shown.",
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    showBadge: true,
  });
}

// --- permission and registration --------------------------------------------------------------

export async function permissionState(): Promise<"granted" | "ask" | "denied"> {
  const p = await Notifications.getPermissionsAsync();
  if (p.granted) return "granted";
  return p.canAskAgain ? "ask" : "denied";
}

export async function wasAsked(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(ASKED)) === "1"; } catch { return true; }
}
export async function markAsked() {
  try { await SecureStore.setItemAsync(ASKED, "1"); } catch { /* ignore */ }
}

/** Shows Android's prompt. Returns whether notifications are allowed now. */
export async function requestPermission(): Promise<boolean> {
  await markAsked();
  await ensureChannel().catch(() => {});
  const p = await Notifications.requestPermissionsAsync();
  return p.granted;
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

/**
 * On each unlock: if notifications are allowed, get the Expo push token and send it (signed) when
 * it differs from the last one sent. If they've been turned off since, remove it on the server.
 * Never throws.
 */
export async function syncPushToken(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const sent = await SecureStore.getItemAsync(SENT).catch(() => null);
    if ((await permissionState()) !== "granted") {
      if (sent && (await setPushToken(null))) await SecureStore.deleteItemAsync(SENT).catch(() => {});
      return;
    }
    await ensureChannel().catch(() => {});
    const id = projectId();
    if (!id) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    if (typeof token !== "string" || !/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/.test(token)) return;
    if (token === sent) return;
    if (await setPushToken(token)) await SecureStore.setItemAsync(SENT, token).catch(() => {});
  } catch {
    // No Firebase config in this build, offline, or the server doesn't know the route yet.
  }
}

/** On Forget: remove the token on the server (best effort) and forget it locally. */
export async function unregisterPush(): Promise<void> {
  await setPushToken(null).catch(() => false);
  await Promise.allSettled([SecureStore.deleteItemAsync(SENT), SecureStore.deleteItemAsync(ASKED)]);
  pending = null;
}
