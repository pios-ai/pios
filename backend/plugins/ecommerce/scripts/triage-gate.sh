#!/bin/bash
# ecommerce plugin · triage-gate hook
#
# Cheap probe: did hawkeye produce a new scan report since the last tick?
# Checks Pi/Output/intel/hawkeye/ and Pi/Output/radar/hawkeye/ for the
# newest .md file and compares its mtime to stored state.
#
# Output: single-line JSON per the on_gate contract in
#   docs/components/plugin-system.md
#
# Env contract (set by plugin-registry.js when invoking):
#   PIOS_VAULT                       — vault root
#   PIOS_PLUGIN_LAST_STATE_JSON     — path to this plugin's last-tick state
#                                      file (may not exist on first run)
#
# State key written back: { "hawkeye_mtime": <epoch_seconds_int> }

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
STATE_FILE="${PIOS_PLUGIN_LAST_STATE_JSON:-/dev/null}"

INTEL_DIR="${VAULT}/Pi/Output/intel/hawkeye"
RADAR_DIR="${VAULT}/Pi/Output/radar/hawkeye"

# Find the newest .md file across both output directories (excluding README).
NEWEST_FILE=""
CURRENT_MTIME=0

for dir in "$INTEL_DIR" "$RADAR_DIR"; do
  if [ ! -d "$dir" ]; then
    continue
  fi
  # List .md files sorted by mtime descending; pick the first (newest).
  candidate=$(find "$dir" -maxdepth 1 -name "*.md" ! -name "README.md" -type f \
    -exec stat -f '%m %N' {} \; 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}')
  if [ -z "$candidate" ]; then
    # GNU stat fallback
    candidate=$(find "$dir" -maxdepth 1 -name "*.md" ! -name "README.md" -type f \
      -exec stat -c '%Y %n' {} \; 2>/dev/null \
      | sort -rn | head -1 | awk '{print $2}')
  fi
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    if stat -f '%m' "$candidate" >/dev/null 2>&1; then
      mtime=$(stat -f '%m' "$candidate" 2>/dev/null || echo 0)   # macOS BSD
    else
      mtime=$(stat -c '%Y' "$candidate" 2>/dev/null || echo 0)   # GNU
    fi
    if [ "$mtime" -gt "$CURRENT_MTIME" ]; then
      CURRENT_MTIME=$mtime
      NEWEST_FILE=$candidate
    fi
  fi
done

# Read last-known mtime from prior state (0 if no prior state).
LAST_MTIME=0
if [ -r "$STATE_FILE" ]; then
  if command -v jq >/dev/null 2>&1; then
    LAST_MTIME=$(jq -r '.hawkeye_mtime // 0' "$STATE_FILE" 2>/dev/null || echo 0)
    LAST_MTIME=${LAST_MTIME:-0}
  else
    LAST_MTIME=$(grep -o '"hawkeye_mtime"[^,}]*' "$STATE_FILE" 2>/dev/null \
                 | sed -E 's/[^0-9]//g' | head -1)
    LAST_MTIME=${LAST_MTIME:-0}
  fi
fi

# Decide fire/skip.
if [ "$CURRENT_MTIME" -gt "$LAST_MTIME" ] && [ "$CURRENT_MTIME" -gt 0 ]; then
  ESCAPED_FILE=${NEWEST_FILE//\\/\\\\}
  ESCAPED_FILE=${ESCAPED_FILE//\"/\\\"}
  printf '{"fire":true,"kind":"new-hawkeye-scan","payload":{"scan_path":"%s","mtime":%s},"since_state":{"hawkeye_mtime":%s}}\n' \
    "$ESCAPED_FILE" "$CURRENT_MTIME" "$CURRENT_MTIME"
else
  printf '{"fire":false}\n'
fi
