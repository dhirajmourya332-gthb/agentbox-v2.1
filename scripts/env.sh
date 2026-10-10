# shellcheck shell=bash disable=SC2034  # a library: its variables are used by the scripts that source it
# Kept for old callers (v2): the Lima host options now live in host/lima/lib.sh.
# shellcheck source=../host/lima/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../host/lima/lib.sh"
