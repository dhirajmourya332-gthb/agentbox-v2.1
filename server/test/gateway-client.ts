/**
 * A signing phone client and tiny test runner for the gateway tests (same helpers as
 * mobile-gateway.test.ts). Rehearsal servers only: never the live ports.
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

export const LOGIN = "owner@example.com";

export type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
export function request(base: URL, method: string, pathAndQuery: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: base.hostname, port: base.port, method, path: pathAndQuery, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
export const json = (r: Res) => JSON.parse(r.body.toString("utf8"));
export const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export function client(portalUrl: string, gatewayUrl: string) {
  const PORTAL = new URL(portalUrl), GATEWAY = new URL(gatewayUrl);
  if (/:(7700|7710)$/.test(PORTAL.host) || /:(7700|7710)$/.test(GATEWAY.host)) {
    console.error("Refusing to run against the live ports (7700/7710). Use a rehearsal server.");
    process.exit(2);
  }
  const portal = (method: string, p: string, body?: unknown) =>
    request(PORTAL, method, p, body === undefined ? {} : { "content-type": "application/json" },
      body === undefined ? undefined : Buffer.from(JSON.stringify(body)));

  class Phone {
    login: string | null = LOGIN;
    sk = ed25519.utils.randomSecretKey();
    pk = ed25519.getPublicKey(this.sk);
    id = "";
    sign(method: string, p: string, body: Buffer = Buffer.alloc(0)) {
      const time = String(Date.now());
      const nonce = b64u(randomBytes(16));
      const msg = ["AB1", method.toUpperCase(), p, time, nonce, b64u(sha256(body))].join("\n");
      return {
        ...(this.login ? { "tailscale-user-login": this.login } : {}),
        "x-ab-device": this.id, "x-ab-time": time, "x-ab-nonce": nonce,
        "x-ab-sig": b64u(ed25519.sign(Buffer.from(msg, "utf8"), this.sk)),
      } as Record<string, string>;
    }
    call(method: string, p: string, body?: unknown) {
      const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      return request(GATEWAY, method, p, { ...this.sign(method, p, raw), ...(raw ? { "content-type": "application/json" } : {}) }, raw);
    }
    claim(code: string, name = "Push test phone") {
      return request(GATEWAY, "POST", "/m/pair/claim", { "content-type": "application/json", "tailscale-user-login": LOGIN },
        Buffer.from(JSON.stringify({ code, public_key: b64u(this.pk), device_name: name, app_version: "0.0.1-test" })));
    }
  }

  async function paired(name: string, approve = true) {
    const phone = new Phone();
    const p = await portal("POST", "/api/devices/pairings", {});
    assert(p.status === 200, `create pairing: ${p.status} ${p.body}`);
    const c = await phone.claim(json(p).code, name);
    assert(c.status === 202, `claim: ${c.status}`);
    phone.id = json(c).device_id;
    if (approve) {
      const a = await portal("POST", `/api/devices/${phone.id}/approve`, {});
      assert(a.status === 200, `approve: ${a.status} ${a.body}`);
    }
    return phone;
  }
  return { PORTAL, GATEWAY, portal, Phone, paired, raw: (method: string, p: string, h: Record<string, string> = {}, b?: Buffer) => request(GATEWAY, method, p, h, b) };
}

// --- results ---------------------------------------------------------------------------------

export const results: { name: string; ok: boolean; note?: string }[] = [];
export async function test(name: string, fn: () => Promise<void | string>) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || undefined });
  } catch (e: any) {
    results.push({ name, ok: false, note: e?.message ?? String(e) });
  }
}
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
export const isEmpty404 = (r: Res, what = "") => {
  assert(r.status === 404, `${what} expected 404, got ${r.status} ${r.body.toString().slice(0, 120)}`);
  assert(r.body.length === 0, `${what} 404 body not empty`);
  assert(!r.headers["content-type"], `${what} 404 has a content-type`);
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function report() {
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `  (${r.note})` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}
