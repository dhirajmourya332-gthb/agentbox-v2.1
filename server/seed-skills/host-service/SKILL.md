---
name: host-service
description: "Host a web page, dashboard, demo or API you built so the owner opens it from a link (no commands for them to run). Use whenever the owner should see or try something in a browser."
---

# Host what you built

<!-- Built into agentbox (server/seed-skills/host-service); refreshed at every start. -->

agentbox serves it and gives you a link the owner can open straight away. You never deal with
ports, proxies, certificates or sign-in. Four tools:

| Tool | What it does |
|---|---|
| `mcp__team__host_start(name, dir, command?)` | Host it and get the link. The same name again restarts it (after you change code). |
| `mcp__team__host_stop(name)` | Stop it. |
| `mcp__team__host_list()` | What's hosted in this work, with links. |
| `mcp__team__host_logs(name)` | The command's last output (a crash, a failed start). |

## Static files (HTML, JS, CSS, built `dist/`)
Leave `command` out: `host_start(name="arm-dashboard", dir="/work/worktrees/<repo>/<id>/parts/x/dashboard")`.
The folder's `index.html` is the start page. Paths without an extension fall back to `index.html`
(single-page apps work).

## A server (Node, Python, a dev server, an API)
Give `command`. It **must listen on `127.0.0.1:$PORT`** (agentbox picks the port and sets `$PORT`):
- `python3 -m http.server $PORT --bind 127.0.0.1`
- `npm run dev -- --host 127.0.0.1 --port $PORT` (Vite) · `npx next dev -H 127.0.0.1 -p $PORT`
- `uvicorn app:app --host 127.0.0.1 --port $PORT` · `flask run -h 127.0.0.1 -p $PORT`
- `node server.js` (reading `process.env.PORT`)

Install dependencies and build **before** `host_start`; the command should only start the server.
If it doesn't listen within 45 s, agentbox stops it and shows you its last output.

Also set: `HOST=127.0.0.1`, `BASE_PATH=/<name>/` and `PUBLIC_URL` (the owner's link).

## Paths: keep links relative
The app lives under `/<name>/`, and by default it receives requests without that prefix (`/` and
`/api/x`). So:
- In HTML/JS use **relative** URLs (`./app.js`, `api/state`, `fetch("api/x")`), not `/app.js`.
  (Absolute asset paths usually still work: agentbox routes them by the page they came from. Relative
  is more reliable.)
- Frameworks with a base path (Vite `base`, Next `basePath`) can use `BASE_PATH`; then pass
  `keep_prefix=true` so the app receives the full path.
- WebSockets work (same path rules).

## Check it before you hand it over
From this machine use the local link from `host_start` (`http://127.0.0.1:<apps>/<name>/`) or
`http://127.0.0.1:$PORT/` directly: curl it, or open it in Playwright or the shared browser. Then give
the owner the **owner's link**, saying what to look at.

## Rules
- The owner opens it; nobody else can (agentbox checks they're signed in). Still, never serve
  secrets, `.env` files, keys or your home folder: serve only the folder the page needs.
- Hosting is for previews and tools for the owner, not production deploys.
- Pages served this way are a secure context (HTTPS on the owner's network, or localhost), so browser
  APIs like Web Serial, WebUSB, camera and clipboard work there.
- Services belong to this work: they keep running when your own task ends and stop when the work is
  marked done. Your lead can stop or restart any of them. Stop what's no longer needed.
- Don't run your own `python -m http.server` in the background to "host" things, and don't tell the
  owner to start servers on their computer: use `host_start`.
