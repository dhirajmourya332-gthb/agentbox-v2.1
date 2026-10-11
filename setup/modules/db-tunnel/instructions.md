# Database tunnels

Private databases are reached through named tunnels on 127.0.0.1. agentbox renders this file from
the database-tunnels integration's settings.

    agentbox-tunnel list            # what's configured
    agentbox-tunnel start <name>    # open (no-op if already up)
    agentbox-tunnel status <name>
    agentbox-tunnel stop <name>     # close when you're done

## Settings

| Setting | Value |
|---|---|
| Tunnels agents may open | {{#tunnels}}`{{.}}` {{/tunnels}}{{^tunnels}}all configured (`agentbox-tunnel list`){{/tunnels}} |
| What's behind them | {{#description}}{{description}}{{/description}}{{^description}}(not described: ask the owner before you rely on a port){{/description}} |
| Writes to shared databases | {{writes}} |

## Rules

{{#writes_never}}
- **Read only.** Never write to a database reached through a tunnel.
{{/writes_never}}
{{#writes_ask}}
- Read-only by default. Writes to a shared database need the owner's OK first: say exactly what
  you will run.
{{/writes_ask}}
{{#writes_allowed}}
- Writes are allowed when the task needs them. Schema changes, deletes and bulk updates still need
  the owner's OK first.
{{/writes_allowed}}
- Never print connection strings or passwords; refer to them by name.
- Close the tunnel when you're done.
- If a tunnel fails with an expired sign-in, don't log in yourself: tell the owner.
