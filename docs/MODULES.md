# Modules: the base and integrations

Every capability is a folder `setup/modules/<id>/` with a manifest (`module.yaml`) and a few
idempotent scripts. There are two kinds (docs/V2-ARCHITECTURE.md § 10):

| Kind | Which | Set up by | Managed with |
|---|---|---|---|
| **base** (`kind: base`) | `core`, `claude`, `access`, `display`, `terminal` | the setup guide's first run, the same for everyone | `agentbox module …` |
| **integration** (`kind: integration`) | everything else: `github`, `gitlab`, `bitbucket`, `aws`, `gcp`, `azure`, `kubernetes`, `db-tunnel`, `env-files`, `voice`, `mobile`, `mobile-app`, `push` (and `teams`, `slack`: coming soon) | the portal's setup agent, after the first run | `agentbox integration …` |

The same manifests drive the guide's roadmap (base only), the portal's Integrations page and setup
agent, and `agentbox status`. An integration that isn't connected installs nothing, asks for
nothing, its features are off (its routes return 404, its units and timers don't run), and agents
don't hear about it.

## Layout

```
setup/modules/<id>/
  module.yaml       the manifest (required)
  install.sh        install packages and files (optional; root)
  configure.sh      write config from /etc/agentbox/config.yaml and the settings (optional; root)
  verify.sh         a deeper end-to-end check (optional; the agent user)
  disable.sh        undo what configure.sh set up, on disable / disconnect (optional; root)
  units/            systemd units the module installs (optional)
  bin/              helpers it installs into /usr/local/bin (optional)
  instructions.md   integrations: the detailed rules template (optional)
```

## `module.yaml`: every module

| Field | Meaning |
|---|---|
| `id` | The folder name; also the key under `modules:` in the config. |
| `kind` | `base` or `integration`. |
| `title`, `description` | Shown in the guide, the portal and `agentbox status`. |
| `optional` | `false` for `core`, `claude` and `access`. |
| `depends` | Module ids that must be set up first. |
| `units` | The systemd units to enable and start (every file under `units/` is installed, with `@USER@`, `@HOME@`, `@APP@`, `@DATA@`, `@SECRETS@`, `@SRC@`, `@CONFIG@` and the `@…_PORT@`s filled in). |
| `steps` | The roadmap, in order (below). |

Each step:

| Field | Meaning |
|---|---|
| `id`, `title` | Identify and name the step. |
| `run` | A script in the module folder, run by the setup agent (as root through sudo). |
| `human: true` | A "your turn" gate: the page shows `instructions` and waits. |
| `instructions` | Markdown for the human: what to type, where to sign in. Integrations: a template (below). |
| `copy` | A command shown with a copy button. Integrations: a template. |
| `check` | A read-only shell command. Exit 0 means the step is done. |
| `when` | `"<config key> == <value>"` (or `!=`): the step applies only then (e.g. `access == cloudflare`). |

## `module.yaml`: integrations

```yaml
id: gcp
kind: integration
category: cloud              # code-hosting | cloud | cluster | database | chat | extras
title: Google Cloud
description: The gcloud CLI from Google's official apt repository
depends: [core]
available: true              # false: a catalog entry only ("coming soon"); can't be connected
settings:                    # asked by the setup agent; saved in /etc/agentbox/integrations/<id>.yaml
  - { key: project, prompt: "Google Cloud project ID", required: true, pattern: '^[a-z][a-z0-9-]{4,28}[a-z0-9]$', example: acme-prod-123 }
  - { key: region, prompt: "Default region (empty: none)" }
  - { key: access, prompt: "What agents may do", options: [read-only, non-production, full], default: read-only }
  - { key: protected, type: list, prompt: "Resources that always need your OK first" }
instructions:
  summary: |                 # 2–4 lines, injected into the prompt of the roles mapped to it
    Google Cloud: use `gcloud` (project {{project}}{{#region}}, region {{region}}{{/region}}); access: {{access}}.
    Read /team/integrations/gcp.md before you change anything in the project.
  file: instructions.md      # the detailed rules → /team/integrations/<id>.md (read on demand)
skills: []                   # skills enabled only while it's connected
default_roles: [devops]      # the role mapping the setup agent proposes; the owner approves
account: "gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1"   # read-only: who it's connected as
revoke: |                    # printed on disconnect: how to revoke the credentials (agentbox leaves them alone)
  On the VM: `gcloud auth revoke --all`.
steps:
  - { id: install, title: Install the gcloud CLI, run: install.sh, check: "command -v gcloud" }
  - id: login
    title: Give the VM Google Cloud credentials
    human: true
    instructions: |
      In the terminal run `gcloud auth login --no-launch-browser`, then
      `gcloud config set project {{project}}`.
    copy: "gcloud auth login --no-launch-browser"
    check: "gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q ."
  - id: project
    title: The project is set and visible
    run: verify.sh
    check: "gcloud projects describe \"$(gcloud config get-value project)\" >/dev/null"
```

### Settings

Each entry: `key` (lower_snake_case), `prompt`, `type` (`string` by default; `list`, `boolean`,
`number`, or `enum` when `options` is given), `required`, `default`, `pattern` (a regex every string
or list item must match), `example`.

- **No secrets.** Settings are plain config (`/etc/agentbox/integrations/<id>.yaml`, root-owned,
  0644) and end up in rendered files. Values that look like tokens or keys are refused; one line,
  at most 300 characters, no `{{`. Credentials come from the provider's own login in the terminal,
  or `agentbox secret set <name>` (stdin → `/secrets/<name>`, 0600).
- Lists are given comma-separated on the command line (`--set labels=bug,feature`).
- Scripts and checks read a setting with `agentbox integration settings <id> --get <key>` (the
  saved value, else the default; lists comma-separated).

### Templates

`instructions.summary`, `instructions.md`, and the steps' `instructions` and `copy` are rendered
with a tiny mustache-like renderer (`cli/integrations.mjs`; no dependency):

| Syntax | Meaning |
|---|---|
| `{{key}}`, `{{paths.work}}` | The value. Lists are joined with ", "; missing, empty or false → nothing. |
| `{{#key}}…{{/key}}` | The block when the value is set (non-empty string, true, non-zero, non-empty list). **Over a list it repeats once per item**, with `{{.}}` the item. |
| `{{^key}}…{{/key}}` | The block when the value is not set. |
| `{{! … }}` | A comment. |

A section or comment tag alone on its line removes the whole line. No HTML escaping (it's
Markdown), and values are never re-rendered. The context is: every setting (saved value, else its
default, else empty), plus `<key>_<option>: true` for the chosen option of each enum (so
`{{#access_read_only}}…{{/access_read_only}}`; dashes become underscores), plus `has_<key>` for each
list (non-empty?), plus `paths` and `user` from the config.

### On the VM

| File | What | Written by |
|---|---|---|
| `/etc/agentbox/integrations/<id>.yaml` | the settings (no secrets) | `connect --set`, `settings --set` |
| `/etc/agentbox/integrations/<id>.summary.md` | the rendered summary (the runner's layer 2) | connect, `settings --set`, `render` |
| `/team/integrations/<id>.md` | the rendered detailed rules (root-owned, 0644), with a "generated, don't edit" header | connect, `settings --set`, `render` |
| `/etc/agentbox/integrations/<id>.state.json` | the last connect / verify / disconnect and its outcome | connect, verify, disconnect |
| `modules.<id>` in `/etc/agentbox/config.yaml` | `true` while connected (the server's feature switch) | connect, disconnect |

Team-specific rules that aren't about a provider go in the owner's own `/team/*.md`.

### States

| State | When |
|---|---|
| `unavailable` | `available: false` (coming soon) |
| `available` | never connected |
| `connecting` | on, and something still waits: a human gate, a missing required setting, unsaved settings, a step not run yet |
| `connected` | on, every applicable check green, the settings saved and valid |
| `error` | on, and a step fails with no gate open before it, or the last connect / verify failed |
| `disconnected` | off, after a disconnect |

Step states (as on the guide's roadmap): `done` (its check passed: the only way), `human` (a gate
whose earlier steps are done), `failed`, `pending`, `skipped` (its `when:` is false).

## The CLI

```
agentbox module list                          the base modules
agentbox module check|verify <id>             checks / verify.sh + checks (any module)
sudo agentbox module install <base id>…       install.sh, units, configure.sh
sudo agentbox module install --enabled        every enabled base module and connected integration (a repair)
sudo agentbox module enable|disable <base id>

agentbox integration list [--json]            the catalog (on / off / soon), by category
agentbox integration status [<id>] [--json]   checks, state, settings, what waits for the owner
sudo agentbox integration connect <id> [--set key=value]…
                                              save settings, modules.<id>=true, install.sh, units,
                                              configure.sh, render; then lists the remaining gates
sudo agentbox integration verify <id>         verify.sh (as the agent user) and every check; records the outcome
sudo agentbox integration disconnect <id> [--forget]
                                              disable.sh, remove units and rendered files,
                                              modules.<id>=false; --forget also drops the settings.
                                              Packages and credentials stay; it prints how to revoke them.
agentbox integration settings <id> [--set k=v]… [--unset k] [--values JSON] [--get k] [--json]
                                              show / change (validated; re-renders and re-runs
                                              configure.sh when connected)
sudo agentbox integration render [<id>]       re-render /team/integrations/* from the settings
```

`agentbox module enable|disable|install <id>` refuses an integration and names the `integration`
command instead. `connect` with no `--set` and no required settings saves empty settings, so an
integration like GitHub can be connected and its settings filled in later. Nothing restarts the
portal: the server picks up `modules.<id>` changes itself.

### `agentbox integration status <id> --json`

For the portal and the setup agent. Without an id: `{ "integrations": [ <this>… ], "checked_at" }`.

```json
{
  "id": "github",
  "title": "GitHub",
  "description": "git + the gh CLI so agents can work with repos, issues, projects and pull requests",
  "category": "code-hosting",
  "available": true,
  "enabled": true,
  "state": "connecting",
  "account": null,
  "depends": ["core"],
  "steps": [
    { "id": "install", "title": "Install git and gh", "human": false, "state": "done",
      "check": { "ok": true, "code": 0 }, "instructions": null, "copy": null },
    { "id": "login", "title": "Log in to GitHub", "human": true, "state": "human",
      "check": { "ok": false, "code": 1, "output": "You are not logged into any GitHub hosts." },
      "instructions": "In the terminal run: `gh auth login` …", "copy": "gh auth login" },
    { "id": "verify", "title": "The GitHub API answers", "human": false, "state": "pending",
      "check": { "ok": false, "code": 1, "output": "…" }, "instructions": null, "copy": null }
  ],
  "settings": {
    "file": "/etc/agentbox/integrations/github.yaml",
    "saved": true,
    "schema": [ { "key": "default_repo", "prompt": "…", "type": "string", "required": false, "pattern": "…", "example": "acme/web-app" } ],
    "values": { "default_repo": "acme/web-app" },
    "missing": [],
    "errors": []
  },
  "instructions": {
    "summary": "GitHub: use `gh` for issues, PRs, reviews and projects (default repo acme/web-app); …",
    "summary_file": "/etc/agentbox/integrations/github.summary.md",
    "file": "/team/integrations/github.md",
    "rendered": true
  },
  "skills": ["review-pr", "open-pr", "file-github-issue", "run-epic", "fix-vulnerability"],
  "default_roles": ["tech-lead", "coder", "tester", "devops"],
  "revoke": "On the VM: `gh auth logout`. …",
  "gates": [
    { "kind": "step", "id": "login", "title": "Log in to GitHub", "instructions": "…", "copy": "gh auth login" }
  ],
  "last": { "action": "connect", "ok": true, "at": "2026-10-11T12:00:00.000Z" },
  "checked_at": "2026-10-11T12:00:03.000Z"
}
```

- `steps[].check` is `null` when the step has no check, `when:` excludes it, or the integration is
  unavailable; `output` (the last lines, at most 600 characters) only for a failing check;
  `timed_out: true` after the 10 s limit.
- `steps[].instructions` / `copy` are rendered with the settings.
- `gates` (only while enabled): `{ "kind": "setting", "key", "title", "command" }` for each missing
  required setting, then `{ "kind": "step", "id", "title", "instructions", "copy" }` for each open
  human gate.
- `last`: `{ action: connect|verify|disconnect, ok: true|false|null (running), at, error? }` or `null`.
- `account`: the first line of the manifest's `account` command (run only when enabled), or `null`.
- `instructions.summary` is rendered from the current settings even when nothing has been written
  yet; `rendered` says whether the files exist.
- `--no-checks` skips the checks (fast; `check` is then `null` and steps are `pending`).
- `agentbox integration status <id>` (no `--json`) exits 0 only when connected.

## Rules

- **Checks are the truth.** A step is done only when its `check` exits 0. It runs as the agent user,
  with a 10 s timeout, and must not change anything.
- **Scripts are idempotent** bash with `set -euo pipefail` (source `setup/lib/common.sh`): running
  them twice is safe. `install.sh` and `configure.sh` run as root; `verify.sh` as the agent user.
- **Read config through the helpers:** `agentbox config get <key>` and `agentbox integration
  settings <id> --get <key>`, never by parsing the YAML yourself.
- **Install from the official source:** the vendor's apt repository with its signing key, or its
  release with a checksum check. Call `wait_for_apt` before apt / dpkg (`apt_install` does).
- **Logins are the owner's.** Never script a login; a human gate says exactly what to type in the
  terminal or the provider's page. Never print secrets, and never ask for one in a web page.
- **Bind to 127.0.0.1.** A module never opens a public listener; `agentbox selftest` fails if one
  does.
- **No personal or company values** in the module: anything install-specific is a config key, a
  setting, a secret, or text the owner writes in `/team`.

## Adding a provider (an integration)

1. Create `setup/modules/<id>/module.yaml` with `kind: integration`, a `category`, and `depends:
   [core]` (plus another integration only if it really needs it).
2. **Install** the provider's official CLI in `install.sh` (idempotent; skip when present).
3. **A login gate:** a `human: true` step whose `instructions` give the exact command (`… auth login`,
   `agentbox secret set <name>` for a token) and whose `check` is a read-only "am I logged in?"
   (`… auth status`, an API `/user` call).
4. **A read-only check** that proves it works for this install (the project, subscription or
   workspace from the settings is visible), with `verify.sh` printing who it's connected as (never
   a token), and an `account` command for the portal's card.
5. **Settings** for everything install-specific (default repo or project, region, what agents may
   change), with patterns and examples; `required` only for what the rules can't do without.
6. **Instructions:** a 2–4 line `summary` and an `instructions.md` with the settings table and the
   rules agents follow (what's read-only, what needs the owner's OK, never print secrets, stop on an
   expired login).
7. `skills`, `default_roles` and `revoke`; a `disable.sh` if `configure.sh` changed anything outside
   the module's own files.
8. Add `<id>: false` under `modules:` in `setup/config.default.yaml`. If the server gets features for
   it, gate them on `modules.<id>` (and add the id to `server/src/config.ts`).
9. Run `cd cli && npm test`: it validates every manifest, renders every template with no settings,
   with the examples and with every enum option, and fails on a leftover `{{`.

## Adding a base module

Rare: the base is what everyone gets on the first run. `kind: base`, steps whose checks prove it
works, and an entry under `modules:` in the default config. The guide picks it up automatically
(`guide/src/manifest.ts`), in dependency order.
