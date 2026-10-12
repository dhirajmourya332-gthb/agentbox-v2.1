/**
 * push.ts in-process, against a fresh throwaway database and a local Expo mock: content-free
 * bodies, details mode, coalescing, retries, and DeviceNotRegistered from tickets and receipts.
 * It never touches a real server or the network.
 *
 *   PUSH_TEST_DIR=/tmp/push-rt/unit MOCK_PORT=7798 node --import tsx test/push.test.ts
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { startExpoMock } from "./expo-mock.ts";
import { assert, report, sleep, test } from "./gateway-client.ts";

const dir = process.env.PUSH_TEST_DIR ?? "/tmp/push-rt/unit";
if (dir.startsWith("/opt/agentbox")) throw new Error("refusing to use the live data directory");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const mock = await startExpoMock(Number(process.env.MOCK_PORT ?? 7798));

const COALESCE = 2000;
process.env.AGENTBOX_DATA = dir;
process.env.AGENTBOX_PUSH_URL = mock.url;
process.env.AGENTBOX_PUSH_COALESCE_MS = String(COALESCE);
process.env.AGENTBOX_PUSH_RECEIPT_DELAY_MS = "1000";
delete process.env.EXPO_ACCESS_TOKEN;

const { run, get, now } = await import("../src/db.ts");
const devices = await import("../src/devices.ts");
const push = await import("../src/push.ts");
push.startPush({ info: () => {}, warn: () => {}, error: (m) => console.error(m) });

const tok = (tag: string) => `ExponentPushToken[${tag}${randomUUID().replace(/-/g, "").slice(0, 16)}]`;
function addDevice(status: "active" | "pending", token: string | null) {
  const id = randomUUID();
  run(`INSERT INTO devices (id, name, public_key, fingerprint, status, created_at, push_token) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, `dev-${id.slice(0, 4)}`, randomUUID(), "FP", status, now(), token);
  return id;
}
const tokenOf = (id: string) => get<{ push_token: string | null }>(`SELECT push_token FROM devices WHERE id = ?`, id)?.push_token ?? null;
let seq = 0;
const item = (title = "tech-lead#1 replied: Partner API keys"): import("../src/push.ts").Attention => ({
  id: `att-${++seq}`, kind: "question", agent_id: "agent-1", task_id: "task-1", room_id: `room-${seq}`, title, created_at: now(), seen_at: null,
});
const allMessages = () => mock.state.sends.flatMap((s) => s.messages);

const A = addDevice("active", tok("A"));
const B = addDevice("active", tok("B"));
addDevice("pending", tok("P"));   // pending devices never get pushes
addDevice("active", null);        // notifications off

await test("token format: Exponent/Expo tokens accepted, anything else refused; only active devices", async () => {
  for (const bad of ["", "abc", "ExponentPushToken[]", "ExponentPushToken[short]", `ExponentPushToken[${"a".repeat(201)}]`,
    "ExponentPushToken[abc def ghi]", "ExponentPushToken[abcdefgh]x", "FooPushToken[abcdefghij]", "ExponentPushToken[abc\ndefghij]"]) {
    assert(!devices.PUSH_TOKEN.test(bad), `accepted ${JSON.stringify(bad)}`);
  }
  assert(devices.PUSH_TOKEN.test("ExpoPushToken[abcdefgh_-12]"), "ExpoPushToken refused");
  const p = addDevice("pending", null);
  assert(!devices.setPushToken(p, tok("Q")), "pending device got a token");
  const c = addDevice("active", null);
  const t = tok("C");
  assert(devices.setPushToken(c, t) && tokenOf(c) === t, "active device didn't get its token");
  // The same token re-registered by another device moves there.
  const d = addDevice("active", null);
  assert(devices.setPushToken(d, t) && tokenOf(c) === null && tokenOf(d) === t, "token not moved");
  assert(devices.clearPushToken(d) && tokenOf(d) === null, "clear failed");
  devices.revokeDevice(c); devices.revokeDevice(d); devices.revokeDevice(p);
});

await test("first item: one request, content-free body, ids-only data, channel attention, high priority", async () => {
  await push.sendAttentionPush(item());
  assert(mock.state.sends.length === 1, `requests: ${mock.state.sends.length}`);
  const msgs = mock.state.sends[0].messages;
  assert(msgs.length === 2, `messages: ${msgs.length} (want devices A and B only)`);
  assert(new Set(msgs.map((m) => m.to)).size === 2 && msgs.every((m) => m.to === tokenOf(A) || m.to === tokenOf(B)), "wrong recipients");
  for (const m of msgs) {
    assert(m.title === "agentbox" && m.body === "Something needs you", `title/body: ${m.title} / ${m.body}`);
    assert(JSON.stringify(Object.keys(m.data).sort()) === JSON.stringify(["attention_id", "kind", "room_id"]), `data keys ${Object.keys(m.data)}`);
    assert(m.data.kind === "question" && m.data.attention_id === "att-1" && m.data.room_id === "room-1", "data values");
    assert(m.channelId === "attention" && m.priority === "high", "channel/priority");
    assert(!JSON.stringify(m).includes("Partner") && !JSON.stringify(m).includes("tech-lead"), "attention text leaked");
  }
  assert(!mock.state.sends[0].headers.authorization, "an access token was sent to a non-Expo host");
});

await test("coalescing: more items within 30 s → no push now, then one push per device with the count", async () => {
  await push.sendAttentionPush(item());
  const third = item();
  await push.sendAttentionPush(third);
  await push.sendAttentionPush({ ...item(), seen_at: now() }); // already seen: ignored
  assert(mock.state.sends.length === 1, `pushed inside the window (${mock.state.sends.length} requests)`);
  await sleep(COALESCE + 600);
  const later = mock.state.sends.slice(1).flatMap((s) => s.messages);
  assert(later.length === 2, `messages after the window: ${later.length}`);
  for (const m of later) {
    assert(m.body === "2 things need you", `body ${m.body}`);
    assert(m.data.attention_id === "att-3", `latest id ${m.data.attention_id}`);
  }
  const before = mock.state.sends.length;
  await push.sendAttentionPush({ ...third }); // exactly the same item again: pushed once only
  await sleep(COALESCE + 300);
  assert(mock.state.sends.length === before, "a duplicate attention item was pushed again");
  // A refreshed reply keeps its id but has a newer time: that is news, so it pushes again.
  await push.sendAttentionPush({ ...third, created_at: new Date(Date.now() + 1000).toISOString() });
  await sleep(COALESCE + 300);
  assert(mock.state.sends.length > before, "a refreshed reply (same id, newer time) was not pushed");
});

await test("details mode: the cleaned title is the body; a count keeps the latest title", async () => {
  push.setPushDetails(true);
  await sleep(COALESCE + 200);
  const before = allMessages().length;
  await push.sendAttentionPush(item("coder#2 failed:‮ evil\nnext line"));
  const m = allMessages().slice(before);
  assert(m.length === 2, `messages: ${m.length}`);
  assert(m[0].body === "coder#2 failed: evil next line", `body ${JSON.stringify(m[0].body)}`);
  await push.sendAttentionPush(item("one"));
  await push.sendAttentionPush(item("two"));
  await sleep(COALESCE + 600);
  const n = allMessages().slice(before + 2);
  assert(n.length === 2 && n[0].body === "2 things need you. Latest: two", `body ${JSON.stringify(n[0]?.body)}`);
  push.setPushDetails(false);
  assert(!push.pushDetails(), "details still on");
});

await test("retries: two 503s, then delivered", async () => {
  await sleep(COALESCE + 200);
  mock.state.failNext = 2;
  const attempts = mock.state.attempts, sends = mock.state.sends.length;
  await push.sendAttentionPush(item());
  assert(mock.state.attempts === attempts + 3, `attempts ${mock.state.attempts - attempts}`);
  assert(mock.state.sends.length === sends + 1, "not delivered after retries");
});

await test("DeviceNotRegistered in the ticket removes that token only", async () => {
  await sleep(COALESCE + 200);
  const gone = addDevice("active", tok("Gone"));
  await push.sendAttentionPush(item());
  assert(tokenOf(gone) === null, "dead token kept");
  assert(tokenOf(A) && tokenOf(B), "other tokens removed");
});

await test("DeviceNotRegistered in a receipt removes that token", async () => {
  await sleep(COALESCE + 200);
  const later = addDevice("active", tok("Later"));
  await push.sendAttentionPush(item());
  assert(tokenOf(later), "token removed too early");
  await push.checkReceipts(true);
  assert(mock.state.receiptCalls.length > 0, "receipts never fetched");
  assert(tokenOf(later) === null, "dead token kept after its receipt");
  assert(tokenOf(A) && tokenOf(B), "other tokens removed");
});

await test("revoked device: token gone with the row; nothing queued for it is sent", async () => {
  await sleep(COALESCE + 200);
  const r = addDevice("active", tok("R"));
  await push.sendAttentionPush(item()); // r is sent now; A and B too
  await push.sendAttentionPush(item()); // queued for all three
  devices.revokeDevice(r);
  const before = allMessages().length;
  await sleep(COALESCE + 600);
  const after = allMessages().slice(before);
  assert(after.length === 2 && after.every((m) => m.to === tokenOf(A) || m.to === tokenOf(B)), `sent ${after.length}`);
  assert(!get(`SELECT 1 FROM devices WHERE id = ?`, r), "row kept");
  devices.revokeAll();
  assert(!get(`SELECT 1 FROM devices WHERE push_token IS NOT NULL`), "revoke-all left tokens");
});

await test("the test notification: content-free, rate-limited, 409 without a token", async () => {
  const t = addDevice("active", tok("T"));
  const r = await push.sendTestPush(t);
  assert(r.ok, `test push: ${r.error}`);
  const m = allMessages().at(-1);
  assert(m.body === "Test notification" && m.data.kind === "test" && m.data.room_id === null, "test message shape");
  assert((await push.sendTestPush(t)).status === 429, "not rate-limited");
  assert((await push.sendTestPush(addDevice("active", null))).status === 409, "no token → 409");
});

await mock.close();
const failed = report();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
