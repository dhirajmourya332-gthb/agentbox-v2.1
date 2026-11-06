import { requireOptionalNativeModule } from "expo";

type EventSubscription = { remove(): void };

/**
 * Hands-free listening for the assistant's name (android/…/WakeWordService.kt): an on-device
 * keyword spotter in a foreground service. `keywords` is one or more lines from
 * src/lib/wakeTokens.ts keywordLine(), joined with "/".
 */

export type WakeState = "listening" | "paused" | "stopped" | "error";

type Native = {
  isSupported(): boolean;
  isRunning(): boolean;
  state(): WakeState;
  start(keywords: string, threshold: number, title: string, text: string): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  addListener(event: "onWake", f: (e: { keyword: string }) => void): EventSubscription;
  addListener(event: "onState", f: (e: { state: WakeState; message: string | null }) => void): EventSubscription;
};

// Absent in builds without the module (and on anything but Android): every call is then a no-op.
const native = requireOptionalNativeModule<Native>("WakeWord");

export const wakeWordAvailable = () => {
  try { return !!native?.isSupported(); } catch { return false; }
};
export const wakeWordRunning = () => {
  try { return !!native?.isRunning(); } catch { return false; }
};
export const wakeWordState = (): WakeState => {
  try { return native?.state() ?? "stopped"; } catch { return "stopped"; }
};

export async function startWakeWord(opts: { keywords: string; threshold: number; title: string; text: string }) {
  if (!native) throw new Error("This build of the app can't listen hands-free.");
  await native.start(opts.keywords, opts.threshold, opts.title, opts.text);
}
export const pauseWakeWord = () => { try { native?.pause(); } catch { /* not running */ } };
export const resumeWakeWord = () => { try { native?.resume(); } catch { /* not running */ } };
export const stopWakeWord = () => { try { native?.stop(); } catch { /* not running */ } };

export function onWake(f: (keyword: string) => void): () => void {
  const sub = native?.addListener("onWake", (e) => f(e.keyword));
  return () => sub?.remove();
}
export function onWakeState(f: (state: WakeState, message: string | null) => void): () => void {
  const sub = native?.addListener("onState", (e) => f(e.state, e.message));
  return () => sub?.remove();
}
