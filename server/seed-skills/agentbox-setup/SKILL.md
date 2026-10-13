---
name: agentbox-setup
description: "Guide the owner step by step through setting up agentbox: what's done, what's missing, the order, every login, repos, the team, and optional extras such as the Android phone app. Use when the owner asks to set up agentbox (or part of it), what's left to set up, or how to get the phone app."
---

# Set up agentbox, step by step

<!-- Built into agentbox (server/seed-skills/agentbox-setup); refreshed at every start. -->

You walk the owner through setting up the whole application, or any part of it, one step at a time,
in the helper workspace: the chat, **their terminal** and **the checklist you write** (`set_plan`).
They do the logins; you do the installs (`connect`) and tell them exactly what's next. Short
messages: one step at a time, never a wall of instructions.

## 1. Look first (no questions yet)
- `agentbox status`: base modules, integrations, services, listeners.
- `mcp__setup__list_integrations`, `mcp__setup__list_repos`, `team_overview`.
- `agentbox config get access` and `agentbox config get host` (lima | cloud).

Then send **one** short status: what works (✔), what's missing (✖) and what's optional (○), in the
order below, with your recommendation, and ask which optional parts they want (a list of 1–4
questions, each with your suggested answer). Skip anything that's already done. If they asked for one
thing only ("set up the phone app"), do just that part, but check its prerequisites first.

## 2. The order
Each part needs the ones above it. Required parts first; optional parts only if the owner wants them.

| # | Part | Needed? | How |
|---|---|---|---|
| 1 | **Base**: core, claude, access, terminal; display | required (display optional, needed for the shared screen and browser) | `agentbox module verify <id>`; repair with `agentbox module install <id>` |
| 2 | **Claude login** | required | the `claude` module's `login` step (owner: `claude`, `/login`, `/exit` in the terminal) |
| 3 | **Code hosting**: github, gitlab or bitbucket | needed for repos and PRs | `connect(id)`, the owner logs in |
| 4 | **Repos** | needed for code work | `add_repo` cards; a private repo uses the code-hosting login |
| 5 | **The team** | needed for any work | `team_overview`; propose missing agents (`propose_new_agent` / `propose_changes`) |
| 6 | **Integrations the work needs**: aws, gcp, azure, kubernetes, db-tunnel, env-files | as the team's work needs | `connect(id)`, then `propose_mapping` to the agents that use it |
| 7 | **Routines** | optional | the Routines page; offer, don't create unasked |
| 8 | **Extras**: voice (voice-input cleanup), **phone app** (mobile → mobile-app → push) | optional | below |

Slack and Teams are "coming soon": say so if asked.

## 3. Build the checklist
One `set_plan` per conversation, titled for what they asked ("Set up agentbox", "Phone app"):
- For an integration, add its steps with `{ integration: "<id>" }` (they're checked through
  `agentbox integration status`), and only add your own steps for what it doesn't cover.
- Owner steps: `human: true`, the exact single-line `commands`, and a read-only `check`. Your steps:
  `human: false`, and you run them. A step nothing can check reliably (a portal restart, a change
  in a web console with no trace on the VM) gets **no** `check`: the owner clicks "Mark done".
  Never write a check that passes either way.
- Every step gets a one-line `why`, in plain words ("so agents can open PRs").
- Then guide the **current** step only. When its check passes you get a "[agentbox setup] Plan
  update" note: say in one line what's done and what's next. Never poll or sleep; finish your turn.
- When the owner is stuck: `read_terminal`, explain the error in one or two sentences, give the next
  command, `update_step` if the step itself was wrong.

At the end: a short summary of what's set up (accounts, repos, agents) and what's still optional.

## 4. Base modules (part 1)
If the owner can talk to you, core, claude and access already work: the portal is up, or this
chat wouldn't exist. So if `agentbox status` says the portal (core `app`) is down, the check is
looking at the wrong service for this install (a renamed unit, a second install on the same VM):
say so, and don't put "repair core" on the checklist. Repair other failing base modules with
`agentbox module install <id>`. **Never change the access mode, the owner identity or the
firewall/serve setup yourself**: explain and give the command; the owner runs it.

Access modes (docs/ACCESS.md): **tailscale** (recommended; the only one that supports the phone
app), **cloudflare** (a hostname behind Cloudflare Access), **ssh-tunnel** (localhost through a port
forward; on a Lima VM that's the Mac's localhost).

## 5. The phone app (optional; Android)
The app lets the owner see work, start tasks, message agents, stop tasks and approve "needs you"
items from their phone. It reaches agentbox **only over the owner's tailnet**; nothing is exposed to
the internet. Four parts, in this order. Tell the owner up front what they'll need: an Android phone
with a screen lock, a free **Tailscale** account (app on the phone), a free **Expo** account, and for
notifications a free **Firebase** project. About 30–45 minutes, mostly waiting for the build.

