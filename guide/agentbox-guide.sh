#!/usr/bin/env bash
# `agentbox guide` (the CLI runs this file; docs/GUIDE.md):
#   agentbox guide [--port N] [--tunnel]   start the guide (if needed) and print a one-time link
#   agentbox guide link [--port N]         just a new one-time link (the guide must be running)
#   agentbox guide stop                    stop it: every link and session stops working
#   agentbox guide restart                 update it from the source tree (sync, build) and restart it;
#                                          sessions, the roadmap and the setup agent carry on
#   agentbox guide status
# --port N: the port you reach the guide on from your computer (Lima: the Mac port, e.g. 8699),
#           used only to print the link. --tunnel: the port-forward commands for cloud VMs.
set -euo pipefail
CONFIG="${AGENTBOX_CONFIG:-/etc/agentbox/config.yaml}"
cfg() { AGENTBOX_CONFIG="$CONFIG" agentbox config get "$1" 2>/dev/null || true; }
die() { printf 'agentbox guide: %s\n' "$*" >&2; exit 1; }

CMD=start LOCAL_PORT="" TUNNEL=0
while [ $# -gt 0 ]; do
  case "$1" in
    start|link|stop|restart|status) CMD="$1"; shift ;;
    --port) LOCAL_PORT="${2:?--port N}"; shift 2 ;;
    --tunnel) TUNNEL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see agentbox guide --help)" ;;
  esac
done
[ -z "$LOCAL_PORT" ] || [[ "$LOCAL_PORT" =~ ^[0-9]{1,5}$ ]] || die "bad --port"

if [ "$(id -u)" -ne 0 ]; then
  again=("$CMD")
  [ -z "$LOCAL_PORT" ] || again+=(--port "$LOCAL_PORT")
  [ "$TUNNEL" = 0 ] || again+=(--tunnel)
  exec sudo env AGENTBOX_CONFIG="$CONFIG" bash "$0" "${again[@]}"
fi

[ -f /etc/systemd/system/agentbox-guide.service ] || die "the guide isn't installed (sudo bash <repo>/guide/install.sh, or re-run setup/bootstrap.sh)"
HOST="$(cfg host)" ACCESS="$(cfg access)" AGENT_USER="$(cfg user)"
DATA="$(cfg paths.data)"; DATA="${DATA:-/opt/agentbox/data}"
PORT="$(cfg ports.guide)"; PORT="${PORT:-7699}"
TOKENS="$DATA/guide/tokens"
SESSIONS="$DATA/guide/sessions.json"

running() { systemctl is-active --quiet agentbox-guide; }

case "$CMD" in
  stop)
    if running; then systemctl stop agentbox-guide; echo "guide stopped; its links no longer work"; else echo "the guide isn't running"; fi
    # Sessions survive restarts (crash, `agentbox guide restart`), not a stop.
    rm -f "$SESSIONS"
    exit 0 ;;
  restart)
    SRC="$(cfg paths.src)"
    [ -f "$SRC/guide/install.sh" ] || die "no guide/ under $SRC (paths.src)"
    was=0; running && was=1
    AGENTBOX_CONFIG="$CONFIG" AGENTBOX_SRC="$SRC" bash "$SRC/guide/install.sh" # restarts a running guide
    if [ "$was" = 0 ]; then systemctl start agentbox-guide; fi
    echo "guide restarted: open pages reconnect by themselves; the setup agent resumes if it was working"
    exit 0 ;;
  status)
    if running; then echo "running on 127.0.0.1:$PORT"; else echo "stopped"; fi
    exit 0 ;;
esac

if [ "$CMD" = start ] && ! running; then
  systemctl start agentbox-guide
fi
running || die "the guide didn't start: journalctl -u agentbox-guide -n 50"
for _ in $(seq 1 60); do
  curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/healthz" && break
  sleep 0.5
done
curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" || die "the guide isn't answering on 127.0.0.1:$PORT: journalctl -u agentbox-guide -n 50"

