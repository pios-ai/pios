#!/bin/bash
# wechat plugin · triage-ingest hook
#
# Heavier probe: parse today's wechat daily_raw .md, find lines from the
# owner herself (filter by display_names.wechat from ~/.pios/config.json),
# emit them as structured events for triage to act on.
#
# This script does NOT decrypt the wechat DB — that's the daily-wechat-
# digest task's job (runs at 00:07 cron, writes daily_raw). triage-ingest
# only reads the already-produced daily_raw.
#
# Output: single-line JSON per the on_ingest contract in
#   docs/components/plugin-system.md
#
# Env contract:
#   PIOS_VAULT                  — vault root
#   PIOS_OWNER                  — owner key
#   PIOS_PLUGIN_GATE_PAYLOAD   — JSON string from on_gate's payload
#                                 (contains raw_path, mtime, date)

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
OWNER="${PIOS_OWNER:-owner}"
GATE_PAYLOAD="${PIOS_PLUGIN_GATE_PAYLOAD:-{}}"

# Pull raw_path from gate payload; fall back to today's path.
RAW_PATH=""
if command -v jq >/dev/null 2>&1; then
  RAW_PATH=$(echo "$GATE_PAYLOAD" | jq -r '.raw_path // empty' 2>/dev/null)
fi
if [ -z "$RAW_PATH" ]; then
  TODAY=$(date +%Y-%m-%d)
  RAW_PATH="${VAULT}/${OWNER}/Pipeline/AI_Wechat_Digest/daily_raw/${TODAY}.md"
fi

if [ ! -r "$RAW_PATH" ]; then
  printf '{"events":[],"summary_for_triage":"wechat: daily_raw not readable: %s"}\n' "$RAW_PATH"
  exit 0
fi

# Resolve owner's wechat display_name from ~/.pios/config.json.
# Used to filter lines that are messages the owner herself sent (the
# "instructions to self" pattern that triage looks for).
WECHAT_NAME=""
PIOS_CFG="$HOME/.pios/config.json"
if [ -r "$PIOS_CFG" ] && command -v jq >/dev/null 2>&1; then
  WECHAT_NAME=$(jq -r '.display_names.wechat // empty' "$PIOS_CFG" 2>/dev/null)
fi

# Count lines from owner-self in today's raw (rough heuristic: lines
# starting with the wechat display name as the speaker prefix).
OWNER_MSG_COUNT=0
if [ -n "$WECHAT_NAME" ]; then
  # grep -c outputs "<N>\n" even on zero matches; strip newline, default to 0.
  OWNER_MSG_COUNT=$(grep -cE "^${WECHAT_NAME}[:：]" "$RAW_PATH" 2>/dev/null | tr -d ' \n')
  OWNER_MSG_COUNT=${OWNER_MSG_COUNT:-0}
fi
TOTAL_LINES=$(wc -l < "$RAW_PATH" 2>/dev/null | tr -d ' \n')
TOTAL_LINES=${TOTAL_LINES:-0}

# Build the events array. For phase-3a pilot we emit a single summary event
# pointing triage at the raw file; triage's LLM will read the file and
# decide which lines deserve cards. Future iterations can pre-classify here.
ESCAPED_PATH=${RAW_PATH//\\/\\\\}
ESCAPED_PATH=${ESCAPED_PATH//\"/\\\"}

cat <<JSON
{"events":[{"kind":"daily-raw-available","summary":"wechat daily_raw updated","raw_path":"${ESCAPED_PATH}","total_lines":${TOTAL_LINES:-0},"owner_msg_count":${OWNER_MSG_COUNT:-0}}],"summary_for_triage":"wechat: ${OWNER_MSG_COUNT} owner messages, ${TOTAL_LINES:-0} total lines"}
JSON
