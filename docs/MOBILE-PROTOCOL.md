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

## Implementation notes (server, v1)
Appended after implementation. The contract above is unchanged except for the approved additions
below: `POST /m/v1/device/forget`, the API's own 404 arriving as 410, `Tailscale-User-Login`
required at claim, per-user claim limits, and a filtered event stream. Revised after the
security review.

**Where things live**
- `server/src/mobile.ts`: the gateway (a second Fastify instance on `127.0.0.1:7710`), the
  allowlist, the main-app guard and the portal admin routes (`/api/devices*`).
- `server/src/signing.ts`: the canonical message builder and the Ed25519 verifier
  (`@noble/curves`, `zip215: false`, i.e. strict RFC 8032). Pure, so tests check vectors against
  exactly this code.
- `server/src/devices.ts`: pairing codes, the device registry, the audit log and Tailscale status.
- Tables (additive, `server/src/db.ts`): `devices`, `device_pairings` (only `sha256(code)` stored),
  `device_audit`.

**Gateway details**
- Bodies are read as **raw bytes** (one buffer content parser, nothing JSON-parsed in the gateway);
  the signed path is the **raw, undecoded** `req.url`. The same raw buffer is forwarded to
  `app.inject()`, with `content-type: application/json` when non-empty. No client header is
  forwarded (no cookies, no `Tailscale-*`, no `X-AB-*`). Injected requests carry an internal marker
  whose value is a **per-process random token**, so nothing outside the process can forge it.
- **Origin:** an empty `Origin` (React Native's Android WebSocket sends one unless told otherwise,
  so the app sends `Origin: ""`) counts as absent. Any non-empty Origin gets 404 (HTTP and WS).
