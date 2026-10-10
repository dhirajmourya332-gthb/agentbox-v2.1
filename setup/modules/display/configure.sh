#!/usr/bin/env bash
# display: the VNC password (docs/ACCESS.md, access workstream): /etc/agentbox/vnc.password,
# 8 random alphanumerics (VNC uses only 8), 0600, owned by the agent user, who runs x11vnc and the
# portal (whose /screen/ proxy supplies it). Kept across re-runs.
source "$(dirname "$0")/../../lib/common.sh"
need_root
f=/etc/agentbox/vnc.password
install -d -m 0755 /etc/agentbox
if [ ! -s "$f" ]; then
  log "generating the VNC password"
  ( umask 077; head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 8 > "$f" )
fi
chown "$AGENT_USER:$AGENT_USER" "$f"
chmod 0600 "$f"
