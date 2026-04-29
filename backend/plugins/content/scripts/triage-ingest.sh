#!/bin/bash
# content plugin · triage-ingest hook
#
# Reads the content draft identified by triage-gate and emits a compact event
# for triage. This script does not generate content; the creator agent owns
# production.
#
# Output: single-line JSON per the on_ingest contract in
#   docs/components/plugin-system.md
#
# Env contract:
#   PIOS_VAULT                  — vault root
#   PIOS_PLUGIN_GATE_PAYLOAD    — JSON string from on_gate's payload
#                                  (contains content_path, mtime)

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
GATE_PAYLOAD="${PIOS_PLUGIN_GATE_PAYLOAD:-{}}"

CONTENT_PATH=""
if command -v jq >/dev/null 2>&1; then
  CONTENT_PATH=$(echo "$GATE_PAYLOAD" | jq -r '.content_path // empty' 2>/dev/null)
fi

if [ -z "$CONTENT_PATH" ]; then
  CONTENT_PATH=$(find "${VAULT}/Pi/Agents/creator/workspace" -type f \( -name '*.md' -o -name '*.txt' \) \
    ! -name '*sync-conflict*' \
    -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr \
    | head -1 \
    | cut -d' ' -f2-)
fi

if [ ! -r "$CONTENT_PATH" ]; then
  printf '{"events":[],"summary_for_triage":"content: draft not readable: %s"}\n' "$CONTENT_PATH"
  exit 0
fi

TOTAL_LINES=$(wc -l < "$CONTENT_PATH" 2>/dev/null | tr -d ' \n')
TOTAL_LINES=${TOTAL_LINES:-0}

TITLE=$(grep -m1 '^# ' "$CONTENT_PATH" 2>/dev/null | sed 's/^# *//' | sed 's/[[:space:]]*$//' || echo "")
if [ -z "$TITLE" ]; then
  TITLE=$(basename "$CONTENT_PATH")
fi

SUMMARY=$(awk '
  BEGIN { in_fm = 0; seen_first = 0 }
  /^---[[:space:]]*$/ {
    if (!seen_first) {
      in_fm = !in_fm
      seen_first = 1
      next
    }
    if (in_fm) {
      in_fm = 0
      next
    }
  }
  in_fm { next }
  /^[[:space:]]*$/ { next }
  /^#/ { next }
  { sub(/[[:space:]]*$/, ""); print; exit }
' "$CONTENT_PATH" 2>/dev/null || echo "")

escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/; $s/\\n$//'
}

ESCAPED_PATH=$(escape_json "$CONTENT_PATH")
ESCAPED_TITLE=$(escape_json "$TITLE")
ESCAPED_SUMMARY=$(escape_json "$SUMMARY")
SUMMARY_TEXT="content: new creator draft — ${TITLE}"
ESCAPED_SUMMARY_FOR_TRIAGE=$(escape_json "$SUMMARY_TEXT")

cat <<JSON
{"events":[{"kind":"content-ready","summary":"creator content draft updated","content_path":"${ESCAPED_PATH}","title":"${ESCAPED_TITLE}","total_lines":${TOTAL_LINES},"excerpt":"${ESCAPED_SUMMARY}"}],"summary_for_triage":"${ESCAPED_SUMMARY_FOR_TRIAGE}"}
JSON
