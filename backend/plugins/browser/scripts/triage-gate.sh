#!/bin/bash
# browser plugin · triage-gate hook
#
# Cheap probe: did PiBrowser sessions.json change since the last tick?
# Output: single-line JSON per docs/components/plugin-system.md.

set -uo pipefail

STATE_FILE="${PIOS_PLUGIN_LAST_STATE_JSON:-/dev/null}"
SESSIONS_JSON="${PIOS_BROWSER_SESSIONS_JSON:-$HOME/Library/Application Support/PiOS/sessions.json}"

python3 - "$STATE_FILE" "$SESSIONS_JSON" <<'PY'
import json
import os
import sys

state_file, sessions_json = sys.argv[1], sys.argv[2]

current_mtime = 0
try:
    current_mtime = int(os.path.getmtime(sessions_json))
except OSError:
    pass

last_mtime = 0
try:
    with open(state_file, "r", encoding="utf-8") as fh:
        last_mtime = int((json.load(fh) or {}).get("browser_sessions_mtime") or 0)
except Exception:
    pass

if current_mtime > last_mtime and current_mtime > 0:
    print(json.dumps({
        "fire": True,
        "kind": "browser-sessions-updated",
        "payload": {
            "sessions_json": sessions_json,
            "mtime": current_mtime,
        },
        "since_state": {
            "browser_sessions_mtime": current_mtime,
        },
    }, ensure_ascii=False))
else:
    print('{"fire":false}')
PY
