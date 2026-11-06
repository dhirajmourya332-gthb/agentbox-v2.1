import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { useEffect, useState } from "react";
import * as wake from "../../modules/wake-word";
import { claimRecognizer, ownsRecognizer, releaseRecognizer } from "../ui/Voice";
import { HttpError, signedJson } from "./api";
import { isLinked, linkAll, linkCall, linked, unlink } from "./assistantLink";
import * as keyring from "./keyring";
import { GLOSSARY, loadVoicePrefs, pickEngine, recognitionAvailable } from "./speech";
import type { Pairing } from "./vault";
import { asksAll, assistantName, isEnd, isNo, isYes, parseSwitch, type Target } from "./assistantWords";
import { keywordLine, wakeNameProblem } from "./wakeTokens";

export { assistantName };

/**
 * The voice assistant (docs/VOICE-ASSISTANT.md). A conversation: listen (Android's recogniser,
 * like dictation) → ask the agentbox (POST /m/v1/assistant/ask, a Claude turn there) → speak the
 * answer (Android's text-to-speech) → listen again for a follow-up, without the wake word, until
 * the owner goes quiet or says "that's all".
 *
 * Actions: the agentbox only PROPOSES one (a task, a reply, a plan decision, running a routine)
 * and says it back ending "Shall I?". It happens only when the next thing the owner says is a yes;
 * then this phone makes the ordinary request (POST /work, threads/:id/messages, …) itself.
 *
 * Switching agentboxes ("switch to Mumbai") and asking all of them ("…on all agentboxes") are
 * handled here, on the phone. Hands-free (the wake word) is modules/wake-word.
 *
 * Nothing heard or said is stored: the transcript lives in memory for the current conversation.
 */

export type Action =
  | { kind: "new_task"; role_id: string; role_name: string; title: string; text: string }
  | { kind: "reply"; thread_id: string; agent_id: string; agent_name: string; work: string | null; text: string; attention_id: string | null }
  | { kind: "decide_plan"; plan_id: string; agent_name: string; title: string; verdict: "approve" | "changes" | "reject"; note: string }
  | { kind: "run_routine"; routine_id: string; routine_name: string };

export type Phase = "idle" | "listening" | "thinking" | "speaking" | "acting";
export type Line = { who: "you" | "assistant" | "note"; text: string; at: number };
export type { Target };
export type Sensitivity = "low" | "normal" | "high";

export type AssistantState = {
  phase: Phase;
  /** What the recogniser hears right now. */
  live: string;
  lines: Line[];
  target: Target | null;
  targets: Target[];
  pending: Action | null;
  handsFree: boolean;
  wake: wake.WakeState;
  error: string | null;
};

export type AssistantPrefs = { wakePhrase: string; sensitivity: Sensitivity };
export const DEFAULT_PREFS: AssistantPrefs = { wakePhrase: "Hey Nova", sensitivity: "normal" };
const THRESHOLD: Record<Sensitivity, number> = { low: 0.35, normal: 0.25, high: 0.15 };

// --- state -----------------------------------------------------------------------------------------

let state: AssistantState = {
  phase: "idle", live: "", lines: [], target: null, targets: [], pending: null, handsFree: false, wake: "stopped", error: null,
};
const listeners = new Set<(s: AssistantState) => void>();
function set(patch: Partial<AssistantState>) {
  state = { ...state, ...patch };
  listeners.forEach((f) => f(state));
}
export const assistantState = () => state;

export function useAssistant(): AssistantState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

const MAX_LINES = 40;
function note(who: Line["who"], text: string) {
  set({ lines: [...state.lines, { who, text, at: Date.now() }].slice(-MAX_LINES) });
}

// --- prefs -----------------------------------------------------------------------------------------

const PHRASE_KEY = "agentbox.assistant.phrase";
const SENS_KEY = "agentbox.assistant.sensitivity";
let prefs: AssistantPrefs = DEFAULT_PREFS;
let prefsLoaded: Promise<AssistantPrefs> | null = null;
const prefListeners = new Set<(p: AssistantPrefs) => void>();

export function loadAssistantPrefs(): Promise<AssistantPrefs> {
  prefsLoaded ??= (async () => {
    try {
      const [ph, se] = await Promise.all([SecureStore.getItemAsync(PHRASE_KEY), SecureStore.getItemAsync(SENS_KEY)]);
      prefs = {
        wakePhrase: ph && !wakeNameProblem(ph) ? ph : DEFAULT_PREFS.wakePhrase,
        sensitivity: se === "low" || se === "high" || se === "normal" ? se : DEFAULT_PREFS.sensitivity,
      };
    } catch { /* defaults */ }
    return prefs;
  })();
  return prefsLoaded;
}

