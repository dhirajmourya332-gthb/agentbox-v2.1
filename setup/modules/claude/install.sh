#!/usr/bin/env bash
# claude: the Claude Code CLI for the agent user, by the official installer (~/.local/bin/claude).
source "$(dirname "$0")/../../lib/common.sh"
need_root
log "claude code (official installer, as $AGENT_USER)"
as_user 'command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null'
as_user 'claude --version'
