# Security

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Email
**security@<maintainer-domain>** _(placeholder: the maintainer fills this in before publishing)_,
or use GitHub's private vulnerability reporting on this repository if it is enabled.

Include what you found, how to reproduce it, and the impact you expect. You'll get an
acknowledgement within a few days. Please give us a reasonable time to fix it before you disclose
it publicly.

## Threat model

agentbox runs a team of AI agents with **full control of one Linux VM**: a shell, passwordless
sudo, Docker, a browser with saved logins, and the CLIs you sign in (GitHub, AWS, kubectl…).

**What it protects:**
- **The VM from the internet.** No service listens on a public interface. The portal, terminal,
  screen and phone gateway bind to `127.0.0.1` and are reached only through Tailscale (`tailscale
  serve`, Funnel refused), a Cloudflare Tunnel with Cloudflare Access, or an SSH tunnel.
- **The portal from everyone but the owner.** Outside localhost, every request needs the owner's
  identity (the Tailscale login, or a verified Cloudflare Access JWT) or a session derived from it.
  Host and Origin checks, JSON-only writes and SameSite cookies stop CSRF and DNS rebinding. The
  terminal and screen are reachable only through the portal.
- **Your devices from the VM.** With the mobile module, the tailnet policy lets your devices reach
  the VM on 443 only, and the VM reach nothing; a firewall in the VM drops other tailnet traffic.
- **Secrets from the portal and the phone.** `/secrets` is 0700/0600 and never served.
- **The phone channel.** Signed requests from paired, owner-approved devices only, with replay
  protection and a route allowlist.

**What it does not protect against:**
- **The agents themselves, or anything that steers them.** Agents act with every credential on
  the VM. **Prompt injection** in an issue, PR, web page, email or document can make an agent run
  commands, leak data or push code. Guardrails in prompts and routine rules reduce this; they are
  not a security boundary.
- **A compromised owner device or identity provider account.** Whoever holds your Tailscale or
  Cloudflare login holds the portal.
- **The cloud provider and anyone with console access to the VM.**
- **Supply-chain attacks** on the packages agents install while they work.

The VM is the trust boundary: assume anything on it, including every credential, can be used by
an agent.

## Hardening recommendations

1. **Least-privilege credentials.** Give agents their own GitHub account or a fine-grained token
   limited to the repos they need, without org-admin rights. Never sign in with your personal
   admin accounts.
2. **Cloud access through roles, not keys.** On a cloud VM use an instance role (AWS instance
   profile, GCP service account) scoped to what agents need, read-only where possible. **No
   long-lived admin access keys** on the VM. Prefer staging accounts over production.
3. **Kubernetes:** a namespace-scoped role, not `cluster-admin`.
4. **Encrypt the disk** (the cloud provider's volume encryption, or FileVault / an encrypted volume
   for a Lima VM).
5. **Allow no inbound traffic** in the cloud firewall or security group; use the provider's console
   (SSM Session Manager, IAP) as the emergency way in.
6. **Allowlist egress** if you can: GitHub, your package registries, Anthropic, your cloud APIs.
   It limits what injected instructions can exfiltrate.
7. **Routine rules:** forbid merging to `main` and production deploys without you; review what
   agents merge.
8. **Run `agentbox selftest`** after setup and after changes; it fails on public listeners, an
   unauthenticated portal, Funnel, and loose permissions on secrets and data.
9. **Keep the VM patched** (`unattended-upgrades`) and agentbox updated (`agentbox update`).
10. **Rotate credentials** you gave the agents if you suspect an injection, and review the
    Activity feed and GitHub audit log.

## Known limitations

- **The terminal's credential is visible in the process list.** ttyd accepts its Basic-auth
  credential only on its command line (`-c user:password`; it has no credential-file or
  environment-variable option), so any local process can read it from `ps` or
  `/proc/<pid>/cmdline`. This is accepted: ttyd listens on `127.0.0.1` only and checks Origin
  (`-O`); browsers never see the credential, because the portal's `/term/` proxy adds it; and the
  only local users are the agent user (who owns `/etc/agentbox/ttyd.credential` and already has a
  shell) and root. The credential is there to stop browsers and other loopback clients (a local
  web page, DNS rebinding), not local processes. If you add other local users to the VM, mount
  `/proc` with `hidepid=invisible` or keep them off it.
- **The setup agent's temporary sudo is per unix user, not per agent.** While a setup-agent turn
  runs, `/etc/sudoers.d/agentbox-setup` gives the agent user passwordless sudo, and every agent runs
  as that user. The portal refuses other agents' `sudo` commands during that time, but a process
  started earlier could still use the grant. The narrow rule that lets the portal create the grant
  (`/etc/sudoers.d/agentbox-setup-helper`: only `/usr/local/sbin/agentbox-setup-sudo`) grants
  nothing unless the portal confirms a setup turn is running; `agentbox selftest` treats it as
  expected and warns only about blanket passwordless sudo.
