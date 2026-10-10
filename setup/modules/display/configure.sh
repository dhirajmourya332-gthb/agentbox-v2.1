#!/usr/bin/env bash
# display: the VNC password (docs/V2-ARCHITECTURE.md § 5). x11vnc reads <secrets>/vnc.passwd
# (its -storepasswd format); the plain password stays in <secrets>/vnc-password (0600) for the
# portal's /screen proxy (access workstream). Kept across re-runs.
source "$(dirname "$0")/../../lib/common.sh"
need_root
S="$(cfg paths.secrets)"
user_dir "$S" 0700
if [ ! -s "$S/vnc-password" ]; then
  log "generating the VNC password"
  # VNC passwords are at most 8 characters.
  ( umask 077; head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 8 > "$S/vnc-password" )
fi
x11vnc -storepasswd "$(cat "$S/vnc-password")" "$S/vnc.passwd" >/dev/null 2>&1
chown "$AGENT_USER:$AGENT_USER" "$S/vnc-password" "$S/vnc.passwd"
chmod 0600 "$S/vnc-password" "$S/vnc.passwd"
