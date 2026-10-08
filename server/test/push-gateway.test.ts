/**
 * Push registration and the phone's group routes, through a REHEARSAL server's gateway with signed
 * requests. Starts its own Expo mock; start the server with AGENTBOX_PUSH_URL pointing at it.
 *
 *   PORTAL=http://127.0.0.1:7796 GATEWAY=http://127.0.0.1:7797 MOCK_PORT=7798 \
 *     node --import tsx test/push-gateway.test.ts
 *
 * See docs/MOBILE-SETUP.md › Testing.
 */
import { startExpoMock } from "./expo-mock.ts";
import { assert, client, isEmpty404, json, report, sleep, test } from "./gateway-client.ts";

const { portal, paired, raw } = client(process.env.PORTAL ?? "http://127.0.0.1:7796", process.env.GATEWAY ?? "http://127.0.0.1:7797");
const mock = await startExpoMock(Number(process.env.MOCK_PORT ?? 7798));

const TOKEN = "ExponentPushToken[rehearsalAAAAAAAAAAAA]";
const P = "/m/v1/device/push-token";
const listed = async () => {
  const r = await portal("GET", "/api/devices");
  assert(r.status === 200, `GET /api/devices ${r.status}`);
  return { text: r.body.toString("utf8"), data: json(r) as { pending: any[]; active: any[] } };
};
const pushOf = async (id: string) => (await listed()).data.active.find((d) => d.id === id)?.push;

const g = await portal("PUT", "/api/devices/gateway", { url: "https://agentbox.rehearsal.ts.net" });
assert(g.status === 200, `set manual url: ${g.status}`);
const phone = await paired("Push phone");

await test("register: 204, portal shows Notifications on, never the token", async () => {
  const r = await phone.call("POST", P, { token: TOKEN });
  assert(r.status === 204 && r.body.length === 0, `register → ${r.status} ${r.body}`);
  const l = await listed();
  assert(l.data.active.find((d) => d.id === phone.id)?.push === true, "push not on");
  assert(!l.text.includes("rehearsalAAAA") && !l.text.includes("push_token"), "token exposed to the portal");
  const act = await portal("GET", "/api/activity");
  assert(act.status !== 200 || !act.body.toString().includes("rehearsalAAAA"), "token in the activity feed");
});

await test("bad token formats → 400, token unchanged", async () => {
  for (const body of [{ token: "abc" }, { token: "ExponentPushToken[]" }, { token: `ExponentPushToken[${"a".repeat(300)}]` },
    { token: "ExponentPushToken[abc def ghijk]" }, { token: 42 }, {}, Buffer.from("not json")]) {
    const r = await phone.call("POST", P, body);
    assert(r.status === 400, `${JSON.stringify(body).slice(0, 40)} → ${r.status}`);
  }
  const big = await phone.call("POST", P, { token: "x".repeat(2000) });
  isEmpty404(big, "over the body limit");
  assert(await pushOf(phone.id) === true, "token lost");
});

await test("unsigned, wrong method, query string → empty 404", async () => {
  isEmpty404(await raw("POST", P, { "content-type": "application/json" }, Buffer.from(JSON.stringify({ token: TOKEN }))), "unsigned");
  isEmpty404(await phone.call("GET", P), "GET");
  isEmpty404(await phone.call("PUT", P, { token: TOKEN }), "PUT");
  isEmpty404(await phone.call("POST", `${P}?x=1`, { token: TOKEN }), "query");
});

await test("send test notification from the portal → content-free message at the mock", async () => {
  const before = mock.state.sends.length;
  const r = await portal("POST", `/api/devices/${phone.id}/test-push`, {});
  assert(r.status === 200, `test-push ${r.status} ${r.body}`);
  const m = mock.state.sends.slice(before).flatMap((s) => s.messages);
  assert(m.length === 1 && m[0].to === TOKEN && m[0].title === "agentbox" && m[0].body === "Test notification" && m[0].channelId === "attention", "message shape");
  isEmpty404(await phone.call("POST", `/m/v1/devices/${phone.id}/test-push`, {}), "test-push via the gateway");
});

await test("details setting: off by default, toggles, validates, portal-only", async () => {
  const r0 = await portal("GET", "/api/devices/push");
  assert(r0.status === 200 && json(r0).details === false, `default ${r0.body}`);
  assert((await portal("PUT", "/api/devices/push", { details: "yes" })).status === 400, "non-boolean accepted");
  const r1 = await portal("PUT", "/api/devices/push", { details: true });
  assert(r1.status === 200 && json(r1).details === true, "not set");
  assert(json(await portal("PUT", "/api/devices/push", { details: false })).details === false, "not cleared");
  isEmpty404(await phone.call("GET", "/m/v1/devices/push"), "via gateway");
  assert((await portal("PUT", "/api/devices/push")).status === 415, "bodyless admin write accepted");
});

await test("unregister: DELETE → 204, Notifications off; twice is fine", async () => {
  const r = await phone.call("DELETE", P);
  assert(r.status === 204, `delete → ${r.status}`);
  assert(await pushOf(phone.id) === false, "still on");
  assert((await phone.call("DELETE", P)).status === 204, "second delete");
  assert((await portal("POST", `/api/devices/${phone.id}/test-push`, {})).status === 409, "test-push without a token");
});