- Checks run in two stages. **Before the body is read:** Origin, path allowlist, header formats,
  the ±60 s window, **`X-AB-Time` not earlier than the gateway's start** (a restart empties the
  nonce cache, so without this a request captured just before a restart could be replayed within its
  window), device exists/active (pending only for `whoami` and `device/forget`), and the
  `Tailscale-User-Login` binding. **After:** signature, then the nonce (recorded only once the
  signature verifies, so nobody can burn a device's nonces), then the 600/min per-device limit.
- The nonce cache is in memory: per device, 120 s. Restarts are covered by the start-time floor
  above.
- Allowlisted paths are matched on the raw path with `^...$` regexes; `:id` segments are
  `[A-Za-z0-9_-]{1,128}`, so `%2e%2e`, `//` and `..` never match. The main app re-checks every
  gateway-injected request (marked with an internal header that clients can't pass through)
  against the same allowlist, and `/api/devices*` refuses them outright.
- Authenticated requests get the API's own status and body (e.g. `400 {"error": ...}`); only the
  headers `content-type`, `content-disposition` and `content-security-policy` are passed through.
  **3xx from the API becomes an empty 404:** the gateway never redirects. **The API's own 404 (no
  such task, file not found, …) becomes 410** with the API's body, so a 404 from the gateway
  always means "not authenticated or not allowed". The app treats 410 as "not found".
- `GET` responses are streamed (`payloadAsStream`), so `/m/v1/file` handles large and binary files.
- Body limits: 16 MB for `uploads`, 21 MB for `voice/transcribe`, 8 KB for `/m/pair/claim`, 1 MB otherwise (including `voice/clean`). Over the limit:
  empty 404 and the connection is closed.
- Malformed HTTP also gets a bare 404 (`clientErrorHandler`); there are no `server` or
  `x-powered-by` headers. `HEAD` routes aren't exposed.
- WebSocket: at most 4 sockets per device (the oldest is closed). The socket ignores what the app
  sends (max 4 KB per frame). On revoke, forget, deny or revoke-all, the device's sockets are
  closed with code 1008. **Events are allowlisted** to what the phone's reads already expose:
  `agent.created|updated|deleted|retired|status`, `task.updated`, `message.created`, `turn.delta`,
  `step.updated`, `thread.created`, `usage`, `group.updated|deleted`, `routine.updated|deleted`,
  `display.updated` and `paused`. Steps are included because `GET work/:id` and
  `GET threads/:id` already return steps with their input and output; the phone sees nothing new.
  Excluded: `skill.*`, `draft.updated`, `agent.skills` and `devices.changed`.
- `last_seen_at` is written at most every 30 s per device.

**Approved addition: `POST /m/v1/device/forget`**
Signed like any other request, with an empty body. It revokes the **calling device itself**, which
has the same effect as Revoke in the portal: the row is deleted and its sockets are closed. It
returns `204` with no body, after which every request from that device gets 404. A pending device
may also call it, to withdraw its pairing. It does **not** map to any `/api` route, and it is
recorded in the audit as "unpaired the phone".

**Pairing details**
- A new code invalidates any earlier unused code (only one live QR at a time); leaving the
  Devices page cancels it.
- The claim compares `sha256(code)` against every live pairing with `timingSafeEqual` (no early
  exit), inside one `BEGIN IMMEDIATE` transaction. The code is burned even if the rest of the claim
  is invalid (bad key, not an Ed25519 point, duplicate key).
- **`Tailscale-User-Login` is required at claim** (phones are user devices, so `tailscale serve`
  always adds it; tagged nodes can't pair). It's stored, and every later request must carry the
  same value.
- Claim rate limit: 10 per minute **per tailnet user** (keyed by `Tailscale-User-Login`), and 30
  per minute across all users, so one tailnet member can't block another's pairing.
- `device_name` is cleaned: bidi overrides and zero-width characters (`\p{Cf}`) are removed, and
  control characters become spaces. At most 64 chars; the default is "Phone". `app_version` is at
  most 32 chars.
- Revoked and denied devices are **deleted**, not kept with a status. The audit keeps the name.
- Expired pending devices are deleted on access, every 15 s, and when the device list is read.

**The main app (port 7700) is localhost-only**
Every `/api/*` route and the `/api/events` WebSocket refuse a request unless:
- its `Host` is a loopback name (`localhost`, `127.0.0.1`, `[::1]`, any port), which blocks DNS
  rebinding (403);
- its `Origin`, if present, is a loopback origin, which blocks other sites and cross-site
  WebSocket hijacking (403);
- a write (POST/PUT/PATCH/DELETE) **with a body** is `application/json` (415). Bodyless writes
  (`curl -X POST localhost:7700/api/pause`, the portal's buttons) still work.

Gateway-injected requests (with the valid token) skip these checks and are checked against the
phone allowlist instead; a wrong token gets 404. The static UI isn't guarded.

**Portal admin (`/api/devices*`, main app only)**
- `POST /api/devices/pairings` → `{id, code, expires_at, url, qr_payload}` (`409` while no
  gateway URL is known). `DELETE /api/devices/pairings` cancels the live code.
- `GET /api/devices` → `{pending: [...], active: [...]}` (public keys aren't returned).
- `POST /api/devices/:id/approve | deny | revoke`, `POST /api/devices/revoke-all`.
- `GET /api/devices/gateway[?fresh=1]` → Tailscale status (`tailscale status --json`, plus
  `tailscale serve status --json` and `tailscale funnel status` for the serve target and Funnel),
  `funnel_capable` (the policy grants this node Funnel: a `funnel` key in `Self.CapMap` or
  `Self.Capabilities`), `guard` (the tailnet firewall table and its drop rules are loaded; read with
  `sudo -n nft`, `null` if that isn't possible), and the URL in effect;
  `PUT /api/devices/gateway {url}` sets or clears the manual `https://` URL (`meta.mobile_url`).
- On top of the main-app guard, these routes refuse any gateway-injected request (404) and require
  JSON on every write, even a bodyless one, so a write always needs a CORS preflight.

**Audit:** each successful (2xx) mutating gateway request adds a `device_audit` row, and so does a
`GET file` (at most once per device and file every 10 minutes, so image lists don't flood the
feed). The Activity
feed shows it as kind `phone`, e.g. "You started a task · via phone (Pixel 8)", linking to the
task where it can.

**Voice (CONTRACTS-v2 C):** `POST voice/transcribe` is allowlisted with its own **21 MB** body
limit (base64 of at most 15 MB of audio). It forwards to `POST /api/voice/transcribe`
(`server/src/voice.ts`) and returns `{text, raw, duration_s, cleaned}`; it never sends anything. A
2xx is audited "dictated by voice · via phone (…)" with no `ref_id`; the audio and text are never
stored or logged. Errors: 400, 413, 429 (20 a minute, 2 at once), 502 (provider), 503 (no
`/secrets/zai.env`). Tests: `server/test/voice.test.ts`.

**Voice v2 (CONTRACTS-v2 C):** `POST voice/clean` is allowlisted with the default 1 MB body limit.
It forwards to `POST /api/voice/clean` with `{text, purpose, agent_id?, lang?}` (text 1–4000
characters, recognised on the phone) and returns `{text, raw, cleaned}`. A 2xx is audited the same
way, "dictated by voice · via phone (…)" with no `ref_id`; the text is never stored or logged.
Errors: 400, 413 (over 4000 characters), 429 (30 a minute), 503. Cleanup failures are a 200 with
the raw text and `cleaned: false`. Tests: `server/test/voice-clean.test.ts`.

**Testing:** `server/test/mobile-gateway.test.ts` runs against a rehearsal server; the recipe is in
`docs/MOBILE-SETUP.md` › Testing. It includes the cross-check vector (RFC 8032 TEST 1 key,
`POST /m/v1/threads/thr_123/messages`, body `{"text":"hello","images":[]}`).

**Network hardening (VM)**
- Everything listens on loopback only: the portal on 7700, the gateway on 7710, noVNC on 7701
  (`websockify 127.0.0.1:7701`), ttyd on 7702 (`-i lo`), x11vnc on 5900 (`-localhost`) and Chromium
  CDP on 9222. Lima forwards loopback-bound guest ports: its default `guestIP: 127.0.0.1` "also
  matches bind addresses 0.0.0.0, :: and ::1". `scripts/install-units.sh` refuses to finish unless
  `ss` shows 7700, 7701, 7702 and 7710 on loopback only.
- **Tailnet firewall** (`vm/bin/agentbox-tailnet-guard`, an nftables table `inet agentbox_tailnet`):
  drops **all** input from `tailscale0`, and output to it except replies. sshd (needed by Lima, so
  on 0.0.0.0) and any dev server an agent starts are unreachable from the tailnet, and the VM
  can't dial other tailnet devices. A 60 s timer (`agentbox-tailnet-guard-watch.timer`) reloads the
  table if it or its drop rules go missing, and a tailscaled drop-in
  (`Requires=`/`After=agentbox-tailnet-guard.service`) means Tailscale doesn't run without it.
- **No `tcp dport 443 accept` rule.** `tailscale serve` terminates inside tailscaled. In kernel-TUN
  mode, tailscaled's netstack intercepts TCP to the node's own Tailscale IPs on serve ports
  (`wgengine/netstack`: `shouldProcessInbound` → `ShouldInterceptTCPPort`) before the packet is
  written to `tailscale0`, so the kernel's input hook never sees it. Serve then proxies to
  127.0.0.1:7710 over loopback. Dropping the rule also keeps anything in the VM that binds :443 off
  the tailnet. If a future Tailscale version delivered serve traffic through the kernel, phones would
  fail to connect: it fails closed and exposes nothing. Confirm on the first real pairing.
- The setup requires a tag (`--advertise-tags`), uses a random hostname (`node-xxxxxx`; ts.net
  certificate names appear in public Certificate Transparency logs), and refuses, taking the node
  off the tailnet, if Funnel is on or the policy grants the node the funnel capability.
- Agents have root in the VM, so the tailnet ACL (enforced outside the VM) is the real boundary;
  see `docs/MOBILE-SETUP.md`.

**Push notifications (v2, docs/CONTRACTS-v2.md › D)**
Supersedes "Out of scope for v1: push notifications".
- `POST /m/v1/device/push-token` with `{"token":"ExponentPushToken[…]"}` (or `ExpoPushToken[…]`;
  the part in brackets is 8–200 of `[A-Za-z0-9_-]`). It is signed like any other request. It is
  gateway-only (no `/api` route), takes **active devices only** (pending gets 404), and accepts a
  body of at most 1 KB. Replies:
  - `204` when stored;
  - `400 {"error":"Invalid push token"}` for a bad format or bad JSON.

  A token belongs to one device: registering it again from another device moves it.
- `DELETE /m/v1/device/push-token`, with an empty body, replies `204`, even when no token was
  stored. It has no query string; other methods get 404.
- The token is a column on the device row (`devices.push_token`, `push_token_at`; an additive
  migration). Revoke, deny, forget and revoke-all delete the row, and the token with it. The portal
  only ever sees `push: true|false` per device, never the token. Turning notifications on or off is
  audited ("turned on notifications · via phone (…)").
- **Sender** (`server/src/push.ts`):
  - For each new Attention item (`onAttention`), it pushes to every **active** device with a token,
    through Expo (`https://exp.host/--/api/v2/push/send`, a JSON array, at most 100 per request).
  - Each message: `title: "agentbox"`; `body: "Something needs you"` or `"N things need you"`;
    `data: { kind, room_id, attention_id }` (ids only); `priority: "high"`; `channelId: "attention"`;
    `ttl` 1 day.
  - **Coalescing:** at most one push per device every 30 s. Items arriving in between are counted,
    and one push goes when the window ends, carrying the newest item's ids.
  - An attention id is pushed once. Items already seen are skipped.
  - **Details mode** (portal toggle, `meta.push_details = "1"`, off by default): the body becomes the
    attention title, cleaned to one printable line of at most 160 chars, or
    `"N things need you. Latest: <title>"`. That text passes through Expo and Google (FCM).
  - **Tickets:** a `DeviceNotRegistered` ticket clears that token at once.
  - **Receipts:** for `ok` tickets, receipts are fetched about 15 minutes later
    (`/--/api/v2/push/getReceipts`, up to 1000 ids per request), and `DeviceNotRegistered` clears the
    token. Receipt ids are kept in memory, so a restart forgets pending ones; the next failed send
    catches a dead token anyway.
  - **Timeouts and retries:** 10 s per request. Network errors, timeouts, 429 and 5xx are retried
    3 times with backoff (1 s, 2 s, 4 s, plus jitter). Other 4xx are not retried. Redirects are
    refused.
  - **Logging:** tokens and notification text are never logged. Only HTTP status codes and Expo
    error codes are (e.g. `push: ticket error DeviceNotRegistered`).
  - **`EXPO_ACCESS_TOKEN`** (optional, server environment): it is sent as
    `Authorization: Bearer …`, and only to `exp.host`. It is needed only if "Enhanced security for
    push notifications" is turned on for the Expo project (expo.dev › project › Settings ›
    Access tokens). Without that setting, anyone holding a device's push token could send it a
    notification, but the token itself never leaves the server and the phone.
  - **`AGENTBOX_PUSH_URL`** (tests only): overrides the send URL. It must be `https://…/push/send`
    or `http://` on loopback, otherwise nothing is sent. The receipts URL is derived from it.
    `AGENTBOX_PUSH_COALESCE_MS` and `AGENTBOX_PUSH_RECEIPT_DELAY_MS` can only shorten the
    windows.
- **Portal admin** (adminGuard: never via the gateway; JSON required on writes):
  - `GET /api/devices` adds `push: boolean` per device;
  - `GET /api/devices/push` returns `{details}`;
  - `PUT /api/devices/push` takes `{details: boolean}`;
  - `POST /api/devices/:id/test-push` sends "Test notification" and replies:
    - `200` when sent;
    - `409` when the device has no token;
    - `429` for more than one per 5 s;
    - `502` when the push service refused it. `DeviceNotRegistered` here also turns that device's
      notifications off.
- **Wiring:** `index.ts` calls `startPush(log)` (the receipt checker). The attention hook is
  connected with `wirePush(onAttention)`.

**Group routes for phones (v2, docs/CONTRACTS-v2.md › E)**
Added to the allowlist (read only):
- `GET /m/v1/groups` → `GET /api/groups` (the list; `GET state` already includes it);
- `GET /m/v1/groups/:id/documents` → `GET /api/groups/:id/documents` (410 for an unknown group).

Already allowed and used for groups:
- `GET /m/v1/threads/:id` (a group's id is its thread id: messages, tasks, steps);
- `POST /m/v1/threads/:id/messages` (posts to the group as the owner).

Still 404 through the gateway:
- `POST groups` (create), `PUT groups/:id` (edit), `DELETE groups/:id`;
- `POST groups/:id/continue` (resume after the turn limit). It isn't in the contract; add it
  explicitly if the app needs it.

## Implementation notes (app notes, v2: overview, groups, voice, push)
Built to `docs/CONTRACTS-v2.md` A–F. What the app calls, all signed, under `/m/v1/`:
- **Overview (home):** `GET progress` (A), `GET attention` (B), `POST attention/:id/seen`,
  `POST attention/seen-all`, `GET tasks?limit=60` (Recently finished: depth-0 tasks that are done,
  failed or stopped). Usage, pause state and groups come from `GET state`. If `progress` or
  `attention` isn't there yet, the app falls back to working instances from `GET work` and shows
  "Not available" for Needs you.
- **Live events used:** `progress.updated`, `progress.cleared`, `attention.updated`, `usage`,
  `group.updated`, `group.deleted`, besides the existing ones. The gateway's event allowlist must
  include the first three.
- **Groups:** the list comes from `GET state` (`groups`, already allowlisted). A group's
  conversation is `GET threads/:groupId` and posting is `POST threads/:groupId/messages` (both
  already allowlisted). Documents: `GET groups/:id/documents` (contract E). Room documents:
  `GET work/:id/documents`. The viewer reads text and images through `GET file`.
- **Voice v2:** speech is recognised on the phone by Android's `SpeechRecognizer`, then the text
  goes to `POST voice/clean` with `{text, purpose: "task"|"message", agent_id?, lang?}` (text
  1–4000 characters; default 1 MB body limit) → `{text, raw, cleaned}`. Insert `text` at the
  cursor with a "use raw" action that swaps in `raw`; never auto-send. 503 means cleanup isn't
  configured: insert the recognised text as it is. Audited "dictated by voice · via phone".
- **Voice v1 (no longer used by the app):** `POST voice/transcribe` with `{audio, mime: "audio/mp4", purpose, agent_id?}`. AAC in
  .m4a, mono, 44.1 kHz, 64 kbit/s: about 2.4 MB (3.2 MB base64) for the 5-minute cap, so the
  route's gateway body limit must exceed the 1 MB default. Timeout 180 s.
- **Voice v2 (app 1.2.0):** the app no longer records audio or calls `voice/transcribe`. Android's
  speech recognition runs on the phone (on-device model when installed, else Google online), and the
  app sends only the text: `POST voice/clean` `{text (1–4000), purpose, agent_id?, lang?}` →
  `{text, raw, cleaned}`, timeout 60 s. 503 (cleanup not configured), 404/410 (older agentbox) and
  other failures insert the raw text with a note; longer than 4000 characters skips cleanup.
- **Push:** `POST device/push-token {token}` on each unlock when the token changed (the last sent
  token is kept in secure storage), `DELETE device/push-token` on Forget (before
  `device/forget`) and when notification permission has been turned off. Notification taps are
  handled only after unlock; `data.room_id` and `data.attention_id` must be safe ids, everything
  else is ignored. A `room_id` that matches a group opens the group, anything else a task room.
- **Permissions (app manifest):** INTERNET, CAMERA, RECORD_AUDIO, POST_NOTIFICATIONS,
  USE_BIOMETRIC, USE_FINGERPRINT. Blocked with `tools:node="remove"`, among others:
  FOREGROUND_SERVICE (and its MICROPHONE / MEDIA_PLAYBACK types), RECEIVE_BOOT_COMPLETED,
  MODIFY_AUDIO_SETTINGS, storage and media. Firebase Messaging's library manifest adds its own
  delivery permissions (WAKE_LOCK, ACCESS_NETWORK_STATE, c2dm RECEIVE) at build time.
**Live progress and "needs you" (CONTRACTS-v2 § A, B; workstream "live")**
- Allowlisted, signed, same JSON as the portal:
  - `GET /m/v1/progress` → `Progress[]`, one per running task, oldest first.
  - `GET /m/v1/attention` → `{ items: Attention[] }`, unseen first (newest first), at most 100.
  - `POST /m/v1/attention/:id/seen` → the updated item (unknown id: 410, like any API 404).
  - `POST /m/v1/attention/seen-all` → `{ seen: n }`.
  - `POST /m/v1/attention/seen-room/:roomId` → `{ seen: n }`. Addition to the contract: marks every
    unseen item whose `room_id` is that task-room root or group id. The portal calls it whenever a
    room, a group or an owner-started task is open and visible; the app should do the same when it
    opens a room or group.
  - All bodyless. These seen calls aren't audited (they change nothing an agent does, and the app
    makes them on every room it opens).
- Events added to the phone stream: `progress.updated` `{progress}`, `progress.cleared`
  `{agent_id, task_id}`, `attention.updated` `{item}`. `progress.*` aren't kept in the events log.
- Progress details:
  - `root_id` is the task-room root for owner-started work (any task in the room, delegated ones
    included), the group id for group turns (and for tasks a group member delegated), and `null`
    for routine work. `group_id` is set only for groups.
  - `progress.updated` is sent when the activity, state, summary or current step changes, at most
    once per agent every 2 s; `stalled_for_s` alone changing doesn't send one, so show elapsed
    time from `step.started_at` (or `last_step_at`) on the device.
  - Stalled: nothing for `AGENTBOX_STALL_MIN` (alias `STALL_MIN`, default 10) minutes, or one shell
    step running that long, checked every 30 s (`AGENTBOX_PROGRESS_TICK_MS`). "Nothing" also counts
    any SDK message the runner receives (thinking, streamed text, a subagent's own steps) as a sign
    of life, so a long subagent or a long answer isn't flagged; a long shell step still is.
  - Summaries are rule-based only (no LLM call): `gh pr checks` output ("3 checks failed: a, b, c;
    5 pending"), test-runner totals, otherwise step counts with the last failed command. From 5 min
    into a turn, at most one every 3 min.
- Attention details:
  - `reply`: the owner-started root task posts a reply in its own conversation, or a group turn
    posts a reply that @mentions no other member (it comes back to the owner). One unseen `reply`
    per room: a newer reply refreshes that item (same id; new `task_id`, `title`, `created_at`)
    and `onAttention` fires again.
  - `failed`: a turn fails (not stopped) anywhere in an owner-started room, or in a group.
    Routine failures don't create items.
  - `stalled`: from progress; created once per task while stalled, and marked seen automatically
    (an `attention.updated` with `seen_at`) when the task resumes or its turn ends. Routine tasks
    can stall too (`room_id` null).
  - Table `attention` (additive, `server/src/db.ts`).
