# agentbox security audit (2026-10-09)

**Method:** four independent, read-only reviews of the live system, plus orchestrator spot-checks.
- **A. Network exposure:** live probes from the Mac, the VM and the internet.
- **B. Phone gateway and portal API:** about 250 attack probes against a paused rehearsal copy.
- **C. Secrets and data at rest:** pattern and exact-value scans, with no values printed.
- **D. Agent/insider threat, the Android app and the supply chain.**

Nothing was changed. No secret values were printed.

## Verdict
- **Phone and tailnet perimeter: strong.** Only `https://node-76bf79…ts.net:443` → the gateway is reachable, and only from the owner's devices. The tailnet policy is enforced off-box: Funnel isn't allowed, Tailscale SSH is off, and the name doesn't resolve in public DNS. The gateway held against forgery, replay, 33 path-encoding tricks, allowlist bypass, and CSRF/DNS rebinding on the portal. The app is hardened (signed keys, FLAG_SECURE, auto-lock, minimal permissions).
- **Overall: high risk, because of what sits behind the perimeter.** Agents run as the owner, with root (passwordless sudo), unrestricted internet egress, AWS **AdministratorAccess**, a GitHub **org-admin** token, every production secret, and the owner's logged-in browser sessions. One successful prompt injection (via a PR, issue, web page or Teams message) could reach all of it. Two local gaps (the terminal WebSocket, and the VM reaching the Mac's services) also need closing.

## Findings (✔ = verified by the orchestrator)

### Critical
| # | Finding | Fix |
|---|---|---|
| C1 ✔ | The VM's AWS key is the owner's IAM user with **AdministratorAccess**, a long-lived key (since 2026-07-17), and **0 MFA devices**. Any agent can read it. | Give agents a read-only or narrowly scoped role with short-lived credentials. Remove the admin key from the VM and **rotate it**. Enable MFA. |
| C2 | The gh token (`repo, workflow, gist`) belongs to a **Brandsek org admin**. The free plan means **no branch protection on `main`**. The org doesn't require 2FA. | Use a fine-grained PAT or a GitHub App for a **non-admin** account (Contents, PRs and Issues only; no Workflows, Administration or gist). Use GitHub Team to get a `main` ruleset (PR plus your approval), CODEOWNERS on `.github/workflows`, and org 2FA. Pin OIDC roles to `main` plus an environment. |
| C3 | All production `.env` secrets (~150 keys: Stripe, Razorpay, Keycloak admin, Mongo, AWS, ENCRYPTION_KEY…) are readable by agents, and **egress is unrestricted**: pastebin and SMTP were reachable. | An egress allowlist (proxy plus an nft output policy). Long term, give agents **staging** `.env` files, not production. Rotate the high-value keys once the controls are in. |
| C4 ✔ | The VM disk image (holding every secret, token and cookie) is on **`/Volumes/External`, which isn't encrypted**. Lima's SSH key is there too. | Encrypt the volume (`diskutil apfs encryptVolume …`, or Finder → Encrypt), or move the VM to the FileVault disk. |

### High
| # | Finding | Fix |
|---|---|---|
| H1 ✔ | **Any web page open in the Mac's browser can open the VM terminal** (ttyd on 7702: a `101` to `Origin: evil`, giving a root shell) **or the screen** (noVNC on 7701; x11vnc has no password). DNS rebinding works too. | Serve the terminal and screen only through the portal's Host/Origin guard, or add ttyd `-O` + `-c user:pass` and an x11vnc password. Disable Ubuntu's own `ttyd.service` on 7681. |
| H2 ✔ | The VM can reach **every loopback service on the Mac** via `192.168.5.2`. The **Mac's MongoDB has no authentication**: from the VM it listed the databases. The home LAN (router admin, the Mac's sshd) is reachable too. | Turn on mongod `security.authorization`. Block VM → Mac loopback and the LAN (host outbound firewall such as LuLu or Little Snitch on limactl, plus an in-VM nft output drop as a tripwire). Turn off Remote Login if unused. |
| H3 | Agents share **one uid with the owner**, with passwordless sudo and the docker group. So every in-VM control is advisory, and the **agentbox admin API is unauthenticated to any in-VM process**: an agent can rewrite instructions, approve skills, change routine permissions, or approve devices. | Run agents as a separate `agent` user without sudo or docker. Keep the orchestrator, `/secrets`, credentials and Chromium under the owner or root. Require an admin token on `/api`. |
| H4 | The shared Chromium holds the **owner's GitHub, Microsoft 365/Teams and Google sessions** (229 cookies). `--password-store=basic` makes them decryptable, and CDP on :9222 is open to any process. | Use separate low-privilege identities for agent browsing, a separate uid for Chromium, and CDP only through the orchestrator. |
| H5 | **Live production secrets are committed in `digital_risk`** (`ENCRYPTION_KEY`, DefectDojo, Shodan, FOFA, CrewAI keys, a Redis URI), so they're in GitHub history. A backend AWS key ID appears in scan results. | Rotate them (ENCRYPTION_KEY via its re-encryption procedure), purge history, and add gitleaks in pre-commit and CI. |
| H6 | **Persistence:** agents can edit `/agents/*/CLAUDE.md`, `/team`, `/skills`, routines (`schedule_routine`), the app code and the DB. | Make them read-only to agents, require owner approval before agent-created routines run, and alert on changes. |
| H7 | **Production MongoDB** is reachable through the tunnel with `.env` credentials, probably read-write. The bastion SSH key isn't restricted. | Give agents a read-only Mongo user, and add `restrict,port-forwarding,permitopen=` on the bastion key. |
| H8 | No prompt-injection rule. **tech-lead merges "small" PRs to `main` autonomously** and reads a Teams group outsiders can post in. | A team rule that content from PRs, issues, web, Teams and advisories is data, never instructions. Every merge to `main` needs the owner until C2 is fixed. |

