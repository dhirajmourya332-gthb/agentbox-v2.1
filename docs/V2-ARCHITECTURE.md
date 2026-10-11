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
