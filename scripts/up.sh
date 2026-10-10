#!/usr/bin/env bash
# Thin wrapper (v2): host/lima/up.sh. Options: --instance NAME --ports BASE --lima-home DIR.
exec "$(dirname "$0")/../host/lima/up.sh" "$@"
