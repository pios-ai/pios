#!/bin/bash
# health plugin · triage-ingest hook
#
# Reads today's health daily_health .md report and emits a structured event
# for triage to determine if any action is needed (e.g. abnormal metrics,
# missing supplement data, etc.)
#
# This script does NOT generate the health report — that's the
# daily-health-digest task's job. triage-ingest only reads the
# already-produced daily_health report.
#
# Output: single-line JSON per the on_ingest contract in
#   docs/components/plugin-system.md
#
# Env contract:
#   PIOS_VAULT                  — vault root
#   PIOS_OWNER                  — owner key
#   PIOS_PLUGIN_GATE_PAYLOAD   — JSON string from on_gate's payload
#                                 (contains report_path, mtime, date)

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
OWNER="${PIOS_OWNER:-owner}"
GATE_PAYLOAD="${PIOS_PLUGIN_GATE_PAYLOAD:-{}}"

# Pull report_path from gate payload; fall back to today's path.
REPORT_PATH=""
if command -v jq >/dev/null 2>&1; then
  REPORT_PATH=$(echo "$GATE_PAYLOAD" | jq -r '.report_path // empty' 2>/dev/null)
fi
if [ -z "$REPORT_PATH" ]; then
  TODAY=$(date +%Y-%m-%d)
  REPORT_PATH="${VAULT}/${OWNER}/Pipeline/AI_Health_Digest/daily_health/${TODAY}.md"
fi

if [ ! -r "$REPORT_PATH" ]; then
  printf '{"events":[],"summary_for_triage":"health: daily_health report not readable: %s"}\n' "$REPORT_PATH"
  exit 0
fi

# Extract the summary line (tagged with ^health-daily-summary) for triage.
SUMMARY_LINE=""
SUMMARY_LINE=$(grep -m1 '\^health-daily-summary' "$REPORT_PATH" 2>/dev/null \
  | sed 's/\^health-daily-summary//' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//' \
  | sed 's/> //' || echo "")

TOTAL_LINES=$(wc -l < "$REPORT_PATH" 2>/dev/null | tr -d ' \n')
TOTAL_LINES=${TOTAL_LINES:-0}

# Escape the strings for JSON embedding.
ESCAPED_PATH=${REPORT_PATH//\\/\\\\}
ESCAPED_PATH=${ESCAPED_PATH//\"/\\\"}
ESCAPED_SUMMARY=${SUMMARY_LINE//\\/\\\\}
ESCAPED_SUMMARY=${ESCAPED_SUMMARY//\"/\\\"}

cat <<JSON
{"events":[{"kind":"health-daily-available","summary":"health daily report updated","report_path":"${ESCAPED_PATH}","total_lines":${TOTAL_LINES},"health_summary":"${ESCAPED_SUMMARY}"}],"summary_for_triage":"health: new daily report (${TOTAL_LINES} lines). ${ESCAPED_SUMMARY}"}
JSON
