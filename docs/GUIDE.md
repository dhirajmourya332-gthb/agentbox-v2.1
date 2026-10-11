# The setup guide

A small web app on the VM that walks you through setup: a **terminal** on the left, a **roadmap**
on the right that ticks itself off as each step's check passes, and a **setup agent** (Claude Code)
that does the installing while you do the logins. Code: `guide/`. Design: docs/SETUP-PLAN.md § 3–4,
docs/V2-ARCHITECTURE.md § 8.

## Opening it

`setup/bootstrap.sh` installs the guide and runs `agentbox guide`, which starts it and prints a
**one-time link**. Run `agentbox guide` again any time for a new link (for example to add a module
later; the same page doubles as the module settings).

| Where | How you open it |
|---|---|
| **Lima** | `host/lima/up.sh` prints the link with the Mac port (default 7699; `--ports BASE` → BASE−1). Later: `host/lima/guide.sh --instance <name>`. |
| **Cloud, before access is set up** | `agentbox guide --tunnel` prints the link plus the port-forward command for AWS SSM, Google Cloud IAP (SSH) and plain SSH. Forward the guide's port, then open the link on your computer. |
| **After the access step** | `https://<your portal>/setup/`, behind the portal's own login (Tailscale identity or Cloudflare Access). `agentbox guide` prints it. |

```
agentbox guide [--port N] [--tunnel]   start (if needed) and print a one-time link
agentbox guide link [--port N]         a new link (the guide must be running)
agentbox guide stop                    stop it: every link and session stops working
agentbox guide restart                 update it from the source tree and restart it (see Restarts)
agentbox guide status
```

`--port` only changes the port printed in the link (the port on *your* computer).

## The page

- **Header:** host adapter and machine name, access mode, and Claude's usage (rate-limit status,
  utilisation, reset time, the last turn's cost) once the setup agent has run.
- **Left, top: the terminal.** A login shell as the agent user in a pty (node-pty, compiled on
  install). It survives page reloads (recent output is replayed); several tabs share it.
- **Left, bottom: the setup agent's log.** What it says, the commands it runs, the tail of their
  output. While it works, a strip on top shows the command it is running and for how long, and a
  heartbeat when nothing has happened for 20 s (see Live progress).
