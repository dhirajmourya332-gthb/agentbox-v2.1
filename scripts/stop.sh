#!/usr/bin/env bash
# Thin wrapper (v2): host/lima/stop.sh [--instance NAME] [--force].
exec "$(dirname "$0")/../host/lima/stop.sh" "$@"
