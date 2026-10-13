#!/usr/bin/env bash
# bench: the bridge token (<secrets>/bench.token, 0600, the agent user) and pyserial for agents.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure python3-serial
secrets="$(cfg paths.secrets)"
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$secrets"
f="$secrets/bench.token"
if [ ! -s "$f" ]; then
  log "generating the bridge token"
  ( umask 077; head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 40 > "$f" )
fi
chown "$AGENT_USER:$AGENT_USER" "$f"
chmod 0600 "$f"
echo "bench: token ready; now run the bridge on your computer (Integrations → Device bridge → Download)"
