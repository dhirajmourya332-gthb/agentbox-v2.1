import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api.ts";
import { Icon, Spinner } from "./ui.tsx";

/**
 * Voice input (backlog 12): record with the mic, the server transcribes (Z.ai GLM-ASR) and cleans
 * the text up, and it's inserted at the cursor for review. Nothing is ever sent automatically.
 */

const MAX_MS = 5 * 60 * 1000;
const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

type Inserted = { at: number; text: string; raw: string; cleaned: boolean };
type State =
  | { kind: "idle" }
  | { kind: "recording"; since: number }
  | { kind: "transcribing" }
  | { kind: "inserted"; ins: Inserted }
  | { kind: "error"; message: string };

const toBase64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the recording"));
    r.readAsDataURL(b);
  });

function micError(e: any) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return "Voice input needs agentbox opened on localhost.";
  if (e?.name === "NotAllowedError" || e?.name === "SecurityError") return "Microphone access is blocked. Allow it for this page in the browser's site settings, then try again.";
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") return "No microphone found. Plug one in or pick one in your system's sound settings.";
  if (e?.name === "NotReadableError") return "The microphone is in use by another app.";
  return "Couldn't start the microphone.";
}

function serverError(e: any) {
  switch (e?.status) {
    case 503: return "Voice isn't set up on this agentbox yet (it needs a Z.ai key in /secrets/zai.env).";
    case 413: return "That recording is too long. Keep it under 5 minutes.";
    case 429: return e.message || "Too many recordings in a minute; wait a moment.";
    case 502: return "The speech service didn't answer. Try again.";
    case 400: return e.message || "Couldn't read that recording. Try again.";
    case undefined: return "Couldn't reach agentbox.";
    default: return e.message || "Transcription failed.";
  }
}

export function useVoice(opts: {
  input: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (f: (prev: string) => string) => void;
  purpose: "task" | "message";
  agentId?: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [now, setNow] = useState(Date.now());
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; discard: boolean; timer: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const release = () => {
    const r = rec.current;
    if (!r) return;
    window.clearTimeout(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
  };

  // Unmounting (navigating away) drops everything and frees the mic.
  useEffect(() => () => {
    if (rec.current) {
      rec.current.discard = true;
      try { rec.current.recorder.stop(); } catch { /* already stopped */ }
    }
    release();
    abort.current?.abort();
  }, []);

  // The clock on the pill.
  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [state.kind]);

  // The note under the box goes once the inserted text is edited away or sent.
  useEffect(() => {
    if (state.kind === "inserted" && !opts.text.includes(state.ins.text)) setState({ kind: "idle" });
  }, [opts.text]);

  function insert(result: { text: string; raw: string; cleaned: boolean }) {
    const el = optsRef.current.input.current;
    const prev = optsRef.current.text;
    // The cursor (or selection) in the box; the end when the box isn't showing the same text.
    const s = el && el.value === prev ? el.selectionStart : prev.length;
    const e = el && el.value === prev ? el.selectionEnd : prev.length;
    const before = prev.slice(0, s), after = prev.slice(e);
    const pre = before && !/\s$/.test(before) ? " " : "";
    const post = after && !/^\s/.test(after) ? " " : "";
    const caret = s + pre.length + result.text.length + post.length;
    const next = before + pre + result.text + post + after;
    optsRef.current.setText(() => next);
    setState({ kind: "inserted", ins: { at: s + pre.length, text: result.text, raw: result.raw, cleaned: result.cleaned } });
    requestAnimationFrame(() => {
      const t = optsRef.current.input.current;
      if (t) { t.focus(); t.setSelectionRange(caret, caret); }
    });
  }

  async function transcribe(blob: Blob, mime: string) {
    setState({ kind: "transcribing" });
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const audio = await toBase64(blob);
      const o = optsRef.current;
      const r = await api.transcribe({ audio, mime, purpose: o.purpose, ...(o.agentId ? { agent_id: o.agentId } : {}) }, ctl.signal);
      if (ctl.signal.aborted) return;
      if (!r.text.trim()) return setState({ kind: "error", message: "Didn't catch any speech. Try again a little closer to the mic." });
      insert(r);
    } catch (e: any) {
      if (ctl.signal.aborted || e?.name === "AbortError") return;
      setState({ kind: "error", message: serverError(e) });
    } finally {
      if (abort.current === ctl) abort.current = null;
    }
  }

  async function start() {
    if (rec.current || state.kind === "transcribing") return;
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      return setState({ kind: "error", message: micError(e) });
    }
    const mime = typeof MediaRecorder !== "undefined" ? MIMES.find((m) => MediaRecorder.isTypeSupported(m)) : undefined;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48_000 });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      return setState({ kind: "error", message: "This browser can't record audio." });
    }
    const r = { recorder, stream, chunks: [] as Blob[], discard: false, timer: 0 };
    rec.current = r;
    recorder.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
    recorder.onstop = () => {
      const type = (recorder.mimeType || mime || "audio/webm").split(";")[0];
      release();
      if (r.discard) return;
      transcribe(new Blob(r.chunks, { type }), type);
    };
    recorder.start(1000);
    r.timer = window.setTimeout(() => done(), MAX_MS); // auto-stop at 5:00
    setNow(Date.now());
    setState({ kind: "recording", since: Date.now() });
  }

  function done() {
    const r = rec.current;
    if (!r) return;
    window.clearTimeout(r.timer);
    try { r.recorder.stop(); } catch { release(); setState({ kind: "idle" }); }
  }

  function cancel() {
    if (rec.current) {
      rec.current.discard = true;
      try { rec.current.recorder.stop(); } catch { /* already stopped */ }
      release();
    }
    abort.current?.abort();
    abort.current = null;
    setState({ kind: "idle" });
  }

  function useRaw() {
    if (state.kind !== "inserted") return;
    const { at, text, raw } = state.ins;
    optsRef.current.setText((prev) => {
      const i = at >= 0 && prev.slice(at, at + text.length) === text ? at : prev.indexOf(text);
      return i < 0 ? prev : prev.slice(0, i) + raw + prev.slice(i + text.length);
    });
    setState({ kind: "idle" });
    optsRef.current.input.current?.focus();
  }

  // Esc cancels recording or transcribing, and only that: the pill carries data-esc-owner, and this
  // runs first (capture) and marks the event handled, so useEscToStop leaves the agents alone.
  const active = state.kind === "recording" || state.kind === "transcribing";
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  const elapsed = state.kind === "recording" ? Math.max(0, now - state.since) : 0;
  return { state, elapsed, start, done, cancel, useRaw, dismiss: () => setState({ kind: "idle" }) };
}

