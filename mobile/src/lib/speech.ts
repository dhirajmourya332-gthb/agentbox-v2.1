import * as SecureStore from "expo-secure-store";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { useEffect, useState } from "react";
import { Platform } from "react-native";

/**
 * Voice v2: Android's own speech recognition (expo-speech-recognition), plus the owner's voice
 * settings. Recognition prefers the on-device model when it's installed for the chosen language,
 * and otherwise uses the phone's default (online, Google) recognition service, unless the owner has
 * turned on "on-device only". Nothing here keeps any recognised text.
 */

export const LANGS = [
  { key: "en-IN", label: "English (India)", short: "English (IN)" },
  { key: "en-US", label: "English (US)", short: "English (US)" },
  { key: "hi-IN", label: "Hindi", short: "Hindi" },
] as const;
export type Lang = (typeof LANGS)[number]["key"];
export const DEFAULT_LANG: Lang = "en-IN";
export const langLabel = (l: string) => LANGS.find((x) => x.key === l)?.label ?? l;

export type VoicePrefs = { lang: Lang; onDeviceOnly: boolean };

const LANG_KEY = "agentbox.voice.lang";
const ONDEVICE_KEY = "agentbox.voice.ondevice-only";

let prefs: VoicePrefs = { lang: DEFAULT_LANG, onDeviceOnly: false };
let loaded: Promise<VoicePrefs> | null = null;
const listeners = new Set<(p: VoicePrefs) => void>();

/** The saved settings (not secret; kept in secure storage like the app's other small settings). */
export function loadVoicePrefs(): Promise<VoicePrefs> {
  loaded ??= (async () => {
    try {
      const [l, o] = await Promise.all([SecureStore.getItemAsync(LANG_KEY), SecureStore.getItemAsync(ONDEVICE_KEY)]);
      prefs = { lang: LANGS.some((x) => x.key === l) ? (l as Lang) : DEFAULT_LANG, onDeviceOnly: o === "1" };
    } catch { /* defaults */ }
    return prefs;
  })();
  return loaded;
}

export async function setVoicePrefs(change: Partial<VoicePrefs>) {
  await loadVoicePrefs();
  prefs = { ...prefs, ...change };
  listeners.forEach((f) => f(prefs));
  await Promise.allSettled([
    SecureStore.setItemAsync(LANG_KEY, prefs.lang),
    SecureStore.setItemAsync(ONDEVICE_KEY, prefs.onDeviceOnly ? "1" : "0"),
  ]);
}

/** On Forget this device. */
export async function clearVoicePrefs() {
  prefs = { lang: DEFAULT_LANG, onDeviceOnly: false };
  loaded = null;
  listeners.forEach((f) => f(prefs));
  await Promise.allSettled([SecureStore.deleteItemAsync(LANG_KEY), SecureStore.deleteItemAsync(ONDEVICE_KEY)]);
}

export function useVoicePrefs(): VoicePrefs {
  const [p, setP] = useState(prefs);
  useEffect(() => {
    listeners.add(setP);
    loadVoicePrefs().then(setP, () => {});
    return () => { listeners.delete(setP); };
  }, []);
  return p;
}

// --- engine ---------------------------------------------------------------------------------

const api = () => (Platform.OS === "android" && typeof Platform.Version === "number" ? Platform.Version : 0);

/** Android 13+ is needed for the library's on-device recognizer, continuous mode and biasing strings. */
export const isAndroid13 = () => api() >= 33;

const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();

/** Is any recognition service installed and enabled? */
export function recognitionAvailable(): boolean {
  try { return ExpoSpeechRecognitionModule.isRecognitionAvailable(); } catch { return false; }
}

/** Can this phone recognise on-device at all (independent of the language model)? */
export function onDeviceSupported(): boolean {
  if (!isAndroid13()) return false;
  try { return ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(); } catch { return false; }
}

export type OnDeviceStatus = "unsupported" | "installed" | "missing" | "unknown";

/** Whether the on-device model for `lang` is installed. Bounded: never waits more than 4 s. */
export async function onDeviceStatus(lang: string): Promise<OnDeviceStatus> {
  if (!onDeviceSupported()) return "unsupported";
  try {
    const res = await Promise.race([
      ExpoSpeechRecognitionModule.getSupportedLocales({}),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    if (!res) return "unknown";
    return res.installedLocales.some((l) => norm(l) === norm(lang)) ? "installed" : "missing";
  } catch {
    return "unknown";
  }
}

export type Engine = "on-device" | "online";

/**
 * Picks where the audio goes. On-device when its model for `lang` is installed; otherwise online,
 * unless `onDeviceOnly` (then null, with the reason).
 */
export async function pickEngine(lang: string, onDeviceOnly: boolean): Promise<{ engine: Engine } | { engine: null; status: OnDeviceStatus }> {
  const status = await onDeviceStatus(lang);
  if (status === "installed") return { engine: "on-device" };
  if (onDeviceOnly) return { engine: null, status };
  return { engine: "online" };
}

/** Asks Android to download the offline model. Returns a plain-words outcome. */
export async function downloadModel(lang: string): Promise<string> {
  if (!onDeviceSupported()) return "This phone can't recognise speech on-device (it needs Android 13 or later with on-device speech recognition).";
  try {
    const r = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale: lang });
    if (r.status === "download_success") return `The offline model for ${langLabel(lang)} is installed.`;
    if (r.status === "download_scheduled") return `Android will download the offline model for ${langLabel(lang)} soon (it may wait for Wi-Fi).`;
    return "Android opened its download screen. Once the model is downloaded, voice runs on-device.";
  } catch {
    return `Android couldn't download an offline model for ${langLabel(lang)}. It may not offer one for this language on this phone.`;
  }
}

/** The fixed words recognition is biased towards, besides agent names and roles. */
export const GLOSSARY = [
  "tech-lead", "coder", "devops", "security", "Dependabot", "Keycloak", "MSSP", "Brandsek", "Scrutex",
  "epic", "PR", "worktree", "staging", "Swagger",
];