await test("DeviceNotRegistered on the test push turns notifications off", async () => {
  assert((await phone.call("POST", P, { token: "ExponentPushToken[GoneBBBBBBBBBBBB]" })).status === 204, "register");
  await sleep(5100); // the test button allows one per device every 5 s
  const r = await portal("POST", `/api/devices/${phone.id}/test-push`, {});
  assert(r.status === 502, `test-push → ${r.status}`);
  assert(await pushOf(phone.id) === false, "dead token kept");
});

await test("pending device can't register (empty 404)", async () => {
  const pending = await paired("Pending phone", false);
  isEmpty404(await pending.call("POST", P, { token: "ExponentPushToken[pendingCCCCCCCCC]" }), "pending");
  await pending.call("POST", "/m/v1/device/forget");
});

await test("revoke clears the token; the revoked device can't register again", async () => {
  const p = await paired("Revoked phone");
  assert((await p.call("POST", P, { token: "ExponentPushToken[revokedDDDDDDDDD]" })).status === 204, "register");
  assert((await portal("POST", `/api/devices/${p.id}/revoke`, {})).status === 200, "revoke");
  assert(!(await listed()).data.active.some((d) => d.id === p.id), "still listed");
  isEmpty404(await p.call("POST", P, { token: "ExponentPushToken[revokedDDDDDDDDD]" }), "register after revoke");
  isEmpty404(await p.call("DELETE", P), "delete after revoke");
});

await test("forget clears the token", async () => {
  const p = await paired("Forgotten phone");
  assert((await p.call("POST", P, { token: "ExponentPushToken[forgetEEEEEEEEEE]" })).status === 204, "register");
  assert((await p.call("POST", "/m/v1/device/forget")).status === 204, "forget");
  isEmpty404(await p.call("POST", P, { token: "ExponentPushToken[forgetEEEEEEEEEE]" }), "register after forget");
});

await test("groups via the gateway: list, thread and documents readable; posting allowed", async () => {
  // The rehearsal copy may have no groups: make one in the portal (the copy is paused, nothing runs).
  if (!json(await portal("GET", "/api/groups")).length) {
    const agent = json(await portal("GET", "/api/state")).agents.find((a: any) => !a.base_agent_id);
    assert(agent, "no agent in the rehearsal DB to make a group with");
    const c = await portal("POST", "/api/groups", { name: "push-rehearsal", purpose: "", members: [agent.id], lead: agent.id });
    assert(c.status === 200, `create group in the portal: ${c.status} ${c.body}`);
  }
  const r = await phone.call("GET", "/m/v1/groups");
  assert(r.status === 200, `GET groups → ${r.status}`);
  const groups = json(r);
  assert(Array.isArray(groups) && groups.length, "groups not a non-empty list");
  const gid = groups[0].id;
  const docs = await phone.call("GET", `/m/v1/groups/${gid}/documents`);
  assert(docs.status === 200 && Array.isArray(json(docs)), `documents → ${docs.status}`);
  assert((await phone.call("GET", "/m/v1/groups/no-such-group/documents")).status === 410, "unknown group's documents not 410");
  const th = await phone.call("GET", `/m/v1/threads/${gid}`);
  assert(th.status === 200 && Array.isArray(json(th).messages), `thread → ${th.status}`);
  const post = await phone.call("POST", `/m/v1/threads/${gid}/messages`, { text: "hello from the push rehearsal", images: [] });
  assert(post.status === 200, `post → ${post.status} ${post.body}`);
  return `${groups.length} group(s)`;
});

await test("groups via the gateway: create, edit, delete, continue → empty 404", async () => {
  const gid = json(await phone.call("GET", "/m/v1/groups"))[0]?.id ?? "grp_x";
  const body = { name: "phone-made", purpose: "", members: [], lead: null };
  isEmpty404(await phone.call("POST", "/m/v1/groups", body), "create");
  isEmpty404(await phone.call("PUT", `/m/v1/groups/${gid}`, body), "edit");
  isEmpty404(await phone.call("DELETE", `/m/v1/groups/${gid}`), "delete");
  isEmpty404(await phone.call("POST", `/m/v1/groups/${gid}/continue`), "continue");
  isEmpty404(await phone.call("GET", `/m/v1/groups/${gid}`), "GET one group (no such route)");
  const still = await portal("GET", "/api/groups");
  assert(!JSON.stringify(json(still)).includes("phone-made"), "a group was created");
});

await test("revoke-all clears every token", async () => {
  assert((await phone.call("POST", P, { token: TOKEN })).status === 204, "register");
  assert((await portal("POST", "/api/devices/revoke-all", {})).status === 200, "revoke-all");
  const l = await listed();
  assert(!l.data.active.length && !l.data.pending.length, "devices left");
  isEmpty404(await phone.call("POST", P, { token: TOKEN }), "register after revoke-all");
});

await mock.close();
process.exit(report() ? 1 : 0);
