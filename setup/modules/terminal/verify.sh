#!/usr/bin/env bash
# terminal: running, loopback only, Origin checked (audit H1).
source "$(dirname "$0")/../../lib/common.sh"
PORT="$(cfg ports.terminal)"
systemctl is-active --quiet agentbox-ttyd || die "agentbox-ttyd isn't running"
agentbox-check-loopback "$PORT" || die "ttyd listens beyond loopback"
systemctl cat agentbox-ttyd | grep -Eq -- ' -O( |$)' || die "ttyd runs without the Origin check (-O)"
echo "terminal ok: ttyd on 127.0.0.1:$PORT with -O"
