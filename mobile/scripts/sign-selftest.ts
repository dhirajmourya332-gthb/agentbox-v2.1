/// <reference types="node" />
/**
 * Self-check for request signing. Run from mobile/:  npx tsx scripts/sign-selftest.ts
 *
 * Signs fixed messages with a fixed TEST key (RFC 8032 test vector 1, never used for real) and
 * verifies them with @noble. Prints the canonical messages and signatures so they can be
 * cross-checked against the server's verifier. Exits non-zero on any failure.
 */
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64url, fromBase64url, strictEncode, utf8 } from "../src/crypto/encoding";
import { canonicalMessage, fingerprint, publicKeyOf, sameFingerprint, signRequest } from "../src/crypto/sign";
import { parsePairingQr } from "../src/lib/qr";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) failed++;
};
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// RFC 8032 §7.1 TEST 1.
const PRIV = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const PUB_EXPECTED = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const pub = publicKeyOf(PRIV);
check("public key matches RFC 8032 vector", toHex(pub) === PUB_EXPECTED);
check("RFC 8032 empty-message signature", toHex(ed25519.sign(new Uint8Array(0), PRIV)) ===
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");

const NONCE = Uint8Array.from({ length: 16 }, (_, i) => i); // 00 01 .. 0f
const TIME = 1700000000000;
const DEVICE = "dev_test_0001";

const vectors = [
  { method: "POST", path: "/m/v1/threads/thr_123/messages", body: '{"text":"hello","images":[]}' },
  { method: "GET", path: `/m/v1/file?path=${strictEncode("/work/uploads/2026-10/it's a test.png")}`, body: "" },
  { method: "GET", path: "/m/v1/events", body: "" },
];

console.log("\nTest key (RFC 8032 TEST 1, public):");
console.log(`  private (hex)       ${toHex(PRIV)}`);
console.log(`  public  (base64url) ${base64url(pub)}`);
console.log(`  fingerprint         ${fingerprint(pub)}`);
console.log(`  device id ${DEVICE}, time ${TIME}, nonce ${base64url(NONCE)}`);

for (const v of vectors) {
  const body = utf8(v.body);
  const { headers, message } = signRequest({ ...v, body, time: TIME, nonce: NONCE, deviceId: DEVICE, privateKey: PRIV });
  console.log(`\n--- ${v.method} ${v.path}${v.body ? `  body=${v.body}` : ""}`);
  console.log("canonical message (\\n-joined):");
  for (const line of message.split("\n")) console.log(`  | ${line}`);
  console.log("headers:");
  for (const [k, val] of Object.entries(headers)) console.log(`  ${k}: ${val}`);
  check("signature verifies with @noble", ed25519.verify(fromBase64url(headers["X-AB-Sig"]), utf8(message), pub));
  // Independent check with Node's own Ed25519 (what a Node server would use).
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
  check("signature verifies with node:crypto", nodeVerify(null, Buffer.from(message, "utf8"), spki, Buffer.from(headers["X-AB-Sig"], "base64url")));
  check("signature is 64 bytes", fromBase64url(headers["X-AB-Sig"]).length === 64);
  const tampered = message.replace(String(TIME), String(TIME + 1));
  check("tampered message is rejected", !ed25519.verify(fromBase64url(headers["X-AB-Sig"]), utf8(tampered), pub));
}

// Encoding and format checks.
check("sha256('') line", canonicalMessage({ method: "get", path: "/x", time: 1, nonce: NONCE }).endsWith("\n47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"));
check("method upper-cased", canonicalMessage({ method: "get", path: "/x", time: 1, nonce: NONCE }).split("\n")[1] === "GET");
for (let n = 0; n < 40; n++) {
  const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
  if (toHex(fromBase64url(base64url(b))) !== toHex(b)) check(`base64url roundtrip ${n}`, false);
}
check("base64url roundtrip 0..39 bytes", true);
check("base64url of 0x00..0x0f", base64url(NONCE) === "AAECAwQFBgcICQoLDA0ODw");
check("fingerprint format", /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(fingerprint(pub)));
check("fingerprint compare ignores dashes/case", sameFingerprint(fingerprint(pub), fingerprint(pub).replace(/-/g, "").toLowerCase()));
check("fingerprint compare rejects other", !sameFingerprint(fingerprint(pub), "AAAA-AAAA-AAAA-AAAA"));
check("strictEncode encodes ' ( ) ! * space /", strictEncode("a'()!* /b") === "a%27%28%29%21%2A%20%2Fb");
check("bad nonce length rejected", (() => { try { canonicalMessage({ method: "GET", path: "/x", time: 1, nonce: new Uint8Array(8) }); return false; } catch { return true; } })());

// QR payload rules.
const code = base64url(new Uint8Array(32).fill(7));
const qr = (o: unknown) => parsePairingQr(JSON.stringify(o));
const good = qr({ v: 1, u: "https://agentbox.tail1234.ts.net", c: code, n: "agentbox" });
check("QR: ts.net accepted as trusted", good.ok && good.trusted && good.payload.gateway === "https://agentbox.tail1234.ts.net");
const other = qr({ v: 1, u: "https://example.com/", c: code });
check("QR: other https host needs confirmation", other.ok && !other.trusted && other.payload.gateway === "https://example.com");
check("QR: http rejected", !qr({ v: 1, u: "http://agentbox.tail1234.ts.net", c: code }).ok);
check("QR: v:2 rejected", !qr({ v: 2, u: "https://agentbox.tail1234.ts.net", c: code }).ok);
check("QR: path rejected", !qr({ v: 1, u: "https://agentbox.tail1234.ts.net/evil", c: code }).ok);
check("QR: userinfo rejected", !qr({ v: 1, u: "https://x@agentbox.tail1234.ts.net", c: code }).ok);
check("QR: lookalike host not trusted", (() => { const r = qr({ v: 1, u: "https://agentbox.ts.net.evil.com", c: code }); return r.ok && !r.trusted; })());
check("QR: short code rejected", !qr({ v: 1, u: "https://a.b.ts.net", c: "abc" }).ok);
check("QR: not JSON rejected", !parsePairingQr("https://a.b.ts.net").ok);
check("QR: 44-char code rejected", !qr({ v: 1, u: "https://a.b.ts.net", c: code + "A" }).ok);
check("QR: 42-char code rejected", !qr({ v: 1, u: "https://a.b.ts.net", c: code.slice(0, 42) }).ok);
check("QR: non-canonical last char rejected", !qr({ v: 1, u: "https://a.b.ts.net", c: code.slice(0, 42) + "B" }).ok);
check("QR: unknown key rejected", !qr({ v: 1, u: "https://a.b.ts.net", c: code, x: 1 }).ok);
check("QR: IPv4 literal rejected", !qr({ v: 1, u: "https://100.64.0.1", c: code }).ok);
check("QR: IPv6 literal rejected", !qr({ v: 1, u: "https://[fd7a::1]", c: code }).ok);
check("QR: query rejected", !qr({ v: 1, u: "https://a.b.ts.net/?x=1", c: code }).ok);
check("QR: v as string rejected", !qr({ v: "1", u: "https://a.b.ts.net", c: code }).ok);
check("QR: random 32-byte codes accepted", Array.from({ length: 200 }, () => qr({ v: 1, u: "https://a.b.ts.net", c: base64url(crypto.getRandomValues(new Uint8Array(32))) }).ok).every(Boolean));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
