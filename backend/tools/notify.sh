#!/bin/bash
# notify.sh — PiOS 统一通知入口
# 用法:
#   notify.sh [--ttl <秒>] [--test] <级别> "消息内容"
#   notify.sh <级别> "消息内容"   （旧用法，兼容，自动按 level 默认 TTL）
# 级别: critical | warning | report | reminder | info | silent
# 标志:
#   --ttl <秒>   指定过期时长，默认按 level：critical=600 / reminder=1800 / report=7200 / info=14400
#   --test       自测通道：只写 Pi/Log/notify-test.jsonl，不走任何生产通道；
#                禁止复用近 24h critical 文本（Afterward 2026-04-21 事件教训）
# 规范: Pi/Config/notification-spec.md
# TTL 架构: Pi/Output/infra/unified-agent-awareness-design-2026-04-22.md (v2)

set -euo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
NOTIFY_JSON="$VAULT/Pi/Inbox/pi_notify.json"
HISTORY_LOG="$VAULT/Pi/Log/notify-history.jsonl"
ARCHIVE_LOG="$VAULT/Pi/Log/notify-archive.jsonl"
TEST_LOG="$VAULT/Pi/Log/notify-test.jsonl"
DEDUP_DIR="/tmp/pios-notify-dedup"
DEDUP_TTL=300  # 5 分钟去重

# ── 解析参数（支持 --ttl / --test 前置，其余按 positional）──
TTL=""
IS_TEST=0
POS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ttl) TTL="${2:-}"; shift 2 ;;
    --ttl=*) TTL="${1#--ttl=}"; shift ;;
    --test) IS_TEST=1; shift ;;
    --) shift; while [ $# -gt 0 ]; do POS_ARGS+=("$1"); shift; done ;;
    -*) echo "未知标志: $1" >&2; exit 1 ;;
    *) POS_ARGS+=("$1"); shift ;;
  esac
done
LEVEL="${POS_ARGS[0]:-}"
MESSAGE="${POS_ARGS[1]:-}"

if [ -z "$LEVEL" ] || [ -z "$MESSAGE" ]; then
  echo "用法: notify.sh [--ttl <秒>] [--test] <critical|warning|report|reminder|info|silent> \"消息\"" >&2
  exit 1
fi

# ── TTL 默认值（按 level，可被 --ttl 或 PIOS_NOTIFY_TTL env 覆盖）──
if [ -z "$TTL" ]; then
  TTL="${PIOS_NOTIFY_TTL:-}"
fi
if [ -z "$TTL" ]; then
  case "$LEVEL" in
    critical) TTL=600 ;;
    warning)  TTL=1800 ;;
    reminder) TTL=1800 ;;
    report)   TTL=7200 ;;
    info)     TTL=14400 ;;
    silent)   TTL=600 ;;
    *) TTL=1800 ;;
  esac
fi

# 计算 expires_at（UTC ISO8601）。ts 也统一在这里算一次，后续复用。
NOW_EPOCH=$(date -u +%s)
EXPIRES_EPOCH=$(( NOW_EPOCH + TTL ))
# macOS date 不支持 -d @epoch；用 python 兜底
_iso_from_epoch() {
  python3 -c "import datetime,sys; print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$1" 2>/dev/null \
    || date -u -r "$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ'
}
TS_NOW=$(_iso_from_epoch "$NOW_EPOCH")
EXPIRES_AT=$(_iso_from_epoch "$EXPIRES_EPOCH")

# 通用：shell 字符串 → JSON 字符串（保留 unicode / 特殊字符）
_json_quote() {
  python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$1" 2>/dev/null || printf '"%s"' "$1"
}

# ── 自测通道（--test）── 2026-04-22 Afterward 教训：自测不得走生产通道、不得复用真实 critical 文本
if [ "$IS_TEST" = "1" ]; then
  mkdir -p "$(dirname "$TEST_LOG")" 2>/dev/null || true
  # 禁止复用近 24h critical 文本。简单匹配：若 MESSAGE 前缀在 pi-speak-log critical 条目中出现 → reject
  SPEAK_LOG="$VAULT/Pi/Log/pi-speak-log.jsonl"
  if [ -f "$SPEAK_LOG" ]; then
    # 通过环境变量传 head 给 python（避免 heredoc UTF-8 问题 + 中文字符被按字节截断）
    export PIOS_TEST_MSG="$MESSAGE" PIOS_TEST_SPEAK_LOG="$SPEAK_LOG"
    if python3 -c "
import json, os, sys, time, datetime
msg = os.environ.get('PIOS_TEST_MSG','')
head = msg[:60]
if not head.strip():
    sys.exit(1)
p = os.environ.get('PIOS_TEST_SPEAK_LOG','')
try:
    with open(p, 'r', encoding='utf-8', errors='replace') as f:
        lines = f.readlines()[-500:]
except Exception:
    sys.exit(1)
cutoff = time.time() - 24*3600
for line in lines:
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get('level') != 'critical':
        continue
    ts = o.get('ts','')
    try:
        t = datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
    except Exception:
        continue
    if t < cutoff:
        continue
    txt = o.get('text','') or ''
    if head in txt:
        sys.exit(0)
