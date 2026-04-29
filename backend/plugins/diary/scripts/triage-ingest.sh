#!/bin/bash
# diary plugin · triage-ingest hook
#
# Reads today's daily diary .md and emits a structured event for triage to
# assess whether there are risk warnings or focus items needing attention.
#
# This script does NOT generate the diary — that's daily-diary-engine's job.
# triage-ingest only reads the already-produced diary file.
#
# Output: single-line JSON per the on_ingest contract in
#   docs/components/plugin-system.md
#
# Env contract:
#   PIOS_VAULT                  — vault root
#   PIOS_OWNER                  — owner key
#   PIOS_PLUGIN_GATE_PAYLOAD   — JSON string from on_gate's payload
#                                 (contains diary_path, mtime, date)

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
OWNER="${PIOS_OWNER:-owner}"
GATE_PAYLOAD="${PIOS_PLUGIN_GATE_PAYLOAD:-{}}"

# Pull diary_path from gate payload; fall back to today's path.
DIARY_PATH=""
if command -v jq >/dev/null 2>&1; then
  DIARY_PATH=$(echo "$GATE_PAYLOAD" | jq -r '.diary_path // empty' 2>/dev/null)
fi
if [ -z "$DIARY_PATH" ]; then
  TODAY=$(date +%Y-%m-%d)
  DIARY_PATH="${VAULT}/${OWNER}/Personal/Daily/${TODAY}.md"
fi

if [ ! -r "$DIARY_PATH" ]; then
  printf '{"events":[],"summary_for_triage":"diary: daily diary not readable: %s"}\n' "$DIARY_PATH"
  exit 0
fi

TOTAL_LINES=$(wc -l < "$DIARY_PATH" 2>/dev/null | tr -d ' \n')
TOTAL_LINES=${TOTAL_LINES:-0}

# Extract topic from frontmatter (topic: <value>).
TOPIC=""
TOPIC=$(grep -m1 '^topic:' "$DIARY_PATH" 2>/dev/null \
  | sed 's/^topic:[[:space:]]*//' | sed "s/^['\"]//;s/['\"]$//" \
  | sed 's/[[:space:]]*$//' || echo "")

# Extract date from frontmatter.
DIARY_DATE=""
DIARY_DATE=$(grep -m1 '^date:' "$DIARY_PATH" 2>/dev/null \
  | sed 's/^date:[[:space:]]*//' | sed 's/[[:space:]]*$//' || echo "")

# Detect if there are risk warnings (## 风险预警 section or ⚠️ lines).
HAS_RISK_WARNING=false
if grep -q '## 风险预警\|⚠️\|⚠' "$DIARY_PATH" 2>/dev/null; then
  HAS_RISK_WARNING=true
fi

# Extract first line of 今日焦点 section (skip header line itself).
FOCUS_SUMMARY=""
FOCUS_SUMMARY=$(awk '/^## 今日焦点/{found=1; next} found && /^[^#]/ && NF>0{print; exit}' \
  "$DIARY_PATH" 2>/dev/null \
  | sed 's/\*\*//g' | sed 's/`//g' | sed 's/[[:space:]]*$//' \
  | head -c 200 || echo "")

# Escape strings for JSON.
escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/; $s/\\n$//'
}
ESCAPED_PATH=$(escape_json "$DIARY_PATH")
ESCAPED_TOPIC=$(escape_json "$TOPIC")
ESCAPED_FOCUS=$(escape_json "$FOCUS_SUMMARY")

SUMMARY_TEXT="diary: new daily entry (${TOTAL_LINES} lines)"
if [ -n "$TOPIC" ]; then
  SUMMARY_TEXT="${SUMMARY_TEXT} — ${TOPIC}"
fi
ESCAPED_SUMMARY=$(escape_json "$SUMMARY_TEXT")

cat <<JSON
{"events":[{"kind":"diary-available","summary":"daily diary updated","diary_path":"${ESCAPED_PATH}","date":"${DIARY_DATE}","total_lines":${TOTAL_LINES},"topic":"${ESCAPED_TOPIC}","has_risk_warning":${HAS_RISK_WARNING},"focus_summary":"${ESCAPED_FOCUS}"}],"summary_for_triage":"${ESCAPED_SUMMARY}"}
JSON
