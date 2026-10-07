# agentbox

A team of Claude agents (tech-lead, coder, tester, devops, …) sharing one Linux computer
to automate software development. Plan: [docs/PLAN.md](docs/PLAN.md) · UI:
[docs/UI-DESIGN.md](docs/UI-DESIGN.md).

## Run

```bash
./scripts/up.sh      # create/start the Lima VM "agentbox", provision it, deploy the app
./scripts/deploy.sh  # redeploy server/ and web/ after changes
./scripts/shell.sh   # shell inside the VM (or: ./scripts/shell.sh <command>)
```

Lima VMs live in `$LIMA_HOME` (default `/Volumes/External/lima`); the scripts refuse to
run if it is missing.

| URL | What |
|---|---|
| http://localhost:7700 | Web UI |
| http://localhost:7701/vnc.html | Shared screen (noVNC) |
| http://localhost:7702 | Terminal (ttyd) |

## First-time sign-in

In the **Terminal** tab: `claude` then `/login`, `gh auth login`, `aws configure sso`.
In the **Screen** tab: sign into Teams and other web apps in the shared Chromium.
Logins persist across VM restarts.

## Developing

```bash
cd web && npm install && npm run dev   # UI on :5173, proxies /api to the VM on :7700
./scripts/deploy.sh                    # ship server/ + web/ into the VM
```
