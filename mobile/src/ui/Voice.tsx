import { Directory, File, Paths } from "expo-file-system";
import { ExpoSpeechRecognitionModule, type ExpoSpeechRecognitionErrorEvent, type ExpoSpeechRecognitionResultEvent } from "expo-speech-recognition";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { api, HttpError } from "../lib/api";
import * as keyring from "../lib/keyring";
import {
  downloadModel, GLOSSARY, isAndroid13, langLabel, loadVoicePrefs, pickEngine, recognitionAvailable, type Engine, type OnDeviceStatus,
} from "../lib/speech";
import { useStore } from "../lib/store";
import { showDialog } from "./dialog";
import { T } from "./kit";
import { usePalette } from "./theme";

/**
 * Voice input, v2. Android recognises the speech itself (on-device when its offline model is
 * installed, otherwise the phone's online Google service). Only the recognised TEXT is sent, once,
 * to POST /m/v1/voice/clean; the tidied text goes in the box for review. Never sends.
 *
 * - The microphone permission is asked for only when the mic is first tapped.
 * - Recognition only runs in the foreground: background, lock (key wipe) and leaving the screen
 *   all abort it and discard everything heard so far. No audio is recorded to a file.
 * - The text heard so far lives only in this hook's memory until it's inserted or discarded.
 */

const MAX_SECONDS = 5 * 60;
const MAX_CLEAN_CHARS = 4000;
const STOP_GRACE_MS = 5000; // after Done, how long to wait for the final result before giving up on it
const MAX_QUICK_ENDS = 5; // recognition ending again and again right after starting: give up

type Phase = "idle" | "starting" | "listening" | "cleaning";
type Session = {
  owner: number;
  lang: string;
  engine: Engine;
  onDeviceOnly: boolean;
  strings: string[];
  startedAt: number;
  segStart: number;
  quickEnds: number;
  finals: string[];
  interim: string;
  done: boolean;
  fatal: string | null;
  fallback: boolean; // on-device failed before hearing anything: retry online on the next start
};

// One recognizer per app. Several composers can be mounted at once (the stack keeps screens), so
// the one that started it owns the events; starting elsewhere cancels the current owner first.
let activeOwner: number | null = null;
let activeCancel: (() => void) | null = null;
let ownerSeq = 0;

/**
 * expo-speech-recognition's continuous mode (Android 13+) creates an empty temp_<uuid>.pcm in the
 * cache for each session and never deletes it (no audio is written to it unless recording is
 * persisted, which we never ask for). Sweep them while nothing is listening.
 */
