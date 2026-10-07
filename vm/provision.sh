#!/usr/bin/env bash
# Provision the agentbox VM. Run as root: provision.sh <agent-user>. Safe to re-run.
set -euo pipefail

AGENT_USER="${1:?usage: provision.sh <user>}"
AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive

as_user() { sudo -u "$AGENT_USER" -H bash -lc "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "--> apt packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  xvfb fluxbox x11vnc novnc python3-websockify ttyd \
  xdotool scrot imagemagick wmctrl xclip x11-utils \
  fonts-noto fonts-noto-color-emoji fonts-liberation \
  git jq curl wget unzip rsync ca-certificates gnupg build-essential \
  python3-pip python3-venv docker.io >/dev/null

echo "--> node 22"
if ! have node || [[ "$(node -v)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "--> github cli"
if ! have gh; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi

echo "--> aws cli v2"
if ! have aws; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscli.zip"
  unzip -q "$tmp/awscli.zip" -d "$tmp" && "$tmp/aws/install" >/dev/null
  rm -rf "$tmp"
fi

echo "--> chromium (playwright build)"
npx -y playwright@latest install-deps chromium >/dev/null
as_user "npx -y playwright@latest install chromium >/dev/null"

echo "--> claude code"
as_user "command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null"

echo "--> user, dirs, helpers"
usermod -aG docker "$AGENT_USER"
mkdir -p /opt/agentbox/app /opt/agentbox/data /agents /work /skills
chown -R "$AGENT_USER:$AGENT_USER" /opt/agentbox /agents /work /skills
install -m 0755 "$SRC/vm/bin/agentbox-chromium" /usr/local/bin/agentbox-chromium
# Every login shell (ttyd, limactl shell, agents) sees the shared display.
cat > /etc/profile.d/agentbox.sh <<'EOF'
export DISPLAY=:99
export PATH="$HOME/.local/bin:$PATH"
EOF

echo "--> systemd units"
for unit in "$SRC"/vm/systemd/*.service; do
  sed -e "s|@USER@|$AGENT_USER|g" -e "s|@HOME@|$AGENT_HOME|g" "$unit" \
    > "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
for svc in agentbox-xvfb agentbox-wm agentbox-vnc agentbox-novnc agentbox-ttyd agentbox-chromium agentbox-web; do
  systemctl enable "$svc" >/dev/null 2>&1
done
# agentbox-web starts after deploy (needs node_modules); the display stack starts now.
systemctl restart agentbox-xvfb agentbox-wm agentbox-vnc agentbox-novnc agentbox-ttyd agentbox-chromium

echo "--> provisioned"
