# Access: reaching the portal, and the portal login

agentbox drives agents that can hold real credentials, so the portal is never on a public port
without a login. Every mode below needs **zero inbound ports** on the VM: the cloud firewall /
security group allows nothing in. Everything agentbox runs listens on `127.0.0.1` only:

| Port (default) | Service | Reached through |
|---|---|---|
| 7700 | the portal (UI + `/api`) | the access mode below |
| 7701 | noVNC / websockify (the shared screen) | the portal's `/screen/` proxy only |
| 7702 | ttyd (the terminal) | the portal's `/term/` proxy only |
| 7710 | the phone gateway (mobile module) | `tailscale serve`, signed requests (docs/MOBILE-PROTOCOL.md) |
| 7699 | the setup guide | localhost, then the portal's login |

The mode is `access:` in `/etc/agentbox/config.yaml`; the `access` module (`setup/modules/access/`)
sets it up, and the server (`server/src/access.ts`) enforces it.

## The modes

| | **tailscale** (default) | **cloudflare** | **ssh-tunnel** |
|---|---|---|---|
| URL | `https://<node>.<tailnet>.ts.net` | `https://<your hostname>` | `http://localhost:7700` through a port forward |
| Who can connect | devices on your tailnet | anyone on the internet **reaches Cloudflare**, only you get past Access | whoever can open the forward (SSH key, AWS IAM, Google IAM) |
| Identity the portal checks | `Tailscale-User-Login` = `owner.tailscale_login` | Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`), `email` = `owner.email` | none: being on localhost is the check |
| Allowed Host / Origin | the ts.net name / `https://` + it | the hostname / `https://` + it | `localhost`, `127.0.0.1`, `[::1]` / the same origin |
| Needs | a free Tailscale account and its app on your devices | a domain on Cloudflare (free plan), Zero Trust (free up to 50 users) | SSM agent + IAM, or IAP, or port 22 open to your IP |
| Phone app | yes (the gateway is tailnet-only) | no | no |

**Recommended:** tailscale as the way in, plus AWS SSM (or your provider's console) as the
break-glass shell.

## What the portal enforces (all modes)

For every `/api` route, the `/api/events` WebSocket, and the `/term` and `/screen` proxies (HTTP and
WebSocket):

- **Host** must be the mode's allowed host (blocks DNS rebinding).
- **Origin**, when sent, must be exactly the portal's own origin (blocks other sites, including
  cross-site WebSocket hijacking). `Origin: null` is refused.
- **`Sec-Fetch-Site: cross-site` or `same-site` is refused** (audit M1: an `<img>` or `<script>` on
  another site sends no Origin, but browsers do send this).
- **Writes with a body must be `application/json`** (a foreign page can't send that without a CORS
  preflight). Device-admin writes must be JSON even without a body.
- **Paths are never percent-encoded**: an encoded `/api`, `/term` or `/screen` path is a 404, and the
  proxies refuse `.`/`..` segments and `//`.
- **In tailscale and cloudflare modes**, every request (the static UI too) also needs the owner's
  identity or a session; anything else is a 401. A config with a missing piece (no owner, no AUD
  tag…) fails closed: every request gets a 503 until it's fixed.

**Sessions** (remote modes): the first request with a valid identity gets
`__Host-agentbox_session=<256-bit random>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`.
Sessions live in the server's memory (a restart signs everyone out), expire after 8 h, and are capped
at 256 (oldest dropped). If a request presents a different or refused identity together with a
session cookie, the session is deleted. `POST /api/auth/logout` ends the session (in cloudflare mode
it also returns the Access logout URL, `https://<team>/cdn-cgi/access/logout`). `GET /api/auth/me`
returns the mode and identity.

**Local tools** (the `agentbox` CLI, scripts, module checks) in the remote modes use the **local
token**: the server writes a fresh random token to `<paths.data>/local-token` (0600, the service
user) at every start. A request carrying `X-Agentbox-Local-Token: <token>` from a loopback peer, with
a loopback Host, is allowed (Origin, Sec-Fetch-Site and JSON checks still apply):

```bash
curl -H "X-Agentbox-Local-Token: $(cat /opt/agentbox/data/local-token)" http://localhost:7700/api/tasks
```

Without it, a loopback Host is refused in the remote modes (403), because a client can send any Host
through `tailscale serve`.

