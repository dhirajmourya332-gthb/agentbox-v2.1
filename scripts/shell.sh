#!/usr/bin/env bash
# Thin wrapper (v2): host/lima/shell.sh [--instance NAME] [cmd...].
exec "$(dirname "$0")/../host/lima/shell.sh" "$@"
