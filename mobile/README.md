# agentbox for Android

A small React Native (Expo) app for starting, delegating and watching agentbox work from your phone.
It talks only to the agentbox mobile gateway over Tailscale, and signs every request with a key that
never leaves the phone. The contract with the server is `docs/MOBILE-PROTOCOL.md`.

## Build it (EAS cloud)

You need a free Expo account. Nothing is built or uploaded until you run these yourself.

```bash
cd mobile
npm install
npx eas-cli@latest login
npx eas-cli@latest init                                   # links the project; adds extra.eas.projectId to app.json
npx eas-cli@latest build -p android --profile preview     # installable APK
```

When the build finishes, EAS prints a link and a QR code to download the `.apk`.

- `preview` and `production` both produce an APK (`eas.json`). Use `production` for the copy you keep.
- The first build asks to generate an Android signing keystore. Let EAS create and keep it. Updates
  must be signed with the same key, or Android refuses to install them over the old app.
- There are no over-the-air updates: `expo-updates` isn't installed. Every change needs a new build.

## Install

1. Open the EAS download link on the phone and download the APK.
2. Allow "Install unknown apps" for your browser when Android asks, then install.
3. Install Tailscale on the phone and sign in to the same tailnet as agentbox.
4. The phone needs a screen lock (PIN, pattern or password). The app refuses to pair without one.

## Pair

1. On the Mac, open the portal → **Devices** → **Pair a phone**. A QR code appears for 2 minutes.
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
- Permissions: camera (QR scan only). Images are picked with the system photo picker (or the
  system file picker on older phones), which needs no storage permission.
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
