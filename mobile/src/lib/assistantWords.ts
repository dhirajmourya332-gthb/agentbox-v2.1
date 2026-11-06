import { normalizeWakeName } from "./wakeTokens";

/**
 * What the phone itself understands in a conversation (lib/assistant.ts): yes and no to a
 * proposal, "that's all", switching agentboxes, asking all of them. Everything else goes to the
 * agentbox. Pure, so scripts/assistant-selftest.ts can check it.
 */

export type Target = { deviceId: string; name: string };

/** Lower case, letters, digits and apostrophes, single-spaced. */
export const clean = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

const YES_RE = /^(yes|yeah|yep|yup|ya|yah|sure|ok|okay|do it|go ahead|go for it|please do|confirm|confirmed|send it|correct|absolutely|haan|ha|han|ji|ji haan|theek hai)\b/;
const NO_RE = /^(no|nope|nah|don't|do not|dont|cancel|wait|hold on|not now|nahi|nahin|na)\b/;
// Only a short reply counts: "okay, and what about the API?" is a new question, not a yes.
const short = (t: string) => t.split(" ").length <= 5;
export const isYes = (t: string) => short(clean(t)) && YES_RE.test(clean(t)) && !NO_RE.test(clean(t).replace(YES_RE, "").trim());
export const isNo = (t: string) => short(clean(t)) && NO_RE.test(clean(t));
export const isEnd = (t: string) =>
  /^(stop|that's all|thats all|that is all|that's it|thats it|nothing|never mind|nevermind|goodbye|bye|thanks|thank you|go to sleep|done|shut up)\b/.test(clean(t)) && short(clean(t));

const SWITCH = /^(?:please )?(?:switch|change|go|move|jump)(?: over)? to (.+)$|^(?:use|talk to|connect to) (.+)$/;
const BOXWORD = /\b(agent ?box(es)?|box|server|workspace)\b/;
const ALL = /\b(all|both|every|each)\b.*\b(agent ?box(es)?|boxes|servers|workspaces|machines|vms?)\b/;

/** "…on all agentboxes", "check both boxes": ask every agentbox the assistant can reach. */
export const asksAll = (t: string) => ALL.test(clean(t));

/**
 * "Switch to Mumbai", "use the other agentbox". `to` is the agentbox; `unknown` means they
 * clearly asked to switch but named none of them. Null: not a switch at all ("use coder for the
 * login bug" is a question for the agentbox).
 */
export function parseSwitch(said: string, targets: Target[], current: Target | null): { to: Target } | { unknown: true } | null {
  const m = clean(said).match(SWITCH);
  if (!m) return null;
  const want = m[1] ?? m[2] ?? "";
  const to = findTarget(want, targets, current);
  if (to) return { to };
  return BOXWORD.test(want) ? { unknown: true } : null;
}

export function findTarget(name: string, targets: Target[], current: Target | null): Target | null {
  const n = clean(name).replace(/^the /, "").replace(/ (agent ?box|box|server|workspace|one)$/, "").trim();
  if (!n) return null;
  if (/^(other|next|another)$/.test(n)) return targets.length === 2 ? targets.find((t) => t.deviceId !== current?.deviceId) ?? null : null;
  return targets.find((t) => clean(t.name) === n)
    ?? targets.find((t) => clean(t.name).includes(n) || n.includes(clean(t.name)))
    // One word of a longer name ("Mumbai" for "GCP Mumbai").
    ?? targets.find((t) => clean(t.name).split(" ").some((w) => w.length > 2 && n.split(" ").includes(w)))
    ?? null;
}

/** "Hey Nova" → "Nova": what the assistant calls itself. */
export function assistantName(phrase: string) {
  const words = (normalizeWakeName(phrase) ?? "").split(" ").filter(Boolean);
  const rest = words[0] && /^(HEY|HI|OK|OKAY|HELLO|YO)$/.test(words[0]) && words.length > 1 ? words.slice(1) : words;
  const name = rest.join(" ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return name || "Assistant";
}
