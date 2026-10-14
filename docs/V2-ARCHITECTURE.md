# agentbox v2: portable, modular, open-source-ready

The contract for the v2 workstreams. Read it together with `docs/SETUP-PLAN.md` (the product plan).

**Hard constraints:**
- (Development only, remove at publish time.) The original `../grok-alt` and its running VM
  `agentbox` are **never touched**: no edits, no deploys, no `limactl` commands against the
  `agentbox` instance.
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
  directly. This closes the cross-site terminal access risk. ttyd also gets `-O`; x11vnc gets a password in a 0600 file.
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
- passwordless sudo for the agent user **(warning only for now: agents currently rely on sudo)**.

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

## Changes (platform workstream)
Minimal additions made while implementing sections 1–4, 6 and 7. Everything else is as above.
- **Config keys added** (`setup/config.default.yaml`):
  - `paths.src`: where the repo lives (lima: `/mnt/agentbox-src`; cloud: the clone bootstrap ran from);
  - `agent_sudo: true|false`: passwordless sudo for the agent user (selftest warns while true);
  - `docker: false`: docker is opt-in (it makes the agent user root-equivalent);
  - `modules.terminal` (default true) and `modules.env-files` (default false) are listed explicitly;
  - `mobile: { serve_port: 8443, expo_owner, eas_project_id }`.
- **The phone gateway moves to `https://<node>.ts.net:8443`** (`mobile.serve_port`), because in v2 the
  portal owns `tailscale serve :443`. The tailnet policy must allow the owner → `tag:…:443,8443`.
  The pairing QR carries the port; the app already accepts origins with a port.
- **No config file** (development, the in-process tests): built-in defaults equal pre-v2 behaviour:
  every module on, `access: ssh-tunnel`, data in `./data`, gateway served on 443. The old env overrides
  (`AGENTBOX_DATA`, `_AGENTS`, `_WORK`, `_SKILLS`, `PORT`, `AGENTBOX_MOBILE_PORT`, plus new
  `AGENTBOX_TEAM`, `AGENTBOX_SECRETS`) still win over the file.
- **`module.yaml`** also has `units: [...]` (the units to enable and start; every file under `units/`,
  drop-in directories included, is installed with `@USER@ @HOME@ @APP@ @DATA@ @SECRETS@ @SRC@
  @PORTAL_PORT@ @SCREEN_PORT@ @TERMINAL_PORT@ @GATEWAY_PORT@ @GUIDE_PORT@ @CONFIG@` filled in), and an
  optional `disable.sh`. `install.sh`/`configure.sh` run as root; `verify.sh` runs as the agent user.
- **CLI extras:** `agentbox module list`, `agentbox module check <id>` (the checks only, read-only),
  `agentbox module install --enabled` (all enabled modules in dependency order). `agentbox guide`
  runs `guide/agentbox-guide.sh` when the guide workstream provides it, else prints a stub.
- **Hooks for the guide workstream:** `setup/bootstrap.sh` runs `guide/install.sh` if it exists
  (env: `AGENTBOX_CONFIG`, `AGENTBOX_SRC`, `AGENTBOX_USER`, `AGENTBOX_HOME`); `setup/lib/deploy-app.sh`
  also syncs `guide/` into `paths.app` when it exists. Lima forwards the guide port (7699) to
  `<--ports base> - 1` on the Mac.
