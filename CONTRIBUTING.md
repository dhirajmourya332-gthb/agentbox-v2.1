# Contributing

Thanks for helping. Issues and pull requests are welcome; for anything large, open an issue first
so we can agree on the approach.

## Repository layout

| Path | What |
|---|---|
| `server/` | The agentbox server (Node 22, TypeScript run with `tsx`, Fastify, SQLite, Claude Agent SDK) |
| `server/seed-skills/` | Skills seeded into a new install. Keep them generic: parameters come from `/team/*.md` |
| `web/` | The portal (React + Vite) |
| `mobile/` | The optional Android app (Expo / React Native) |
| `setup/` | Bootstrap, the setup guide's modules (`setup/modules/<id>/`) |
| `vm/` | Provisioning, systemd units and helper commands installed in the VM |
| `scripts/`, `lima/` | The local Lima host (macOS) |
| `docs/` | Design docs and contracts |

## Development setup

You need Node 22 and npm. The server runs inside the VM; for most work, run a VM (Lima on macOS is
the quickest, see the README) and iterate against it.

```bash
# server
cd server && npm install
npx tsc -p . --noEmit                          # type-check

# portal
cd web && npm install
npm run dev                                    # Vite on :5173, proxies /api to the portal on :7700
npx tsc -p . && npm run build                  # type-check and build

# mobile (optional)
cd mobile && npm install
npm run typecheck && npm run selftest
```

Deploy your working copy into a Lima VM with `./scripts/deploy.sh` (it refuses while agents are
busy; `--force` overrides). On a cloud VM, `agentbox update` builds from the checkout on the VM.

## Tests

Server tests are plain TypeScript scripts in `server/test/`; each prints `PASS`/`FAIL` lines and
exits non-zero on failure. In-process tests use a throwaway database and are safe to run anywhere:

```bash
cd server
node --disable-warning=ExperimentalWarning --import tsx test/live-progress.test.ts
node --disable-warning=ExperimentalWarning --import tsx test/routine-runs.test.ts
node --disable-warning=ExperimentalWarning --import tsx test/push.test.ts
```

The `*-gateway.test.ts` and `voice*.test.ts` scripts drive a running rehearsal server; their
header comments say how to start it. Never point them at an install you use.

Before you open a PR: type-check `server/`, `web/` (and `mobile/` if you touched it), run the
relevant tests, and build the portal.

## Conventions

- Conventional commits: `type(scope): summary`, e.g. `fix(portal): keep scroll position on new
  messages`.
- Keep changes focused; follow the patterns around you.
- **No personal or company specifics** anywhere: code, prompts, skills, tests, UI text, docs. Use
  neutral examples (`acme/web-app`, issue `#1234`, `you@example.com`). Install-specific values
  belong in `/etc/agentbox/config.yaml`, `/secrets`, or a `/team` file the user edits.
- **Security first:** every listener binds to `127.0.0.1`; every portal route goes through the
  auth guard; phone routes must be on the gateway allowlist; never log secrets. Read
  [SECURITY.md](SECURITY.md) before touching access, auth, the gateway or `/secrets` handling.

## Writing a module

Modules are how agentbox grows: a folder `setup/modules/<id>/` with a `module.yaml` manifest,
idempotent scripts and read-only checks. The format, the rules and a full example are in
[docs/MODULES.md](docs/MODULES.md). In short:

1. One manifest with ordered steps; each has a read-only `check` (exit 0 = done).
2. Logins and secrets are **human gates**; the guide never collects secrets.
3. Scripts are idempotent bash, read config with `agentbox config get`, and never print secrets.
4. Server features of the module are off when it is disabled.
5. Team conventions go in a `team/` template, not in prompts.

## Writing a seed skill

A skill is `server/seed-skills/<name>/SKILL.md` (front matter `name` and `description`, then the
procedure) plus optional `scripts/`. Skills must work for any team: take repos, boards, people and
labels from `/team/*.md`, and say what to do when a setting is missing.
