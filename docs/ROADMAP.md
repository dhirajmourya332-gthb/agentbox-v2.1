# Roadmap

Direction, not commitments. Open an issue to discuss any of it.

## Now: portable, modular setup (v2)
- One bootstrap command on any Ubuntu 24.04 VM, then a guided setup page: a live terminal plus a
  roadmap that ticks itself off as each module's check passes.
- Hosts: any cloud VM (default) or a local Lima VM on macOS.
- Access with zero inbound ports: Tailscale or Cloudflare Tunnel + Access, with a portal login;
  the terminal and screen served only through the portal.
- The `agentbox` CLI (`status`, `config`, `module`, `secret`, `update`, `selftest`).
- A security self-test as the last setup step.
- Generic seed skills driven by `/team` rule files.

## Next
- **Approval gate:** merges, deploy workflows and cloud write commands pause for the owner's
  Approve / Reject, enforced on every tool call.
- **Hard tool limits per agent:** tools an agent wasn't given are refused, not just discouraged.
- **Chat integrations:** agents in your team's chat channels (e.g. Microsoft Teams or Slack), and
  one-way status updates into a channel.
- **Export and import** of an install (agents, skills, team rules, routines), with secrets encrypted
  by a passphrase.
- **iOS app.**

## Later
- Egress allowlisting as a module.
- Per-agent credentials (separate GitHub and cloud identities per role).
- Multi-user access with per-user audit trails.
