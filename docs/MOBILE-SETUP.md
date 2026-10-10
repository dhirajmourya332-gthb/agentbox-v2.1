# Mobile app: owner setup

The agentbox Android app reaches your VM only over your **tailnet** (Tailscale). Nothing is
exposed to the internet. The full design is in [MOBILE-PROTOCOL.md](MOBILE-PROTOCOL.md).

## 1. Prepare your tailnet (Tailscale admin console, once)
Do this **before** running the setup script.

1. **DNS page:** turn on **MagicDNS** and **HTTPS certificates**.
2. **Access controls:** create the tag and lock the policy down. The default policy lets every
   device reach every other device on every port; replace that (`"src": ["*"], "dst": ["*:*"]`).
   Keep only rules you need, and give the agentbox VM exactly this:

```jsonc
{
  "tagOwners": {
    "tag:agentbox": ["autogroup:admin"]
  },
  "acls": [
    // Your own devices → the agentbox VM, HTTPS only. List your login(s); not "*".
    { "action": "accept", "src": ["you@example.com"], "dst": ["tag:agentbox:443"] }
    // … your other rules, none with a "*:*" destination.
    // NOTHING from tag:agentbox outward: never use tag:agentbox (or "*") as a "src".
  ],
  "nodeAttrs": [
    // If you use Funnel elsewhere, target only those devices. Never give "funnel" to
    // tag:agentbox, "*", autogroup:tagged or autogroup:member while the VM could match it.
  ],
  "tests": [
    { "src": "you@example.com", "accept": ["tag:agentbox:443"], "deny": ["tag:agentbox:22", "tag:agentbox:7700"] },
    { "src": "tag:agentbox", "deny": ["you@example.com:22", "you@example.com:443"] }
  ]
}
```

Why it matters: agents have full control of the VM, sudo included. The ACL is enforced by
Tailscale outside the VM, so agents can't loosen it. The VM's own tailnet firewall (below) is a
second layer.

## 2. Put the gateway on your tailnet
On the machine that runs the scripts (the Mac, for a Lima install), with the current code deployed (`scripts/deploy.sh`):

```bash
AGENTBOX_TS_TAG=tag:agentbox ./scripts/mobile-setup.sh
```

