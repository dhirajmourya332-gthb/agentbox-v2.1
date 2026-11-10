# The desktop app

`desktop/`: an Electron app for macOS, Windows and Linux. It does what needed a terminal on your
computer before, and keeps your agentboxes in one window:

- **Your agentboxes**, each one's portal in the window. The list is the `agentbox` CLI's profiles
  (`~/.config/agentbox/profiles.json`), so the app and the CLI share it.
- **Device bridge on/off** (docs/BENCH.md) in the toolbar and the tray. No installer script and no
  terminal: the app fetches the bridge's settings and script from the portal, runs it with Python,
  and shows what it shares. Bridges that were on come back on when the app starts.
- **Create a new agentbox on Google Cloud** from buttons: the VM (Ubuntu 24.04, shielded, no open
  ports: SSH only from IAP's range), the install, then the **setup guide in a window** (its one-time
  link through an SSH forward over IAP). When the guide finishes, **Connect** reads the address it set
  up (Tailscale or Cloudflare) and adds the agentbox.
- **Connect an existing VM** the same way (it reads the access mode over IAP SSH).
- **Update** an agentbox (`sudo agentbox update` over IAP SSH; refuses while agents work), with
  its output live.
- **Tunnels** for agentboxes in ssh-tunnel mode: the portal through an SSH forward over IAP, opened
  when you open the agentbox and kept up (also usable by the CLI on that port while the app runs).
- **"Needs you" notifications** and a count in the tray / Dock.
- **Runs in the background** in the tray (closing the window keeps bridges and tunnels up); **open
  at login** is a setting.

## Run it

```sh
cd desktop
npm install
npm start            # the app
npm test             # its logic (no Electron needed)
npm run dist:mac     # or dist:win / dist:linux → desktop/dist/
```

Builds are unsigned: macOS asks to confirm the first open (right-click → Open), Windows SmartScreen
asks too. Signing needs an Apple Developer ID / a Windows code-signing certificate
(electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD`). Each platform is built on that platform;
`.github/workflows/desktop.yml` (run it by hand from the Actions tab) builds all three.

## What it needs on your computer

| For | Needs |
|---|---|
| Agentboxes in Tailscale mode | this computer on your tailnet (as for the browser) |
| Google Cloud: create, connect, update, tunnels | the Google Cloud CLI (`gcloud`); **Sign in** in the app runs `gcloud auth login` in your browser |
| The device bridge | Python 3.9+ (the bridge makes its own venv with pyserial and websockets) |

## How it's built (and kept safe)

```
src/main/main.mjs      window, tray, IPC (only from the app's own page), launch at login
src/main/views.mjs     portals in locked-down views; the setup guide's window
src/main/store.mjs     profiles (shared with the CLI) and the app's settings
src/main/tunnels.mjs   SSH forwards over IAP (and the CLI's Lima forward), kept up
src/main/bridge.mjs    the device bridge: settings and script from the portal, run with Python
src/main/gcloud.mjs    gcloud: status, sign-in, VMs, IAP SSH, forwards, the create steps
src/main/flows.mjs     create / guide / connect / update, as jobs with steps and a live log
src/main/jobs.mjs      jobs
src/main/notify.mjs    "needs you" notifications
src/main/env.mjs       the computer: PATH (apps opened from the Dock don't get the shell's), finding and running programs on any OS
src/preload/preload.cjs  the app page's API
src/renderer/          the app's page (sidebar, toolbar, panels); plain JS, no build step
```

- **A portal gets none of the app's powers.** It's a web page from the agentbox, shown in a
  `WebContentsView` with no preload, sandboxed, with its own cookie jar per agentbox. It can't
  navigate away from its own address (other links open in your browser). Only the microphone
  (voice), the clipboard, fullscreen and notifications are allowed, for its own origin.
- **Only the app's own page talks to the main process**, through a fixed list of calls; the main
  process checks the sender is that page. Everything privileged (gcloud, ssh, Python) runs only when
  you click something there, with arguments it checks (VM names, zones, project ids, ports, the
  repository URL). Programs run without a shell on macOS/Linux; Windows `.cmd` files (gcloud)
  go through the shell with quoted arguments.
- **No credentials pass through the app.** gcloud keeps its own login; the bridge's token is written
  to the bridge's settings file (0600) in the app's folder, as the installer writes it to
  `~/.agentbox-bench`.
- **Nothing listens on this computer** but the tunnels' `127.0.0.1` ports; the bridge dials out.

## The portal side

`GET /api/bench/config`: the bridge's settings as JSON (the same as the installer's), for the app.
Older agentboxes without it work too: the app reads the settings from the installer instead. The
bridge script honours `AGENTBOX_BENCH_HOME`, so the app keeps one folder (and token) per agentbox.

## Not yet

AWS and Azure VMs (Google Cloud first); signing and auto-update; the app's own bridge settings
(device allowlist) in the UI: edit `config.json` in the app's `bench/<agentbox>` folder for now.