# A one-time token: the guide keeps only its SHA-256 (a file holding the expiry), and deletes it on use.
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA/guide" "$TOKENS"
TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
HASH="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
( umask 077; echo $(( $(date +%s) + 1800 )) > "$TOKENS/$HASH" )
chown "$AGENT_USER:$AGENT_USER" "$TOKENS/$HASH"

# Remote access ready? Then the guide is also at https://<host>/setup/ behind the portal's login.
remote=""
case "$ACCESS" in
  tailscale) [ -n "$(cfg tailscale.hostname)" ] && [ -n "$(cfg owner.tailscale_login)" ] && remote="https://$(cfg tailscale.hostname)/setup/" ;;
  cloudflare) [ -n "$(cfg cloudflare.hostname)" ] && [ -n "$(cfg cloudflare.aud)" ] && [ -n "$(cfg cloudflare.team_domain)" ] && [ -n "$(cfg owner.email)" ] && remote="https://$(cfg cloudflare.hostname)/setup/" ;;
esac
systemctl is-active --quiet agentbox-web || remote=""

link() { echo "http://localhost:$1/?t=$TOKEN"; }
echo "agentbox setup guide · host $HOST · access $ACCESS"
if [ -n "$remote" ]; then
  echo
  echo "  Open: $remote   (behind your $ACCESS login)"
  echo
  echo "  Or through a port forward, with this one-time link (valid 30 minutes):"
  echo "    $(link "${LOCAL_PORT:-$PORT}")"
elif [ "$HOST" = lima ]; then
  echo
  echo "  Open on your Mac (one-time link, valid 30 minutes):"
  if [ -n "$LOCAL_PORT" ]; then
    echo "    $(link "$LOCAL_PORT")"
  else
    echo "    $(link "<guide port>")"
    echo "  where <guide port> is the Mac port forwarded to $PORT: host/lima/up.sh printed it (--ports BASE: BASE-1;"
    echo "  default 7699). On the Mac, host/lima/guide.sh --instance <name> prints the exact link."
  fi
else
  echo
  echo "  One-time link (valid 30 minutes), once port $PORT is forwarded to your computer:"
  echo "    $(link "${LOCAL_PORT:-$PORT}")"
  [ "$TUNNEL" = 1 ] || echo "  How to forward it without opening any port: agentbox guide --tunnel"
fi

if [ "$TUNNEL" = 1 ]; then
  # Best-effort provider hints (link-local metadata, 1 s each).
  ec2_id="" ec2_region="" gcp_name="" gcp_zone=""
  if tok="$(curl -sf --max-time 1 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null)"; then
    ec2_id="$(curl -sf --max-time 1 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/instance-id || true)"
    ec2_region="$(curl -sf --max-time 1 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/placement/region || true)"
  elif curl -sf --max-time 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/name >/dev/null 2>&1; then
    gcp_name="$(curl -sf --max-time 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/name || true)"
    gcp_zone="$(curl -sf --max-time 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone | sed 's|.*/||' || true)"
  fi
  P="$PORT" L="${LOCAL_PORT:-$PORT}"
  cat <<EOF

  Forward the guide's port from your computer (the guide listens on this VM's 127.0.0.1:$P only):

  AWS (Session Manager; no inbound ports; needs the SSM agent and an instance role):
    aws ssm start-session --target ${ec2_id:-<instance-id>}${ec2_region:+ --region $ec2_region} \\
      --document-name AWS-StartPortForwardingSession \\
      --parameters '{"portNumber":["$P"],"localPortNumber":["$L"]}'

  Google Cloud (SSH through IAP; allow 35.235.240.0/20 to port 22 only):
    gcloud compute ssh ${gcp_name:-<vm-name>} --zone ${gcp_zone:-<zone>} --tunnel-through-iap -- -N -L $L:127.0.0.1:$P

  Plain SSH (port 22 open to your IP only):
    ssh -N -L $L:127.0.0.1:$P $AGENT_USER@<vm-address>

  Then open the link above on your computer.
EOF
fi
