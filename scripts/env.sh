# Sourced by the other scripts.
set -euo pipefail

VM_NAME="${VM_NAME:-agentbox}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_MOUNT="/mnt/agentbox-src"

# Where Lima keeps its VMs. Set LIMA_HOME to put them elsewhere (e.g. on an external drive); if you
# set it, it must exist, so an unmounted drive never makes Lima silently fall back to ~/.lima.
if [ -n "${LIMA_HOME:-}" ] && [ ! -d "$LIMA_HOME" ]; then
  echo "error: LIMA_HOME ($LIMA_HOME) does not exist — is its drive mounted?" >&2
  exit 1
fi
export LIMA_HOME="${LIMA_HOME:-$HOME/.lima}"

LIMACTL="$(command -v limactl)"

vm_status() { "$LIMACTL" list --format '{{.Status}}' "$VM_NAME" 2>/dev/null || true; }
vm() { "$LIMACTL" shell --workdir / "$VM_NAME" "$@"; }