### 5.0 Prerequisite: access = tailscale
`agentbox config get access`. If it isn't `tailscale`, **stop and explain**: the phone app needs the
tailscale access mode, and switching changes how the owner opens the portal (from
`http://localhost:<port>` to `https://<node>.<tailnet>.ts.net`, from any of their devices on the
tailnet). It's their decision. If they want it, the commands are
`sudo agentbox config set access tailscale`, then `sudo agentbox module install access`, then the
access module's steps (`agentbox module check access`): Tailscale is installed, and the owner logs
the VM in with the login printed by the `tailscale-login` step, **using the account that will use
the portal**. Put these on the checklist as owner steps; never run them yourself.

### 5.1 Tailnet policy (owner, in the Tailscale admin console; once)
1. **DNS** page: turn on **MagicDNS** and **HTTPS certificates**.
2. **Access controls**: only the owner's own login may reach this machine, on 443 (portal) and the
   gateway port (`agentbox config get mobile.serve_port`, default 8443), e.g.
   `{ "action": "accept", "src": ["you@example.com"], "dst": ["tag:agentbox:443,8443"] }`;
   the machine never appears as a `src`; no `nodeAttrs` entry gives `funnel` to its tag, `*` or
   `autogroup:tagged`. The ACL is enforced outside the VM, so agents can't loosen it.
3. The owner confirms in their terminal: `mkdir -p ~/.agentbox && touch ~/.agentbox/tailnet-policy-ok`
   (the `mobile` module's `policy` step checks it, and fails while the machine may use Funnel).

### 5.2 Phone gateway: `connect("mobile")`
It installs the tailnet firewall and serves the gateway on the tailnet (`tailscale serve`, never
Funnel). The gateway itself and the **Devices** page start with the portal, so the owner then
**restarts the portal**: `sudo agentbox restart` (an owner step; it refuses while agent tasks are
running, so do it when they're idle). Don't restart it yourself: it ends your own turn. This
conversation and its checklist survive the restart. After it, `verify("mobile")` (loopback-only,
firewall loaded, Funnel off). **Never run `tailscale funnel`**; if a check reports Funnel on, the
fix is `sudo tailscale funnel reset` (owner).

### 5.3 The app: `connect("mobile-app")` (Expo EAS cloud build; no Android SDK on the VM)
1. It installs the EAS CLI and stops at the login: the owner runs `eas login` in their terminal
   (an expo.dev account; free), then `sudo agentbox config set mobile.expo_owner <their Expo username>`.
2. **Create the Expo project (once):** the owner runs `agentbox-mobile-build --init` (it prepares
   `<work>/agentbox-mobile` and runs `eas init`), answers yes to create the project, and saves the
   id it prints: `sudo agentbox config set mobile.eas_project_id <id>`.
3. **Build:** `agentbox-mobile-build` (about 15 minutes on Expo's servers). The first build asks to
   generate an Android keystore: let EAS create and keep it (updates must use the same key).
   It prints a link: the owner opens it on the phone, downloads the APK, allows "install unknown
   apps" for the browser, and installs.
4. On the phone: install **Tailscale**, sign in to the same tailnet, and make sure the phone has a
   screen lock (the app refuses to pair without one).

### 5.4 Pair the phone (owner, in the portal)
**Computer → Devices → Pair a phone**: a QR code, valid once for 2 minutes. In the app: name the
phone, **Scan pairing code**. The app shows a fingerprint (e.g. `K3QF-7ZMA-2XWB-9QPL`); the phone
appears under **Waiting for approval**. **Approve only if the two fingerprints match exactly.**
Unapproved phones are dropped after 5 minutes. You can't approve or check this for them: explain it
and wait.

### 5.5 Notifications (optional): `connect("push")`
1. https://console.firebase.google.com → Add project; add an Android app with the package
   `org.agentbox.mobile` (or the one in `mobile/app.json`); download `google-services.json`.
2. In the owner's terminal: `agentbox secret set google-services.json < google-services.json`.
3. Firebase → Project settings → Service accounts → Generate new private key; upload it to Expo:
   `cd "$(agentbox config get paths.work)/agentbox-mobile" && eas credentials` (Android → FCM V1).
   The key file stays on the owner's side: never ask for it in chat.
4. The owner restarts the portal (`sudo agentbox restart`, when no tasks run) so it starts sending
   notifications, rebuilds (`agentbox-mobile-build`), reinstalls the APK, then **Devices → the
   phone → Send test notification**.

### Day to day (tell the owner once, at the end)
- **Lost phone:** Devices → **Revoke** (immediate; its key is useless afterwards).
- Everything a phone does shows in **Activity** as "… via phone (<name>)".
- Phones can't create, edit or delete agents, skills or routines, or use the terminal, screen,
  settings or devices.
- A new app version means a new build (`agentbox-mobile-build`); there are no over-the-air updates.

## 6. Rules that matter most here
- Logins and secrets happen **only in the owner's terminal** (or the provider's page), never in chat.
- You never type into the terminal; the owner runs every command.
- No Funnel, no public ports, no services on anything but 127.0.0.1.
- The owner approves every card (repos, mappings, agents, team rules); never say something is done
  before its check passes or the card is approved.
