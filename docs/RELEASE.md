# agentbox: release notes

| | |
|---|---|
| **Release** | 2026-10-09 |
| **Server and portal** | `main` @ `4714f08` (77 commits since 2026-10-07), deployed to the agentbox VM |
| **Android app** | v1.3.0 (versionCode 6), built with EAS (internal distribution APK) |
| **Agents** | tech-lead, coder, devops, security, plus one instance per task |

agentbox is a self-hosted team of Claude agents (tech-lead, coder, devops, security…) that share one
Linux computer (a Lima VM) with a browser, terminal and dev tools. You talk to them from a local web
portal on the Mac or an Android app. They plan, code, review, test and deploy with GitHub, AWS,
Kubernetes and Microsoft Teams, under rules you set.

---

## 1. The shared computer
- **One Lima VM** (Ubuntu 24.04, 4 CPU, 6 GiB RAM + 4 GiB swap, 60 GiB disk) on the external drive,
  shared by all agents.
- **A virtual display** (Xvfb) with a window manager and a **shared Chromium** that has persistent
  logins (GitHub, Microsoft Teams…). The agents drive it through Playwright.
- **Built in:** `claude` (Claude Code), `gh`, the `aws` CLI, `kubectl`, Docker, Node, ffmpeg, Tailscale.
- **Watching and taking over:**
  - **Screen:** watch the VM's display live in the portal (noVNC), or **take control** of it.
  - **Terminal:** a shell in the VM, in the portal (ttyd).
  - **Screen lock:** only one agent drives the browser at a time; the others wait. Released after 10
    minutes idle.
- **Isolation:** the Mac's home folder is not shared. This repo is mounted read-only.
- **Start and stop:** `scripts/start.sh` (checks the VM, recovers a broken state, waits for health),
  `scripts/stop.sh` (refuses while agents are working, unless `--force`), and `scripts/deploy.sh`
  (refuses while agents are working).

## 2. Agents
- **Agents are roles.** Each has its own **job description** (CLAUDE.md), **memory**, **skills** and
  chat history, isolated from the others.
- **Interview-based creation:** answer a few questions and agentbox drafts the agent's role, scope,
  tools and rules.
- **One instance per task:** every task runs on its own copy of an agent (`coder#3`, `security#2`…),
  with up to 5 per agent per starter.
  - Rework goes back to **the instance that did the work**, automatically matched by issue or PR
    number, and it is reopened if it was closed.
  - Instances are closed only when their PR is merged or closed.
- **Team awareness and delegation:** agents know each other and hand off work (`delegate_task`,
  `send_message`).
  - Reports come back automatically.
  - Depth and fan-out limits; no handing work back to whoever gave it.
  - A **tech-lead on demand**: any task or routine can bring in one tech-lead as its lead.
- **Instructions reload on every turn:** a changed job description applies from each agent's next
  turn, including in long-running conversations (verified).
- **Skills:** shared procedures agents follow. Seeded skills: `file-github-issue`, `run-epic`,
  `open-pr`, `review-pr`, `fix-vulnerability`. Agents can propose new skills for your approval.
- **Model and usage:** runs on your Claude subscription. A usage chip shows the 5-hour and weekly
  limits; routines skip runs while rate-limited.

## 3. Working with agents
- **New task:** pick an agent, describe the work, optionally attach images or dictate by voice.
- **Task rooms:**
  - Every task and everything it starts (coders, devops, the lead…) is one **room**: a single
    timeline across all of its agents.
  - A filter shows one agent's messages (collapsible).
  - A members panel, a **Documents** tab, and a **shared folder** (`/work/rooms/…`) with `state.md`,
    `scripts/` and `notes/`, so agents reuse what earlier steps learned.
  - Mark a room **Done** (closes everything in it). Finished rooms stay listed for 24 h unless kept.
- **Groups:**
  - Chat rooms with members and a lead that you choose.
  - **@mentions** decide who replies; agents can stay silent when they have nothing to add.
  - A safety pause after 12 agent turns in a row; read tracking.
- **Live progress:**
  - A status line per working agent, saying what it's doing right now (e.g. "Waiting on CI for PR
    #4984 · 17 min") and how long, expandable to its step log.
  - **"Possibly stuck"** after 10 minutes of no progress, with **Stop** and **Send a note**.
  - Rule-based summaries for long turns (e.g. CI check results).
  - Replies stream into the timeline.
- **Needs you:**
  - Agents' replies to you, failures and stalls are collected on the Overview page, with
    **mark seen**.
  - Coloured dots on rooms and groups in the sidebar.