- **Right: the roadmap.**
  - *Start here:* **Log in to Claude** (the `claude` module's login gate), **Choose your modules**
    (the profile), **Setup agent** (Start / Pause / Resume).
  - *Modules:* the profile in dependency order, each with its steps. Modules that are off are listed
    at the end (─).
  - *Finish:* the **security self-test**, then the portal's URL and **Finish**.
  - "Your turn" cards render the step's `instructions` (markdown) and its `copy` command with
    **Copy** and **Paste in terminal** (types it; you press Enter). Failed steps show the reason and
    **Retry** (re-runs `agentbox module install <id>`). **Re-check all** re-runs every check now.
- Light and dark themes follow the system; the header button cycles auto / light / dark.

### Live progress

Nothing that runs is ever visually frozen:

- A **running step** (an install / verify by the setup agent, or a Retry) shows a spinner, the
  elapsed time ("Installing… 2 min 14 s") and the **last 10 lines of its output**, auto-scrolling.
  A Retry's output comes straight from `sudo agentbox module install <id>`; for the setup agent's
  installs, `agentbox module install` also writes each module's script output to
  `<data>/guide/runs/<id>.log` (0600, a fresh file per run, only when its output isn't a terminal),
  which the guide reads every second.
- **Heartbeat:** after 20 s without new output, a calm line: "Still working: no new output for 45 s.
  Some steps take several minutes on a small VM."
- **The setup agent's pane** shows its current command with the elapsed time, "Thinking…" between
  commands, and the same heartbeat.
- **Known waits are explained:** every apt/dpkg action in the setup scripts first calls
  `wait_for_apt` (`setup/lib/apt-wait.sh`). When another process holds the dpkg lock (on a new VM,
  Ubuntu's unattended-upgrades for the first minutes), it prints every 15 s
  `⏳ Waiting for Ubuntu's automatic security updates to finish (unattended-upgrades is installing updates; this is normal on a new VM) — 3 min elapsed, up to 15 min · now: Setting up libssl3t64…`
  (the package from `/var/log/unattended-upgrades/unattended-upgrades-dpkg.log`), and gives up after
  15 minutes with what to do. The guide recognises the `⏳` lines and shows them as a yellow
  **Waiting for Ubuntu updates** badge with the detail, not as an error.

Elapsed times come from the server (`guide/src/progress.ts`, shared with the page); the page ticks
them every second.

### Restarts

The guide can restart in the middle of setup (a crash, `agentbox guide restart` to apply an update)
without losing the owner or the setup agent:

- **Sessions persist:** sessions are kept in `<data>/guide/sessions.json` (0600) as SHA-256 of the
  session id → expiry, so an open page stays signed in. Expired ones are dropped on load. One-time
  tokens stay single-use (deleted on use; unused ones are removed whenever the unit stops). Finish
  and `agentbox guide stop` delete the sessions file.
- **The page reconnects:** on a dropped WebSocket it shows "Reconnecting in N s (attempt n)" and
  retries with backoff (1 s → 15 s); after a few failed attempts a banner says the guide isn't
  answering. If the session is really gone (401) it stops and says: "Your setup link expired or the
  guide restarted. Run `agentbox guide` in the VM (or `host/lima/guide.sh`) for a new link."
- **The setup agent resumes:** on SIGTERM the guide records whether the agent was mid-turn
  (`agentStatus: "running"` in `state.json`; the unit uses `KillMode=mixed` so the guide hears the
  signal before the agent's Claude Code process is stopped). On the next start, once the checks are
  in, it resumes the saved session with a "continue" message and the pane says **Resumed after a
  restart**. A paused or waiting agent stays as it was.
- **Deploys don't restart it:** `setup/lib/deploy-app.sh` (run by core's install and
  `agentbox update`) leaves `<paths.app>/guide` alone while `agentbox-guide` is running, and says
  so; it updates a guide that is installed but stopped (`guide/install.sh`). A running guide picks
  up new code only with `agentbox guide restart` (`host/lima/guide.sh restart` from the Mac), which
  runs `guide/install.sh` (sync, npm install, build, unit) and restarts it: the three points above
  make that safe mid-setup. A step that was running when the guide restarted shows ✖ "interrupted"
  until the resumed agent (or a Retry) runs it again.

### Step states

| | State | Meaning |
|---|---|---|
| ○ | pending | Not started, or waiting for an earlier step of its module |
| ● | running | The setup agent (or a Retry) is installing / verifying this module right now |
| ⏸ | your turn | A human gate whose earlier steps are done and whose check isn't green yet |
| ✔ | done | **Its check passed.** Nothing else ever marks a step done. |
| ✖ | failed | An install / verify of the module finished and this step's check still fails |
| ─ | off | The module isn't in the profile |

A step is shown only when its `when:` condition holds (e.g. the `cloudflare-*` steps only with
`access: cloudflare`); hidden steps' checks don't run.

## How it works

- **Roadmap state** (`guide/src/roadmap.ts`, pure): the manifests (`<paths.src>/setup/modules/*/module.yaml`),
  the config, the latest check results, and which modules are being worked on. The **profile** is
  the enabled modules (core, claude and access always) plus everything they depend on, in
  dependency order (`guide/src/manifest.ts`).
- **Checks** (`guide/src/checks.ts`): each applicable step's `check` runs as the agent user
  (`bash -lc`), with a 10 s timeout that kills its whole process group, at most 4 at a time and never
  overlapping itself. Steps that aren't green are re-checked every 3 s; green ones every 30 s (so a
  regression shows). Changes are pushed to the page over a WebSocket (`/ws/state`).
- **The config** is re-read when the file changes, so `agentbox config set …` in the terminal (e.g.
  choosing the access mode) updates the roadmap within a second.
- **The profile step** writes the config through the CLI: switching a module on runs
  `agentbox config set modules.<id> true` (dependencies too; the setup agent installs it in order),
  switching one off runs `agentbox module disable <id>` (dependents too; units are removed). Saving
  marks the step (`<data>/guide/profile-confirmed`).
- **The setup agent** (`guide/src/agent.ts`) is a Claude Code session through the Agent SDK
  (`query()`, like `server/src/runner.ts`), with Claude Code's system prompt plus the profile, the
  manifests and the rules: install / verify with `agentbox module install|verify <id>`; never log in
  or handle secrets; at a human gate say exactly what to run and end the turn; no Docker. A
  `PreToolUse` hook refuses login commands, `agentbox secret set`, reading secrets or credentials,
  and Docker. It starts only once the Claude login check **and** the profile are green.
  - The roadmap follows it: an `agentbox module install|verify|enable <id>` command marks that
    module ● while it runs and records the outcome (✖ with the output's tail on failure).
  - When a turn ends with a gate open, the agent is *waiting*; when that gate's check turns green the
    guide sends it "continue" by itself. **Pause** interrupts the turn; nothing restarts it until
    **Resume**.
  - The session id is kept in `<data>/guide/state.json`, so it resumes after a guide restart (a
    session that can't be resumed starts fresh).
- **Finish:** when every step is ✔ the guide runs `agentbox selftest` and shows the result. On a
  pass it shows the portal's URL; **Finish** ends every session, deletes unused links and the
  portal-proxy secret, and stops the `agentbox-guide` unit.

## Security

The guide hands out a shell as the agent user, who has passwordless sudo while the guide runs, so it
is guarded like the terminal.

- **Listens on 127.0.0.1:`ports.guide` (7699) only.**
- **Direct access** (the Lima forward, or an SSM / IAP / SSH port forward) needs a **guide
  session**: `agentbox guide` (root, i.e. someone who already has a shell on the VM) writes the
  SHA-256 of a random 256-bit token to `<data>/guide/tokens/` (0600, expiry 30 minutes) and prints
  `http://localhost:<port>/?t=<token>`. The guide deletes the file on first use and sets an HttpOnly,
  SameSite=Strict session cookie (8 h; the guide keeps only its SHA-256, in `sessions.json`, 0600,
  so it survives a restart), then redirects to drop the token from the address bar. Without a session every page, API call and WebSocket is a 401.
  - Host must be a loopback name (DNS rebinding); Origin, when sent, must be exactly the guide's
    own origin (another localhost port is another site); `Sec-Fetch-Site: cross-site|same-site` is
    refused on the API and WebSockets; writes must be JSON. The terminal WebSocket is refused
    cross-origin.
  - Responses carry `X-Frame-Options: DENY`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- **Through the portal** (once access is set up): the portal serves the guide at `/setup/` behind
  the **same `createAccess` login** as everything else (owner identity, Host/Origin, session, JSON
  writes; `server/src/access.ts`). It forwards to the guide with `X-Agentbox-Guide-Proxy: <secret>`,
  a random value the guide writes to `<data>/guide/proxy-token` (0600) at start and deletes at stop;
  the guide trusts it only from a loopback peer. Cookies and identity headers are not forwarded, and
  the guide's cookies never reach the portal's origin. While the guide isn't running `/setup/` is a 503.
  With `access: ssh-tunnel` the portal has no login (being on localhost is the check, as for `/term/`),
  so `/setup/` on the forwarded portal port is open to whoever holds the forward, with the Host,
  Origin and Sec-Fetch-Site checks.
- **Sudo while it runs:** the unit's `ExecStartPre` grants the agent user `NOPASSWD:ALL` in
  `/etc/sudoers.d/agentbox-guide`; `ExecStopPost` removes it (with the tokens and the proxy secret)
  whenever the guide stops. With `agent_sudo: true` (the default) the core module grants the same
  permanently anyway; with `agent_sudo: false` the agent user has root only while the guide runs.
- **No secrets through the page:** gates tell you what to type in the terminal or the official login
  page; `agentbox secret set` reads from the terminal's stdin.

## Files

| | |
|---|---|
| `guide/server.ts` | entry (the unit runs `node --import tsx server.ts` as the agent user) |
| `guide/src/app.ts` | HTTP + WebSockets, state, profile, retry, self-test, Finish |
| `guide/src/{manifest,profile,roadmap,checks,auth,terminal,agent}.ts` | the pieces above |
| `guide/web/` | the page (React, xterm.js; built to `guide/dist/`) |
| `guide/install.sh` | run by bootstrap: build tools for node-pty, `<paths.app>/guide`, npm packages, the page, the unit |
| `guide/agentbox-guide.sh` | `agentbox guide` |
| `guide/agentbox-guide.service` | the unit template (not enabled at boot) |
| `host/lima/guide.sh` | the Mac-side link for a Lima VM |
| `guide/src/progress.ts` | live progress: output tail, `⏳` waits, elapsed time, heartbeat (shared with the page) |
| `setup/lib/apt-wait.sh` | `wait_for_apt` (sourced by `common.sh`, bootstrap, `guide/install.sh`, the access module) |
| `<paths.data>/guide/` | `state.json` (agent session and status, attempts, log, self-test), `sessions.json`, `runs/<module>.log`, `tokens/`, `proxy-token`, `profile-confirmed` |

Tests: `cd guide && npm test` (the state machine, `when:`, profile resolution, the check runner with
timeouts, the token / session / proxy auth over HTTP and WebSockets, the setup agent's wiring with a
fake SDK, live progress, restarts: sessions, agent resume, Retry and agent output; `wait_for_apt`
against a test lock holder and deploy-app.sh leaving a running guide alone, in bash). The portal's `/setup/` proxy is covered by `cd server && npm run test:access`.