export type Voice = ReturnType<typeof useVoice>;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The mic button, next to the attach button. While recording, pressing it again is Done. */
export function MicButton({ v }: { v: Voice }) {
  const recording = v.state.kind === "recording";
  const busy = v.state.kind === "transcribing";
  return (
    <button type="button" className={`icon-btn attach-btn mic-btn${recording ? " live" : ""}`} aria-pressed={recording}
      aria-label={recording ? "Stop recording and transcribe" : "Dictate"} title={recording ? "Done: stop and transcribe" : "Dictate (speak instead of typing)"}
      disabled={busy} onClick={() => (recording ? v.done() : v.start())}>
      <Icon name="mic" size={15} />
    </button>
  );
}

/** "● Listening 0:12 · Done · Cancel", "Transcribing…", "use raw", or what went wrong. */
export function VoiceStatus({ v, className = "" }: { v: Voice; className?: string }) {
  const s = v.state;
  if (s.kind === "idle") return null;
  if (s.kind === "recording" || s.kind === "transcribing") {
    return (
      <div className={`voice-bar ${className}`} data-esc-owner="" role="status" aria-live="polite">
        {s.kind === "recording"
          ? <span className="voice-live"><span className="voice-dot" aria-hidden="true" />Listening {clock(v.elapsed)}<span className="hint"> / 5:00</span></span>
          : <span className="voice-live"><Spinner />Transcribing…</span>}
        <span className="grow" />
        {s.kind === "recording" && <button type="button" className="btn primary sm" onClick={v.done}>Done</button>}
        <button type="button" className="btn ghost sm" onClick={v.cancel} title="Esc">Cancel</button>
      </div>
    );
  }
  if (s.kind === "error") {
    return (
      <div className={`voice-bar error ${className}`} role="alert">
        <span>{s.message}</span>
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={v.dismiss}><Icon name="x" size={12} /></button>
      </div>
    );
  }
  const ins = s.ins;
  return (
    <div className={`voice-bar note ${className}`} role="status">
      <span className="hint">
        {ins.cleaned ? "Transcribed and tidied up; check it before sending." : "Transcribed as spoken (cleanup unavailable); check it before sending."}
      </span>
      {ins.cleaned && ins.raw !== ins.text && <button type="button" className="link-button" onClick={v.useRaw}>Use raw transcript</button>}
      <span className="grow" />
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={v.dismiss}><Icon name="x" size={12} /></button>
    </div>
  );
}
