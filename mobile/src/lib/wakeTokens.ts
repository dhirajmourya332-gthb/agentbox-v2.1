import VOCAB from "./wakeVocab.json";

/**
 * The wake word as the on-device keyword spotter wants it: the name split into the model's word
 * pieces ("Hey Jarvis" → "▁HE Y ▁JA R VI S"). The model (sherpa-onnx's English KWS zipformer,
 * trained on GigaSpeech) uses a 500-piece SentencePiece *unigram* vocabulary; wakeVocab.json is
 * that vocabulary with each piece's log-probability, exported from the model's bpe.model. Encoding
 * is SentencePiece's own: the split with the highest total score (Viterbi). It matched the
 * sentencepiece library on 3000 dictionary words; scripts/assistant-selftest.ts keeps a few of them.
 */

const SPACE = "▁"; // ▁ marks the start of a word
const pieces = new Map<string, number>();
let longest = 1;
for (const [p, s] of VOCAB as [string, number][]) {
  if (p.startsWith("<")) continue; // <blk>, <sos/eos>, <unk>
  pieces.set(p, s);
  longest = Math.max(longest, p.length);
}

/** Letters, digits, apostrophes and spaces, upper case, single-spaced. Null if nothing is left. */
export function normalizeWakeName(name: string): string | null {
  const s = name.toUpperCase().replace(/[^A-Z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

/** The pieces for `name`, or null when some character can't be spelled with this vocabulary. */
export function wakeTokens(name: string): string[] | null {
  const norm = normalizeWakeName(name);
  if (!norm) return null;
  const text = SPACE + norm.replace(/ /g, SPACE);
  const n = text.length;
  const best = new Array<number>(n + 1).fill(-Infinity);
  const from = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === -Infinity) continue;
    for (let len = 1; len <= longest && i + len <= n; len++) {
      const s = pieces.get(text.slice(i, i + len));
      if (s === undefined) continue;
      if (best[i] + s > best[i + len]) { best[i + len] = best[i] + s; from[i + len] = i; }
    }
  }
  if (best[n] === -Infinity) return null;
  const out: string[] = [];
  for (let j = n; j > 0; j = from[j]) out.unshift(text.slice(from[j], j));
  return out;
}

/** A keywords line for the spotter: pieces, then `@` and a label (the label comes back on a match). */
export function keywordLine(name: string): string | null {
  const t = wakeTokens(name);
  const norm = normalizeWakeName(name);
  return t && norm ? `${t.join(" ")} @${norm.replace(/ /g, "_")}` : null;
}

/**
 * Whether a name makes a reliable wake word. Short names (fewer than 4 pieces or 5 letters) match
 * everyday speech too often; very long ones are tiring to say.
 */
export function wakeNameProblem(name: string): string | null {
  const norm = normalizeWakeName(name);
  if (!norm) return "Use letters.";
  const t = wakeTokens(norm);
  if (!t) return "Use plain letters (A–Z).";
  const letters = norm.replace(/[^A-Z]/g, "").length;
  if (letters < 5 || t.length < 4) return "Too short: it would wake up by mistake. Try two words, like \"Hey Nova\".";
  if (norm.split(" ").length > 4 || letters > 24) return "Too long. Two or three words work best.";
  return null;
}
