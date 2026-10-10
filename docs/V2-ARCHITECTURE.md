# agentbox v2: portable, modular, open-source-ready

The contract for the v2 workstreams. Read it together with `docs/SETUP-PLAN.md` (the product plan).

**Hard constraints:**
- The original `../grok-alt` and its running VM `agentbox` are **never touched**: no edits, no deploys,
  no `limactl` commands against the `agentbox` instance.
- **No compromise on security:** zero inbound ports by default; every non-localhost access needs a login.
- **Open source:** anyone who clones the repo can set it up. Nothing personal or company-specific
  stays in code, skills, prompts, tests or docs: those become examples or setup-time inputs.

## 1. Hosts (the lower layer that makes "where" irrelevant)
| `host` | What it is | Who runs the services | How the code gets there | Notes |
|---|---|---|---|---|
| `cloud` (default) | Any raw Ubuntu 24.04 VM: AWS, GCP, Azure, Hetzner, bare metal | systemd **inside the VM** | `git clone` on the VM; `agentbox update` = `git pull`, build, restart | No Mac involved. First shell via the provider's console or SSM / IAP. |
| `lima` | A local Lima VM on macOS | systemd inside the VM | the repo mounted read-only at `/mnt/agentbox-src`, plus an rsync deploy (as today) | Instance name and host ports configurable (v2 default: instance `agentbox`; use another name to run side by side) |

Everything above the host layer only uses: the config file, systemd units, the `agentbox` CLI and the
module scripts. A small number of host hooks (`deploy`, `start`, `stop`, `forward-ports`) are the only
host-specific code: `host/cloud/*.sh` and `host/lima/*.sh`.

