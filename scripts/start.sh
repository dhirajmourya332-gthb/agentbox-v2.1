#!/usr/bin/env bash
# Thin wrapper (v2): host/lima/start.sh [--instance NAME] [--ports BASE] [--open].
exec "$(dirname "$0")/../host/lima/start.sh" "$@"
