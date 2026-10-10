#!/usr/bin/env bash
# cloud host: start agentbox's services (they also start on boot). Run on the VM.
exec sudo agentbox start "$@"
