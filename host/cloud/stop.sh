#!/usr/bin/env bash
# cloud host: stop agentbox's services; refuses while agents are busy unless --force. Run on the VM.
exec sudo agentbox stop "$@"
