# Shared helpers for the access module's scripts. Sourced, not run.
# Never prints secrets: tokens and certificates are only ever tested for presence.
# Callers may inherit UMask=0077 (the portal's and guide's sudo): system files need normal modes.
[ "$(id -u)" -ne 0 ] || umask 022

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

cfg()  { agentbox config get "$1" 2>/dev/null || true; }
cfg_set() { agentbox config set "$1" "$2" >/dev/null; }

need_root() { [ "$(id -u)" -eq 0 ] || die "Run this with sudo."; }

mode()        { cfg access; }
portal_port() { local p; p="$(cfg ports.portal)"; echo "${p:-7700}"; }
app_dir()     { local p; p="$(cfg paths.app)"; echo "${p:-/opt/agentbox/app}"; }
data_dir()    { local p; p="$(cfg paths.data)"; echo "${p:-/opt/agentbox/data}"; }

# json_get <python expression over `d`>: reads JSON on stdin, prints the expression ('' on error).
json_get() { python3 -c "import sys, json
try:
    d = json.load(sys.stdin); v = ($1)
    print('' if v is None else (json.dumps(v) if isinstance(v, (dict, list)) else v))
except Exception:
    print('')"; }

# portal_status <Host header> [extra curl args...]: the portal's HTTP status for GET /api/auth/me.
portal_status() {
  local host="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $host" "$@" "http://127.0.0.1:$(portal_port)/api/auth/me" || echo 000
}
