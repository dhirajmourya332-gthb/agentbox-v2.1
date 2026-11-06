/**
 * Self-test for the voice assistant's on-phone parts: the wake phrase → keyword-spotter pieces
 * (checked against the sentencepiece library's own output for this model) and the words the
 * phone handles itself. Run: npm run selftest:assistant
 */
import assert from "node:assert/strict";
import { asksAll, assistantName, findTarget, isEnd, isNo, isYes, parseSwitch } from "../src/lib/assistantWords";
import { keywordLine, wakeNameProblem, wakeTokens } from "../src/lib/wakeTokens";

// sentencepiece.encode(..., out_type=str) with the model's bpe.model.
const REFERENCE: [string, string[]][] = [
  ["HELLO WORLD", ["▁HE", "LL", "O", "▁WORLD"]],
  ["MERRY CHRISTMAS", ["▁ME", "R", "RY", "▁", "CH", "R", "IST", "MA", "S"]],
  ["HEY JARVIS", ["▁HE", "Y", "▁JA", "R", "VI", "S"]],
  ["FRIDAY", ["▁F", "RI", "DAY"]],
  ["OK AGENTBOX", ["▁O", "K", "▁A", "G", "ENT", "B", "O", "X"]],
  ["HEY NOVA", ["▁HE", "Y", "▁NO", "V", "A"]],
];
for (const [text, pieces] of REFERENCE) assert.deepEqual(wakeTokens(text), pieces, text);
assert.deepEqual(wakeTokens("  hey,   Nova! "), ["▁HE", "Y", "▁NO", "V", "A"]);
assert.equal(keywordLine("Hey Nova"), "▁HE Y ▁NO V A @HEY_NOVA");
assert.equal(wakeTokens("—"), null);
assert.match(wakeNameProblem("Bob") ?? "", /Too short/);
assert.match(wakeNameProblem("") ?? "", /letters/);
assert.equal(wakeNameProblem("Hey Nova"), null);
assert.match(wakeNameProblem("one two three four five") ?? "", /Too long/);

assert.equal(assistantName("Hey Nova"), "Nova");
assert.equal(assistantName("ok jarvis"), "Jarvis");
assert.equal(assistantName("Friday"), "Friday");

for (const y of ["yes", "Yes please", "yeah go ahead", "okay", "do it", "haan", "Sure."]) assert.ok(isYes(y), y);
for (const n of ["okay and what about the API timeline", "yes no", "no", "what's next", "please tell me more"]) assert.ok(!isYes(n), n);
for (const n of ["no", "No, wait", "cancel that", "nahi"]) assert.ok(isNo(n), n);
assert.ok(!isNo("now tell me about routines"));
for (const e of ["that's all", "thanks", "Stop.", "never mind"]) assert.ok(isEnd(e), e);
assert.ok(!isEnd("stop the deploy task on mumbai please right now"));

const boxes = [{ deviceId: "a", name: "GCP Mumbai" }, { deviceId: "b", name: "gcp2" }];
const at = boxes[0];
assert.deepEqual(parseSwitch("switch to gcp2", boxes, at), { to: boxes[1] });
assert.deepEqual(parseSwitch("Switch over to Mumbai.", boxes, at), { to: boxes[0] });
assert.deepEqual(parseSwitch("use the other agentbox", boxes, at), { to: boxes[1] });
assert.deepEqual(parseSwitch("go to the tokyo server", boxes, at), { unknown: true });
assert.equal(parseSwitch("use coder for the login bug", boxes, at), null);
assert.equal(parseSwitch("what's the update on the migration", boxes, at), null);
assert.equal(findTarget("other", [boxes[0]], at), null);
assert.ok(asksAll("what needs me on all agentboxes"));
assert.ok(asksAll("check both boxes"));
assert.ok(!asksAll("are all tasks done"));

console.log("assistant selftest: ok");
