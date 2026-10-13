#!/usr/bin/env bash
# bench: the portal's connectivity test (bridge connected, round trip, serial relay through the loopback port).
source "$(dirname "$0")/../../lib/common.sh"
out="$(agentbox api -X POST /bench/test 2>&1 || true)"
python3 - "$out" <<'PY' || exit 1
import json, sys
try:
    r = json.loads(sys.argv[1])
except Exception:
    sys.exit("bench test didn't answer: %s" % sys.argv[1][:300])
for s in r["steps"]:
    print("%s %-13s %s" % ("✔" if s["ok"] else "✖", s["name"], s["detail"]))
sys.exit(0 if r["ok"] else 1)
PY