- **Agreed with the access workstream** (`docs/ACCESS.md` on its branch):
  - no `setup/modules/access` here (the CLI tolerates its absence when ordering dependencies);
  - ttyd: `-i lo -O -W -c "$(cat /etc/agentbox/ttyd.credential)"`; the terminal module writes
    `/etc/agentbox/ttyd.credential` (`agentbox:<32 random>`, 0600, the agent user's) and disables
    Ubuntu's `ttyd.service`;
  - x11vnc: `-passwdfile /etc/agentbox/vnc.password -localhost`; the display module writes the
    password (8 alphanumerics, 0600, the agent user's);
  - Lima forwards only the portal and the guide; the terminal and screen go through the portal
    (`/term/`, `/screen/`);
  - local `/api` callers send `X-Agentbox-Local-Token: <data>/local-token`: `agentbox api [-X M] [-d JSON]
    <path>` does this, and the module checks, the CLI's busy check and the Lima scripts use it;
  - steps may carry `when: "<key> == <value>"` (or `!=`); the CLI skips steps whose condition is false;
  - `config.ts` exports `accessProjection()` for `access-config.ts`.
- **Bootstrap defaults:** on lima the agent user is the login user (as before) and `access` defaults to
  `ssh-tunnel` (the Lima localhost forwards); on cloud the user is `agentbox` and `access` is
  `tailscale`. `--host`, `--user`, `--access` override.
- **db-tunnel:** tunnels are files `<secrets>/tunnels/<name>.conf` (modes `ssh-ssm`, `ssh`, `ssm`),
  saved with `agentbox secret set`; the command is `agentbox-tunnel start|stop|status|list|check`.
  The old `mongodb_tunnel_*` commands are gone (company-specific).
- **Selftest:** `sshd` (and systemd's socket for it) is an allowed listener on `host: lima` and with
  `access: ssh-tunnel`; anywhere else it fails.
- The portal's unit has `UMask=0077` and an optional `EnvironmentFile=-<secrets>/agentbox-web.env`
  (e.g. `EXPO_ACCESS_TOKEN`).

## Changes (guide workstream)
Details in docs/GUIDE.md.
- **`guide/`:** Fastify server (`server.ts`, `src/`) + React page (`web/`, built to `dist/`), installed
  by `guide/install.sh` (bootstrap's hook) into `<paths.app>/guide` as `agentbox-guide.service`
  (the agent user; not enabled at boot). `agentbox guide` is `guide/agentbox-guide.sh`:
  start + a one-time link, `link`, `stop`, `status`, `--tunnel`, `--port`. Bootstrap ends by running
  it; `host/lima/up.sh` prints the link with the Mac port; `host/lima/guide.sh` prints a new one.
- **Auth:** direct access needs a session from a one-time token (`<data>/guide/tokens/`, SHA-256,
  30 min); loopback Host, own Origin, no cross-site fetches, JSON writes. After access is set up the
  **portal serves the guide at `/setup/`** behind `createAccess` (new path kind `setup` in
  `server/src/access.ts`, proxied with `X-Agentbox-Guide-Proxy` from `<data>/guide/proxy-token`;
  `AccessConfig.ports.guide`, `accessProjection()` includes it). No separate `tailscale serve` /
  `cloudflared` route.
- **Sudo during setup:** the unit grants the agent user `NOPASSWD:ALL` in
  `/etc/sudoers.d/agentbox-guide` while it runs and removes it when it stops (so `agent_sudo: false`
  only takes effect after Finish / `agentbox guide stop`).
- **Terminal:** node-pty 1.1.0, compiled on install (`build-essential`; it ships no Linux prebuilds).
- **The profile step** is a guide step (`guide.profile`, a marker file in `<data>/guide/`), shown
  under "Start here" with the Claude login gate and the setup agent. The setup agent starts only when
  both are green.
- **Fix (access module):** its steps referred to `<paths.app>/setup/modules/access/*.sh`, which
  `deploy-app.sh` never copies (only `server/`, `web/`, `guide/`), so the `verify` check could never
  pass. They now use `<paths.src>/setup/...` (docs/ACCESS.md likewise).

## 10. Bare-minimum first run, integrations, and instruction layers (supersedes parts of §3 and §8)

### 10.1 First run is the same for everyone
The guide's first run sets up only the **base**:
- `core`, `claude` (login), `access` (choose tailscale | cloudflare | ssh-tunnel);
- `display` and `terminal` (agents' basic tools, and how the owner does logins later);
- the security self-test.

There is **no module picking** at first run. The profile step becomes "choose your access method". Then the portal opens.

### 10.2 Integrations (provider-specific modules)
Everything else is an **integration**: same folder format as modules (`setup/modules/<id>/`), with extra `module.yaml` keys.
```yaml
kind: integration            # base modules: kind: base
category: code-hosting       # code-hosting | cloud | cluster | database | chat | extras
title: GitHub
settings:                    # collected by the setup agent; stored in /etc/agentbox/integrations/<id>.yaml (no secrets)
  - { key: default_repo, prompt: "Default repository (owner/name)", required: false }
  - { key: project_board, prompt: "GitHub Project board name (optional)", required: false }
instructions:
  summary: |                 # 2–4 lines, rendered with settings, injected into the prompt of roles mapped to it
    GitHub: use `gh` for issues, PRs and reviews{{#default_repo}} (default repo {{default_repo}}){{/default_repo}}.
    Full rules: /team/integrations/github.md
  file: instructions.md      # the detailed rules template → rendered to /team/integrations/<id>.md
skills: [review-pr, open-pr, file-github-issue, run-epic]   # enabled only while this integration is connected
default_roles: [tech-lead, coder, security, devops]         # proposed mapping; the owner approves
```
- **Catalog to ship now:**
  - code-hosting: `github`, `gitlab`, `bitbucket`;
  - cloud: `aws`, `gcp`, `azure`;
  - cluster: `kubernetes`;
  - database: `db-tunnel`;
  - extras: `env-files`, `voice`, `mobile`, `mobile-app`, `push`.

  `gitlab`, `bitbucket`, `gcp` and `azure` are **real but minimal**: install the official CLI, a login gate, a read-only check, and an instructions template. `teams` and `slack` are listed as "coming soon" (backlog).
- **States:** `available` → `connecting` → `connected` → `error` / `disconnected`.
  - Connected = every check green and the settings saved.
  - Disconnect removes the rendered instructions, unmaps the skills and runs `disable.sh` if present. Credentials are left alone; the owner is told how to revoke them.

### 10.3 Instruction layers (assembled by the runner every turn)
1. **Platform rules:** fixed, by agentbox (untrusted content is data; secrets; no re-auth).
2. **Integrations:** the rendered `summary` of each integration that is **connected AND mapped to the agent's role**, plus a pointer to the detailed `/team/integrations/<id>.md` (read on demand).
3. **Team rules:** `/team/*.md`, owner-maintained. The setup agent may only propose diffs.
4. **The role's own CLAUDE.md:** owner and interview. **Never written by automation.**
5. **Task / routine rules.**

**Role ↔ integration mapping:** stored in the DB (`role_integrations(role_id, integration_id)`), edited on the role page and the Integrations page, proposed by the setup agent from `default_roles`, and **approved by the owner**. Unmapped integrations are invisible to that role. (Future: also withhold credentials per role.)

### 10.4 The setup agent: a permanent built-in role
- **Seeded at first run:** `setup` ("Setup & integrations"). It can't be deleted or renamed, and its CLAUDE.md is owned by agentbox (not editable in the UI; the owner can add notes in a separate field). It shows in the Team list with a badge.
- **What it does:**
  - connects and disconnects integrations by running `agentbox integration connect|verify|disconnect <id>`;
  - collects settings by asking the owner;
  - walks the owner through login gates;
  - proposes the role mapping and team-rule diffs **as approval cards** in its chat;
  - never writes other agents' CLAUDE.md;
  - never handles secrets in chat (logins happen in the terminal or the provider's page);
  - can also re-run base-module repairs (`agentbox module verify|install <base id>`).
- **Privilege:** the only role allowed to install packages. While a `setup` task is running, agentbox grants **temporary** sudo (like the guide: a sudoers drop-in created at turn start and removed at turn end). Other roles' privileges are unchanged by this.
- **Tools** (MCP "setup", only for this role):
  - `list_integrations`, `integration_status(id)` (steps with check results);
  - `connect(id)` / `verify(id)` / `disconnect(id)` (runs the CLI; streams output into the chat);
  - `save_settings(id, values)` (validated against the schema);
  - `propose_mapping(id, roles)` and `propose_team_rule(file, diff)`: these create **approval cards**, so only the owner's click applies them.
- **In the chat:** a **steps card** per integration with live states (○ ● ⏸ ✔ ✖), the same visuals as the guide, plus "your turn" cards with copy buttons, and an **embedded terminal** toggle for logins (the portal's `/term/`).

### 10.5 Portal: the Integrations page
A catalog grouped by category. Each card shows: status, the connected account and settings summary, mapped roles (editable), and **Connect / Reconnect / Disconnect**. Connect opens or creates a task with the setup agent for that integration.

### 10.6 CLI
- `agentbox integration list|status|connect|verify|disconnect|settings <id> [--set k=v]`;
- `agentbox integration render`: re-renders `/team/integrations/*` from the settings.

`agentbox module` keeps working for base modules.

## Changes (integrations workstream)
Details in docs/MODULES.md (format, CLI, the `status --json` shape) and docs/GUIDE.md.
- **Manifests:** every module has `kind: base|integration`. Integration extras beyond § 10.2:
  `available: false` (a catalog entry only: `teams`, `slack`), `account` (a read-only command printing
  the connected account, for the portal's card), `revoke` (printed on disconnect). Settings entries
  have `type` (string, list, boolean, number, enum via `options`), `default`, `pattern`, `example`.
- **Templates:** `{{key}}`, `{{#key}}…{{/key}}` (repeats over a list), `{{^key}}…{{/key}}`, plus
  `<key>_<option>` flags for enums and `has_<key>` for lists; the steps' `instructions` / `copy`
  are rendered too. Renderer: `cli/integrations.mjs` (no dependency).
- **State:** connected = enabled (`modules.<id>: true`, still the server's feature switch) + every
  applicable check green + settings saved and valid. Extra state `unavailable`. The last
  connect / verify / disconnect is kept in `/etc/agentbox/integrations/<id>.state.json` (the `error`
  and `disconnected` states). `connect` saves empty settings when none are required.
- **`/team` examples are gone:** `github.md` (+ `branching.md`), `kubernetes.md`, `db-tunnel.md`,
  `env-files.md` became the integrations' `instructions.md`, rendered to `/team/integrations/<id>.md`.
  The seed skills now read `/team/integrations/github.md` (same Settings row names).
- **`kubernetes` no longer depends on `aws`** (EKS, GKE, AKS or any cluster; a `provider` setting).
- **`agentbox module enable|disable|install <id>` refuses integrations** and names the
  `integration` command; `module list` shows the base; `module install --enabled` still installs every
  enabled module (a repair) and re-renders connected integrations. `agentbox status` lists the base
  and the connected integrations separately (`--json`: `modules` = base, plus `integrations`).
- **Nothing restarts the portal** on connect / disconnect (the setup agent runs inside it): the
  server must notice `modules.<id>` changes itself.
- **Default config:** every integration off (`github` too); `gitlab`, `bitbucket`, `gcp`, `azure` added.
- **Guide:** loads `kind: base` only; the profile step is the access choice (`POST /api/profile
  {"access": …}`); the setup agent's hook also refuses `glab`/`gcloud`/`az` logins and `agentbox
  integration connect|disconnect`.

## Changes (reconcile: portal ↔ integrations CLI)
- **The portal reads the real CLI.** `adaptIntegration` (server/src/integrations.ts) follows
  `integration status --json` exactly (steps with `check`, `gates`, `settings.{schema,values,missing,errors}`,
  `revoke`, `last`; `available: false` → `unavailable`, shown as "coming soon"). The catalog comes from
  `status --json` (with checks; `list --json` has no state). connect / verify / disconnect have no JSON:
  their exit code and streamed output are the result. Settings are saved with
  `settings <id> --values '<json>' --json`, so the CLI's validation (types, patterns, token-like values) applies.
- **Sudo for the CLI's writes:** the CLI re-runs itself through `sudo -n` when not interactive. The
  portal runs connect / verify / disconnect / settings only while the setup agent holds its temporary
  grant (or with `agent_sudo`, or as root); otherwise it refuses with a clear message.
- **`modules.*` live:** config.ts re-reads `modules.*` when config.yaml changes (an mtime check, at
  most once a second, on every feature check, status call and turn). Other keys still need a restart.
  New ids: `gitlab`, `bitbucket`, `gcp`, `azure`, `teams`, `slack`; integrations default off.
- **Connected (portal)** = `modules.<id>` on (fresh) AND the CLI's last state `connected`. Layer 2 is
  the rendered `<id>.summary.md` plus the detailed file only if it exists. Integration skills apply only
  while connected and mapped; a role's directly assigned skill that belongs to an integration it can't
  see is withheld too.
- **Interview:** the tools question and the context come from the catalog (connected first);
  `/team/integrations/github.md` is mentioned only when GitHub is connected.
- **Selftest § 8:** the setup helper's narrow NOPASSWD rule passes; only blanket NOPASSWD warns
  (a running setup turn or the guide is a note).

## Changes (setup workspace)
The setup agent gets its own screen, in the first-run guide's spirit: chat, the owner's terminal and a
checklist the agent writes, on one page (`#/setup/<session>`; `#/setup` opens the latest live session
or a new one). A setup session is a setup task instance.
- **Entry points:** the sidebar (Setup, and the setup role under Team), the Overview's Team card,
  Integrations' Connect / Reconnect / Disconnect, the New-task form ("Start with setup"), and any link to a
  setup instance (`#/agents/<id>` redirects). The role page still holds the owner's notes.
- **Layout:** checklist and chat on the left, terminal on the right; resizable splits (drag or arrow
  keys), each panel expands to the full screen (button; Esc restores, except inside the terminal where
  Esc belongs to the shell); remembered in `localStorage` (`agentbox.setup.layout`). ≤ 900 px: tabs.
  Every panel stays mounted, so the terminal keeps its connection.
- **The checklist** (`server/src/setupPlan.ts`, table `setup_plans`, one per session): setup-only MCP
  tools `set_plan(title, steps[])`, `update_step(id, …)`, `add_steps(steps, after?)`. A step has `id`,
  `title`, `why`, `instructions` (Markdown), `commands[]` (single lines without control characters, so
  "Insert in terminal" can never press Enter), `check` (read-only, no sudo), `human`, or
  `integration` + `integration_step` (checked through `agentbox integration status <id> --json`;
  `{ integration }` alone expands to all of its steps). Steps that come back unchanged keep their progress.
- **The checker:** every ~3 s the current step's check runs as the portal's user (`bash -lc`, a minimal
  environment without the portal's secrets, 10 s timeout with the process group killed, output capped to
  4 KB and redacted). Pass → done, the pointer moves, and the agent gets one queued note in its thread
  (task source `setup`, a `system` message), debounced (4 s) and at most once per step. A failing poll
  stays pending with its last output; the owner's "Check now" that fails shows as failed. Owner
  buttons: Check now, Mark done, Skip, Reopen (`POST /api/setup/plans/:id/steps/:step`, refused with the
  local token). Right after `set_plan`, every check runs once and already-done steps are ticked (no note).
- **The terminal** (`server/src/terminal.ts`): one login shell for the owner in a node-pty inside the
  portal (node-pty is an optional dependency; without it the panel falls back to ttyd at `/term/`, which
  the agent can't read). A headless xterm keeps the rendered screen for `read_terminal(lines=200)`
  (setup role only), whose text is redacted (`server/src/redact.ts`: AWS key ids and secrets, GitHub,
  GitLab and Slack tokens, JWTs, Authorization headers, private keys, URL passwords, one-time codes,
  password=…, long credential-like values after token/secret/password/key). The WebSocket
  `/api/setup/terminal` is behind the portal's auth, needs a browser Origin and refuses the local-token
  header. There is no tool or API that writes to it; only the owner's page does.
- **Events:** `setup.plan` (the plan view) and `setup.check` (a check started / ended), both ephemeral.

## Changes (repos)
Repos are first-class (docs/TRUSTED-AUTONOMY.md §6–7), Conductor-style: one canonical clone per repo,
one git worktree per task. Server: `repos.ts` (store, git, worktrees, maps, layer), `repoGuard.ts`
(PreToolUse), `repoAccounts.ts` (account listings), `repoRoutes.ts`, `setupRequests.ts`.
- **Store:** table `repos` (`name` slug, `url` without credentials, `provider`, `default_branch`,
  `description`, `test_command`, `protected_branches`, `allowed_roles` (role ids; empty = every role),
  `agents_may_merge`, `agents_may_deploy` (both default off), `propose_map_pr`, `status` cloning | ready
  | error | archived, `last_fetch_at`, `error`, `map_status` none | running | ready | error,
  `map_updated_at`) and `repo_worktrees` (one row per task × repo: `path`, `branch`, `status` pending |
  active | kept | removed | discarded | error, `note`). No new config key: paths derive from
  `paths.work` and `paths.data`.
- **Disk:** canonical clone `<work>/repos/<name>` (`git clone --filter=blob:none --no-checkout`,
  never edited: nothing is checked out there); worktrees `<work>/worktrees/<repo>/<task-short-id>`
  on `agentbox/<task-short-id>-<slug>` from `origin/<default>` (`--no-track`, so agents push with
  `git push -u origin HEAD`); archive `<work>/repos/.archive/<name>-<stamp>`; map
  `<data>/repos/<name>/map/` (served by `/api/file` too). Every name is a slug (route words reserved)
  and every path is resolved and confined under its root.
- **URLs:** `https://host/path`, `ssh://[git@]host[:port]/path`, `git@host:path` only; refused: any
  userinfo in https, other ssh users, `file://`, `ext::` and other transports, a leading `-`, `..`,
  spaces and control characters. Access is checked with `git ls-remote --symref`. Credentials come
  from `gh auth setup-git`, the Bitbucket helper's credential helper, or ssh keys.
- **Git:** `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `ssh -o BatchMode=yes`, a timeout per
  operation with the process group killed, one operation at a time per clone; output has userinfo
  stripped and secrets redacted (`redact.ts`) before it's stored, shown or streamed.
- **Fetch and sweep:** `git fetch --prune origin` every 15 min (`AGENTBOX_REPO_FETCH_MS`), on demand,
  and before a worktree is made from a fetch older than 5 min. A daily sweep (`AGENTBOX_REPO_SWEEP_MS`)
  runs `git worktree prune`, closes worktrees of closed or deleted tasks, removes clean untracked
  worktree folders and deletes local `agentbox/*` branches of removed worktrees with nothing unpushed.
- **Worktrees and the runner:** a task is bound to repos by the New-task form (`repos` on
  `POST /api/work`), `delegate_task(repos)` (each helper gets its own) or `use_repo`. Before every
  turn the runner creates missing worktrees (`prepareWorktrees`) and passes them as Claude
  `additionalDirectories`; `cwd` stays the agent's home (its CLAUDE.md) and the room folder
  (`state.md`, `scripts/`, `notes/`) is unchanged. Rework and revived instances reuse theirs (a kept
  one as is; a removed one is re-added from its branch). Tasks working in a repo also get the
  `onboard-repo` skill.
- **Close:** on `agent.retired` each worktree is inspected (`git status --porcelain`, `git rev-list
  HEAD <branch> --not --remotes`): removed when clean and pushed, otherwise **kept** with a note
  ("kept: unpushed work (…)"), shown on the Repos page with the owner's Discard (`--force` remove +
  `branch -D`).
- **Guard (`repoGuard`, next to `rulesGuard`):** the edit tools may not write under `<work>/repos`;
  a shell command that names that folder (or runs with its cwd there) may only use a whitelist of
  read-only commands and git subcommands, no redirects. Per repo, unless allowed: `git push` to a
  protected branch (refspec destinations, `HEAD`/no refspec resolved to the current branch, `--all`
  / `--mirror`), `gh pr merge` into a protected base (base read with `gh pr view`; unknown base is
  refused), `glab mr merge`, and deploy workflows (`deployWorkflowOf`, shared with `rules.ts`). The
  repo is identified by the remote's configured URL, `-R owner/repo`, a PR URL, or the task's bound repo.
- **Layer "Repos"** (between integrations and team rules): for each ready repo the role may use, its
  name, description, default branch, test command, map and rules; cached per role (invalidated on any
  repo change), plus this task's worktree paths. Empty for the setup agent. The platform layer's
  work-area line and the team layer's git text now point at task worktrees.
- **Team tools:** `use_repo(name)` (binds + creates, returns path and branch; allowed roles only; if
  agentbox can't fetch the repo it raises a setup request for that agent and still gives the worktree
  from the last fetch), `repo_map_done(name, description, test_command)` (refuses until every map file
  exists), `delegate_task(…, repos)`.
- **Onboarding:** after a clone (and on Re-map), a task for tech-lead (else a coding role, else any
  allowed role), bound to the repo, with the seed skill `onboard-repo` (copied once into existing
  libraries: `ensureSeedSkill`). It writes a high-level map, `ARCHITECTURE.md` and `FEATURE-MAP.md`, to the map folder (read-only: no installs,
  builds or tests; lower-level detail comes from the repo memory, docs/TREE-MEMORY.md); no PR
  unless `propose_map_pr`. A task that closes without `repo_map_done` leaves `map_status: error`.
  Drift: Re-map, and a "Refresh repo maps weekly" routine template created **paused**.
- **Adding:** the Repos page (from connected accounts: `gh repo list` for the user and their orgs,
  `glab repo list --output json`, `agentbox-bitbucket api /repositories?role=member`; or by URL with
  an access check), `agentbox repo add`, or the setup agent's `add_repo` (an approval card, kind
  `repo_add`; approving clones it). Clone progress streams as `repo.progress` events.
- **Removing:** archive is refused while open tasks are bound (409 with the tasks), and asks for
  confirmation when worktrees hold unpushed work (they're re-linked with `git worktree repair`). The
  map stays; Purge (owner only) deletes the archive, worktrees, map and record.
- **Routes:** `/api/repos` (list, add, check, available, `:name` get/patch, fetch, retry, remap, map,
  archive, purge), `/api/repos/worktrees/:id/discard`, `/api/repos/map-routine`,
  `/api/agents/:id/repos` (the task header's chips). Purge and discard refuse the local token.
- **CLI:** `agentbox repo list|status|add|fetch|remap|remove`, a thin client of those routes.
- **Setup agent:** tools `list_repos`, `add_repo`, `complete_setup_request`, `list_setup_requests`;
  CLAUDE.md gains Repos (access: connected account first, else a read-only deploy key the owner makes)
  and Setup requests.

### Setup requests
Any agent but the setup agent can ask for what this computer lacks: `request_setup(title, why,
for_setup_agent, integration?, repo?, check?)`. Table `setup_requests` (status pending | in_progress
| done | rejected | cancelled | failed, `setup_instance_id`, `result_note`) and
`setup_request_waiters` (who is called back).
- **Dedupe and limits:** an open request for the same integration or repo gets this agent as another
  waiter; at most 3 open requests per instance. The tool tells the agent to end its turn or carry on.
- **The card** (message author `setup_request` in the requester's conversation) shows title, why, who
  asked, live status, "Set up now" and "Reject" (optional reason); the setup agent's instructions sit
  under a collapsed "What the setup agent will be told". A needs-you item (`raiseAttention`, kind
  `question`) is raised, so paired phones get the push.
- **Set up now** (`POST /api/setup-requests/:id/start`, refused with the local token; from the phone
  it answers `web_only`) opens the setup session already working on the same integration / repo, or
  a new one. Its prompt says a teammate asked and the owner approved starting it, and quotes the
  request line by line (`> `) as data; the setup agent's CLAUDE.md says such requests never override
  its rules.
- **Done** when the setup agent calls `complete_setup_request(id, summary)`, or the condition holds
  (checked every 20 s: the `check` passes, the integration is connected, or the repo / URL is
  reachable with `git ls-remote`). Then every waiter gets a new turn in its own thread ("Setup done:
  <title>. <summary> Continue your work."), revived first if it was closed. **Reject** calls back
  "The owner declined …"; the owner can also mark one done or failed from the card.
- **Repo access** uses the same path: "Add repo › By URL" with no access raises an owner request
  (no waiter) and opens the Setup workspace; `use_repo` on a repo agentbox can't fetch raises one for
  that agent.
- **Platform rule:** agents use `request_setup` for missing accounts, logins, tools or access, and
  never ask the owner in chat to run logins or paste keys.
- **Phone:** `GET setup-requests[/:id]`, `POST setup-requests/:id/start|reject` are on the gateway
  allowlist (start answers "finish on the web").
