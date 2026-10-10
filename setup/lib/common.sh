# Sourced by module scripts (setup/modules/<id>/{install,configure,verify}.sh).
# `agentbox module install` runs them as root with AGENTBOX_USER, AGENTBOX_HOME, AGENTBOX_SRC,
# AGENTBOX_MODULE_DIR and AGENTBOX_CONFIG set; verify.sh runs as the agent user.
# shellcheck shell=bash disable=SC2034  # variables for the scripts that source this
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Read the config through the CLI (docs/V2-ARCHITECTURE.md § 3). Prints "" for a missing key.
cfg() { agentbox config get "$1" 2>/dev/null || true; }

AGENT_USER="${AGENTBOX_USER:-$(cfg user)}"
AGENT_HOME="${AGENTBOX_HOME:-$(getent passwd "$AGENT_USER" | cut -d: -f6)}"
SRC="${AGENTBOX_SRC:-$(cfg paths.src)}"
MODULE_DIR="${AGENTBOX_MODULE_DIR:-$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)}"

log() { printf -- '--> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
is_root() { [ "$(id -u)" -eq 0 ]; }
need_root() { is_root || die "run through 'sudo agentbox module install $(basename "$MODULE_DIR")'"; }

# Run a command line as the agent user, in a login shell.
as_user() {
  if [ "$(id -un)" = "$AGENT_USER" ]; then bash -lc "$*"; else sudo -u "$AGENT_USER" -H bash -lc "$*"; fi
}

# apt-get update at most once an hour (and once per script run), then install quietly.
_apt_updated=0
apt_install() {
  local stamp=/var/lib/apt/periodic/agentbox-update-stamp
  if [ "$_apt_updated" = 0 ] && { [ ! -f "$stamp" ] || [ -n "$(find "$stamp" -mmin +60 2>/dev/null)" ]; }; then
    apt-get update -qq
    mkdir -p "$(dirname "$stamp")" && touch "$stamp"
  fi
  _apt_updated=1
  apt-get install -y -qq --no-install-recommends "$@" >/dev/null
}
# Install only the packages that are missing (fast re-runs).
apt_ensure() {
  local missing=()
  for p in "$@"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || missing+=("$p"); done
  [ ${#missing[@]} -eq 0 ] || apt_install "${missing[@]}"
}

# Install a helper script into /usr/local/bin.
install_bin() { install -m 0755 "$1" "/usr/local/bin/${2:-$(basename "$1")}"; }

# A directory owned by the agent user with the given mode.
user_dir() { install -d -m "${2:-0755}" -o "$AGENT_USER" -g "$AGENT_USER" "$1"; }

# True when systemd is running (not in a plain container).
has_systemd() { [ -d /run/systemd/system ]; }
