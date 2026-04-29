#!/bin/bash
# content plugin · triage-gate hook
#
# Cheap probe: did creator workspace receive a newer markdown/text draft
# since the last tick?
#
# Output: single-line JSON per the on_gate contract in
#   docs/components/plugin-system.md
#
# Env contract (set by plugin-registry.js when invoking):
#   PIOS_VAULT                       — vault root
#   PIOS_PLUGIN_LAST_STATE_JSON      — path to this plugin's last-tick state
#                                      file (may not exist on first run)
#
# State key written back: { "content_mtime": <epoch_seconds_int> }

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
STATE_FILE="${PIOS_PLUGIN_LAST_STATE_JSON:-/dev/null}"
WORKSPACE="${VAULT}/Pi/Agents/creator/workspace"

newest_file() {
  if [ ! -d "$WORKSPACE" ]; then
    return 0
  fi
  find "$WORKSPACE" -type f \( -name '*.md' -o -name '*.txt' \) \
    ! -name '*sync-conflict*' \
    -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr \
    | head -1 \
    | cut -d' ' -f2-
}

NEWEST_PATH=$(newest_file)
CURRENT_MTIME=0
if [ -n "$NEWEST_PATH" ] && [ -f "$NEWEST_PATH" ]; then
  if stat -f '%m' "$NEWEST_PATH" >/dev/null 2>&1; then
    CURRENT_MTIME=$(stat -f '%m' "$NEWEST_PATH" 2>/dev/null || echo 0)
  else
    CURRENT_MTIME=$(stat -c '%Y' "$NEWEST_PATH" 2>/dev/null || echo 0)
  fi
fi

LAST_MTIME=0
if [ -r "$STATE_FILE" ]; then
  if command -v jq >/dev/null 2>&1; then
    LAST_MTIME=$(jq -r '.content_mtime // 0' "$STATE_FILE" 2>/dev/null || echo 0)
    LAST_MTIME=${LAST_MTIME:-0}
  else
    LAST_MTIME=$(grep -o '"content_mtime"[^,}]*' "$STATE_FILE" 2>/dev/null \
                 | sed -E 's/[^0-9]//g' | head -1)
    LAST_MTIME=${LAST_MTIME:-0}
  fi
fi

escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/; $s/\\n$//'
}

if [ "$CURRENT_MTIME" -gt "$LAST_MTIME" ] && [ "$CURRENT_MTIME" -gt 0 ]; then
  ESCAPED_PATH=$(escape_json "$NEWEST_PATH")
  printf '{"fire":true,"kind":"new-content-draft","payload":{"content_path":"%s","mtime":%s},"since_state":{"content_mtime":%s}}\n' \
    "$ESCAPED_PATH" "$CURRENT_MTIME" "$CURRENT_MTIME"
else
  printf '{"fire":false}\n'
fi