**The phone gateway** is unchanged: requests it injects carry an in-process token and are checked
against the phone allowlist instead; `/api/devices*`, `/api/screen/credential`, `/term` and
`/screen` are never reachable from a phone.

## Terminal and screen (audit H1)

The browser never talks to ttyd or noVNC directly. The portal proxies:

- `/term/*` → `http://127.0.0.1:<ports.terminal>/*` (ttyd), including the `/term/ws` WebSocket;
- `/screen/*` → `http://127.0.0.1:<ports.screen>/*` (websockify serving noVNC), including the
  `/screen/websockify` WebSocket.

Both sit behind the same checks as `/api`. The proxy forwards only a small allowlist of request
headers: never cookies, identity headers, `X-Forwarded-*` or the local token. It speaks to the
upstream as its own origin (`Host`/`Origin: 127.0.0.1:<port>`), drops `Set-Cookie` from the
upstream, and adds `X-Frame-Options: SAMEORIGIN` and `Cache-Control: no-store`.

Two upstream secrets stop anything that reaches the loopback ports *without* the portal, for
example a page in the agents' own Chromium that rebinds a name to 127.0.0.1. Origin checks alone
can't stop that, because under rebinding the Origin matches the Host:

- **ttyd** runs with `-O` (check origin), `-i lo`, and `-c <user:password>` from
  `/etc/agentbox/ttyd.credential` (0600). The portal adds it as Basic auth on the proxied requests.
- **x11vnc** runs with `-passwdfile /etc/agentbox/vnc.password` (0600) instead of `-nopw`. The
  portal hands the password to the signed-in UI (`GET /api/screen/credential`), which puts it in
  the noVNC URL's **fragment** (`#&password=…`). Browsers never send the fragment to a server, and
  noVNC reads it from there.