- **Stop and pause:** Esc or Stop ends the current turn. **Pause all** stops everything and persists
  across restarts.
- **Image attachments:** paste (⌘V), drag and drop, or pick screenshots into any message or new task.
  Agents open them to look; you see thumbnails.
- **Voice input (free):**
  - The mic in every message box.
  - **Mac:** Chrome's speech recognition. **Android:** the phone's own recognizer, **on-device when
    possible**.
  - Then a **GLM cleanup** step (your Z.ai Coding Plan, `glm-5.3-flash`): removes fillers, fixes
    jargon, applies self-corrections ("4957, no, 4958" becomes `#4958`), and writes issue numbers as
    `#1234`.
  - You review before sending, with a "use raw" option. Languages: English (India), English (US),
    Hindi.
- **Documents:** everything agents write, across all agents, newest first, with search and filters.
  Also per room and group. Click any file path in a chat to open it in the reader.
- **Activity:** a live feed and graph of who did what, including actions taken "via phone".
- **Light and dark themes,** or follow the system.

## 4. Routines (scheduled work)
- **Cron schedules** with timezones and a live preview of the next runs. **Run now**, enable and
  disable.
- **Each routine has its own agent instance,** kept across runs. Delegated work (e.g. tech-lead
  merging) joins the routine's room.
- **Context between runs:**
  - **Continue** (default): the conversation carries over, so agents don't re-explore. It is
    **compacted** after 5 runs, 24 hours or 100k tokens, whichever comes first, with instructions on
    what to keep.
  - **Fresh** starts every run from scratch.
  - **Compact now** and **Start fresh** buttons; context size per agent.