sys.exit(1)
"; then
      echo "[notify.sh --test] rejected: 测试文本与近 24h critical 重合，禁止复用生产文本" >&2
      exit 2
    fi
    unset PIOS_TEST_MSG PIOS_TEST_SPEAK_LOG
  fi
  _HOST=$(hostname -s 2>/dev/null || echo "unknown")
  echo "{\"ts\":\"$TS_NOW\",\"level\":\"$LEVEL\",\"host\":\"$_HOST\",\"ttl\":$TTL,\"expires_at\":\"$EXPIRES_AT\",\"test\":true,\"msg\":$(_json_quote "$MESSAGE")}" >> "$TEST_LOG"
  exit 0
fi

# ── 过期检查（作者给了极短 TTL 或递归中 expires_at 已到）──
# FROM_ROUTE 再入时读环境 PIOS_NOTIFY_EXPIRES_AT（pi-route 传下来的原始 expires），
# 保证递归链每层都看同一个过期判据。
EFFECTIVE_EXPIRES_AT="${PIOS_NOTIFY_EXPIRES_AT:-$EXPIRES_AT}"
_epoch_from_iso() {
  python3 -c "import datetime,sys; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp()))" "$1" 2>/dev/null || echo 0
}
EFF_EXP_EPOCH=$(_epoch_from_iso "$EFFECTIVE_EXPIRES_AT")
if [ "$EFF_EXP_EPOCH" -gt 0 ] && [ "$EFF_EXP_EPOCH" -lt "$NOW_EPOCH" ]; then
  mkdir -p "$(dirname "$ARCHIVE_LOG")" 2>/dev/null || true
  _HOST=$(hostname -s 2>/dev/null || echo "unknown")
  echo "{\"ts\":\"$TS_NOW\",\"level\":\"$LEVEL\",\"host\":\"$_HOST\",\"expires_at\":\"$EFFECTIVE_EXPIRES_AT\",\"archived_reason\":\"expired_at_entry\",\"msg\":$(_json_quote "$MESSAGE")}" >> "$ARCHIVE_LOG"
  exit 0
fi

# ── 去重 ──
# 用消息前 60 字符做 key，避免 AI 同次生成的近似消息（前缀相同，结尾略有出入）双发
# ⚠️ 2026-04-19 修正：PIOS_NOTIFY_FROM_ROUTE=1 的递归调用必须跳过 dedup——
#    否则用户触发第一次 notify.sh（touch dedup 文件）→ 后台 fireReflex → pi-route →
#    再调 notify.sh（同消息 PIOS_NOTIFY_FROM_ROUTE=1）→ dedup 命中 → exit 0 →
#    legacy 分支永不执行 → pi_notify.json 永不写 → main.watchFile 永不触发 →
#    sendNotification 永不调 → TTS 永远无声。
if [ "${PIOS_NOTIFY_FROM_ROUTE:-0}" != "1" ]; then
  mkdir -p "$DEDUP_DIR"
  MSG_PREFIX="${MESSAGE:0:60}"
  MSG_HASH=$(echo -n "${LEVEL}:${MSG_PREFIX}" | md5sum 2>/dev/null | cut -c1-16 \
    || echo -n "${LEVEL}:${MSG_PREFIX}" | md5 -q 2>/dev/null | cut -c1-16 \
    || echo -n "${LEVEL}:${MSG_PREFIX}" | shasum 2>/dev/null | cut -c1-16 \
    || echo -n "${LEVEL}:${MSG_PREFIX}" | python3 -c "import hashlib,sys; print(hashlib.md5(sys.stdin.buffer.read()).hexdigest()[:16])" 2>/dev/null \
    || echo "fallback$(date +%s)")
  DEDUP_FILE="$DEDUP_DIR/$MSG_HASH"
  # 快路径：文件存在且未过期 → 直接 skip
  if [ -f "$DEDUP_FILE" ]; then
    FILE_AGE=$(( $(date +%s) - $(stat -f%m "$DEDUP_FILE" 2>/dev/null || stat -c%Y "$DEDUP_FILE" 2>/dev/null || echo 0) ))
    if [ "$FILE_AGE" -lt "$DEDUP_TTL" ]; then
      exit 0  # 重复消息，静默跳过
    fi
    rm -f "$DEDUP_FILE"
  fi
  # 原子加锁：mkdir 成功 = 本进程第一个到达；失败 = 并发重复 → skip
  # ⚠️ 2026-04-21 修复：原 touch 方案有 TOCTOU 竞争，同轮次两次调用都可通过 dedup
  DEDUP_LOCK="$DEDUP_DIR/${MSG_HASH}.lk"
  if ! mkdir "$DEDUP_LOCK" 2>/dev/null; then
    exit 0  # 并发重复，静默跳过
  fi
  # 双检查（持锁后再确认，防止 expire+re-create 竞争）
  if [ -f "$DEDUP_FILE" ]; then
    FILE_AGE=$(( $(date +%s) - $(stat -f%m "$DEDUP_FILE" 2>/dev/null || stat -c%Y "$DEDUP_FILE" 2>/dev/null || echo 0) ))
    rm -rf "$DEDUP_LOCK"
    [ "$FILE_AGE" -lt "$DEDUP_TTL" ] && exit 0
  fi
  touch "$DEDUP_FILE"
  rm -rf "$DEDUP_LOCK"
  # 清理过期去重文件（含过期 .lk 目录）
  find "$DEDUP_DIR" -maxdepth 1 -mmin +10 \( -type f -o -type d -name "*.lk" \) -delete 2>/dev/null || true
