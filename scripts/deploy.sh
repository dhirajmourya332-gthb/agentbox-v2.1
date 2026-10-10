#!/usr/bin/env bash
# Thin wrapper (v2): host/lima/deploy.sh [--instance NAME] [--force].
exec "$(dirname "$0")/../host/lima/deploy.sh" "$@"
