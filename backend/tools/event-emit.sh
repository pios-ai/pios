#!/bin/bash
# event-emit.sh — 后台事件写入 agent-event-inbox.jsonl
#
# 用于把 worker 完成 / 系统告警 / proactive 消息以结构化方式追加到事件收件箱，
# 供 PiBrowser 的前台 Pi（或其它订阅方）下一轮对话时自动感知。
#
# 用法:
#   event-emit.sh --type <worker_done|system_alert|intel_update|proactive>
#                 --level <critical|report|info>
#                 --priority <1..4>
#                 --summary "<一句话摘要>"
#                 [--detail "<展开>"]
#                 [--source <标识>]
#                 [--card <card_id>]
#                 [--ttl <秒>]      # 覆盖 level 默认 TTL
#
# level 默认 TTL：critical=600 / report=7200 / info=14400
# priority 语义（父卡 v2 §3.5）：1=reflex+下轮强制提及 / 2=下轮自然融入 / 3=汇总 / 4=静默
#
# 2026-04-22 · Phase 2 实施（父卡 unify-background-events-into-current-agent-awareness）

set -euo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
# 2026-04-22 · 分片：每 host 写自己的 agent-event-inbox-{host}.jsonl，避免 Syncthing 并发冲突
HOST=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "unknown")
INBOX="$VAULT/Pi/State/agent-event-inbox-${HOST}.jsonl"

TYPE=""; LEVEL="report"; PRIORITY="2"
SUMMARY=""; DETAIL=""; SOURCE=""; CARD_ID=""; TTL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --type)     TYPE="${2:-}"; shift 2 ;;
    --level)    LEVEL="${2:-}"; shift 2 ;;
    --priority) PRIORITY="${2:-}"; shift 2 ;;
    --summary)  SUMMARY="${2:-}"; shift 2 ;;
    --detail)   DETAIL="${2:-}"; shift 2 ;;
    --source)   SOURCE="${2:-}"; shift 2 ;;
    --card)     CARD_ID="${2:-}"; shift 2 ;;
    --ttl)      TTL="${2:-}"; shift 2 ;;
    -h|--help)
      head -n 20 "$0" | tail -n 19
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TYPE" ] || [ -z "$SUMMARY" ]; then
  echo "--type 和 --summary 必填" >&2
  exit 1
fi

# 默认 TTL
if [ -z "$TTL" ]; then
  case "$LEVEL" in
    critical) TTL=600 ;;
    report)   TTL=7200 ;;
    info)     TTL=14400 ;;
    *)        TTL=3600 ;;
  esac
fi

mkdir -p "$(dirname "$INBOX")" 2>/dev/null || true

# 用 python 生成一行 JSON，避免 shell quoting 坑
export EMIT_TYPE="$TYPE" EMIT_LEVEL="$LEVEL" EMIT_PRIO="$PRIORITY" \
       EMIT_SUMMARY="$SUMMARY" EMIT_DETAIL="$DETAIL" EMIT_SOURCE="$SOURCE" \
       EMIT_CARD="$CARD_ID" EMIT_TTL="$TTL" EMIT_INBOX="$INBOX"

python3 <<'PY'
import json, os, secrets, datetime, time
ttl = int(os.environ["EMIT_TTL"])
now = datetime.datetime.utcnow()
exp = now + datetime.timedelta(seconds=ttl)
event = {
    "event_id": f"evt-{now.strftime('%Y-%m-%dT%H%M%SZ')}-{secrets.token_hex(2)}",
    "ts":         now.strftime('%Y-%m-%dT%H:%M:%SZ'),
    "expires_at": exp.strftime('%Y-%m-%dT%H:%M:%SZ'),
    "type":     os.environ["EMIT_TYPE"],
    "level":    os.environ["EMIT_LEVEL"],
    "priority": int(os.environ["EMIT_PRIO"]),
    "summary":  os.environ["EMIT_SUMMARY"],
}
for k, envk in [("detail","EMIT_DETAIL"), ("source","EMIT_SOURCE"), ("card_id","EMIT_CARD")]:
    v = os.environ.get(envk,"")
    if v:
        event[k] = v
with open(os.environ["EMIT_INBOX"], "a", encoding="utf-8") as f:
    f.write(json.dumps(event, ensure_ascii=False) + "\n")
print(event["event_id"])
PY
