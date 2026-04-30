#!/bin/bash
# wechat plugin · triage-gate hook
#
# Cheap probe: did today's wechat daily_raw .md change since the last tick?
# Output: single-line JSON per the on_gate contract in
#   docs/components/plugin-system.md
#
# Env contract (set by plugin-registry.js when invoking):
#   PIOS_VAULT                       — vault root
#   PIOS_OWNER                       — owner key
#   PIOS_PLUGIN_LAST_STATE_JSON     — path to this plugin's last-tick state
#                                      file (may not exist on first run)
#
# State key written back: { "wechat_mtime": <epoch_seconds_int> }

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
OWNER="${PIOS_OWNER:-owner}"
STATE_FILE="${PIOS_PLUGIN_LAST_STATE_JSON:-/dev/null}"
TODAY=$(date +%Y-%m-%d)

RAW_PATH="${VAULT}/${OWNER}/Pipeline/AI_Wechat_Digest/daily_raw/${TODAY}.md"

# Get current mtime of the daily_raw file (seconds since epoch).
CURRENT_MTIME=0
if [ -f "$RAW_PATH" ]; then
  if stat -f '%m' "$RAW_PATH" >/dev/null 2>&1; then
    CURRENT_MTIME=$(stat -f '%m' "$RAW_PATH" 2>/dev/null || echo 0)   # macOS BSD
  else
    CURRENT_MTIME=$(stat -c '%Y' "$RAW_PATH" 2>/dev/null || echo 0)   # GNU
  fi
fi

# Read last-known mtime from prior state (0 if no prior state).
LAST_MTIME=0
if [ -r "$STATE_FILE" ]; then
  if command -v jq >/dev/null 2>&1; then
    LAST_MTIME=$(jq -r '.wechat_mtime // 0' "$STATE_FILE" 2>/dev/null || echo 0)
  else
    # jq-less fallback: a single grep+sed for the field.
    LAST_MTIME=$(grep -o '"wechat_mtime"[^,}]*' "$STATE_FILE" 2>/dev/null \
                 | sed -E 's/[^0-9]//g' | head -1)
    LAST_MTIME=${LAST_MTIME:-0}
  fi
fi

# Decide fire/skip.
if [ "$CURRENT_MTIME" -gt "$LAST_MTIME" ] && [ "$CURRENT_MTIME" -gt 0 ]; then
  # Fire — emit single-line JSON per contract.
  printf '{"fire":true,"kind":"new-daily-raw","payload":{"raw_path":"%s","mtime":%s,"date":"%s"},"since_state":{"wechat_mtime":%s}}\n' \
    "$RAW_PATH" "$CURRENT_MTIME" "$TODAY" "$CURRENT_MTIME"
else
  printf '{"fire":false}\n'
fi
