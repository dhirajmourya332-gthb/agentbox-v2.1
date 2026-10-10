# agentbox for Android

A small React Native (Expo) app for starting, delegating and watching agentbox work from your phone.
It talks only to the agentbox mobile gateway over Tailscale, and signs every request with a key that
never leaves the phone. The contract with the server is `docs/MOBILE-PROTOCOL.md`.

## Install-specific inputs

The repo holds no account ids. `app.json` is the shared base; `app.config.ts` layers your own values
over it from environment variables:

| Variable | Required | What it is |
|---|---|---|
| `EXPO_OWNER` | no | Your Expo account or organisation. Defaults to the logged-in Expo user. |
| `EAS_PROJECT_ID` | for EAS builds | The project id `eas init` prints. |
| `ANDROID_PACKAGE` | no | The Android application id. Default `org.agentbox.mobile`. Keep it the same across builds, or Android treats each build as a different app. |
| `GOOGLE_SERVICES_FILE` | no | Path to your Firebase `google-services.json` (default `./google-services.json`). Push notifications are configured only if this file exists. It is git-ignored: never commit it. |

Put them in your shell (or in EAS environment variables for cloud builds), e.g.:

```bash
export EXPO_OWNER=your-expo-name EAS_PROJECT_ID=00000000-0000-0000-0000-000000000000
```

The `mobile-app` setup module asks for these and fills them in for you.

## Build it (EAS cloud)

You need a free Expo account. Nothing is built or uploaded until you run these yourself.

```bash
cd mobile
npm install
npx eas-cli@latest login
npx eas-cli@latest init                                  # creates the project, prints its id
export EAS_PROJECT_ID=<the id it printed>                # app.config.ts reads it
npx eas-cli@latest build -p android --profile preview    # installable APK
```

`eas init` may offer to write the id into the config; with `app.config.ts` it can't, so set
`EAS_PROJECT_ID` instead.

When the build finishes, EAS prints a link and a QR code to download the `.apk`.

- `preview` and `production` both produce an APK (`eas.json`). Use `production` for the copy you keep.
- The first build asks to generate an Android signing keystore. Let EAS create and keep it. Updates
  must be signed with the same key, or Android refuses to install them over the old app.
- There are no over-the-air updates: `expo-updates` isn't installed. Every change needs a new build.

### Push notifications need Firebase (once)

Android delivers Expo push notifications through Firebase Cloud Messaging. Until this is set up the
app works normally, but it can't get a push token, so it never registers for notifications.

1. In the Firebase console, create a project and add an Android app with the same package as
   `ANDROID_PACKAGE` (default `org.agentbox.mobile`). Download `google-services.json` into
   `mobile/` (or anywhere, and point `GOOGLE_SERVICES_FILE` at it). `app.config.ts` notices the
   file and turns on the push configuration.
2. Create a service-account key for FCM V1 and upload it to the project's EAS credentials
   (`npx eas-cli@latest credentials` → Android → Google Service Account → FCM V1).
3. Build again.

## Install

1. Open the EAS download link on the phone and download the APK.
2. Allow "Install unknown apps" for your browser when Android asks, then install.
3. Install Tailscale on the phone and sign in to the same tailnet as agentbox.
4. The phone needs a screen lock (PIN, pattern or password). The app refuses to pair without one.

## Pair

1. Open the portal → **Devices** → **Pair a phone**. A QR code appears for 2 minutes.
2. In the app, name the phone, tap **Scan pairing code** and scan it.
   - Codes must point to an `https://…ts.net` address. Any other https address shows a warning first.
3. The app shows a fingerprint like `K3QF-7ZMA-2XWB-…`. Check it matches the pending device in the
   portal, then click **Approve** there. The app continues on its own (within 5 minutes).

To unpair, use **Settings → Forget this device**: it asks agentbox to remove the phone, then
wipes it locally. If agentbox couldn't be reached, also **Revoke** it in the portal.

## Security notes

- The private key is an Ed25519 key made on the phone and stored in `expo-secure-store` (Android
  Keystore). If the phone has strong biometrics, the Keystore only releases it after a fingerprint
  or face check. Otherwise the app asks for the screen lock before reading it. **Limitation:**
  expo-secure-store can't bind a key to the PIN/pattern (biometric-only), so on phones without
  strong biometrics that check is enforced by the app, not the Keystore. Prefer a phone with a
  fingerprint sensor or face unlock.
- The app asks you to unlock on every launch and after 2 minutes in the background (checked on
  return against both the wall clock and a monotonic clock; a clock set backwards also locks).
  Locking wipes the key and all loaded data from memory.
- Screenshots and screen recording are blocked. App backups are off. Cleartext HTTP is off.
- Permissions: camera (QR scan only), microphone (voice input, asked for on the first tap of the
  mic) and notifications (asked for once, after pairing or on the first unlock). Images are picked
  with the system photo picker (or the system file picker on older phones), which needs no storage
  permission. No foreground service, background recording, background fetch or boot receiver
  permissions (they're in `blockedPermissions`).
- Voice input uses Android's own speech recognition (`expo-speech-recognition`). It runs on-device
  when the offline model for the chosen language is installed; otherwise the audio goes to the
  phone's online Google recognition service. The listening bar says which ("on-device" or
  "Google"). **Settings → Voice** picks the language (English (India), English (US), Hindi), turns on
  "On-device only" (then voice never uses the online service) and downloads the offline model.
  Only the recognised text is sent to agentbox (`POST /m/v1/voice/clean`) to tidy up; no audio
  reaches agentbox and no audio file is kept. It goes in the box for review and is never sent on
  its own. Going to the background, locking or leaving the screen aborts recognition and discards
  everything heard. The speech module's manifest entry is a `<queries>` element (package visibility
  for the Google app and any `android.speech.RecognitionService`), not a permission.
- Notifications say only "Something needs you" and carry ids, never text. Tapping one opens the
  app, which still asks you to unlock before showing anything.
- Every dialog is drawn in-app, so screenshot blocking covers it too. If screenshot blocking can't
  be turned on, the app shows nothing.
- No request follows redirects. If a signed request gets a 404, the app asks `whoami`; only if
  that also 404s does it stop and show "This phone isn't paired any more".

## Develop

```bash
npm run typecheck                     # tsc --noEmit
npm run selftest                      # signing + QR rules self-test (prints test vectors)
npx expo-doctor
npx expo export --platform android    # checks the Hermes bundle builds (delete dist/ afterwards)
```

Expo Go can't run this app because it relies on native modules and settings that Expo Go lacks. Use
an EAS build, or a local dev build with `npx expo run:android`.