fi

# ── 路由（P7 Stage 2 · 2026-04-19 · 归一 pi-speak 架构） ──
#
# 2 种触发场景：
#   (a) pi-route.sendLocalNotify 递归调我 → 设 PIOS_NOTIFY_FROM_ROUTE=1 → 走 legacy 分支直接写 pi_notify.json
#       这避免 pi-speak ↔ pi-route ↔ notify.sh 无限递归
#   (b) 业务代码（triage/sense-maker/life/reminder cron）直调 → 无 sentinel env → 归一走 pi-speak 架构：
#         critical / reminder → fireReflex（反射：立即发，不过 triage 决策）
#         warning / report / info → proposeIntent（意识：triage Step 8 决策说不说/怎么说/哪个通道）
#         silent → 只 history log

FROM_ROUTE="${PIOS_NOTIFY_FROM_ROUTE:-0}"
PI_SPEAK="$VAULT/Projects/pios/backend/pi-speak.js"

if [ "$FROM_ROUTE" = "1" ]; then
  # (a) pi-route.sendLocalNotify 调用：只写 pi_notify.json 给 main.watchFile 做 macOS 原生 toast。
  # notify-history 由 pi-speak.js 的 appendNotifyHistory 独家负责（fireReflex/executeDecision
  # 返回后会写），这里绝不能再写，否则每条都双份。
  # ⚠️ 2026-04-21 误修复复盘：当时以为 FROM_ROUTE=1 是"legacy 入口"才独家写日志，实则它永远是
  # pi-speak → pi-route → sendLocalNotify 的下游；pi-speak 写自己的那份，notify.sh 再写第二份 →
  # notify-history 每条 2 遍（带 source/不带 source 各一）。见 archive/reflect-2026-04-21-triage-report-dedup.md。
  case "$LEVEL" in
    critical|warning)
      echo "{\"type\":\"$LEVEL\",\"text\":$(_json_quote "$MESSAGE"),\"expires_at\":\"$EFFECTIVE_EXPIRES_AT\"}" > "$NOTIFY_JSON"
      ;;
    report|reminder|info)
      echo "{\"text\":$(_json_quote "$MESSAGE"),\"expires_at\":\"$EFFECTIVE_EXPIRES_AT\"}" > "$NOTIFY_JSON"
      ;;
    silent)
      :
      ;;
    *)
      echo "未知级别: $LEVEL" >&2 ; exit 1 ;;
  esac
  exit 0
fi

# (b) 归一分支：写 pi-speak queue，主进程在进程内 dispatch
# 2026-04-20 Bug A/B 根治：原来 `node -e fireReflex ... &` 起子进程有两个硬伤：
#   1. 子进程拿不到 Electron global._npcSpeak → bubble 永远 null（"只弹通知不说话"）
#   2. cron 环境 PATH 无 /opt/homebrew/bin → node 找不到 → stderr 被吞 → silent fail
#        （今晚 17:00/18:30 reminder 连 pi-speak-log 都没 entry 的根因）
# 改法：只往 queue 文件 append 一行 JSON，PiOS 主进程 watchFile 读增量，在进程内
#       require pi-speak 走 fireReflex / proposeIntent。纯文件 IO 在 cron 环境也稳。
QUEUE="$VAULT/Pi/Inbox/pi-speak-queue.jsonl"
mkdir -p "$(dirname "$QUEUE")" 2>/dev/null || true
MSG_JSON=$(_json_quote "$MESSAGE")
_queue_line() {
  local TYPE="$1"  # reflex | intent
  local PRI="${2:-3}"
  printf '{"ts":"%s","type":"%s","source":"notify.sh-%s","level":"%s","text":%s,"priority":%s,"expires_at":"%s"}\n' \
    "$TS_NOW" "$TYPE" "$LEVEL" "$LEVEL" "$MSG_JSON" "$PRI" "$EFFECTIVE_EXPIRES_AT" >> "$QUEUE"
}

case "$LEVEL" in
  critical|reminder|report)
    # 反射：主进程立即 fireReflex（critical 里面 pi-route 自己会走多通道）
    _queue_line reflex 1
    ;;
  warning|info)
    # 意识：主进程 proposeIntent，由 triage Step 8 决策
    _queue_line intent 3
    ;;
  silent)
    # 只 notify-history log（前面已写）
    ;;
  *)
    echo "未知级别: $LEVEL（可选: critical|warning|report|reminder|info|silent）" >&2
    exit 1
    ;;
esac