export async function setAssistantPrefs(change: Partial<AssistantPrefs>) {
  await loadAssistantPrefs();
  if (change.wakePhrase !== undefined) {
    const problem = wakeNameProblem(change.wakePhrase);
    if (problem) throw new Error(problem);
  }
  prefs = { ...prefs, ...change };
  prefListeners.forEach((f) => f(prefs));
  await Promise.allSettled([SecureStore.setItemAsync(PHRASE_KEY, prefs.wakePhrase), SecureStore.setItemAsync(SENS_KEY, prefs.sensitivity)]);
  // A running listener picks the new name or sensitivity up straight away.
  if (state.handsFree) await startListening().catch((e) => set({ error: String(e?.message ?? e) }));
}

export function useAssistantPrefs(): AssistantPrefs {
  const [p, setP] = useState(prefs);
  useEffect(() => {
    prefListeners.add(setP);
    loadAssistantPrefs().then(setP, () => {});
    return () => { prefListeners.delete(setP); };
  }, []);
  return p;
}

/** On Forget this device. */
export async function clearAssistantPrefs() {
  disableHandsFree();
  prefs = DEFAULT_PREFS;
  prefsLoaded = null;
  prefListeners.forEach((f) => f(prefs));
  set({ lines: [], pending: null });
  await Promise.allSettled([SecureStore.deleteItemAsync(PHRASE_KEY), SecureStore.deleteItemAsync(SENS_KEY)]);
}

// --- where questions go ----------------------------------------------------------------------------

/** The agentbox open in the app (its key is in the app's keyring while unlocked). */
let appTarget: Target | null = null;

function refreshTargets() {
  const list: Target[] = [...linked()];
  if (appTarget && keyring.currentDevice() === appTarget.deviceId && !list.some((t) => t.deviceId === appTarget!.deviceId)) list.push(appTarget);
  const keep = state.target && list.find((t) => t.deviceId === state.target!.deviceId);
  const target = keep ?? (appTarget && list.find((t) => t.deviceId === appTarget!.deviceId)) ?? list[0] ?? null;
  set({ targets: list, target });
}

/** From the app shell: the agentbox open on screen (null while locked / unpaired). */
export function setAppTarget(t: Target | null) {
  appTarget = t;
  refreshTargets();
}
export const targetsChanged = () => refreshTargets();

export function chooseTarget(deviceId: string) {
  const t = state.targets.find((x) => x.deviceId === deviceId);
  if (t) { set({ target: t, pending: null }); convo = null; }
}

function call<T>(deviceId: string, method: "GET" | "POST", path: string, body?: unknown, timeout?: number): Promise<T> {
  if (isLinked(deviceId)) return linkCall<T>(deviceId, method, path, body, timeout);
  if (keyring.currentDevice() === deviceId) return signedJson<T>(method, path, body, timeout);
  return Promise.reject(new Error("That agentbox is locked. Open agentbox and unlock it, or turn on hands-free."));
}

// --- speaking and listening --------------------------------------------------------------------------

let ttsLang: string | undefined = "en-IN";
let voicesChecked = "";