- **Overlap protection:** a run is skipped while the previous cycle (including the lead's work) is
  still going.
- **Routine rules,** standing orders for everyone in the routine:
  - instructions for everyone and per role;
  - switches for **merge to main** (never / safe only / allowed), **deploy** (none / staging /
    production), **GitHub issues**, **Teams posts** and **helpers at once**;
  - merges into `main`, pushes to `main`, deploy workflows and issue creation are **checked before the
    command runs**.
- **Run tracking:**
  - **Running now** (live, also in the sidebar).
  - **Run history**, the archive: outcome, duration and a one-line summary, filterable.
  - **A page per run** showing just that run's conversation.
- **Live routine: "Dependabot security PR review"** (security + tech-lead, daily 10:00 IST):
  - reviews up to 50 Dependabot PRs per run, alert-linked ones first, by severity;
  - safe PRs are squash-merged by tech-lead;
  - doubtful ones get you as reviewer, plus an analysis comment;
  - never deploys.

## 5. Engineering workflow (team rules in `/team`)
- **GitHub issues:** filed by the team's guidelines, assigned to you, on the **Brandsek - Scrum** board,
  in the current sprint.
- **Branching:**
  - Big work becomes an **epic** (`epic/<n>-<slug>`) with sub-issues, each in its **own worktree**,
    merged into the epic.
  - **Epic → `main` only with your approval.**
  - Small work uses `fix/`, `feature/`, `hotfix/`… branches.
  - After a merge, branches are deleted and worktrees cleaned up.
- **Reviews:**
  - tech-lead reviews every PR.
  - It merges small, green, non-critical PRs itself.
  - **Big or critical PRs into `main`** (auth, payments, infra, schema, client-facing APIs) wait for
    you.
  - Merges into **epic branches** don't need you; critical ones are flagged in the epic → `main` PR.
- **Security fixes:** security fixes vulnerabilities with a breaking-changes verdict (with evidence)
  and a merge confidence. It never dismisses alerts.
- **Deployments:** devops deploys only through the existing GitHub workflows. Services without a
  workflow need your explicit OK for the method and steps.
- **CI waits:** waits are capped at 10 minutes, then agents report what passed, failed and is still
  pending.
- **Kubernetes:** `kubectl` on the production EKS cluster (context `brandsek-prod`):
  - read-only commands freely;
  - **every change needs your approval**, with the command, impact, dry-run and rollback;
  - never print Secrets.
- **Database tunnel:**
  - `mongodb_tunnel_start` / `_status` / `_stop` reach the shared MongoDB, Redis and RabbitMQ through
    AWS SSM.
  - The shared DB is treated as **live data**: read-only unless you approve a write.
  - Real `.env` files are in `/secrets`, symlinked into worktrees and never printed.
- **The rest:** never re-authenticate CLIs; anything unclear goes to you.

## 6. Android app (v1.3.0)
- **Screens:**
  - **Overview:** Needs you, In progress (live, with "possibly stuck"), Routines running, and Recently
    finished.
  - **Rooms and groups:**
    - a live timeline that **stays where you are** when you scroll up, with a "New messages ↓" button;
    - a **Members** sheet (who's working or idle) with a filter;
    - a **Documents** tab with a reader.
  - **New task;** **Routines:** Active | History | Schedules, with read-only run screens;
    **Settings;** **Pause all / Resume**.
- **Message bar:** a clean, rounded bar with **+** (photos), auto-growing text, and one button that is
  **mic** when empty and **send** when there's text. Voice records inline.
- **Push notifications** (Firebase / Expo):
  - "Something needs you" by default;
  - **optional details** (e.g. "tech-lead#1 replied: MSP API keys"), toggled on the portal's Devices
    page;
  - **Send test notification** from the portal.
- **Security:**
  - Reachable only over your **Tailscale** network.
  - Pairing by **one-time QR code** plus **your approval** of the device fingerprint in the portal.
  - One private key per install, signing every request.
  - Fingerprint or PIN unlock; auto-lock after 2 minutes in the background.
  - **Screenshots blocked;** no backups; HTTPS only; no over-the-air updates.
  - Minimal permissions: internet, camera (QR), microphone, notifications, fingerprint.

## 7. Security model
- **Nothing is exposed to the internet:**
  - The portal, screen and terminal are bound to localhost; the Mac reaches them through Lima.
  - The phone **gateway** is reachable only on your tailnet, via `tailscale serve`.
  - **Funnel isn't allowed by your tailnet policy:** verified that even root in the VM can't enable it.
- **Tailnet policy:** only your devices can reach the VM, and only on port 443. The VM can't reach your
  devices. It's enforced by Tailscale, outside the VM.
- **Firewall in the VM:** drops all tailnet traffic except Tailscale's own serve path, with a 60-second
  watchdog. Tailscale won't start without it.
- **Gateway:**
  - Ed25519-signed requests, a ±60 s window, and no replay.
  - Identical **empty 404s** for anything unauthenticated.
  - A route **allowlist**: phones can't edit agents, rules, skills, devices, the terminal or the screen.
  - A per-device audit trail.
- **The portal API** accepts only requests from your own machine (Host and Origin checks; JSON-only
  writes), so web pages can't drive it (CSRF and DNS-rebinding protection).
- **Secrets:** `/secrets` (0700/0600); the portal and phone can't read it, symlinks included. The
  voice key and tunnel config live there.
- **Reviews done:** two independent reviews of the mobile work, plus a **full audit of the live
  system** (`docs/SECURITY-AUDIT.md`): network, gateway, secrets, agent risk and supply chain.
  - Its open findings and the remediation plan (Phase 0, 1, 2) are listed there.
  - Most urgent: the VM terminal's origin check, least-privilege AWS and GitHub credentials for
    agents, and encrypting the external drive.

## 8. Performance and reliability
- **Room and chat loads are capped:** step logs for running and recent tasks only, 4 KB per step
  field, and an index on tasks by thread. The largest room loads in **about 0.06 s** (it took 52 s).
- **Health checks are cached,** with no per-poll process spawning.
- **4 GiB swap** in the VM.
- **Recovery after sleep, network loss or reboot:** Tailscale and the app reconnect by themselves;
  after a Mac reboot, run `scripts/start.sh`.

## 9. Documentation
| File | Contents |
|---|---|
| `docs/PLAN.md` | Architecture and milestones |
| `docs/UI-DESIGN.md` | Portal design |
| `docs/BACKLOG.md` | Backlog: done, planned, parked |
| `docs/CONTRACTS-v2.md` | API contracts for progress, needs-you, voice, push, the app and routine runs |
| `docs/MOBILE-PROTOCOL.md` | Mobile security design, protocol and implementation notes |
| `docs/MOBILE-SETUP.md` | Tailscale and app setup, Firebase, and testing |
| `docs/SECURITY-AUDIT.md` | Security audit and decisions |
| `mobile/README.md` | Building and installing the app |

## 10. Known limitations and next up
- **Security Phase 0 isn't applied yet:** the terminal and screen origin checks, file-viewer
  narrowing, cross-site GET blocking and DB file permissions. Plus Phase 1 owner actions (AWS, GitHub,
  drive encryption…).
- **Agents' access is broad:** your AWS admin identity, GitHub org admin, production secrets and EKS
  **cluster-admin** (an accepted risk), with instruction-level guardrails.
- **The backlog:** Microsoft Teams integration (15) and one-way Teams updates (16). Parked: an
  approval gate, per-agent tool blocking, and a Teams listener.
