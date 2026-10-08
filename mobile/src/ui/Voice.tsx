import { getRecordingPermissionsAsync, RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, type RecordingOptions } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { api, HttpError } from "../lib/api";
import * as keyring from "../lib/keyring";
import { showDialog } from "./dialog";
import { T } from "./kit";
import { usePalette } from "./theme";

/**
 * Voice input (backlog 12, contract C). Records AAC/m4a (mono), sends it once to
 * POST /m/v1/voice/transcribe, and puts the cleaned text in the box for review. Never sends.
 *
 * - The microphone permission is asked for only when the mic is first tapped.
 * - Recording only happens in the foreground: if the app goes to the background or locks, the
 *   recording is stopped and discarded. There is no background-recording service.
 * - The recording file lives in the app's cache only until it's read (or cancelled), then it's
 *   deleted. Any leftovers (e.g. after a crash) are swept on the next use.
 */

const MAX_SECONDS = 5 * 60;
const MAX_BYTES = 15 * 1024 * 1024;
const MIME = "audio/mp4"; // AAC in an MPEG-4 (.m4a) container

const OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  android: { extension: ".m4a", outputFormat: "mpeg4", audioEncoder: "aac" },
};

let recordingNow = 0;

/** Deletes expo-audio's recordings in the cache (its "Audio" folder). Skipped while recording. */
function sweepRecordings() {
  if (recordingNow > 0) return;
  try {
    const dir = new Directory(Paths.cache, "Audio");
    if (!dir.exists) return;
    for (const f of dir.list()) {
      if (f instanceof File && /^recording-.*\.m4a$/i.test(f.name)) {
        try { f.delete(); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function deleteFile(uri: string | null) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch { /* ignore */ }
}

const errorText = (e: unknown) => {
  if (e instanceof HttpError) {
    if (e.status === 413) return "That recording is too long. Keep it under 5 minutes.";
    if (e.status === 503) return "Voice isn't set up on agentbox yet.";
    if (e.status === 502) return "The transcription service failed. Try again.";
    if (e.status === 404 || e.status === 410) return "This agentbox doesn't support voice yet.";
  }
  return e instanceof Error && e.message ? e.message : "Couldn't transcribe that.";
};

export type Voice = ReturnType<typeof useVoice>;

/**
 * `setText` is the box's state setter: the transcript is appended to whatever is there.
 */
export function useVoice({ purpose, agentId, setText }: {
  purpose: "task" | "message"; agentId?: string; setText: Dispatch<SetStateAction<string>>;
}) {
  const recorder = useAudioRecorder(OPTIONS);
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ text: string; raw: string } | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const gen = useRef(0); // bumped on cancel: any later result from an earlier run is dropped
  const uri = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const startedAt = useRef(0);
  const finishRef = useRef<() => void>(() => {});

  const counted = useRef(false); // whether this hook holds one count in `recordingNow`
  const release = () => {
    if (counted.current) { counted.current = false; recordingNow = Math.max(0, recordingNow - 1); }
  };

  const stopRecorder = useCallback(async () => {
    clearInterval(timer.current);
    try {
      if (recorder.isRecording) await recorder.stop();
    } catch { /* already stopped or released */ }
    release();
  }, [recorder]);

  /** Stop and throw everything away. */
  const cancel = useCallback(async () => {
    gen.current++;
    phaseRef.current = "idle";
    setPhase("idle");
    setSeconds(0);
    await stopRecorder();
    deleteFile(uri.current);
    uri.current = null;
    sweepRecordings();
  }, [stopRecorder]);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setError(null);
    setLast(null);
    let perm = await getRecordingPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) {
        showDialog("Microphone is off", "agentbox needs the microphone to hear you. Allow it in Android Settings → Apps → agentbox → Permissions.", [
          { text: "Not now", style: "cancel" },
          { text: "Open settings", onPress: () => { Linking.openSettings().catch(() => {}); } },
        ]);
        return;
      }
      perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) return;
    }
    if (AppState.currentState !== "active" || !keyring.isLoaded()) return;
    const my = ++gen.current;
    sweepRecordings();
    phaseRef.current = "starting";
    setPhase("starting");
    recordingNow++;
    counted.current = true;
    try {
      await recorder.prepareToRecordAsync();
      if (my !== gen.current) { await stopRecorder(); deleteFile(recorder.uri); return; }
      uri.current = recorder.uri;
      recorder.record();
    } catch {
      await stopRecorder();
      deleteFile(recorder.uri);
      phaseRef.current = "idle";
      setPhase("idle");
      setError("Couldn't start the microphone.");
      return;
    }
    startedAt.current = Date.now();
    setSeconds(0);
    phaseRef.current = "recording";
    setPhase("recording");
    timer.current = setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000;
      setSeconds(Math.floor(s));
      if (s >= MAX_SECONDS) finishRef.current();
    }, 250);
  }, [recorder, stopRecorder]);

  /** Done: stop, read the file, delete it, transcribe, and put the text in the box. */
  const finish = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    const my = gen.current;
    await stopRecorder();
    const path = recorder.uri ?? uri.current;
    phaseRef.current = "transcribing";
    setPhase("transcribing");
    let audio = "";
    try {
      if (!path) throw new Error("Nothing was recorded.");
      const f = new File(path);
      if (!f.exists || !f.size) throw new Error("Nothing was recorded.");
      if (f.size > MAX_BYTES) throw new Error("That recording is too big.");
      audio = await f.base64();
    } catch (e) {
      if (my === gen.current) setError(e instanceof Error ? e.message : "Couldn't read the recording.");
      audio = "";
    } finally {
      deleteFile(path);
      deleteFile(uri.current);
      uri.current = null;
    }
    if (!audio || my !== gen.current) {
      if (my === gen.current) { phaseRef.current = "idle"; setPhase("idle"); }
      return;
    }
    try {
      const res = await api.transcribe({ audio, mime: MIME, purpose, ...(agentId ? { agent_id: agentId } : {}) });
      audio = "";
      if (my !== gen.current) return;
      const text = (res.text || res.raw || "").trim();
      if (!text) setError("Didn't catch anything. Try again.");
      else {
        setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}${t.endsWith("\n") ? "" : " "}${text}` : text));
        const raw = (res.raw ?? "").trim();
        setLast(res.cleaned && raw && raw !== text ? { text, raw } : null);
      }
    } catch (e) {
      if (my === gen.current) setError(errorText(e));
    } finally {
      if (my === gen.current) { phaseRef.current = "idle"; setPhase("idle"); }
    }
  }, [recorder, stopRecorder, purpose, agentId, setText]);
  finishRef.current = () => { finish(); };

  /** Swap the cleaned text we inserted for the raw transcript. */
  const applyRaw = useCallback(() => {
    if (!last) return;
    setText((t) => {
      const i = t.lastIndexOf(last.text);
      return i === -1 ? `${t}${t ? " " : ""}${last.raw}` : t.slice(0, i) + last.raw + t.slice(i + last.text.length);
    });
    setLast(null);
  }, [last, setText]);

  // Background or lock: cancel and discard. (Locking also unmounts the screen; see below.)
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active" && phaseRef.current !== "idle") cancel();
    });
    const off = keyring.onWipe(() => { if (phaseRef.current !== "idle") cancel(); });
    return () => { sub.remove(); off(); };
  }, [cancel]);

  // Leaving the screen: stop and delete.
  useEffect(() => () => {
    gen.current++;
    clearInterval(timer.current);
    if (phaseRef.current === "recording" || phaseRef.current === "starting") {
      try { if (recorder.isRecording) recorder.stop().catch(() => {}); } catch { /* released */ }
    }
    release();
    deleteFile(uri.current);
    uri.current = null;
    setTimeout(sweepRecordings, 1500); // after the recorder has let go of the file
  }, [recorder]);

  return {
    phase, seconds, error, last, start, finish, cancel, applyRaw,
    dismiss: () => { setError(null); setLast(null); },
    busy: phase !== "idle",
  };
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

/** Listening / Transcribing / result line, shown above the box while in use. */
export function VoiceBar({ v }: { v: Voice }) {
  const p = usePalette();
  if (v.phase === "recording" || v.phase === "starting") {
    return (
      <View style={[st.bar, { backgroundColor: p.surface2 }]} accessibilityLiveRegion="polite">
        <Text style={{ color: p.bad, fontSize: 14 }}>●</Text>
        <T size={14} weight="600" style={{ flex: 1 }}>{v.phase === "starting" ? "Starting…" : `Listening ${clock(v.seconds)}`}</T>
        <T muted size={12}>max 5:00</T>
        <Pressable onPress={() => { v.cancel(); }} accessibilityRole="button" hitSlop={8} style={st.act}>
          <T size={14} weight="600" muted>Cancel</T>
        </Pressable>
        <Pressable onPress={() => { v.finish(); }} disabled={v.phase !== "recording"} accessibilityRole="button" hitSlop={8}
          style={[st.act, st.done, { backgroundColor: p.accent }]}>
          <Text style={{ color: p.accentText, fontWeight: "600", fontSize: 14 }}>Done</Text>
        </Pressable>
      </View>
    );
  }
  if (v.phase === "transcribing") {
    return (
      <View style={[st.bar, { backgroundColor: p.surface2 }]} accessibilityLiveRegion="polite">
        <ActivityIndicator color={p.muted} size="small" />
        <T size={14} style={{ flex: 1 }}>Transcribing…</T>
        <Pressable onPress={() => { v.cancel(); }} accessibilityRole="button" hitSlop={8} style={st.act}>
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
  if (v.last) {
    return (
      <View style={st.note}>
        <T muted size={13} style={{ flex: 1 }}>Transcribed and tidied up. Check it before sending.</T>
        <Pressable onPress={v.applyRaw} accessibilityRole="button" hitSlop={8}>
          <T size={13} weight="600" style={{ color: p.accent }}>Use raw transcript</T>
        </Pressable>
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
  bar: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 4 },
  act: { paddingVertical: 6, paddingHorizontal: 6 },
  done: { borderRadius: 8, paddingHorizontal: 12 },
  note: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
});