It refuses to run without `AGENTBOX_TS_TAG`. It's safe to re-run. It:
1. runs `scripts/install-units.sh`. This reinstalls the web, noVNC and ttyd units and the tailnet
   firewall (with a 60 s watch timer and a drop-in so `tailscaled` can't run without it), restarts
   those services, and **refuses to continue** unless ports 7700, 7701, 7702 and 7710 listen on
   loopback only. It won't restart `agentbox-web` while agent tasks are running unless you pass
   `--force`;
2. installs Tailscale in the VM, from the official repository for Ubuntu 24.04;
3. runs `tailscale up` as a **tagged** node with a random, non-descriptive hostname such as
   `node-xxxxxx`. Certificate names for `*.ts.net` are published in public Certificate
   Transparency logs, so the name shouldn't describe the machine. It also passes `--ssh=false
   --accept-dns=false --accept-routes=false`. **The first time, it prints a login URL: open it and
   sign in;**
4. **refuses, and takes the machine off the tailnet,** if Funnel is on or your policy gives this
   machine the Funnel capability;
5. runs `tailscale serve --bg --https=443 http://127.0.0.1:7710`, which is tailnet only;
6. checks Funnel again and prints the `https://node-xxxxxx.<tailnet>.ts.net` URL.

**Never run `tailscale funnel`.** The Devices page shows a red warning if Funnel is on, if the
policy allows Funnel for this machine, or if the tailnet firewall isn't loaded. To fix the
firewall, run `scripts/install-units.sh`; to turn Funnel off, run `sudo tailscale funnel reset`
in the VM.

## 3. Pair a phone
1. In the portal, open **Computer → Devices** and click **Pair a phone**. A QR code appears; it
   works once, for 2 minutes. Next to it the page shows the gateway's host name; the app asks you
   to confirm that name, so check that they match.
2. In the app, scan it. The app shows a **fingerprint** (e.g. `K3QF-7ZMA-2XWB-9QPL`).
3. The phone appears under **Waiting for approval** with a fingerprint. **Approve only if the two
   match exactly.** Unapproved phones are dropped after 5 minutes.

The portal works only when opened on `localhost` or `127.0.0.1`, as it is from the Mac. Its API
refuses other host names and other sites.

## 4. Day to day
- **Revoke** a phone, or **Revoke all**, on the Devices page. It takes effect at once: the phone's
  live connection is closed. "Forget this device" in the app does the same from the phone.
- Everything a phone changes, and every file it opens, shows in **Activity** as
  "… via phone (<name>)".
- Phones can view work, tasks, routines, documents and files; start tasks; send messages and
  images; stop tasks; mark tasks done; run routines; and pause or resume. They can't create,
  edit or delete agents, skills or routines, or use the terminal, the screen, settings or devices.

## If a phone is lost
Revoke it on the Devices page. Its key is useless after that, even to someone who has unlocked
the phone.

## Testing (for developers)

> **In a VM that already runs Tailscale**, the gateway reports the real `*.ts.net` URL instead of the
> test's manual one, and the pairing tests then fail. Put a stub first on `PATH` for the rehearsal:
> `mkdir -p /tmp/stub && printf '#!/bin/sh\nexit 1\n' > /tmp/stub/tailscale && chmod +x /tmp/stub/tailscale`,
> then start the rehearsal with `PATH=/tmp/stub:$PATH`.
The gateway test client signs real requests. **Run it only against a rehearsal copy**, never the
live server. In the VM:

```bash
mkdir -p /tmp/mob/{data,agents,work,skills}
rsync -a --exclude node_modules /mnt/agentbox-src/server/ /tmp/mob/server/
(cd /tmp/mob/server && npm install --no-audit --no-fund)

# Snapshot the database, then pause the copy and disable its routines.
cat > /tmp/mob/snap.mjs <<'EOF'
import { DatabaseSync } from "node:sqlite";
new DatabaseSync("/opt/agentbox/data/agentbox.db", { readOnly: true })
  .exec(`VACUUM INTO '/tmp/mob/data/agentbox.db'`);
const db = new DatabaseSync("/tmp/mob/data/agentbox.db");
db.exec(`INSERT INTO meta (key, value) VALUES ('paused', '1')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
db.exec(`UPDATE routines SET enabled = 0`);
EOF
node /tmp/mob/snap.mjs

cd /tmp/mob/server
STARTED=$(date +%s%3N)
AGENTBOX_DATA=/tmp/mob/data AGENTBOX_AGENTS=/tmp/mob/agents AGENTBOX_WORK=/tmp/mob/work AGENTBOX_SKILLS=/tmp/mob/skills \
AGENTBOX_MAX_RUNNING=0 AGENTBOX_CDP=http://127.0.0.1:1 PORT=7790 AGENTBOX_MOBILE_PORT=7791 \
AGENTBOX_PAIRING_TTL_MS=15000 AGENTBOX_PENDING_TTL_MS=20000 \
  node --disable-warning=ExperimentalWarning --import tsx src/index.ts > /tmp/mob/server.log 2>&1 &
until ss -ltn | grep -q ':7791 '; do sleep 1; done

SERVER_STARTED_MS=$STARTED PORTAL=http://127.0.0.1:7790 GATEWAY=http://127.0.0.1:7791 WORK=/tmp/mob/work \
AGENTBOX_PAIRING_TTL_MS=15000 AGENTBOX_PENDING_TTL_MS=20000 \
  node --disable-warning=ExperimentalWarning --import tsx test/mobile-gateway.test.ts

kill %1; rm -rf /tmp/mob
```

Notes:
- **Paused and `AGENTBOX_MAX_RUNNING=0`:** both stop any agent turn from running in the copy.
- **TTL variables:** they can only **shorten** the 2-minute and 5-minute windows. Keep them at
  15 s or more: a busy VM can take several seconds per request.
- **Run time:** about two to three minutes, because the client paces its pairing claims to stay
  under 10 per minute.
- **Rerunning:** restart the rehearsal server first, because the last case uses up that minute's
  claim budget. The "signed before the server started" case runs only within 50 s of
  `SERVER_STARTED_MS`; otherwise it's reported as skipped.

### Push notification tests
Two more test files, both small:
- `test/push.test.ts` runs `push.ts` in-process, against a throwaway database and a local Expo mock
  (`test/expo-mock.ts`). It needs no server.
- `test/push-gateway.test.ts` signs real requests against a rehearsal server whose
  `AGENTBOX_PUSH_URL` points at the mock it starts.

```bash
mkdir -p /tmp/push-rt/{data,agents,work/uploads,skills}   # snapshot the DB as above, into /tmp/push-rt/data
cd /tmp/push-rt/server
PUSH_TEST_DIR=/tmp/push-rt/unit MOCK_PORT=7798 node --import tsx test/push.test.ts
AGENTBOX_DATA=/tmp/push-rt/data AGENTBOX_AGENTS=/tmp/push-rt/agents AGENTBOX_WORK=/tmp/push-rt/work AGENTBOX_SKILLS=/tmp/push-rt/skills \
AGENTBOX_MAX_RUNNING=0 AGENTBOX_CDP=http://127.0.0.1:1 PORT=7796 AGENTBOX_MOBILE_PORT=7797 \
AGENTBOX_PUSH_URL=http://127.0.0.1:7798/--/api/v2/push/send \
  node --import tsx src/index.ts > /tmp/push-rt/server.log 2>&1 &
until ss -ltn | grep -q ':7797 '; do sleep 1; done
PORTAL=http://127.0.0.1:7796 GATEWAY=http://127.0.0.1:7797 MOCK_PORT=7798 node --import tsx test/push-gateway.test.ts
kill %1; rm -rf /tmp/push-rt
```
The gateway test creates a group in the copy if it has none, and posts one message to it (the copy
is paused, so nothing runs). It ends with revoke-all.

## Push notifications: Firebase (FCM) setup (owner, once)
Expo delivers Android notifications through Firebase Cloud Messaging, so the Expo project needs
FCM V1 credentials:
1. **Firebase project:** go to <https://console.firebase.google.com> › Add project (Analytics not
   needed).
2. **Android app:** Project settings › General › Add app › Android. The package name must equal
   `android.package` in `mobile/app.json`. Download `google-services.json` and put it in `mobile/`,
   with `"android": { "googleServicesFile": "./google-services.json" }` in `app.json`. The file
   holds no secret, but keep it out of public repos anyway.
3. **Service account key:** Project settings › Service accounts › Firebase Admin SDK › Generate new
   private key. This downloads a JSON key; it **is** a secret, so don't commit it.
4. **Upload it to Expo:** in `mobile/`, run `npx eas-cli login`, then `npx eas-cli credentials`.
   Pick Android, then the build profile (e.g. production). Go to Google Service Account ›
   **Manage your Google Service Account Key for Push Notifications (FCM V1)** › Set up › Upload a
   new service account key, and choose the JSON from step 3. Then delete the local copy of the key.
   (Alternatively: expo.dev › project › Credentials › Android › FCM V1 service account key.)
5. **Rebuild the app** (`eas build -p android`), so it includes `google-services.json`.
6. **Optional, recommended:** expo.dev › project › Settings › turn on **Enhanced security for push
   notifications**. Then create an access token (expo.dev › Account settings › Access tokens) and give
   it to the server as `EXPO_ACCESS_TOKEN`, e.g. `Environment=EXPO_ACCESS_TOKEN=…` in a
   systemd drop-in for `agentbox-web`, or an `EnvironmentFile` readable only by the service user.
   Without it, pushes fail with an authorization error once enhanced security is on.
7. **Test:** pair the phone, allow notifications in the app, then use **Send test notification** on
   the Devices page.

