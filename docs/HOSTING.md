# Hosting what agents build

Agents host what they build (a page, dashboard, demo, API) and give the owner a link, instead of
asking the owner to run a server on their computer.

```
owner's browser ──https://<node>.ts.net:10000/<name>/──▶ tailscale serve ──▶ gateway 127.0.0.1:7790
                                                                         ├─ static folder (served directly)
                                                                         └─ command on 127.0.0.1:$PORT (7800–7899)
```

## For agents (four tools, skill `host-service`)
| Tool | |
|---|---|
| `host_start(name, dir, command?, keep_prefix?)` | Static folder (no command) or a command that listens on `127.0.0.1:$PORT`. Returns the owner's link. The same name again restarts it. |
| `host_stop(name)` | The starter, or the work's lead. |
| `host_list()` | Services in this work, with links. |
| `host_logs(name)` | The command's last output. |

Commands get `PORT`, `HOST=127.0.0.1`, `BASE_PATH=/<name>/`, `PUBLIC_URL` and a clean environment
(nothing from the portal's own). The app receives paths without `/<name>` unless `keep_prefix`.
Absolute asset paths (`/assets/x.js`) are routed by the Referer's service. Redirects and WebSockets
are proxied. A command that doesn't listen within 45 s is stopped, and its output is returned.

## Lifecycle and control
- Services belong to the task room (the work). A helper's task ending doesn't stop them; the work
  being marked done (its root retiring) stops them all.
- The starter and the room's lead (its root, or an orchestrator that joined it) can stop or restart
  any service in the work. The owner stops any from the room's "hosted" strip (or `POST /api/hosting/:id/stop`).
- After an agentbox restart, commands start again (same port when free); static services carry on.
- Limits: 6 per work, 24 in all. Logs: `<data>/hosting/<id>.log`.

## Security
- **Its own origin.** Hosted pages run code agents wrote, so they never share the portal's origin
  (`https://<node>.ts.net`). The gateway is another port, the portal refuses requests from other origins
  (Origin and Sec-Fetch-Site checks), and the gateway strips the portal's session cookie.
- **Owner only.** tailscale mode: `Tailscale-User-Login` must be the owner (set by `tailscale serve`,
  trusted only from loopback). ssh-tunnel mode: localhost only (Host checked, against DNS rebinding).
  Local processes can use `http://127.0.0.1:7790/<name>/` to test. Cloudflare mode: not yet.
- Only folders under `/work` or `/agents` can be served or run; a command must not use a CLI the agent's
  role doesn't have (the same rule as the shell).
- Hosted pages are a secure context (HTTPS, or localhost), so Web Serial, WebUSB, camera and clipboard work.

## Setup
`setup/modules/access/configure.sh` adds `tailscale serve --bg --https=<hosting.serve_port> http://127.0.0.1:<ports.apps>`
(defaults 10000 and 7790; tailscale serve's HTTPS ports are 443, 8443 and 10000). On an existing install:
`sudo tailscale serve --bg --https=10000 http://127.0.0.1:7790`.