/** The recognition language's voice when the phone has one; otherwise the phone's default voice. */
async function pickTtsLang(lang: string) {
  const want = lang === "hi-IN" ? "en-IN" : lang;
  if (voicesChecked === want) return;
  voicesChecked = want;
  try {
    const voices = await Promise.race([Speech.getAvailableVoicesAsync(), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    const has = (l: string) => !!voices?.some((v) => v.language?.replace("_", "-").toLowerCase() === l.toLowerCase());
    ttsLang = !voices || !voices.length ? undefined : has(want) ? want : has("en-US") ? "en-US" : undefined;
  } catch {
    ttsLang = undefined;
  }
}

/**
 * Speaks `text`. Never hangs: some text-to-speech engines don't report the end (no voice for the
 * language, engine busy), so a watchdog sized to the text resolves it anyway.
 */
function say(text: string, my: number): Promise<void> {
  if (my !== gen) return Promise.resolve();
  set({ phase: "speaking" });
  note("assistant", text);
  return new Promise((resolve) => {
    let over = false;
    const done = () => { if (!over) { over = true; clearTimeout(watchdog); resolve(); } };
    const words = text.split(/\s+/).length;
    const watchdog = setTimeout(() => { try { Speech.stop(); } catch { /* not speaking */ } done(); }, 4000 + words * 600);
    try {
      Speech.speak(text, { ...(ttsLang ? { language: ttsLang } : {}), rate: 1.0, onDone: done, onStopped: done, onError: done });
    } catch {
      done();
    }
  });
}

const join = (parts: string[]) => parts.map((s) => s.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

/** One utterance. Null when nothing was said within `waitMs`. */
async function listenOnce(waitMs: number, my: number): Promise<string | null> {
  if (my !== gen) return null;
  if (!recognitionAvailable()) throw new Error("This phone has no speech recognition service. Enable Google's speech services.");
  const perm = await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync();
  if (!perm.granted) throw new Error("agentbox needs the microphone. Allow it in the app's Android settings.");
  const vp = await loadVoicePrefs();
  await pickTtsLang(vp.lang);
  const pick = await pickEngine(vp.lang, vp.onDeviceOnly);
  if (!pick.engine) throw new Error("The offline speech model isn't installed. Download it in Settings, Voice.");
  if (my !== gen) return null;
  set({ phase: "listening", live: "" });
  return new Promise((resolve) => {
    const finals: string[] = [];
    let interim = "";
    let heard = false;
    let finished = false;
    const id = claimRecognizer(() => finish(null));
    const finish = (v: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(quiet);
      clearTimeout(cap);
      subs.forEach((s) => s.remove());
      releaseRecognizer(id);
      set({ live: "" });
      resolve(v);
    };
    const subs = [
      ExpoSpeechRecognitionModule.addListener("result", (e) => {
        if (!ownsRecognizer(id)) return;
        const t = (e.results?.[0]?.transcript ?? "").trim();
        if (e.isFinal) { if (t) finals.push(t); interim = ""; } else interim = t;
        if (t) heard = true;
        set({ live: join([...finals, interim]) });
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => {
        if (ownsRecognizer(id)) finish(join([...finals, interim]) || null);
      }),
    ];
    // Nothing said: give up quietly. Something said: the recogniser ends on its own at the pause
    // (and if it doesn't within a few seconds of the last words, stop it ourselves).
    const quiet = setTimeout(() => {
      if (heard) return;
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* not running */ }
      finish(null);
    }, waitMs);
    // At most 45 s per utterance; if Android never reports the end, take what was heard.
    const cap = setTimeout(() => {
      try { ExpoSpeechRecognitionModule.stop(); } catch { /* not running */ }
      setTimeout(() => finish(join([...finals, interim]) || null), 3000);
    }, 45_000);
    try {
      ExpoSpeechRecognitionModule.start({
        lang: vp.lang,
        interimResults: true,
        maxAlternatives: 1,
        continuous: false,
        requiresOnDeviceRecognition: pick.engine === "on-device",
        contextualStrings: [...state.targets.map((t) => t.name), ...GLOSSARY, "yes", "no"],
        androidIntentOptions: { EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 1400, EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 1200 },
        recordingOptions: { persist: false },
      });
    } catch {
      finish(null);
    }
  });
}

// --- the conversation --------------------------------------------------------------------------------

type Turn = { role: "user" | "assistant"; text: string };
/** The current conversation with one agentbox (sent back as context). Forgotten after 5 minutes. */
let convo: { deviceId: string; turns: Turn[]; at: number } | null = null;
const CONVO_MS = 5 * 60_000;
/** The agentbox gives up at 90 s; past a minute the owner has stopped waiting anyway. */
const ASK_TIMEOUT_MS = 60_000;

let gen = 0;
let running = false;

function friendly(e: unknown, box: string): string {
  if (e instanceof HttpError) {
    if (e.status === 404 || e.status === 410) return `${box} needs an update before I can answer there.`;
    if (e.status === 429) return "I'm getting too many questions at once. Give me a moment.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

async function ask(t: Target, text: string, my: number): Promise<{ speech: string; action: Action | null }> {
  if (!convo || convo.deviceId !== t.deviceId || Date.now() - convo.at > CONVO_MS) convo = { deviceId: t.deviceId, turns: [], at: Date.now() };
  set({ phase: "thinking" });
  // Answers take several seconds (a Claude turn on the agentbox): say so, so silence isn't a mystery.
  const holding = setTimeout(() => {
    if (my === gen && state.phase === "thinking") { try { Speech.speak("One moment.", ttsLang ? { language: ttsLang } : {}); } catch { /* no voice */ } }
  }, 1500);
  let res: { speech: string; action: Action | null };
  try {
    res = await call<{ speech: string; action: Action | null }>(t.deviceId, "POST", "/m/v1/assistant/ask",
      { text, history: convo.turns.slice(-10), name: assistantName(prefs.wakePhrase), box: t.name }, ASK_TIMEOUT_MS);
  } finally {
    clearTimeout(holding);
  }
  if (my === gen && convo?.deviceId === t.deviceId) {
    convo.turns.push({ role: "user", text }, { role: "assistant", text: res.speech });
    convo.at = Date.now();
  }
  return { speech: String(res.speech ?? ""), action: res.action ?? null };
}

/** Carries out a confirmed action through the same routes a tap would use. */
async function act(t: Target, a: Action): Promise<string> {
  set({ phase: "acting" });
  switch (a.kind) {
    case "new_task":
      await call(t.deviceId, "POST", "/m/v1/work", { role_id: a.role_id, text: a.text, title: a.title });
      return `Started. ${a.role_name} has it.`;
    case "reply":
      await call(t.deviceId, "POST", `/m/v1/threads/${encodeURIComponent(a.thread_id)}/messages`, { text: a.text });
      if (a.attention_id) await call(t.deviceId, "POST", `/m/v1/attention/${encodeURIComponent(a.attention_id)}/seen`).catch(() => {});
      return `Sent to ${a.agent_name.replace(/#\d+$/, "")}.`;
    case "decide_plan":
      await call(t.deviceId, "POST", `/m/v1/plans/${encodeURIComponent(a.plan_id)}/decide`, { verdict: a.verdict, note: a.note });
      return a.verdict === "approve" ? "Approved." : a.verdict === "reject" ? "Rejected." : "Sent back with your note.";
    case "run_routine":
      await call(t.deviceId, "POST", `/m/v1/routines/${encodeURIComponent(a.routine_id)}/run`);
      return `${a.routine_name} is running.`;
  }
}

/** Handles one thing the owner said. False: the conversation is over. */
async function handle(heard: string, my: number): Promise<boolean> {
  const target = state.target;
  if (!target) { await say("I can't reach an agentbox. Open agentbox and unlock it.", my); return false; }

  const pending = state.pending;
  if (pending) {
    set({ pending: null });
    if (isYes(heard)) {
      try { await say(await act(target, pending), my); } catch (e) { await say(`That didn't work. ${friendly(e, target.name)}`, my); }
      return true;
    }
    if (isNo(heard)) { await say("Okay, I won't.", my); return true; }
    // Anything else: a new request; the proposal is dropped.
  }
  if (isEnd(heard)) { await say("Okay.", my); return false; }

  const sw = parseSwitch(heard, state.targets, target);
  if (sw && "to" in sw) {
    convo = null;
    set({ target: sw.to });
    await say(sw.to.deviceId === target.deviceId ? `We're on ${sw.to.name}.` : `Switched to ${sw.to.name}.`, my);
    return true;
  }
  if (sw) {
    await say(`I don't know that one. ${state.targets.length > 1 ? `You have ${state.targets.map((x) => x.name).join(" and ")}.` : `I can only reach ${target.name} right now.`}`, my);
    return true;
  }

  if (asksAll(heard) && state.targets.length > 1) {
    for (const box of state.targets) {
      if (my !== gen) return false;
      try {
        const r = await ask(box, heard, my);
        await say(`On ${box.name}: ${r.speech}`, my);
      } catch (e) {
        await say(`On ${box.name}: ${friendly(e, box.name)}`, my);
      }
    }
    return true;
  }

  try {
    const r = await ask(target, heard, my);
    if (my !== gen) return false;
    await say(r.speech, my);
    if (r.action) set({ pending: r.action });
  } catch (e) {
    await say(friendly(e, target.name), my);
  }
  return true;
}

/** Start a conversation (the wake word, or the Talk button). Again while talking: stop. */
export async function talk(trigger: "wake" | "button") {
  if (running) {
    if (trigger === "button") stopTalking();
    return;
  }
  running = true;
  const my = ++gen;
  set({ error: null });
  wake.pauseWakeWord();
  try {
    // A tap is in the foreground, so the permission can be asked for there (hands-free asked already).
    if (trigger === "button" && !(await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync()).granted) {
      await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
    }
    await loadAssistantPrefs();
    refreshTargets();
    let followUp = false;
    for (let round = 0; round < 20 && my === gen; round++) {
      // A proposal waits for a yes or no a little longer.
      const heard = await listenOnce(state.pending ? 8000 : followUp ? 6000 : 8000, my);
      if (my !== gen) break;
      if (!heard) {
        if (state.pending) { set({ pending: null }); await say("Okay, I'll leave it.", my); }
        else if (!followUp) await say("I didn't catch that.", my);
        break;
      }
      note("you", heard);
      if (!(await handle(heard, my))) break;
      followUp = true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    set({ error: msg });
    await say(msg, my).catch(() => {});
  } finally {
    if (my === gen) {
      running = false;
      set({ phase: "idle", live: "" });
      if (state.handsFree) wake.resumeWakeWord();
    }
  }
}

export function stopTalking() {
  gen++;
  running = false;
  try { Speech.stop(); } catch { /* not speaking */ }
  try { ExpoSpeechRecognitionModule.abort(); } catch { /* not listening */ }
  set({ phase: "idle", live: "", pending: null });
  if (state.handsFree) wake.resumeWakeWord();
}

/** The on-screen Yes / No for a proposal (same as saying it). */
export async function answerPending(yes: boolean) {
  const a = state.pending;
  const target = state.target;
  if (!a || !target) return;
  stopTalking();
  const my = ++gen;
  running = true;
  try {
    if (yes) {
      try { await say(await act(target, a), my); } catch (e) { await say(`That didn't work. ${friendly(e, target.name)}`, my); }
    } else {
      await say("Okay, I won't.", my);
    }
  } finally {
    if (my === gen) {
      running = false;
      set({ phase: "idle", live: "" });
      if (state.handsFree) wake.resumeWakeWord();
    }
  }
}

// --- hands-free ----------------------------------------------------------------------------------------

export const handsFreeAvailable = () => wake.wakeWordAvailable();

async function startListening() {
  const p = await loadAssistantPrefs();
  const line = keywordLine(p.wakePhrase);
  if (!line) throw new Error("Pick a wake phrase made of letters.");
  const name = assistantName(p.wakePhrase);
  await wake.startWakeWord({
    keywords: line, threshold: THRESHOLD[p.sensitivity],
    title: `${name} is listening`, text: `Say "${p.wakePhrase}" to talk. Nothing is recorded.`,
  });
}

/**
 * Turns hands-free on: unlocks every agentbox for the assistant (a fingerprint each) and starts
 * listening for the wake phrase. Must be called while the app is open. Returns a problem, or null.
 */
export async function enableHandsFree(servers: Pairing[]): Promise<string | null> {
  if (!wake.wakeWordAvailable()) return "This phone can't listen hands-free (it needs a 64-bit ARM phone and this app version).";
  let perm = await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync();
  if (!perm.granted) perm = await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
  if (!perm.granted) return "Hands-free needs the microphone permission.";
  const p = await loadAssistantPrefs();
  const problem = wakeNameProblem(p.wakePhrase);
  if (problem) return problem;
  const failed = await linkAll(servers);
  refreshTargets();
  if (!linked().length) return "Couldn't unlock any agentbox, so the assistant would have nowhere to ask.";
  try {
    await startListening();
  } catch (e) {
    unlink();
    refreshTargets();
    return e instanceof Error ? e.message : "Couldn't start listening.";
  }
  set({ handsFree: true, error: null });
  return failed.length ? `On, but ${failed.join(" and ")} stayed locked, so the assistant can't reach ${failed.length > 1 ? "them" : "it"}.` : null;
}

export function disableHandsFree() {
  wake.stopWakeWord();
  unlink();
  if (running) stopTalking();
  set({ handsFree: false, wake: "stopped" });
  refreshTargets();
}

/** Wiring for the native listener; call once (AssistantHost). */
export function startAssistantEvents() {
  const offWake = wake.onWake(() => { void talk("wake"); });
  const offState = wake.onWakeState((s, message) => {
    set({ wake: s });
    if (s === "error" && message) set({ error: message });
    // "Stop listening" in the notification: also drop the keys.
    if (s === "stopped" && state.handsFree) disableHandsFree();
  });
  return () => { offWake(); offState(); };
}
