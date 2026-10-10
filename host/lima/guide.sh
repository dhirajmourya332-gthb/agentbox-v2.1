#!/usr/bin/env bash
# Start the setup guide in the Lima VM and print its one-time link with the Mac port.
#   host/lima/guide.sh [--instance NAME] [--ports BASE] [--lima-home DIR] [stop|status]
source "$(dirname "$0")/lib.sh"
case "${ARGS[0]:-}" in
  stop|status) vm agentbox guide "${ARGS[0]}" ;;
  "") vm agentbox guide --port "$PORT_GUIDE" ;;
  *) echo "usage: host/lima/guide.sh [--instance NAME] [--ports BASE] [stop|status]" >&2; exit 2 ;;
esac
