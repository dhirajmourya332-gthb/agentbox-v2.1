import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api.ts";
import { Icon, Spinner } from "./ui.tsx";

/**
 * Voice input (backlog 12, voice v2): the browser's own speech recogniser (Chrome's Web Speech API)
 * turns speech into text as you talk, the server's GLM model tidies it up (POST /api/voice/clean),
 * and it's inserted at the cursor for review. Nothing is ever sent automatically.
 */

const MAX_MS = 5 * 60 * 1000;
const LANG_KEY = "agentbox.voice.lang";
const HINT_KEY = "agentbox.voice.hint";
export const LANGS = [
  { tag: "en-IN", label: "English (India)" },
  { tag: "en-US", label: "English (US)" },
  { tag: "hi-IN", label: "Hindi / Hinglish" },
] as const;

type Inserted = { at: number; text: string; raw: string; cleaned: boolean; note?: string };
type State =
  | { kind: "idle" }
  | { kind: "listening"; since: number; heard: string }
  | { kind: "cleaning" }
  | { kind: "inserted"; ins: Inserted }
  | { kind: "error"; message: string };

/** The bits of SpeechRecognition used here (not in every TS DOM lib). */
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null;
};
const Recognizer = (): (new () => Recognition) | undefined =>
  typeof window === "undefined" ? undefined : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const savedLang = () => {
  const v = store.get(LANG_KEY);
  return LANGS.some((l) => l.tag === v) ? v! : "en-IN";
};

function recognitionError(code: string) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it for this page in the browser's site settings, then try again.";
    case "audio-capture": return "No microphone found. Plug one in or pick one in your system's sound settings.";
    case "network": return "Couldn't reach Chrome's speech service (it runs on Google's servers). Check the internet connection and try again.";
    case "language-not-supported": return "The browser can't recognise that language. Pick another one.";
    default: return "Speech recognition stopped unexpectedly. Try again.";
  }
}