function sweepTemp() {
  if (activeOwner !== null) return;
  try {
    const dir = new Directory(Paths.cache);
    if (!dir.exists) return;
    for (const f of dir.list()) {
      if (f instanceof File && /^temp_[0-9a-f-]+\.pcm$/i.test(f.name)) {
        try { f.delete(); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

const join = (parts: string[]) => parts.map((s) => s.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

/** Recognition errors in plain words. Null: not an error worth stopping for. */
function recognitionError(e: ExpoSpeechRecognitionErrorEvent, s: Session): string | null {
  switch (e.error as string) {
    case "aborted":
    case "no-speech":
    case "speech-timeout":
      return null;
    case "not-allowed":
      return "agentbox can't use the microphone. Allow it in Android Settings → Apps → agentbox → Permissions.";
    case "service-not-allowed":
      return "Android's speech recognition isn't available. Check that Google's speech services (or the Google app) are installed and enabled.";
    case "network":
      return s.engine === "online"
        ? "Couldn't reach Google's speech service. Check the connection, or download the offline model in Settings → Voice."
        : "Speech recognition needed the network and couldn't reach it. Try again.";
    case "language-not-supported":
      return s.engine === "on-device"
        ? `The on-device model for ${langLabel(s.lang)} isn't ready. Download it in Settings → Voice.`
        : `This phone's speech service doesn't support ${langLabel(s.lang)}. Pick another language in Settings → Voice.`;
    case "audio-capture":
      return "Couldn't use the microphone. Another app may be using it.";
    case "busy":
      return "Speech recognition is busy. Try again in a moment.";
    case "too-many-requests":
      return "Google's speech service is limiting requests. Try again shortly.";
    default:
      return "Speech recognition stopped unexpectedly. Try again.";
  }
}

/** Why cleanup didn't happen, when the text was inserted as heard. */
function cleanupNote(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 503) return "Cleanup isn't set up on agentbox, so this is the text as heard. Check it before sending.";
    if (e.status === 404 || e.status === 410) return "This agentbox doesn't support voice cleanup yet, so this is the text as heard. Check it before sending.";
    if (e.status === 429) return "Too many cleanup requests just now, so this is the text as heard. Check it before sending.";
    if (e.status === 400 || e.status === 413) return "agentbox couldn't tidy that up, so this is the text as heard. Check it before sending.";
  }
  return "Couldn't reach agentbox to tidy it up, so this is the text as heard. Check it before sending.";
}

export type Voice = ReturnType<typeof useVoice>;
export type VoiceResult = { note: string; warn: boolean; swap: { text: string; raw: string } | null };

/**
 * `setText` is the box's state setter: the text is appended to whatever is there.
 */
export function useVoice({ purpose, agentId, setText }: {
  purpose: "task" | "message"; agentId?: string; setText: Dispatch<SetStateAction<string>>;
}) {
  const store = useStore();
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [live, setLive] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VoiceResult | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const setP = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const me = useRef(0);
  if (!me.current) me.current = ++ownerSeq;
  const sess = useRef<Session | null>(null);
  const gen = useRef(0); // bumped on cancel: any later result from an earlier run is dropped
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Biasing strings: agent names, slugs and roles, group names, plus the fixed glossary.
  const stringsRef = useRef<string[]>([]);
  {
    const words = new Set<string>(GLOSSARY);
    for (const a of store.agents) {
      for (const w of [a.name, a.slug, a.title, a.slug.replace(/-/g, " ")]) if (w && w.length <= 60) words.add(w.trim());
    }
    for (const g of store.groups) if (g.name && g.name.length <= 60) words.add(g.name.trim());
    stringsRef.current = [...words].filter(Boolean).slice(0, 100);
  }
  const purposeRef = useRef({ purpose, agentId });
  purposeRef.current = { purpose, agentId };
  const setTextRef = useRef(setText);
  setTextRef.current = setText;

  const clearTimers = () => {
    clearInterval(tick.current);
    clearTimeout(stopTimer.current);
    clearTimeout(restartTimer.current);
  };

  const release = () => {
    if (activeOwner === me.current) { activeOwner = null; activeCancel = null; }
    setTimeout(sweepTemp, 1500);
  };

  /** Stop and throw everything away. */
  const cancel = useCallback(() => {
    gen.current++;
    const s = sess.current;
    sess.current = null;
    clearTimers();
    if (s) {
      s.finals = [];
      s.interim = "";
      if (activeOwner === me.current) { try { ExpoSpeechRecognitionModule.abort(); } catch { /* not running */ } }
    }
    release();
    setLive("");
    setSeconds(0);
    setEngine(null);
    setP("idle");
  }, []);

  /** Starts (or restarts) the recognizer for this session. */
  const begin = (s: Session) => {
    if (sess.current !== s || AppState.currentState !== "active" || !keyring.isLoaded()) { cancel(); return; }
    s.segStart = Date.now();
    const a13 = isAndroid13();
    try {
      ExpoSpeechRecognitionModule.start({
        lang: s.lang,
        interimResults: true,
        maxAlternatives: 1,
        continuous: true, // segmented session on Android 13+; long silence timeouts below that
        requiresOnDeviceRecognition: s.engine === "on-device",
        addsPunctuation: a13 && s.engine === "on-device",
        contextualStrings: a13 && s.strings.length ? s.strings : undefined,
        recordingOptions: { persist: false },
      });
    } catch {
      s.fatal = "Couldn't start speech recognition. Try again.";
      finalize(s);
    }
  };

  /** Recognition is over (Done, the 5-minute cap, or an error): tidy up the text and insert it. */
  const finalize = (s: Session) => {
    if (sess.current !== s) return;
    sess.current = null;
    clearTimers();
    release();
    const raw = join([...s.finals, s.interim]);
    s.finals = [];
    s.interim = "";
    const fatal = s.fatal;
    setLive("");
    setEngine(null);
    if (!raw) {
      setP("idle");
      if (fatal) setError(fatal);
      else setError("Didn't catch anything. Try again.");
      return;
    }
    clean(raw, s.lang, fatal).catch(() => {});
  };

  const insert = (text: string) => setTextRef.current(
    (t) => (t.trim() ? `${t.replace(/\s+$/, "")}${t.endsWith("\n") ? "" : " "}${text}` : text));

  const clean = async (raw: string, lang: string, fatal: string | null) => {
    const my = gen.current;
    const { purpose: pur, agentId: aid } = purposeRef.current;
    if (raw.length > MAX_CLEAN_CHARS) {
      setP("idle");
      insert(raw);
      setResult({ note: fatal ?? "Too long to tidy up (over 4,000 characters), so this is the text as heard. Check it before sending.", warn: true, swap: null });
      return;
    }
    setP("cleaning");
    try {
      const res = await api.cleanVoice({ text: raw, purpose: pur, lang, ...(aid ? { agent_id: aid } : {}) });
      if (my !== gen.current) return;
      const text = (typeof res.text === "string" ? res.text : "").trim() || raw;
      insert(text);
      const changed = !!res.cleaned && text !== raw;
      setResult({
        note: fatal ?? (changed ? "Tidied up. Check it before sending." : "Check it before sending."),
        warn: !!fatal,
        swap: changed ? { text, raw } : null,
      });
    } catch (e) {
      if (my !== gen.current) return;
      insert(raw);
      setResult({ note: fatal ?? cleanupNote(e), warn: true, swap: null });
    } finally {
      if (my === gen.current) setP("idle");
    }
  };

  // Recognizer events. Only the owner of the current session reacts.
  useEffect(() => {
    const mine = () => (activeOwner === me.current ? sess.current : null);
    const subs = [
      ExpoSpeechRecognitionModule.addListener("start", () => {
        const s = mine();
        if (s && phaseRef.current === "starting") setP("listening");
      }),
      ExpoSpeechRecognitionModule.addListener("result", (e: ExpoSpeechRecognitionResultEvent) => {
        const s = mine();
        if (!s) return;
        const t = (e.results?.[0]?.transcript ?? "").trim();
        if (e.isFinal) {
          if (t) s.finals.push(t);
          s.interim = "";
        } else {
          s.interim = t;
        }
        if (phaseRef.current === "starting") setP("listening");
        setLive(join([...s.finals, s.interim]));
      }),
      ExpoSpeechRecognitionModule.addListener("error", (e: ExpoSpeechRecognitionErrorEvent) => {
        const s = mine();
        if (!s) return;
        if (e.error === "language-not-supported" && s.engine === "on-device" && !s.onDeviceOnly && !s.finals.length && !s.interim) {
          s.fallback = true; // model went missing: carry on online
          return;
        }
        const msg = recognitionError(e, s);
        if (msg) s.fatal = msg;
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => {
        const s = mine();
        if (!s) return;
        if (s.done || s.fatal || (Date.now() - s.startedAt) / 1000 >= MAX_SECONDS) { finalize(s); return; }
        if (s.fallback) {
          s.fallback = false;
          s.engine = "online";
          setEngine("online");
        }
        // Ended on silence (or a soft error) while the owner is still talking: listen again.
        s.quickEnds = Date.now() - s.segStart < 1500 ? s.quickEnds + 1 : 0;
        if (s.quickEnds >= MAX_QUICK_ENDS) {
          s.fatal = "Speech recognition keeps stopping. Try again.";
          finalize(s);
          return;
        }
        clearTimeout(restartTimer.current);
        restartTimer.current = setTimeout(() => begin(s), 150);
      }),
    ];
    return () => subs.forEach((x) => x.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Done: stop listening, take the final result, tidy it up. */
  const finish = useCallback(() => {
    const s = sess.current;
    if (!s || s.done) return;
    s.done = true;
    clearInterval(tick.current);
    clearTimeout(restartTimer.current);
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* not running */ }
    // If the final result never comes, use what we have.
    stopTimer.current = setTimeout(() => {
      if (sess.current !== s) return;
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* ignore */ }
      finalize(s);
    }, STOP_GRACE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setError(null);
    setResult(null);
    if (AppState.currentState !== "active" || !keyring.isLoaded()) return;
    if (!recognitionAvailable()) {
      setError("This phone has no speech recognition service. Install or enable Google's speech services (or the Google app) and try again.");
      return;
    }
    let perm = await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) {
        showDialog("Microphone is off", "agentbox needs the microphone to hear you. Allow it in Android Settings → Apps → agentbox → Permissions.", [
          { text: "Not now", style: "cancel" },
          { text: "Open settings", onPress: () => { Linking.openSettings().catch(() => {}); } },
        ]);
        return;
      }
      perm = await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
      if (!perm.granted) { setError("Voice needs the microphone permission."); return; }
    }
    if (AppState.currentState !== "active" || !keyring.isLoaded() || phaseRef.current !== "idle") return;
    if (activeOwner !== null && activeOwner !== me.current) activeCancel?.();
    const my = ++gen.current;
    setP("starting");
    const prefs = await loadVoicePrefs();
    const pick = await pickEngine(prefs.lang, prefs.onDeviceOnly);
    if (my !== gen.current) return;
    if (!pick.engine) {
      setP("idle");
      offerModel(prefs.lang, pick.status);
      return;
    }
    if (AppState.currentState !== "active" || !keyring.isLoaded()) { cancel(); return; }
    const now = Date.now();
    const s: Session = {
      owner: me.current, lang: prefs.lang, engine: pick.engine, onDeviceOnly: prefs.onDeviceOnly, strings: stringsRef.current,
      startedAt: now, segStart: now, quickEnds: 0, finals: [], interim: "", done: false, fatal: null, fallback: false,
    };
    sess.current = s;
    activeOwner = me.current;
    activeCancel = cancel;
    setEngine(pick.engine);
    setSeconds(0);
    setLive("");
    tick.current = setInterval(() => {
      const secs = (Date.now() - s.startedAt) / 1000;
      setSeconds(Math.min(MAX_SECONDS, Math.floor(secs)));
      if (secs >= MAX_SECONDS) finishRef.current();
    }, 250);
    begin(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancel]);

  /** Swap the cleaned text we inserted for the raw text as heard. */
  const applyRaw = useCallback(() => {
    const swap = result?.swap;
    if (!swap) return;
    setText((t) => {
      const i = t.lastIndexOf(swap.text);
      return i === -1 ? `${t}${t ? " " : ""}${swap.raw}` : t.slice(0, i) + swap.raw + t.slice(i + swap.text.length);
    });
    setResult(null);
  }, [result, setText]);

  // Background or lock: cancel and discard. (Locking also unmounts the screen; see below.)
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st !== "active" && phaseRef.current !== "idle") cancel();
    });
    const off = keyring.onWipe(() => { if (phaseRef.current !== "idle") cancel(); });
    return () => { sub.remove(); off(); };
  }, [cancel]);

  // Leaving the screen: abort and discard.
  useEffect(() => () => { cancel(); }, [cancel]);

  return {
    phase, seconds, engine, live, error, result, start, finish, cancel, applyRaw,
    dismiss: () => { setError(null); setResult(null); },
    busy: phase !== "idle",
  };
}

/** "On-device only" is on, but the model isn't there. */
function offerModel(lang: string, status: OnDeviceStatus) {
  if (status === "unsupported") {
    showDialog("On-device voice isn't available",
      "This phone can't recognise speech on-device (it needs Android 13 or later with on-device speech recognition). To use voice, turn off \"On-device only\" in Settings → Voice; speech then goes to Google's online service.");
    return;
  }
  showDialog("Offline model needed",
    `"On-device only" is on, but the offline speech model for ${langLabel(lang)} isn't installed. Download it now? Android may download it in the background or wait for Wi-Fi.`, [
      { text: "Not now", style: "cancel" },
      { text: "Download", onPress: () => { downloadModel(lang).then((m) => showDialog("Offline model", m), () => {}); } },
    ]);
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The mic button, next to the image attach button. */
export function MicButton({ v, size = 40 }: { v: Voice; size?: number }) {
  const p = usePalette();
  return (
    <Pressable onPress={() => { v.start().catch(() => {}); }} disabled={v.busy} accessibilityRole="button" accessibilityLabel="Speak instead of typing"
      accessibilityState={{ disabled: v.busy }} hitSlop={6}
      style={({ pressed }) => [st.mic, { width: size, height: size, borderRadius: size / 2, borderColor: p.border, opacity: v.busy ? 0.4 : pressed ? 0.7 : 1 }]}>
      <MicGlyph color={p.text} />
    </Pressable>
  );
}

/** A small microphone drawn with views (no icon font). */
function MicGlyph({ color }: { color: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ width: 8, height: 13, borderRadius: 4, backgroundColor: color }} />
      <View style={{ width: 14, height: 7, borderBottomLeftRadius: 7, borderBottomRightRadius: 7, borderWidth: 1.5, borderTopWidth: 0, borderColor: color, marginTop: -4 }} />
      <View style={{ width: 1.5, height: 3, backgroundColor: color }} />
    </View>
  );
}

