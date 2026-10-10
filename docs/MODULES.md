# Modules

Every capability beyond the core is a **module**: a folder `setup/modules/<id>/` with a manifest
and a few idempotent scripts. The same manifests drive the setup guide's roadmap, `agentbox
status`, and `agentbox module enable|disable|install|verify <id>`. A module that isn't enabled in
`/etc/agentbox/config.yaml` installs nothing, asks for nothing, and its features are off (its
routes return 404 and its units and timers don't run).

## Layout

```
setup/modules/<id>/
  module.yaml       the manifest (required)
  install.sh        install packages and files (optional)
  configure.sh      write config from /etc/agentbox/config.yaml (optional)
  verify.sh         a deeper end-to-end check (optional)
  units/            systemd units the module installs (optional)
  team/             team-rule templates copied to /team as examples the user edits (optional)
```

## `module.yaml`

| Field | Meaning |
|---|---|
| `id` | The folder name; also the key under `modules:` in the config. |
| `title`, `description` | Shown in the guide and in `agentbox status`. |
| `optional` | `false` for `core`, `claude` and `access`; `true` otherwise. |
| `depends` | Module ids that must be set up first. |
| `steps` | The roadmap, in order (below). |

Each step:

| Field | Meaning |
|---|---|
| `id`, `title` | Identify and name the step. |
| `run` | A script in the module folder, run by the setup agent (as root through sudo). |
| `human: true` | A "your turn" gate: the guide shows `instructions` and waits. |
| `instructions` | Markdown for the human: what to type, where to sign in. |
| `copy` | A command the guide shows with a copy button. |
| `check` | A read-only shell command. Exit 0 means the step is done. |

## Rules

- **Checks are the truth.** A step is done only when its `check` exits 0. It runs as the agent user,
  with a 10 s timeout, and must not change anything.
- **Scripts are idempotent** bash with `set -euo pipefail`: running them twice is safe.
- **Read config through the helper:** `agentbox config get <key>`, never by parsing the YAML
  yourself.
- **Never print secrets**, and never ask for one in the guide page. The human types secrets into
  the terminal or an official login page; files go in with `agentbox secret set <name>` (stdin →
  `/secrets/<name>`, 0600).
- **Bind to 127.0.0.1.** A module never opens a public listener; `agentbox selftest` fails if one
  does.
- **No personal or company values** in the module: anything install-specific is a config key, a
  secret, or a `team/` template the user edits.

## Example: `github`

```yaml
# setup/modules/github/module.yaml
id: github
title: GitHub
description: git + gh CLI so agents can work with repos, issues and PRs
optional: true
depends: [core]
steps:
  - id: install
    title: Install git and gh
    run: install.sh
    check: "command -v gh && command -v git"
  - id: login
    title: Log in to GitHub
    human: true
    instructions: |
      In the terminal run: `gh auth login` (GitHub.com, HTTPS, browser).
      Add the project scope if you use GitHub Projects: `gh auth refresh -s project`.
    copy: "gh auth login"
    check: "gh auth status"
  - id: team-rules
    title: Describe your team's GitHub conventions
    human: true
    instructions: |
      Edit `/team/github.md`: your default repo, the issue assignee, the project board and its
      sprint field, labels and branching rules. The GitHub skills read it.
    check: "test -s /team/github.md && ! grep -q '<your-github-login>' /team/github.md"
  - id: verify
    title: Verify
    run: verify.sh
    check: "gh api user -q .login"
```

```bash
#!/usr/bin/env bash
# setup/modules/github/install.sh
set -euo pipefail
if ! command -v gh >/dev/null; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh git
fi
team=$(agentbox config get paths.team)
# Copy the example team rules once; never overwrite the user's edits.
[ -e "$team/github.md" ] || install -m 0644 -o "$(agentbox config get user)" \
  "$(dirname "$0")/team/github.md" "$team/github.md"
```

The example team file it copies is [`setup/modules/github/team/github.md`](../setup/modules/github/team/github.md).

## Adding a module

1. Create `setup/modules/<id>/module.yaml` with at least one step whose `check` proves the
   capability works (not just that a package is installed).
2. Add `install.sh` / `configure.sh` / `verify.sh` as needed, following the rules above.
3. Add `<id>: false` under `modules:` in the default config written by `setup/bootstrap.sh`.
4. If the server gets features for it, gate them on the module being enabled (routes return 404,
   timers don't start).
5. If agents should know about it, add a `team/` template rather than hard-coding it in prompts.
6. Document it in the README's module table.
