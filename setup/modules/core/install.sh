#!/usr/bin/env bash
# core: base packages, Node 22, the agent's directories, helper scripts, sudo policy. Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root

log "base packages"
apt_ensure git jq curl wget unzip rsync ca-certificates gnupg build-essential python3 python3-pip python3-venv \
  iproute2 netcat-openbsd sudo

log "node 22"
if ! have node || [[ "$(node -v)" != v22.* ]]; then
  wait_for_apt # the NodeSource script runs apt-get itself
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt_install nodejs
fi

log "docker (only if docker: true in the config)"
if [ "$(cfg docker)" = "true" ]; then
  apt_ensure docker.io
  usermod -aG docker "$AGENT_USER"
fi

log "directories"
install -d -m 0755 /opt/agentbox
user_dir "$(cfg paths.app)" 0755
# The DB and data: only the agent user (selftest checks this).
user_dir "$(cfg paths.data)" 0700
chmod -R go-rwx "$(cfg paths.data)"
for key in agents work skills team; do user_dir "$(cfg "paths.$key")" 0755; done
user_dir "$(cfg paths.secrets)" 0700

log "helpers"
install_bin "$MODULE_DIR/bin/agentbox-check-loopback"

log "login shells"
cat > /etc/profile.d/agentbox.sh <<'PROFILE'
# agentbox (setup/modules/core): every login shell (the portal's terminal, agents) sees ~/.local/bin.
export PATH="$HOME/.local/bin:$PATH"
PROFILE

log "sudo policy for $AGENT_USER (agent_sudo: $(cfg agent_sudo))"
SUDOERS=/etc/sudoers.d/agentbox-agent
if [ "$(cfg agent_sudo)" = "true" ]; then
  # Agents have full control of the VM (audit H3: selftest warns about this).
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$AGENT_USER" > "$SUDOERS.tmp"
  chmod 0440 "$SUDOERS.tmp" && visudo -cf "$SUDOERS.tmp" >/dev/null && mv "$SUDOERS.tmp" "$SUDOERS"
else
  rm -f "$SUDOERS"
  # Other grants (e.g. Lima's own sudoers entry for the login user) aren't ours to remove. Only
  # blanket NOPASSWD counts: the setup helper's narrow rule below is expected (selftest § 8).
  if sudo -l -U "$AGENT_USER" 2>/dev/null | grep -Eq 'NOPASSWD:[[:space:]]*ALL[[:space:]]*$'; then
    warn "$AGENT_USER still has passwordless sudo from another sudoers entry"
  fi
fi

log "setup agent: temporary sudo helper (docs/V2-ARCHITECTURE.md §10.4)"
# The portal grants sudo only while a setup-agent turn runs, through this root-owned helper; it
# refuses to grant unless the portal confirms such a turn. A grant never survives a reinstall.
HELPER_SRC="$(dirname "$0")/../../../server/setup-agent/agentbox-setup-sudo"
if [ -f "$HELPER_SRC" ]; then
  install -m 0755 -o root -g root "$HELPER_SRC" /usr/local/sbin/agentbox-setup-sudo
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/agentbox-setup-sudo\n' "$AGENT_USER" > /etc/sudoers.d/agentbox-setup-helper.tmp
  chmod 0440 /etc/sudoers.d/agentbox-setup-helper.tmp && visudo -cf /etc/sudoers.d/agentbox-setup-helper.tmp >/dev/null \
    && mv /etc/sudoers.d/agentbox-setup-helper.tmp /etc/sudoers.d/agentbox-setup-helper
  rm -f /etc/sudoers.d/agentbox-setup
fi