These units belong to the `display` and `terminal` modules; the exact flags are in
[Unit changes for the terminal and display modules](#unit-changes-for-the-terminal-and-display-modules).

## Threat model

### Common to all modes
- **In scope:** other websites in your browser (CSRF, cross-site GETs, WebSocket hijacking, DNS
  rebinding against the portal, the terminal and the screen); anyone on the network path; anyone
  who finds the hostname.
- **Out of scope here:** processes inside the VM. Agents run as the agent user and can reach
  127.0.0.1, read the local token, and run commands anyway. That boundary is audit H3 (a separate
  agent user, an admin token the agent user can't read). The local token grants nothing a local
  process doesn't already have.
- **Session theft:** the cookie is HttpOnly, `__Host-`, Secure and SameSite=Strict, and in the
  remote modes the identity header/JWT arrives with every request anyway: presenting a stolen
  cookie together with someone else's identity ends the session.

### tailscale
- **Who can reach it:** only devices on your tailnet that the tailnet policy lets reach this node on
  443. `tailscale serve` terminates TLS inside tailscaled and proxies to 127.0.0.1:7700. **Funnel**
  (public internet) is refused by the module, both when it's on and when the policy merely allows it.
- **Identity:** tailscale serve sets `Tailscale-User-Login` from the connecting node's owner and
  strips any client-sent `Tailscale-*` headers. The portal trusts it only from a loopback peer and
  only if it equals `owner.tailscale_login` (case-insensitive). Tagged devices send no login, so
  they get a 401.
- **Residual risks:**
  - another tailnet member can reach the login check (a 401), but not past it;
  - a compromised device of yours *is* you (use Tailscale device approval, key expiry, and Tailnet
    Lock);
  - a local process can forge the header (see "Out of scope" above);
  - the node name appears in Certificate Transparency logs, so the module picks a random name
    (`n-xxxxxxxx`).

### cloudflare
- **Who can reach it:** anyone can reach Cloudflare's edge at your hostname. **Cloudflare Access**
  stops them before the request enters the tunnel (SSO or a one-time PIN, only your email). The
  tunnel is outbound-only: nothing on the VM listens publicly.
- **Identity:** the portal verifies the Access JWT itself, so Access being misconfigured or bypassed
  (a DNS record pointing elsewhere, a Bypass policy) doesn't open the portal:
  - **RS256 only** (`alg: none`, HS256/key confusion, RS512 and PS256 are refused before any key is
    used);
  - the signature is checked against the team's JWKS (`https://<team>/cdn-cgi/access/certs`), cached
    for an hour and refreshed on an unknown `kid` at most every 30 s; RSA keys under 2048 bits and
    non-signing keys are ignored;
  - `aud` must contain the configured AUD tag, `iss` must be `https://<team>`;
  - `exp`, `nbf` and `iat` are checked with 60 s of skew;
  - `email` must equal `owner.email`;
  - the JWT is only trusted from a loopback peer (cloudflared).

  Once the AUD tag is set, `cloudflared` also refuses requests without a valid token
  (`originRequest.access.required`), as a second layer.
- **Residual risks:**
  - your Cloudflare account and the identity provider become part of the trust base (use MFA on
    both);
  - Cloudflare terminates TLS, so it sees the traffic;
  - the hostname is public (it's in DNS and CT logs);
  - `/etc/cloudflared/cert.pem` can create tunnels and DNS records in the zone, so it's root-only,
    0600.

### ssh-tunnel
- **Who can reach it:** only whoever can open a port forward: AWS IAM through SSM, Google IAM
  through IAP, or an SSH key.
- **Identity:** none in the portal. Being on localhost (Host and Origin loopback) is the check,
  exactly as before v2.
- **Residual risks:**
  - plain SSH needs port 22 open (restrict it to your IP; prefer SSM or IAP);
  - anyone with a shell on your laptop can use the forwarded port while it's open.

## Setup

The guide runs these steps for you; the commands are here for reference. Choose a mode:
`agentbox config set access tailscale|cloudflare|ssh-tunnel`.

### tailscale
1. `install.sh` installs Tailscale from `pkgs.tailscale.com` (signed apt repo).
2. **Your turn:** `sudo bash /opt/agentbox/app/setup/modules/access/tailscale-up.sh`. It runs
   `tailscale up --hostname n-xxxxxxxx --ssh=false --accept-routes=false --accept-dns=false` and
   prints a login URL. Log in with **the account that will use the portal**.
3. In the Tailscale admin console → **DNS**: MagicDNS and **HTTPS Certificates** must be on.
4. `configure.sh`:
   - refuses Funnel;
   - runs `tailscale serve --bg --https=443 http://127.0.0.1:7700`;
   - records `tailscale.hostname` (the full ts.net name) and `owner.tailscale_login` (the login that
     brought the node up) in the config;
   - restarts the portal.

   If the node is tagged, set the owner yourself: `agentbox config set owner.tailscale_login you@example.com`.
5. Recommended tailnet policy: only your own devices may reach `tag:agentbox` (or this node) on 443;
   no `funnel` nodeAttr; no SSH grants.

**Tailscale and the phone gateway:** the gateway (mobile module) is also served by `tailscale serve`.
Both can't own `https://<node>/`, so `configure.sh` refuses to overwrite another target. The mobile
module should serve the gateway on its own HTTPS port (e.g. `tailscale serve --bg --https=8443
http://127.0.0.1:7710`, with the pairing URL including `:8443`).

### cloudflare
1. `install.sh` installs `cloudflared` from `pkg.cloudflare.com` (signed apt repo).
2. **Your turn:** set the hostname, then log in:
   ```
   agentbox config set cloudflare.hostname agentbox.example.com
   sudo bash /opt/agentbox/app/setup/modules/access/cloudflared-login.sh   # opens the browser login
   ```
3. `configure.sh`:
   - creates a named tunnel (`agentbox-xxxxxxxx`) with credentials in `/etc/cloudflared/tunnel.json`
     (0600);
   - writes `/etc/cloudflared/config.yml`: the hostname → `http://127.0.0.1:7700`, everything else
     `http_status:404`;
   - creates the DNS record and installs `cloudflared.service`.
4. **Your turn: the Access application** (below), then:
   ```
   agentbox config set cloudflare.team_domain <team>.cloudflareaccess.com
   agentbox config set cloudflare.aud <AUD tag>
   agentbox config set owner.email you@example.com
   sudo bash /opt/agentbox/app/setup/modules/access/configure.sh   # adds the Access check to cloudflared too
   ```
5. `verify.sh` checks that an unauthenticated request to `https://<hostname>` gets Cloudflare's
   login (a redirect to `<team>.cloudflareaccess.com`), not the portal, and that the portal refuses a
   missing or forged JWT.

#### Cloudflare: the Access application
What you'll see in the Zero Trust dashboard (`one.dash.cloudflare.com`):

```
Zero Trust ▸ Access ▸ Applications                         [ + Add an application ]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Select type:  (•) Self-hosted   ( ) SaaS   ( ) Private network   ( ) Bookmark  │
└──────────────────────────────────────────────────────────────────────────────┘

Configure application
  Application name      [ agentbox                         ]
  Session duration      [ 8 hours                       ▾ ]
  Application domain    Subdomain [ agentbox ]  Domain [ example.com ▾ ]  Path [      ]
  Identity providers    [x] One-time PIN    [x] <your SSO, if any>
                        [x] Instant Auth (skip the picker when there is one provider)
                                                                    [ Next ]
Add policies
  Policy name           [ owner only                       ]
  Action                [ Allow                         ▾ ]
  Configure rules
    Include   Selector [ Emails ▾ ]   Value [ you@example.com ]
    (no Exclude / Require needed; do NOT add "Everyone", "Emails ending in",
     Bypass, or Service Auth rules)
                                                                    [ Next ]
Setup
  (defaults are fine; leave CORS settings off)                     [ Add application ]
```

Then copy the two values the portal needs:

```
Access ▸ Applications ▸ agentbox ▸ (Edit) ▸ Overview
  Application Audience (AUD) Tag   4714f0f7c3...e2a1   [ copy ]   → cloudflare.aud

Settings ▸ Custom Pages   (or: Settings ▸ General)
  Team domain   <team>.cloudflareaccess.com                      → cloudflare.team_domain
```

Optional hardening: in **Settings ▸ Authentication**, require MFA in your identity provider. A
one-time PIN goes to your email, so the email account's own MFA matters.

### ssh-tunnel
`configure.sh` prints the forward for your provider. Then browse `http://localhost:7700`:

```bash
# AWS SSM (no port 22)
aws ssm start-session --target i-0123456789abcdef0 --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["7700"],"localPortNumber":["7700"]}'
# Google Cloud: SSH through IAP (port 22 open only to 35.235.240.0/20)
gcloud compute ssh my-vm --zone europe-west1-b --tunnel-through-iap -- -N -L 7700:127.0.0.1:7700
# Plain SSH (port 22 restricted to your IP)
ssh -N -L 7700:127.0.0.1:7700 agentbox@vm.example.com
```

The terminal and screen come through the same forward (`/term/`, `/screen/`).

## Unit changes for the terminal and display modules
The `terminal` and `display` modules own these units (the access module only verifies them):

- **ttyd** (`agentbox-ttyd.service`), loopback, origin check, credential; no `-b` (the proxy strips
  `/term`):
  ```ini
  ExecStart=/bin/sh -c 'exec /usr/bin/ttyd -i lo -p 7702 -O -W -c "$(cat /etc/agentbox/ttyd.credential)" -t fontSize=14 -t titleFixed=agentbox /bin/bash -l'
  ```
  - Generate the credential at install: `agentbox:<32 random chars>`, mode 0600, owned by the user
    the portal and ttyd run as.
  - The credential is visible in ttyd's command line to local users (`/proc/<pid>/cmdline`). That
    is accepted: it only has to stop browsers.
  - Disable Ubuntu's own `ttyd.service` (port 7681): `systemctl disable --now ttyd.service`.
- **x11vnc** (`agentbox-vnc.service`): replace `-nopw` with `-passwdfile /etc/agentbox/vnc.password`
  and keep `-localhost`. Generate the file at install: 8 random alphanumeric characters (VNC uses
  only the first 8), mode 0600, owned by the same user.
- **websockify** (`agentbox-novnc.service`): unchanged (`127.0.0.1:7701`).
- **The portal** (`agentbox-web.service`) reads `AGENTBOX_CONFIG` (default
  `/etc/agentbox/config.yaml`). Optional overrides:
  - `AGENTBOX_TTYD_CREDENTIAL_FILE` (default `/etc/agentbox/ttyd.credential`);
  - `AGENTBOX_VNC_PASSWORD_FILE` (default `/etc/agentbox/vnc.password`);
  - `AGENTBOX_LOCAL_TOKEN_FILE` (default `<AGENTBOX_DATA>/local-token`).
- **Lima:** forward only the portal port (7700), not 7701/7702.

## Tests
`cd server && npm run test:access` runs `server/test/access.test.ts` in-process (no VM, Tailscale or
Cloudflare). It uses a fake ttyd/websockify, and an RSA key generated locally behind a mocked JWKS.
