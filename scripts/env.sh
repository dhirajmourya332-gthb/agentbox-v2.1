# Sourced by the other scripts.
set -euo pipefail

VM_NAME="${VM_NAME:-agentbox}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_MOUNT="/mnt/agentbox-src"

# Lima VMs live on the external drive. Refuse to fall back to ~/.lima on the boot disk.
export LIMA_HOME="${LIMA_HOME:-/Volumes/External/lima}"
if [ ! -d "$LIMA_HOME" ]; then
  echo "error: LIMA_HOME ($LIMA_HOME) does not exist — is the External drive mounted?" >&2
  exit 1
fi

LIMACTL="$(command -v limactl)"

vm_status() { "$LIMACTL" list --format '{{.Status}}' "$VM_NAME" 2>/dev/null || true; }
vm() { "$LIMACTL" shell --workdir / "$VM_NAME" "$@"; }
