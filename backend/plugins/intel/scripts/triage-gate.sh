#!/bin/bash
# intel plugin · triage-gate hook
#
# Cheap probe: did intel produce new report files since the last tick?
# Checks Pi/Agents/intel/workspace recursively, excluding scan-state files,
# and compares report mtimes to stored state.
#
# Output: single-line JSON per the on_gate contract in
#   docs/components/plugin-system.md
#
# State key written back: { "intel_mtime": <epoch_seconds_int> }

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
STATE_FILE="${PIOS_PLUGIN_LAST_STATE_JSON:-/dev/null}"
WORKSPACE="${VAULT}/Pi/Agents/intel/workspace"

stat_mtime() {
  if stat -f '%m' "$1" >/dev/null 2>&1; then
    stat -f '%m' "$1" 2>/dev/null || echo 0
  else
    stat -c '%Y' "$1" 2>/dev/null || echo 0
  fi
}

LAST_MTIME=0
if [ -r "$STATE_FILE" ]; then
  if command -v jq >/dev/null 2>&1; then
    LAST_MTIME=$(jq -r '.intel_mtime // 0' "$STATE_FILE" 2>/dev/null || echo 0)
    LAST_MTIME=${LAST_MTIME:-0}
  else
    LAST_MTIME=$(grep -o '"intel_mtime"[^,}]*' "$STATE_FILE" 2>/dev/null \
                 | sed -E 's/[^0-9]//g' | head -1)
    LAST_MTIME=${LAST_MTIME:-0}
  fi
fi

CURRENT_MTIME=0
NEW_REPORTS_WITH_MTIME=""

if [ -d "$WORKSPACE" ]; then
  while IFS= read -r file; do
    mtime=$(stat_mtime "$file")
    if [ "$mtime" -gt "$CURRENT_MTIME" ]; then
      CURRENT_MTIME=$mtime
    fi
    if [ "$mtime" -gt "$LAST_MTIME" ]; then
      NEW_REPORTS_WITH_MTIME="${NEW_REPORTS_WITH_MTIME}${mtime}	${file}
"
    fi
  done < <(find "$WORKSPACE" -type f -name "*.md" \
    ! -path "*/scan-state/*" \
    ! -name "README.md" \
    ! -name "*.sync-conflict*" \
    2>/dev/null)
fi

if [ "$CURRENT_MTIME" -gt "$LAST_MTIME" ] && [ -n "$NEW_REPORTS_WITH_MTIME" ]; then
  # Keep the gate payload small and newest-first. The registry state still
  # records the latest mtime, so future ticks remain idempotent.
  NEW_REPORTS=$(printf '%s' "$NEW_REPORTS_WITH_MTIME" | sort -rn | head -10 | cut -f2-)
  if command -v python3 >/dev/null 2>&1; then
    REPORTS_JSON=$(printf '%s' "$NEW_REPORTS" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')
  else
    REPORTS_JSON="[]"
  fi
  printf '{"fire":true,"kind":"new-intel-report","payload":{"workspace":"%s","report_paths":%s,"mtime":%s},"since_state":{"intel_mtime":%s}}\n' \
    "$WORKSPACE" "$REPORTS_JSON" "$CURRENT_MTIME" "$CURRENT_MTIME"
else
  printf '{"fire":false}\n'
fi
