# agentbox

**A self-hosted team of Claude agents that share one Linux VM.** A tech-lead, coders, a devops
and a security agent (or whatever roles you hire) work side by side on one machine with a browser,
a terminal and your dev tools. You talk to them from a web portal, or from an optional Android app.
They plan, code, review, test and ship through the integrations you connect (GitHub, GitLab or
Bitbucket; AWS, Google Cloud or Azure; Kubernetes…) under rules you write.

> Screenshot: _placeholder (`docs/screenshot.png`, the portal's Overview with a task room open)._

[Features](#features) · [Quickstart](#quickstart) · [Security model](#security-model) ·
[Requirements](#requirements) · [Base and integrations](#base-and-integrations) · [FAQ](#faq) · [Docs](#docs)

## Features

**The shared computer**
- One Ubuntu 24.04 VM, shared by every agent: the VM is the security boundary.
- A virtual display with a shared Chromium that keeps its logins. Agents drive it; you watch it live
  in the portal, or take control.
- A terminal in the portal. One agent at a time drives the screen; the others wait.

**Agents**
- **Agents are roles.** Each has its own job description, memory, skills and chat history.
- **Hire by interview:** answer a few questions and agentbox drafts the role, its tools and rules.
- **One instance per task** (`coder#3`, `security#2`…). Rework goes back to the instance that did
  the work.
- **Delegation:** agents know each other and hand off work; reports come back automatically, with
  depth and fan-out limits.
- **Skills:** shared procedures (`file-github-issue`, `run-epic`, `open-pr`, `review-pr`,
  `fix-vulnerability` are seeded). Agents can propose new ones for your approval.
- **Integrations** you connect from the portal: each brings its CLI, a login you do yourself, a few
  settings (default repo, project board, cloud project, writable namespaces…) and rules rendered
  from them into `/team/integrations/<id>.md`, given only to the roles you map it to.
- **Repos:** add them from a connected GitHub, GitLab or Bitbucket account or by URL. agentbox
  keeps one read-only partial clone of each and gives every task its own git worktree and branch;
  pushes to protected branches and deploys are refused unless you allow them per repo. An
  onboarding task maps each repo (architecture, feature map, verified commands, risk and test
  readiness) for the other agents.
- **Setup requests:** an agent that lacks an account, login, tool or access asks for it; you get a
  card with "Set up now" (the setup agent does it with you) or "Reject", and the agent is called
  back either way.
- **Team rules** in `/team/*.md` that you write and every agent reads.

**Working with them**
- **Task rooms:** a task and everything it starts form one timeline, with a shared folder and
  documents.
- **Groups:** chat rooms with members and a lead; @mentions decide who replies.
- **Live progress:** what each agent is doing right now, "possibly stuck" alerts, and a
  **Needs you** list.
- **Routines:** cron schedules with standing rules (e.g. "never merge to main", "staging deploys
  only"), checked before the command runs. Run history with a page per run.
- **Image attachments, voice input** (browser or phone speech recognition, with an optional LLM
  clean-up), **documents** across agents, an **activity** feed, light and dark themes.
- **Pause all** and **Stop** at any time.

**Android app (optional)**
- Start, delegate and watch work from your phone; push notifications that carry no content by
  default.
- Reachable only over your Tailscale network; QR pairing plus your approval; every request signed
  with a key that never leaves the phone; biometric unlock; screenshots blocked.

## Quickstart

agentbox runs on **any Ubuntu 24.04 VM**. Everything (agents, services, repos) lives in that VM.

### 1. Any cloud VM (AWS, GCP, Azure, Hetzner, bare metal)

1. Create an Ubuntu 24.04 VM (4 vCPU, 8 GiB RAM and 60 GiB of disk are comfortable). **Allow no
   inbound traffic** in its firewall or security group; get your first shell through the
   provider's console (e.g. AWS SSM Session Manager, GCP IAP).
2. As a sudo-capable user, clone into **`/opt/agentbox/src`** (not your home folder) and run the
   bootstrap:

   ```bash
   sudo install -d -m 0755 -o "$USER" -g "$USER" /opt/agentbox/src
   git clone https://github.com/<you>/agentbox.git /opt/agentbox/src
   sudo /opt/agentbox/src/setup/bootstrap.sh
   ```

   Why there: bootstrap creates a separate **`agentbox`** user, and agents and the setup guide run
   as that user. It must be able to read the repo, but on Ubuntu 24.04 every home folder is private
   to its owner (`drwxr-x---`), so a clone in `~/` fails with `can't read …/setup/modules: EACCES`.
   The clone stays yours, so `git pull` and `sudo agentbox update` keep working. Already cloned into
   your home folder? Move it:
   `sudo mv ~/agentbox /opt/agentbox/src && sudo /opt/agentbox/src/setup/bootstrap.sh` (it updates the
   config to the new place). Bootstrap stops with this hint if it can't read the repo.

3. Bootstrap installs the basics, starts the **setup guide** on `127.0.0.1:7699` and prints a
   one-time link plus the port-forward command for your provider (`agentbox guide --tunnel` prints
   them again, with a new link). Forward the port, open the link and follow it. The guide has a
   terminal on the left and a roadmap on the right. You log in to Claude and choose how you'll
   reach agentbox (Tailscale, Cloudflare or an SSH tunnel); Claude then sets up the **base** (core,
   access, the shared screen and the terminal) and stops at "your turn" cards for logins. A step
   turns green only when its check passes. The security self-test closes the first run.
4. Once the access step is done, the portal is at your private HTTPS address
   (`https://<node>.<tailnet>.ts.net` or `https://agentbox.<your-domain>`), behind a login.
5. **Then connect what your team uses**, from the portal: **Helper** (or **Integrations**) →
   GitHub, GitLab or Bitbucket; AWS, Google Cloud or Azure; Kubernetes; database tunnels; the phone
   app… The helper installs each one, asks for its settings and walks you through its login.
   From a shell: `agentbox integration list`, `agentbox integration connect <id>`.

### 2. A local Lima VM on macOS

```bash
brew install lima
git clone https://github.com/<you>/agentbox.git && cd agentbox
./scripts/up.sh          # creates the Lima VM, mounts this repo read-only, provisions it
```

Then open the one-time guide link it prints (`host/lima/guide.sh` prints a new one) and follow it as
above. Day to day:
`./scripts/start.sh`, `./scripts/stop.sh` (refuses while agents are working, unless `--force`) and
`./scripts/deploy.sh` (after code changes). Set `LIMA_HOME` to keep VMs somewhere other than
`~/.lima`, and `VM_NAME` to run a second instance side by side.

## Security model

Agents have **full control of the VM** (shell, sudo, Docker, the browser) and act with **whatever
credentials you give them**. The design keeps the outside world away from the VM, and keeps the
agents' reach to what you hand them.

- **Zero inbound ports.** Every service binds to `127.0.0.1`. You reach the portal through
  **Tailscale** (`tailscale serve`, tailnet only, Funnel refused) or **Cloudflare Tunnel +
  Cloudflare Access** (an outbound-only tunnel with SSO in front). An SSH tunnel works as a
  fallback.
- **A login for everything that isn't localhost.** The portal checks the Tailscale identity, or
  verifies the Cloudflare Access JWT, against the owner, then issues a short-lived session cookie.
  The terminal and screen are served only through the portal, behind the same login. Host and
  Origin checks and JSON-only writes protect against CSRF and DNS rebinding.
- **Secrets live in `/secrets`** (0700/0600), never in the repo; the portal and the phone can't
  read them. The guide never asks you to paste a secret into a web page.
- **The phone gateway** accepts only signed requests from paired, approved devices, over your
  tailnet, and only an allowlist of routes.
- **`agentbox selftest`** fails on public listeners, an unauthenticated portal, Funnel, loose
  secret permissions and more.

> **Prompt injection is real.** Agents read issues, PRs, web pages and documents written by other
> people, and crafted text can steer them. Give them **least privilege**: a GitHub account or token
> limited to the repos they need, a scoped cloud role (an instance role rather than long-lived
> admin keys), staging rather than production, and routine rules that forbid merging or deploying
> without you. See [SECURITY.md](SECURITY.md).

## Requirements

- A **Claude subscription** (Pro or Max) for Claude Code.
- An Ubuntu 24.04 VM (in the cloud, or Lima on macOS) with outbound internet access.
- One way in: a free **Tailscale** account (recommended, and needed for the phone app), or a domain
  on **Cloudflare**.
- Only for the integrations you connect: a GitHub, GitLab or Bitbucket account; an AWS, Google
  Cloud or Azure account; a Kubernetes cluster; an Expo account and a Firebase project (phone app
  and push); a Z.ai key (voice clean-up).

## Base and integrations

The first run is the same for everyone: the **base**. Everything else is an **integration** you
connect later from the portal (or `agentbox integration connect <id>`). An integration that isn't
connected installs nothing, asks for nothing, and agents don't hear about it.

**Base** (set up by the guide):

| Module | What it adds | Your part |
|---|---|---|
| `core` | the server, portal, database, systemd units | none |
| `claude` | Claude Code CLI and Agent SDK | `claude` → `/login` |
| `access` | Tailscale, Cloudflare or SSH-tunnel access, plus the portal login | choose one; sign in to Tailscale or Cloudflare |
| `display` | virtual display, shared Chromium, screen sharing | none |
| `terminal` | a terminal in the portal (also where you do the integrations' logins) | none |

**Integrations** (connected from the portal):

| Category | Integration | What it adds | Your part |
|---|---|---|---|
| code hosting | `github` | git, `gh`, the GitHub skills, rules for issues, boards and branches | `gh auth login` |
| | `gitlab` | git, `glab` (gitlab.com or self-managed) | `glab auth login` |
| | `bitbucket` | git, the Bitbucket Cloud REST API through `agentbox-bitbucket` | save an API or access token |
| cloud | `aws` | AWS CLI and the SSM plugin | an instance role, or `aws configure sso` |
| | `gcp` | the gcloud CLI (and the GKE auth plugin) | a service account, or `gcloud auth login` |
| | `azure` | the Azure CLI | a managed identity, or `az login` |
| cluster | `kubernetes` | `kubectl` and rules for which namespaces agents may change | point kubectl at the cluster |
| database | `db-tunnel` | SSH / SSM tunnels to private databases | the tunnel config and key |
| extras | `env-files` | per-repo `.env` files in `/secrets` | `agentbox secret set …` |
| | `voice` | LLM clean-up of dictated text | `agentbox secret set zai.env` |
| | `mobile` | the phone gateway and Devices page (needs Tailscale) | apply the tailnet policy |
| | `mobile-app` | build the Android app with EAS | `eas login` |
| | `push` | push notifications (Firebase) | create a Firebase project |
| chat | `teams`, `slack` | coming soon | |

How they're built, and how to add one: [docs/MODULES.md](docs/MODULES.md).

**Repos** are added on the portal's Repos page or with `agentbox repo add <url>` (also `repo list`,
`status`, `fetch`, `remap`, `remove`). Clones live in `/work/repos/<name>`, task worktrees in
`/work/worktrees/<repo>/<task>`, and each repo's map in agentbox's data folder.

## FAQ

**Is this an official Anthropic product?** No. It's a self-hosted project built on Claude Code and
the Claude Agent SDK.

**Can I run it without a cloud account?** Yes, on a Lima VM on your Mac, or on any Ubuntu 24.04
machine.

**Does it need open ports?** No. Tailscale and Cloudflare Tunnel are both outbound-only, so your
firewall can deny all inbound traffic.

**Can several people use it?** It's built for one owner. Everyone who gets in acts through the same
agents and credentials.

**Is there an iPhone app?** Not yet: Android only.

**Where do my team's conventions go?** Provider-specific ones are integration **settings** (e.g.
GitHub's default repo, board, sprint field and labels: `agentbox integration settings github`),
rendered into `/team/integrations/<id>.md`. Everything else goes in your own `/team/*.md` files.
Team-specific words for voice recognition go in `/team/glossary.txt`, one per line.

**How do I update?** `agentbox update` pulls, builds and restarts; it waits for busy agents unless
you pass `--force`.

## Docs

| | |
|---|---|
| [docs/SETUP-PLAN.md](docs/SETUP-PLAN.md) | The setup design: modules, access modes, the guide |
| [docs/GUIDE.md](docs/GUIDE.md) | The setup guide: opening it, the roadmap, the setup agent, its security |
| [docs/V2-ARCHITECTURE.md](docs/V2-ARCHITECTURE.md) | Hosts, config, modules, CLI, access and auth, self-test |
| [docs/MODULES.md](docs/MODULES.md) | Base modules and integrations: the format, and how to add a provider |
| [docs/PLAN.md](docs/PLAN.md) | The original architecture |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | The portal's design |
| [docs/CONTRACTS-v2.md](docs/CONTRACTS-v2.md) | API contracts: progress, voice, push, the app, routine runs |
| [docs/MOBILE-PROTOCOL.md](docs/MOBILE-PROTOCOL.md), [docs/MOBILE-SETUP.md](docs/MOBILE-SETUP.md) | The phone app's security design and setup |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What's next |
| [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [LICENSE.md](LICENSE.md) | Security policy, contributing, license |
