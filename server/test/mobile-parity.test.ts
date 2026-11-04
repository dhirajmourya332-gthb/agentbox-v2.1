/**
 * Web parity on the phone (v2.1): the new allowlist entries (screen, System, Activity, documents,
 * agent conversations, notes, hosted services, status-only integrations / repos / skills), what
 * stays off, and the screen input checks (server/src/screenCapture.ts).
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/mobile-parity.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-parity-"));
Object.assign(process.env, {
  AGENTBOX_DATA: path.join(tmp, "data"), AGENTBOX_AGENTS: path.join(tmp, "agents"), AGENTBOX_WORK: path.join(tmp, "work"),
  AGENTBOX_SKILLS: path.join(tmp, "skills"),
});

const { allowedRoute } = await import("../src/mobile.ts");
const S = await import("../src/screenCapture.ts");
const { takeDisplay, releaseDisplay } = await import("../src/control.ts");

test("allowlist: the new reads", () => {
  for (const r of ["screen/snapshot", "health", "activity", "agents/a1/threads", "agents/a1/documents", "work/w1/notes",
    "hosting", "integrations/summary", "repos", "skills"]) {
    assert.ok(allowedRoute("GET", r), r);
  }
});

test("allowlist: the new writes", () => {
  for (const r of ["display/take", "display/release", "screen/input", "work/w1/notes", "hosting/h1/stop"]) assert.ok(allowedRoute("POST", r), r);
  assert.ok(allowedRoute("PATCH", "notes/n1"));
  assert.ok(allowedRoute("DELETE", "notes/n1"));
});

test("allowlist: still off", () => {
  const off: [string, string][] = [
    ["GET", "integrations"], ["GET", "integrations/github"], ["POST", "integrations/github/task"],
    ["GET", "setup/terminal"], ["GET", "screen/credential"], ["GET", "agents/a1"], ["PATCH", "agents/a1"],
    ["PUT", "agents/a1/instructions"], ["POST", "skills"], ["PUT", "skills/x"], ["DELETE", "skills/x"],
    ["POST", "repos"], ["POST", "repos/x/purge"], ["DELETE", "agents/a1"], ["DELETE", "routines/r1"],
    ["PATCH", "repos/x"], ["DELETE", "notes/n1/x"], ["PATCH", "notes/../x"], ["GET", "devices"], ["DELETE", "devices/pairings"],
    ["POST", "screen/snapshot"], ["GET", "screen/input"], ["GET", "approvals"], ["POST", "approvals/a/approve"],
  ];
  for (const [m, r] of off) assert.ok(!allowedRoute(m, r), `${m} ${r}`);
});

test("screen input: positions are fractions, keys come from a fixed list, text is printable", () => {
  assert.deepEqual(S.parseInput({ kind: "tap", x: 0.5, y: 1 }), { kind: "tap", x: 0.5, y: 1, button: "left", double: false });
  assert.throws(() => S.parseInput({ kind: "tap", x: 1.2, y: 0 }), /between 0 and 1/);
  assert.throws(() => S.parseInput({ kind: "tap", x: "0.1", y: 0 }), /between 0 and 1/);
  assert.equal((S.parseInput({ kind: "scroll", x: 0, y: 0, dir: "down", amount: 99 }) as any).amount, 15);
  assert.throws(() => S.parseInput({ kind: "scroll", x: 0, y: 0, dir: "left" }), /dir/);
  assert.deepEqual(S.parseInput({ kind: "key", key: "Return" }), { kind: "key", key: "Return" });
  for (const key of ["ctrl+alt+Delete", "super", "alt+F4", "Return; rm -rf /", "ctrl+shift+t"]) {
    assert.throws(() => S.parseInput({ kind: "key", key }), /isn't allowed/, key);
  }
  assert.deepEqual(S.parseInput({ kind: "text", text: "hi\u0007\nthere‮" }), { kind: "text", text: "hithere" });
  assert.throws(() => S.parseInput({ kind: "text", text: "\n\t" }), /Nothing to type/);
  assert.throws(() => S.parseInput({ kind: "text", text: "x".repeat(1001) }), /1000/);
  assert.throws(() => S.parseInput({ kind: "click" }), /Unknown/);
});

test("screen input: refused unless the owner holds the screen", async () => {
  releaseDisplay();
  await assert.rejects(S.sendInput({ kind: "key", key: "Return" }), (e: any) => e.statusCode === 409);
  takeDisplay();
  // Holding it, the call goes on to xdotool (absent here, or no display): any failure but the 409.
  await assert.rejects(S.sendInput({ kind: "key", key: "Return" }).then(() => { throw new Error("ran"); }), (e: any) => e.statusCode !== 409);
  releaseDisplay();
});