## 2. Config: `/etc/agentbox/config.yaml` (root-owned, 0644; no secrets)
```yaml
host: cloud              # cloud | lima
access: tailscale        # tailscale | cloudflare | ssh-tunnel (localhost only)
user: agentbox           # the unix user agents run as (created by bootstrap)
paths: { app: /opt/agentbox/app, data: /opt/agentbox/data, work: /work, agents: /agents,
         team: /team, skills: /skills, secrets: /secrets }
ports: { portal: 7700, screen: 7701, terminal: 7702, gateway: 7710, guide: 7699 }   # all bound to 127.0.0.1
modules:                 # enabled modules; core, claude, access are always on
  display: true
  github: true
  aws: false
  kubernetes: false
  db-tunnel: false
  voice: false
  mobile: false          # needs access=tailscale
  mobile-app: false
  push: false
tailscale: { hostname: "" }                       # set by the access module
cloudflare: { hostname: "", team_domain: "", aud: "" }  # set by the access module
owner: { tailscale_login: "", email: "" }         # who may use the portal (set during setup)
```
The server reads it at start (`AGENTBOX_CONFIG`, default `/etc/agentbox/config.yaml`; dev fallback:
built-in defaults equivalent to today's behaviour) and exposes `GET /api/config/public`: modules, host
and access, with no secrets. **Features of a disabled module are off:** no routes (they return 404), no
timers, no units (e.g. `mobile: false` means the gateway isn't started and Tailscale status isn't
polled).

## 3. Modules: `setup/modules/<id>/`
`module.yaml`:
```yaml
id: github
title: GitHub
description: git + gh CLI so agents can work with repos, issues and PRs
optional: true
depends: [core]
steps:                      # shown on the roadmap, in order
  - id: install
    title: Install git and gh
    run: install.sh         # by the setup agent (root via sudo); idempotent
    check: "command -v gh && command -v git"
  - id: login
    title: Log in to GitHub
    human: true             # a "YOUR TURN" gate
    instructions: |
      In the terminal run: `gh auth login` (GitHub.com, HTTPS, browser).
      Add the project scope if you use GitHub Projects: `gh auth refresh -s project`.
    copy: "gh auth login"
    check: "gh auth status"
  - id: verify
    title: Verify
    run: verify.sh
    check: "gh api user -q .login"
```
- **Rules:**
  - `check` is a read-only shell command, run as the agent user, with a 10 s timeout. Exit 0 means done.
  - `install.sh`, `configure.sh` and `verify.sh` are idempotent bash with `set -euo pipefail`.
  - They read `/etc/agentbox/config.yaml` through the `agentbox config get <key>` helper.
  - They never print secrets.
- **Human gates** never collect secrets in the guide page. The human types them into the terminal or
  the official login page; for files, `agentbox secret set <name>` reads from stdin into `/secrets`.
- **Modules:** `core`, `claude`, `access`, `display`, `terminal`, `github`, `aws`, `kubernetes`,
  `db-tunnel` (generic: "SSH tunnel through a bastion / SSM", configured by the user), `env-files`,
  `voice`, `mobile`, `mobile-app`, `push`.
- **Module-owned files:** systemd units under `setup/modules/<id>/units/`, installed by the module.
  Team-rule templates under `setup/modules/<id>/team/`, copied to `/team` as examples the user edits.

## 4. The `agentbox` CLI: `/usr/local/bin/agentbox`
- `agentbox status`: the modules with their checks (green/red), services and listeners.
- `agentbox config get|set <key> [value]`.
- `agentbox module enable|disable|install|verify <id>`.
- `agentbox secret set <name>`: stdin into `/secrets/<name>`, 0600.
- `agentbox update`: pull and build (cloud), or rsync and build (lima), then restart, refusing while
  agents are busy unless `--force`.
- `agentbox start|stop|restart`.
- `agentbox guide`: start the setup guide and print how to open it.
- `agentbox selftest`: the security self-test (section 6).

## 5. Access and portal auth (`access` module; server `server/src/access.ts`)
- **All services stay bound to 127.0.0.1.**
- **`tailscale`:**
  - `tailscale serve --https=443 → 127.0.0.1:<portal>`;
  - the portal trusts `Tailscale-User-Login` **only** on requests arriving through serve (loopback
    peer) and requires it to equal `owner.tailscale_login`;
  - the allowed Host is the ts.net name; Origin must equal it.
- **`cloudflare`:**
  - a `cloudflared` tunnel (outbound) maps `https://<hostname>` → 127.0.0.1:<portal>;
  - the portal **verifies the `Cf-Access-Jwt-Assertion` JWT** (signature against
    `https://<team_domain>/cdn-cgi/access/certs`, the `aud` tag, expiry), and requires `email` ==
    `owner.email`;
  - the allowed Host and Origin are the hostname.
- **`ssh-tunnel`:** localhost-only, the current behaviour (Host and Origin must be loopback).
- **The terminal and screen are served through the portal** (`/term/*`, `/screen/*` reverse proxies
  with WebSocket support) behind the same auth plus Origin checks, so ttyd and noVNC are never reachable
  directly. This fixes audit H1. ttyd also gets `-O`; x11vnc gets a password in a 0600 file.
- **The phone gateway** (mobile module) is unchanged: signed requests, Tailscale only.
- **Sessions:** after the first authenticated request the portal sets an HttpOnly, Secure,
  SameSite=Strict session cookie (8 h); all `/api` calls need it or a valid identity header/JWT.
  CSRF: Origin check + JSON-only writes (as today) + SameSite.

## 6. Security self-test (`agentbox selftest`, the last roadmap step)
It fails on any of these:
- a listener on a non-loopback address other than an allowed list (tailscaled, the DHCP client,
  systemd-resolved);
- the portal answering without auth through the access path;
- Funnel enabled or permitted (Tailscale);
- `/secrets` perms not 0700/0600, or not owned by the agent user;
- the DB and data dir world-readable;
- the terminal or screen reachable without portal auth;
- the tailnet guard missing (when mobile is on);
- passwordless sudo for the agent user **(warning only for now; see audit H3)**.

Cloud-side checks print **instructions** (e.g. "verify your firewall / security group has no inbound
rules") because the VM can't see the provider's firewall.

## 7. Bootstrap (`setup/bootstrap.sh`, run as a sudo-capable user on a fresh Ubuntu 24.04)
1. Install the base packages, Node 22, git, and the Claude Code CLI.
2. Create the agent user and directories; write a default `/etc/agentbox/config.yaml` (host
   auto-detected: lima if `/mnt/agentbox-src` exists, else cloud).
3. Install the `agentbox` CLI, the guide server and ttyd.
4. Start the guide on 127.0.0.1:7699 and print how to reach it:
   - lima: the forwarded `http://localhost:<port>`;
   - cloud before access exists: `agentbox guide --tunnel` prints the SSM / IAP / SSH port-forward
     commands for the common providers;
   - after the access step: the HTTPS URL.

## 8. Guide (`guide/`: a small server + page, built with the web app)
- **Server:**
  - reads the module manifests and the config;
  - runs the pending `check`s every 3 s;
  - pushes state over a WebSocket;
  - starts the **setup agent**, a Claude Code session (Agent SDK) with a system prompt containing the
    manifests and the rule "you run install/configure/verify scripts; you never perform logins; at
    human gates you stop and wait".
- **Page:** a terminal (xterm.js to a guide-owned pty, or ttyd) on the left, the roadmap on the right:
  states ○ ● ⏸ ✔ ✖ ─; "your turn" cards with copy buttons; module toggles at the profile step.
- **Auth:** while there's no access module yet, it is localhost only. It switches to the portal's auth
  once access is set up. Port 7699; it shuts down at the end.

## 9. Open-source hygiene
- **Company specifics become examples:**
  - seed skills that encoded a company board, sprint or rules become generic, with parameters in
    `/team/github.md` (board name, assignee, labels…);
  - prompts and tests use neutral names (`acme`, `example-repo`).
- **Removed from the repo:** `mobile/google-services.json`; the Expo `owner` / `projectId` in
  `app.json` become env or `app.config.ts` inputs (`EXPO_OWNER`, `EAS_PROJECT_ID`) filled in during
  the mobile-app module.
- **Company-specific docs** (security audit, backlog, release notes of this install) move out of the
  public repo, to `docs/internal/` (git-ignored) or are removed. Public docs: README (what it is,
  quickstart for cloud and lima), `docs/` (architecture, modules, access, mobile, security model),
  SECURITY.md, CONTRIBUTING.md, and a LICENSE placeholder (the owner picks the license).
- **A fresh git history at publish time** (one initial commit).
