# agentbox mobile: security design and protocol (v1)

The contract between the agentbox server (mobile gateway + portal Devices page) and the Android
app (`mobile/`, React Native / Expo). Backlog item 10. **Security is the top priority; when in
doubt, refuse.**

## Goals
1. Nobody on the internet can discover or reach agentbox. No public ports, no public DNS, no
   Tailscale Funnel.
2. A phone connects only after scanning a QR code shown in the portal (which is reachable only
   from the owner's Mac), **and** the owner approves that device in the portal.
3. One pairing = one app install. Every request is signed with a private key that never leaves
   that install. A copied URL, QR code, or captured request is useless.
4. Least privilege: the phone gets a fixed allowlist of actions. Instantly revocable.

## Network path
```
Android app ──(Tailscale: WireGuard, owner's tailnet only)──▶ tailscale serve :443 (in the VM)
   ──▶ 127.0.0.1:7710  mobile gateway (in the agentbox server process)
   ──▶ app.inject() into the normal /api handlers (allowlisted routes only)
```
- The gateway is a **separate Fastify instance** in the same Node process, listening on
  `127.0.0.1:${AGENTBOX_MOBILE_PORT ?? 7710}` inside the VM. Port 7710 is **not** forwarded by
  Lima to the Mac (only 7700–7702 are).
- `tailscale serve --bg --https=443 http://127.0.0.1:7710` exposes it on the tailnet only, at
  `https://<hostname>.<tailnet>.ts.net` with a valid TLS certificate. **Never** `tailscale funnel`.
- The portal (7700), noVNC (7701) and ttyd (7702) are never exposed through Tailscale.
- Tailnet ACLs (owner's job, documented in setup): only the owner's devices may reach the VM node.

## Gateway behaviour
- Every response to an unauthenticated or invalid request is **`404` with an empty body**, with
  the same headers as any other 404. No error messages, no version headers, no `x-powered-by`. The
  gateway must not be distinguishable from "nothing here" without a valid signature.
- Requests that carry an `Origin` header are refused (404). Browsers send one; the app doesn't.
  This blocks browser-based access.
- Only these paths exist without a device signature: `POST /m/pair/claim`. Everything else needs
  a valid signature.
- Rate limits: `POST /m/pair/claim`, at most 10 per minute globally. Signed requests, at most 600
  per minute per device. Over the limit: 404.
- Request bodies: at most 16 MB (image uploads); everything else at most 1 MB.
- Security headers on every response: `cache-control: no-store`, `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`.

## Pairing
1. **Portal** (Devices page, localhost only): owner clicks **Pair a phone**.
   - `POST /api/devices/pairings` creates a pairing with a code of 32 random bytes (base64url),
     expiring in **2 minutes** and single-use. Only `sha256(code)` is stored.
   - The portal shows a QR code with this JSON payload, plus a countdown:
     `{"v":1,"u":"https://<host>.ts.net","c":"<code>","n":"agentbox"}`
   - `u` is the gateway URL. It comes from `tailscale status --json` (`Self.DNSName`) when
     available, otherwise from a URL the owner sets on the Devices page (stored in `meta`).
2. **App** scans it, then generates an **Ed25519** key pair (`@noble/curves/ed25519`, private key
   from a CSPRNG) and sends:
   `POST {u}/m/pair/claim` with JSON `{ "code", "public_key": base64url(32 bytes), "device_name", "app_version" }`.
3. **Server**, as one atomic step:
   - finds the unexpired, unused pairing by `sha256(code)` (constant-time compare);
   - marks it used, whatever happens next;
   - creates a device with status **`pending`**, storing the public key, its fingerprint, the
     name, the app version, and the `Tailscale-User-Login` header if present;
   - replies `202 {"device_id","fingerprint","status":"pending"}`.
   - An invalid, expired or used code gets 404.
4. **Fingerprint:** the first 10 bytes of `sha256(public_key)`, shown as base32 in groups of 4,
   e.g. `K3QF-7ZMA-2XWB-...`. The app shows it, and the portal shows the pending device with the
   same fingerprint. The owner compares them, then clicks **Approve** (status becomes `active`)
   or **Deny** (device deleted).
5. A pending device that isn't approved within **5 minutes** is deleted.
6. The app polls signed `GET /m/v1/whoami`:
   - pending: `200 {"status":"pending"}`;
   - active: `200 {"status":"active","device_id","name"}`;
   - anything else: 404, and the app returns to the pairing screen.

## Request signing (every request except /m/pair/claim)
Headers:
```
X-AB-Device: <device_id>
X-AB-Time:   <unix milliseconds>
X-AB-Nonce:  <16 random bytes, base64url>
X-AB-Sig:    <base64url(ed25519.sign(message, privateKey))>
```
Message, UTF-8, joined with `\n`:
```
AB1
<METHOD uppercase>
<path including query string, exactly as sent, e.g. /m/v1/work?x=1>
<X-AB-Time>
<X-AB-Nonce>
<base64url(sha256(raw body bytes))>   (sha256 of empty bytes when there's no body)
```
**Server checks** (any failure → 404):
- the device exists and is active (pending is accepted only for `/m/v1/whoami`);
- `|now − time| ≤ 60 s`;
- the nonce hasn't been seen for this device in the last 120 s (kept in memory);
- the signature verifies against the stored public key;
- if a `Tailscale-User-Login` was recorded at pairing, the request's header must match it.

On success it updates `last_seen_at`.

**WebSocket** `GET /m/v1/events`: signed exactly like a GET with an empty body. React Native's
`WebSocket` accepts headers (`new WebSocket(url, [], { headers })`). The server pushes the same
JSON events the portal's websocket gets. On revocation, the server closes that device's sockets
immediately.

**Files and images** `GET /m/v1/file?path=...`: signed per request. RN `<Image source={{ uri, headers }}>`
supports headers.

## Allowed actions (gateway `/m/v1/<rest>` → internal `/api/<rest>`)
Read:
- `GET`: `state`, `work`, `work/:id`, `work/:id/documents`, `threads/:id`, `tasks`, `routines`,
  `routines/:id`, `documents`, `file`, `control`.

Write:
- `POST work` (new task), `POST threads/:id/messages`, `POST tasks/:id/stop`;
- `POST pause`, `POST resume`;
- `POST routines/:id/run`, `POST agents/:id/done`;
- `POST uploads` (images).

**Everything else is 404**, including agent create/edit/delete, instructions, skills, routine
create/edit/rules, groups admin, terminal, screen/display control, devices admin, and settings.
`/api/devices/*` is never reachable through the gateway.

**Audit:** every successful mutating request through the gateway is recorded with the device id
and name, and shown in Activity as "via phone (<device name>)".

## Portal Devices page (localhost only)
- **Pair a phone:** QR code, 2-minute countdown, regenerate.
- **Pending devices:** name, fingerprint, tailnet login, with **Approve** and **Deny**.
- **Paired devices:** name, fingerprint, app version, tailnet login, paired at, last seen, with
  **Revoke** (immediate: closes its sockets) and **Revoke all**.
- **Gateway status:** whether Tailscale is up, the URL, and a reminder that Funnel must stay off.

## App requirements (`mobile/`)
- Expo (current SDK), TypeScript, Android only.
- No `expo-updates` or OTA, no analytics, no crash reporting that ships data out, no secrets in
  the bundle.
- `android.allowBackup: false`, so keys aren't backed up. HTTPS only (no cleartext). Permissions:
  camera (QR) and media (attaching images) only.
- **Key storage:**
  - The private key goes in `expo-secure-store` (Android Keystore-encrypted), with
    `requireAuthentication: true` where the device supports it.
  - Unlocking the app requires biometrics or the device PIN (`expo-local-authentication`).
  - The key is held in memory only while unlocked. The app locks after 2 minutes in the
    background, wiping the key from memory.
- `expo-screen-capture`: screenshots blocked app-wide.
- "Forget this device" wipes the key and pairing data.
- **Screens:** Pair (scan, show fingerprint, wait for approval), Unlock, Work, Task/Room,
  New task, Routines, Pause/Resume control, Settings.

## Out of scope for v1
- Push notifications: the app updates live while open.
- iOS.
