#!/usr/bin/env bash
# terminal: the ttyd credential the portal's /term/ proxy uses (docs/ACCESS.md, access workstream):
# /etc/agentbox/ttyd.credential = agentbox:<32 random characters>, 0600, owned by the agent user
# (who runs both the portal and ttyd). Kept across re-runs.
source "$(dirname "$0")/../../lib/common.sh"
need_root
f=/etc/agentbox/ttyd.credential
install -d -m 0755 /etc/agentbox
if [ ! -s "$f" ]; then
  log "generating the ttyd credential"
  ( umask 077; printf 'agentbox:%s' "$(head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 32)" > "$f" )
fi
chown "$AGENT_USER:$AGENT_USER" "$f"
chmod 0600 "$f"