/** Why the text went in as recognised, when cleanup didn't happen. */
function cleanupNote(e: any) {
  switch (e?.status) {
    case 503: return "Cleanup isn't set up on this agentbox (it needs a Z.ai key in /secrets/zai.env), so this is the text as recognised.";
    case 413: return "Too long to tidy up, so this is the text as recognised.";
    case 429: return "Too many cleanups in a minute, so this is the text as recognised.";
    case undefined: return "Couldn't reach agentbox to tidy it up, so this is the text as recognised.";
    default: return "Cleanup failed, so this is the text as recognised.";
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
  const [lang, setLangState] = useState(savedLang);
  const [firstHint, setFirstHint] = useState(false);
  const sess = useRef<{
    rec: Recognition; since: number; committed: string; final: string; interim: string;
    stopping: boolean; discard: boolean; timer: number; fallback: number; quickEnds: number; lastStart: number;
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const join = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" ");
  const heardSoFar = () => { const s = sess.current; return s ? join(s.committed, s.final, s.interim) : ""; };

  const release = () => {
    const s = sess.current;
    if (!s) return;
    window.clearTimeout(s.timer);
    window.clearTimeout(s.fallback);
    s.rec.onresult = s.rec.onerror = s.rec.onend = null;
    sess.current = null;
    setFirstHint(false);
  };

  // Unmounting (navigating away) drops everything and frees the mic.
  useEffect(() => () => {
    const s = sess.current;
    if (s) { s.discard = true; try { s.rec.abort(); } catch { /* already stopped */ } }
    release();
    abort.current?.abort();
  }, []);

  // The clock on the pill.
  useEffect(() => {
    if (state.kind !== "listening") return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [state.kind]);

  // The note under the box goes once the inserted text is edited away or sent.
  useEffect(() => {
    if (state.kind === "inserted" && !opts.text.includes(state.ins.text)) setState({ kind: "idle" });
  }, [opts.text]);

  function insert(result: { text: string; raw: string; cleaned: boolean }, note?: string) {
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
    setState({ kind: "inserted", ins: { at: s + pre.length, text: result.text, raw: result.raw, cleaned: result.cleaned, note } });
    requestAnimationFrame(() => {
      const t = optsRef.current.input.current;
      if (t) { t.focus(); t.setSelectionRange(caret, caret); }
    });
  }

  async function clean(raw: string, usedLang: string) {
    setState({ kind: "cleaning" });
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const o = optsRef.current;
      const r = await api.cleanVoice({ text: raw, purpose: o.purpose, lang: usedLang, ...(o.agentId ? { agent_id: o.agentId } : {}) }, ctl.signal);
      if (ctl.signal.aborted) return;
      insert(r, r.cleaned ? undefined : "Couldn't tidy it up, so this is the text as recognised.");
    } catch (e: any) {
      if (ctl.signal.aborted || e?.name === "AbortError") return;
      // Never lose what was said: the recognised text goes in as it is.
      insert({ text: raw, raw, cleaned: false }, cleanupNote(e));
    } finally {
      if (abort.current === ctl) abort.current = null;
    }
  }

  /** The session is over (Done, 5:00, or a fatal error): clean up what was heard, or explain. */
  function finish(errorCode?: string) {
    const s = sess.current;
    if (!s) return;
    const raw = join(s.committed, s.final);
    const usedLang = s.rec.lang;
    const discard = s.discard;
    release();
    if (discard) return;
    if (raw) return void clean(raw, usedLang);
    if (errorCode) return setState({ kind: "error", message: recognitionError(errorCode) });
    setState({ kind: "error", message: "Didn't catch any speech. Try again a little closer to the mic." });
  }

  function listen(s: NonNullable<typeof sess.current>) {
    const rec = s.rec;
    rec.onresult = (e: any) => {
      if (sess.current !== s) return;
      let final = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = String(e.results[i][0]?.transcript ?? "");
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      s.final = final;
      s.interim = interim;
      s.quickEnds = 0;
      setState((st) => (st.kind === "listening" ? { ...st, heard: heardSoFar() } : st));
    };
    rec.onerror = (e: any) => {
      if (sess.current !== s) return;
      const code = String(e?.error ?? "");
      if (code === "no-speech" || code === "aborted") return; // onend follows; silence just restarts
      if (join(s.committed, s.final)) {
        // Keep what was heard: tidy it up, then say why it stopped.
        s.stopping = true;
        return;
      }
      s.discard = true;
      release();
      try { rec.abort(); } catch { /* already stopped */ }
      setState({ kind: "error", message: recognitionError(code) });
    };
    rec.onend = () => {
      if (sess.current !== s) return;
      // Chrome ends a session after a stretch of silence (or ~60 s) even when continuous: carry the
      // text over and start again, unless the owner pressed Done or Cancel.
      s.committed = join(s.committed, s.final);
      s.final = s.interim = "";
      if (s.stopping || s.discard || Date.now() - s.since >= MAX_MS) return finish();
      // A recogniser that ends at once, again and again, isn't going to work: stop instead of spinning.
      s.quickEnds = Date.now() - s.lastStart < 1000 ? s.quickEnds + 1 : 0;
      if (s.quickEnds >= 3) return finish("unknown");
      try { s.lastStart = Date.now(); rec.start(); } catch { finish("unknown"); }
    };
  }

  function start() {
    if (sess.current || state.kind === "cleaning") return;
    const R = Recognizer();
    if (!R) return setState({ kind: "error", message: "Voice input needs Chrome or Edge." });
    if (!window.isSecureContext) return setState({ kind: "error", message: "Voice input needs agentbox opened on localhost." });
    let rec: Recognition;
    try {
      rec = new R();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
    } catch {
      return setState({ kind: "error", message: "Voice input needs Chrome or Edge." });
    }
    const t = Date.now();
    const s = { rec, since: t, committed: "", final: "", interim: "", stopping: false, discard: false, timer: 0, fallback: 0, quickEnds: 0, lastStart: t };
    sess.current = s;
    listen(s);
    try { rec.start(); } catch {
      release();
      return setState({ kind: "error", message: "Couldn't start speech recognition. Try again." });
    }
    s.timer = window.setTimeout(() => done(), MAX_MS); // auto-stop at 5:00
    if (!store.get(HINT_KEY)) { setFirstHint(true); store.set(HINT_KEY, "1"); }
    setNow(t);
    setState({ kind: "listening", since: t, heard: "" });
  }

  function done() {
    const s = sess.current;
    if (!s || s.stopping) return;
    s.stopping = true;
    window.clearTimeout(s.timer);
    setState({ kind: "cleaning" });
    // stop() delivers the last results, then onend finishes. If it never comes, finish anyway.
    s.fallback = window.setTimeout(() => { if (sess.current === s) { s.committed = join(s.committed, s.final, s.interim); s.final = s.interim = ""; finish(); } }, 2500);
    try { s.rec.stop(); } catch { finish(); }
  }

  function cancel() {
    const s = sess.current;
    if (s) {
      s.discard = true;
      release();
      try { s.rec.abort(); } catch { /* already stopped */ }
    }
    abort.current?.abort();
    abort.current = null;
    setState({ kind: "idle" });
  }

  /** Pick the recognition language; while listening, the session restarts with it (text so far kept). */
  function setLang(tag: string) {
    if (!LANGS.some((l) => l.tag === tag)) return;
    setLangState(tag);
    store.set(LANG_KEY, tag);
    const s = sess.current;
    if (s && !s.stopping) {
      s.rec.lang = tag;
      try { s.rec.stop(); } catch { /* onend restarts it */ }
    }
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

  // Esc cancels listening or cleaning, and only that: the pill carries data-esc-owner, and this
  // runs first (capture) and marks the event handled, so useEscToStop leaves the agents alone.
  const active = state.kind === "listening" || state.kind === "cleaning";
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

  const elapsed = state.kind === "listening" ? Math.max(0, now - state.since) : 0;
  return {
    state, elapsed, lang, setLang, firstHint, start, done, cancel, useRaw,
    dismiss: () => { setFirstHint(false); setState({ kind: "idle" }); },
  };
}

export type Voice = ReturnType<typeof useVoice>;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** The last part of what was heard, so the pill shows the words being spoken now. */
const tail = (t: string, n = 90) => (t.length > n ? `…${t.slice(-n).replace(/^\S*\s/, "")}` : t);

/** The mic button, next to the attach button. While listening, pressing it again is Done. */
export function MicButton({ v }: { v: Voice }) {
  const listening = v.state.kind === "listening";
  const busy = v.state.kind === "cleaning";
  return (
    <button type="button" className={`icon-btn attach-btn mic-btn${listening ? " live" : ""}`} aria-pressed={listening}
      aria-label={listening ? "Done: stop listening" : "Dictate"} title={listening ? "Done: stop listening and tidy up" : "Dictate (speak instead of typing)"}
      disabled={busy} onClick={() => (listening ? v.done() : v.start())}>
      <Icon name="mic" size={15} />
    </button>
  );
}

/** "● Listening 0:12 · what you're saying · Done · Cancel", "Cleaning up…", "use raw", or what went wrong. */
export function VoiceStatus({ v, className = "" }: { v: Voice; className?: string }) {
  const s = v.state;
  if (s.kind === "idle") return null;
  if (s.kind === "listening" || s.kind === "cleaning") {
    return (
      <div className={`voice-bar ${className}`} data-esc-owner="" role="status" aria-live="polite">
        {s.kind === "listening"
          ? <span className="voice-live"><span className="voice-dot" aria-hidden="true" />Listening {clock(v.elapsed)}<span className="hint"> / 5:00</span></span>
          : <span className="voice-live"><Spinner />Cleaning up…</span>}
        {s.kind === "listening" && <span className="voice-heard" title={s.heard}>{s.heard ? tail(s.heard) : <span className="hint">Speak now</span>}</span>}
        {s.kind === "listening" && (
          <select className="voice-lang" aria-label="Speech language" value={v.lang} onChange={(e) => v.setLang(e.target.value)}>
            {LANGS.map((l) => <option key={l.tag} value={l.tag}>{l.label}</option>)}
          </select>
        )}
        {s.kind === "listening" && <button type="button" className="btn primary sm" onClick={v.done}>Done</button>}
        <button type="button" className="btn ghost sm" onClick={v.cancel} title="Esc">Cancel</button>
        {v.firstHint && s.kind === "listening" && (
          <span className="voice-first hint">Speech is recognized by Chrome (Google); the text is then tidied by your GLM model.</span>
        )}
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
      <span className="hint">{ins.cleaned ? "Recognised and tidied up; check it before sending." : `${ins.note ?? "This is the text as recognised."} Check it before sending.`}</span>
      {ins.cleaned && ins.raw !== ins.text && <button type="button" className="link-button" onClick={v.useRaw}>Use raw</button>}
      <span className="grow" />
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={v.dismiss}><Icon name="x" size={12} /></button>
    </div>
  );
}