/** Listening / Cleaning up / result line, shown above the box while in use. */
export function VoiceBar({ v }: { v: Voice }) {
  const p = usePalette();
  if (v.phase === "starting" || v.phase === "listening") {
    const where = v.engine === "on-device" ? "on-device" : v.engine === "online" ? "Google" : null;
    return (
      <View style={{ marginBottom: 4 }}>
        <View style={[st.bar, { backgroundColor: p.surface2 }]} accessibilityLiveRegion="polite">
          <Text style={{ color: p.bad, fontSize: 14 }}>●</Text>
          <T size={14} weight="600">{v.phase === "starting" ? "Starting…" : `Listening ${clock(v.seconds)}`}</T>
          {where && (
            <View style={[st.tag, { borderColor: p.border }]}
              accessibilityLabel={where === "Google" ? "Speech goes to Google's online service" : "Speech stays on this phone"}>
              <T muted size={11}>{where}</T>
            </View>
          )}
          <View style={{ flex: 1 }} />
          <Pressable onPress={v.cancel} accessibilityRole="button" accessibilityLabel="Cancel and discard" hitSlop={8} style={st.act}>
            <T size={14} weight="600" muted>Cancel</T>
          </Pressable>
          <Pressable onPress={v.finish} disabled={v.phase !== "listening"} accessibilityRole="button" hitSlop={8}
            style={[st.act, st.done, { backgroundColor: p.accent, opacity: v.phase === "listening" ? 1 : 0.5 }]}>
            <Text style={{ color: p.accentText, fontWeight: "600", fontSize: 14 }}>Done</Text>
          </Pressable>
        </View>
        {!!v.live && (
          <Text style={[st.live, { color: p.muted }]} numberOfLines={3} ellipsizeMode="head">{v.live}</Text>
        )}
      </View>
    );
  }
  if (v.phase === "cleaning") {
    return (
      <View style={[st.bar, { backgroundColor: p.surface2, marginBottom: 4 }]} accessibilityLiveRegion="polite">
        <ActivityIndicator color={p.muted} size="small" />
        <T size={14} style={{ flex: 1 }}>Cleaning up…</T>
        <Pressable onPress={v.cancel} accessibilityRole="button" accessibilityLabel="Cancel and discard" hitSlop={8} style={st.act}>
          <T size={14} weight="600" muted>Cancel</T>
        </Pressable>
      </View>
    );
  }
  if (v.error) {
    return (
      <Pressable onPress={v.dismiss} accessibilityRole="button" accessibilityLabel={`${v.error} Dismiss`} style={st.note}>
        <Text style={{ color: p.bad, fontSize: 13, flex: 1 }}>{v.error}</Text>
        <T muted size={13}>✕</T>
      </Pressable>
    );
  }
  if (v.result) {
    return (
      <View style={st.note}>
        <Text style={{ color: v.result.warn ? p.bad : p.muted, fontSize: 13, flex: 1 }}>{v.result.note}</Text>
        {v.result.swap && (
          <Pressable onPress={v.applyRaw} accessibilityRole="button" hitSlop={8}>
            <T size={13} weight="600" style={{ color: p.accent }}>Use raw</T>
          </Pressable>
        )}
        <Pressable onPress={v.dismiss} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={8}>
          <T muted size={13}>✕</T>
        </Pressable>
      </View>
    );
  }
  return null;
}

const st = StyleSheet.create({
  mic: { borderWidth: 1, alignItems: "center", justifyContent: "center" },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  tag: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  live: { fontSize: 13, paddingHorizontal: 12, paddingTop: 4 },
  act: { paddingVertical: 6, paddingHorizontal: 6 },
  done: { borderRadius: 8, paddingHorizontal: 12 },
  note: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
});