### Medium
- **M1. Cross-site GETs reach the portal.** Browsers send no Origin on `<img>` GETs, so a malicious page can loop `/api/health` (it spawns processes) or probe `/api/file`. **Fix:** refuse `Sec-Fetch-Site: cross-site|same-site` on all `/api`, and cache health.
- **M2. `/api/file` (and the phone's `file`) serves dotfiles and `.git`** (`.git/config` and `frontend/.env` returned 200). **Fix:** only document and image types; refuse dotfiles, `.git/`, `memory/`, `*.pem`, `*.key`, `id_*`.
- **M3. The DB and backups are world-readable** (0644, dir 0755); `~/.claude` is 0775. **Fix:** 0700/0600 and `UMask=0077` on the service.
- **M4. The tailnet guard has no `forward`/`prerouting` chains,** so Docker-published ports would bypass it (nothing is published today). **Fix:** add the chains.
- **M5. The `rules.ts` command guards are routine-only and regex-based,** so they're easy to bypass (`git push origin HEAD:refs/heads/main`, `gh api …/merge`, scripts). **Fix:** an approval gate hook on all turns, as UX. The real boundary is C1/C2/H3.
- **M6. The `tag:agentbox` node has `ssh` and `file-sharing` capabilities.** Root could also move the node to another tailnet. **Fix:** remove those grants and enable **Tailnet Lock**.
- **M7. No off-box audit trail:** agents can write the step log. **Fix:** CloudTrail alerts on the agent principal, GitHub audit-log notifications, and a daily export of steps to the Mac.
- **M8. Push is sent without `EXPO_ACCESS_TOKEN`,** so anyone with the push token can send notifications (phishing text). **Fix:** turn on Expo enhanced push security and set the token in a root-only EnvironmentFile.

### Low
- **Gateway:** two stalled forged uploads can hold the heavy slots (no request timeout). `voice/transcribe` is still allowlisted though unused. The upload path check works as an existence oracle. `tasks?limit=-1` bypasses the cap. Raw SQLite and Fastify error text is returned. A device name can include a fake fingerprint. Small-order keys are accepted at claim. Non-Latin-1 filenames give a 500.
- **`/tmp`:** expired Keycloak JWTs in `be4950.log`, `ex1.json`, `ex2.json` (0644). Delete them, and give agents per-agent scratch dirs.
- **Firebase key:** restrict it in Google Cloud to the Android app (package + SHA-1) and the FCM APIs only.
- **Expo:** enable 2FA on the account. It holds the FCM key and the app signing key, which could be used to ship a malicious update.
- **Voice:** the default can use Google's cloud. Consider defaulting to on-device where supported.
- **Mac firewall:** turn on stealth mode, turn off auto-allow for downloaded apps, and identify the listener on `*:64537`.
- **Housekeeping:** remove the locked, unexplained `nova` login account in the VM. Shorten Claude transcript retention.
- **Docs:** the voice limit and claim-limit numbers are stale in MOBILE-PROTOCOL.md.

## Plan

**Phase 0: code and config fixes the orchestrator can apply** (small; restarts only the terminal/screen services and the portal while agents are idle):
1. Lock down the terminal and screen (H1): route them through the portal guard, or add origin checks and passwords. Disable `ttyd.service`.
2. Harden the gateway and portal:
   - the `Sec-Fetch-Site` check (M1);
   - narrow file serving (M2);
   - a request timeout and per-device heavy slots;
   - drop `voice/transcribe`;
   - uniform errors; limit clamping; plain device names; reject small-order keys.
3. Permissions: DB perms and `UMask` (M3); the guard's forward/prerouting chains (M4); delete the `/tmp` JWTs.
4. **Agent rules:** content from PRs, issues, web and Teams is data, not instructions. Every merge to `main` needs the owner (H8).

**Phase 1: owner actions** (accounts and consoles; mostly quick):
5. Encrypt `/Volumes/External` (C4).
6. AWS (C1): a read-only role for agents, the admin key removed from the VM and rotated, MFA on.
7. GitHub (C2): a fine-grained non-admin token for agents, org 2FA, and GitHub Team for a `main` ruleset.
8. The Mac's mongod auth, and blocking VM → Mac loopback/LAN (H2); Remote Login off if unused; firewall stealth mode.
9. Expo 2FA, enhanced push, and the token (M8); restrict the Firebase key.
10. Tailscale: Tailnet Lock, and remove the ssh/file-sharing grants for the tag (M6).
11. Rotate the secrets committed in `digital_risk` and purge them from history (H5): a company task.

**Phase 2: structural** (bigger engineering; makes the in-VM controls real):
12. A separate `agent` user without sudo or docker, an admin token on `/api`, and read-only CLAUDE.md, `/team` and `/skills` (H3, H6).
13. An egress allowlist proxy (C3).
14. An approval gate for merges, pushes to `main`, workflow dispatches, AWS writes and DB writes (M5).
15. Separate agent identities for the browser, an isolated Chromium (H4); a read-only Mongo user (H7); staging `.env` files (C3); off-box audit (M7).
