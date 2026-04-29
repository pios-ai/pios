#!/bin/bash
# location plugin · triage-gate hook
#
# Cheap probe: did today's location digest, or the newest location markdown
# file, change since the last tick?

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
OWNER="${PIOS_OWNER:-owner}"
STATE_FILE="${PIOS_PLUGIN_LAST_STATE_JSON:-/dev/null}"
TODAY=$(date +%Y-%m-%d)
TODAY_PATH="${VAULT}/${OWNER}/Pipeline/AI_Location_Digest/daily_location/${TODAY}.md"
LOCATION_DIR="${VAULT}/${OWNER}/Pipeline/AI_Location_Digest"

python3 - "$STATE_FILE" "$TODAY_PATH" "$LOCATION_DIR" <<'PY'
import json
import os
import sys

state_file, today_path, location_dir = sys.argv[1], sys.argv[2], sys.argv[3]

def newest_location_file():
    if os.path.isfile(today_path):
        return today_path
    if not os.path.isdir(location_dir):
        return ""
    newest = None
    for root, dirs, files in os.walk(location_dir):
        dirs[:] = [d for d in dirs if "sync-conflict" not in d]
        for name in files:
            if not name.endswith(".md") or "sync-conflict" in name:
                continue
            full = os.path.join(root, name)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            if newest is None or mtime > newest[0]:
                newest = (mtime, full)
    return newest[1] if newest else ""

location_path = newest_location_file()
current_mtime = 0
try:
    current_mtime = int(os.path.getmtime(location_path)) if location_path else 0
except OSError:
    pass

last_mtime = 0
try:
    with open(state_file, "r", encoding="utf-8") as fh:
        last_mtime = int((json.load(fh) or {}).get("location_mtime") or 0)
except Exception:
    pass

if current_mtime > last_mtime and current_mtime > 0:
    print(json.dumps({
        "fire": True,
        "kind": "new-location-digest",
        "payload": {
            "location_path": location_path,
            "mtime": current_mtime,
        },
        "since_state": {
            "location_mtime": current_mtime,
        },
    }, ensure_ascii=False))
else:
    print('{"fire":false}')
PY
