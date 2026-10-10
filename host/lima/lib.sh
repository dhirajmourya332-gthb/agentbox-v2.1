# shellcheck shell=bash disable=SC2034  # a library: its variables are used by the scripts that source it
# Sourced by host/lima/*.sh (run on the Mac). Options, from flags or env (defaults = pre-v2):
#   --instance NAME   AGENTBOX_INSTANCE (or VM_NAME)   Lima instance          default: agentbox
#   --lima-home DIR   LIMA_HOME                         where Lima keeps VMs   default: ~/.lima
#   --ports BASE      AGENTBOX_PORT_BASE                Mac ports: portal BASE, guide BASE-1
#                                                       (terminal and screen go through the portal)  default: 7700
#   --cpus N --memory SIZE --disk SIZE (up.sh only)     default: 4, 6GiB, 60GiB
# Run v2 beside an existing install:  host/lima/up.sh --instance agentbox-v2 --ports 8700
# Other arguments are left in ARGS for the script.
set -euo pipefail

VM_NAME="${AGENTBOX_INSTANCE:-${VM_NAME:-agentbox}}"
PORT_BASE="${AGENTBOX_PORT_BASE:-7700}"
CPUS="${AGENTBOX_CPUS:-4}" MEMORY="${AGENTBOX_MEMORY:-6GiB}" DISK="${AGENTBOX_DISK:-60GiB}"
LIMA_HOME="${LIMA_HOME:-$HOME/.lima}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) VM_NAME="${2:?}"; shift 2 ;;
    --lima-home) LIMA_HOME="${2:?}"; shift 2 ;;
    --ports) PORT_BASE="${2:?}"; shift 2 ;;
    --cpus) CPUS="${2:?}"; shift 2 ;;
    --memory) MEMORY="${2:?}"; shift 2 ;;
    --disk) DISK="${2:?}"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[[ "$VM_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "error: bad instance name: $VM_NAME" >&2; exit 1; }
[[ "$PORT_BASE" =~ ^[0-9]+$ ]] && [ "$PORT_BASE" -ge 1025 ] && [ "$PORT_BASE" -le 65000 ] || { echo "error: bad --ports $PORT_BASE" >&2; exit 1; }
PORT_PORTAL=$PORT_BASE PORT_GUIDE=$((PORT_BASE - 1))

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_MOUNT="/mnt/agentbox-src"

# Lima VMs live where LIMA_HOME says. Refuse to fall back to ~/.lima silently.
export LIMA_HOME
if [ ! -d "$LIMA_HOME" ]; then
  echo "error: LIMA_HOME ($LIMA_HOME) does not exist (is the drive mounted? or pass --lima-home)" >&2
  exit 1
fi
LIMACTL="$(command -v limactl || true)"
[ -x "$LIMACTL" ] || LIMACTL=/opt/homebrew/bin/limactl
[ -x "$LIMACTL" ] || { echo "error: limactl not found" >&2; exit 1; }

vm_status() { "$LIMACTL" list --format '{{.Status}}' "$VM_NAME" 2>/dev/null || true; }
vm() { "$LIMACTL" shell --workdir / "$VM_NAME" "$@"; }

# Agents busy? Asked inside the VM with the local token. Prints the count; 0 if unknown.
busy_count() {
  vm agentbox api /api/tasks 2>/dev/null \
    | python3 -c 'import sys, json; print(sum(t["status"] in ("running", "queued") for t in json.load(sys.stdin)))' 2>/dev/null || echo 0
}

urls() {
  cat <<URLS
  Portal    http://localhost:$PORT_PORTAL   (terminal and screen: /term/ and /screen/ behind it)
URLS
}
