# Database tunnels (example: edit to fit your team)

Private databases are reached through named tunnels on 127.0.0.1:

    agentbox-tunnel list            # what's configured
    agentbox-tunnel start main      # open (no-op if already up)
    agentbox-tunnel status main
    agentbox-tunnel stop main       # close when you're done

- `main`: MongoDB on 127.0.0.1:27017, Redis on 127.0.0.1:6379 (replace with yours).
- Read-only by default. Writes to a shared database need the owner's OK first.
- If a tunnel fails with an expired sign-in, don't log in yourself: tell the owner.
