#!/bin/bash
# photos plugin · triage-ingest hook
#
# Reads today's photo diary .md and emits a structured event for triage to
# assess activity, people present, and locations visited.
#
# This script does NOT generate the photo diary — that's photo-pipeline's job.
# triage-ingest only reads the already-produced digest file.
#
# Output: single-line JSON per the on_ingest contract in
#   docs/components/plugin-system.md
#
# Env contract:
#   PIOS_VAULT                  — vault root
#   PIOS_OWNER                  — owner key
#   PIOS_PLUGIN_GATE_PAYLOAD   — JSON string from on_gate's payload
#                                 (contains photo_path, mtime, date)

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
OWNER="${PIOS_OWNER:-owner}"
GATE_PAYLOAD="${PIOS_PLUGIN_GATE_PAYLOAD:-{}}"

# Pull photo_path from gate payload; fall back to today's path.
PHOTO_PATH=""
if command -v jq >/dev/null 2>&1; then
  PHOTO_PATH=$(echo "$GATE_PAYLOAD" | jq -r '.photo_path // empty' 2>/dev/null)
fi
if [ -z "$PHOTO_PATH" ]; then
  TODAY=$(date +%Y-%m-%d)
  PHOTO_PATH="${VAULT}/${OWNER}/Pipeline/AI_Photo_Digest/daily_photo/${TODAY}.md"
fi

if [ ! -r "$PHOTO_PATH" ]; then
  printf '{"events":[],"summary_for_triage":"photos: photo diary not readable: %s"}\n' "$PHOTO_PATH"
  exit 0
fi

TOTAL_LINES=$(wc -l < "$PHOTO_PATH" 2>/dev/null | tr -d ' \n')
TOTAL_LINES=${TOTAL_LINES:-0}

# Extract date from frontmatter.
PHOTO_DATE=""
PHOTO_DATE=$(grep -m1 '^date:' "$PHOTO_PATH" 2>/dev/null \
  | sed 's/^date:[[:space:]]*//' | sed 's/[[:space:]]*$//' || echo "")

# Extract total_photos from frontmatter.
TOTAL_PHOTOS=0
TOTAL_PHOTOS=$(grep -m1 '^total_photos:' "$PHOTO_PATH" 2>/dev/null \
  | sed 's/^total_photos:[[:space:]]*//' | sed 's/[[:space:]]*$//' || echo "0")

# Extract one-line photo summary (line after 照片日记一句话总结, with ^photo-daily-summary anchor).
PHOTO_SUMMARY=""
PHOTO_SUMMARY=$(grep '^photo-daily-summary\|photo-daily-summary$\|\^photo-daily-summary' "$PHOTO_PATH" 2>/dev/null \
  | sed 's/ \^photo-daily-summary//' | sed 's/[[:space:]]*$//' | head -1 || echo "")

# Fallback: grab line containing ^photo-daily-summary anchor
if [ -z "$PHOTO_SUMMARY" ]; then
  PHOTO_SUMMARY=$(grep '\^photo-daily-summary' "$PHOTO_PATH" 2>/dev/null \
    | sed 's/ \^photo-daily-summary//' | sed 's/[[:space:]]*$//' | head -1 || echo "")
fi

# Escape strings for JSON.
escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/; $s/\\n$//'
}
ESCAPED_PATH=$(escape_json "$PHOTO_PATH")
ESCAPED_SUMMARY=$(escape_json "$PHOTO_SUMMARY")

SUMMARY_TEXT="photos: new photo diary (${TOTAL_PHOTOS} photos)"
if [ -n "$PHOTO_SUMMARY" ]; then
  SUMMARY_TEXT="${SUMMARY_TEXT} — ${PHOTO_SUMMARY}"
fi
ESCAPED_SUMMARY_FOR_TRIAGE=$(escape_json "$SUMMARY_TEXT")

cat <<JSON
{"events":[{"kind":"photos-daily-available","summary":"daily photo diary updated","photo_path":"${ESCAPED_PATH}","date":"${PHOTO_DATE}","total_lines":${TOTAL_LINES},"total_photos":${TOTAL_PHOTOS},"photo_summary":"${ESCAPED_SUMMARY}"}],"summary_for_triage":"${ESCAPED_SUMMARY_FOR_TRIAGE}"}
JSON
