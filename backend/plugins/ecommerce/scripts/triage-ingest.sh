#!/bin/bash
# ecommerce plugin · triage-ingest hook
#
# Reads the newest hawkeye scan report (identified by gate payload) and emits
# a structured event for triage to determine if any action is needed.
#
# This script does NOT run the scan — that's the hawkeye-worker task's job.
# triage-ingest only surfaces the already-produced scan report.
#
# Output: single-line JSON per the on_ingest contract in
#   docs/components/plugin-system.md
#
# Env contract:
#   PIOS_VAULT                  — vault root
#   PIOS_PLUGIN_GATE_PAYLOAD   — JSON string from on_gate's payload
#                                 (contains scan_path, mtime)

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
GATE_PAYLOAD="${PIOS_PLUGIN_GATE_PAYLOAD:-{}}"

# Pull scan_path from gate payload.
SCAN_PATH=""
if command -v jq >/dev/null 2>&1; then
  SCAN_PATH=$(echo "$GATE_PAYLOAD" | jq -r '.scan_path // empty' 2>/dev/null)
fi

if [ -z "$SCAN_PATH" ] || [ ! -r "$SCAN_PATH" ]; then
  printf '{"events":[],"summary_for_triage":"ecommerce: scan report not readable: %s"}\n' "$SCAN_PATH"
  exit 0
fi

# Extract a title from the filename (basename without .md).
FILENAME=$(basename "$SCAN_PATH" .md)

# Determine report kind from filename pattern.
KIND="ecommerce-scan-available"
if echo "$FILENAME" | grep -qi 'redline'; then
  KIND="ecommerce-redline-available"
elif echo "$FILENAME" | grep -qi 'summary\|week\|weekly'; then
  KIND="ecommerce-weekly-summary-available"
elif echo "$FILENAME" | grep -qi 'followup'; then
  KIND="ecommerce-followup-available"
fi

TOTAL_LINES=$(wc -l < "$SCAN_PATH" 2>/dev/null | tr -d ' \n')
TOTAL_LINES=${TOTAL_LINES:-0}

# Extract first non-empty heading line for summary.
HEADING=$(grep -m1 '^#' "$SCAN_PATH" 2>/dev/null | sed 's/^#*[[:space:]]*//' | head -c 100 || echo "")

# Domain context path for triage card enrichment.
DOMAIN_CONTEXT="${VAULT}/Projects/ai-ecommerce/DOMAIN.md"

# Escape strings for JSON embedding.
ESCAPED_PATH=${SCAN_PATH//\\/\\\\}
ESCAPED_PATH=${ESCAPED_PATH//\"/\\\"}
ESCAPED_HEADING=${HEADING//\\/\\\\}
ESCAPED_HEADING=${ESCAPED_HEADING//\"/\\\"}
ESCAPED_DOMAIN=${DOMAIN_CONTEXT//\\/\\\\}
ESCAPED_DOMAIN=${ESCAPED_DOMAIN//\"/\\\"}

cat <<JSON
{"events":[{"kind":"${KIND}","summary":"hawkeye scan report updated","scan_path":"${ESCAPED_PATH}","title":"${ESCAPED_HEADING}","total_lines":${TOTAL_LINES},"domain_context_path":"${ESCAPED_DOMAIN}"}],"summary_for_triage":"ecommerce: new scan report ${FILENAME} (${TOTAL_LINES} lines). ${ESCAPED_HEADING}"}
JSON
