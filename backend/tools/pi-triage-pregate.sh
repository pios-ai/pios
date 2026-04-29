#!/bin/bash
# pi-triage-pregate.sh
# Pi triage task 的 bash 层哑门。被 pios-tick.sh 在主循环里 eval 调用。
#
# 返回 0：有事要 triage 处理 → 放行启动 claude-cli
# 返回 1：无事 → pre_gate skip（不启动 claude-cli，写 gate_skipped run record）
#
# 7 个条件任一满足即放行（对齐 Pi/Agents/pi/tasks/triage.md 的 Step 0 门控）：
#   1. Cards/inbox/ 有 .md 文件
#   2. Cards/active/ 有 status: done 的卡
#   3. clarification_response.md 行数 > gate-state.clarify_lines
#   4. 今日微信 daily_raw mtime > gate-state.wechat_mtime
#   5. Cards/active/ 有 verify-after 时间已过期
#   6. Cards/active/ 有 deferred_until 今天或之前
#   7. Cards/active/ 有 triage 该收口或可派发的项（僵尸锁 / 新 owner 请求 / 状态错位 / 可派候选）

set -uo pipefail

VAULT="${PIOS_VAULT:-$(cd "$(dirname "$0")/../.." && pwd)}"
# pios-tick.sh eval 时不传 $HOST，自己识别
# shellcheck source=lib/host-resolve.sh
source "$VAULT/Pi/Tools/lib/host-resolve.sh"
HOST=$(pios_resolve_host)

# Always-on side effect: refresh Cards/active/_summary.md (auto-loaded by Claude/Codex
# via BOOT.md startup protocol Step 6). Failure here must NOT block triage gate.
PIOS_VAULT="$VAULT" python3 "$VAULT/Pi/Tools/cards-summary-gen.py" >/dev/null 2>&1 || true

CARDS_INBOX="$VAULT/Cards/inbox"
CARDS_ACTIVE="$VAULT/Cards/active"
GATE_STATE="$VAULT/Pi/Log/gate-state-${HOST}.json"
CLARIFY_FILE="$VAULT/Pi/Inbox/clarification_response.md"
TODAY=$(date +%Y-%m-%d)
WECHAT_FILE="$VAULT/owner/Pipeline/AI_Wechat_Digest/daily_raw/${TODAY}.md"

# ── last_actual_run epoch（多条件复用）────────────────
_LAST_RUN_EPOCH=$(python3 -c "
import json
from datetime import datetime
try:
    ts = json.load(open('$GATE_STATE')).get('last_actual_run','2000-01-01 00:00')
    print(int(datetime.strptime(ts, '%Y-%m-%d %H:%M').timestamp()))
except: print(0)
" 2>/dev/null || echo 0)

# ── 条件 1: inbox 有 mtime 新于上次 triage 完成的文件 ────
# 老 source:worker 卡永远留 inbox，mtime 停在分类时——不触发
# owner 新建卡或 pipeline 新建 wechat 卡才有新 mtime
if compgen -G "$CARDS_INBOX/*.md" >/dev/null 2>&1; then
  _LATEST_INBOX_MTIME=$(stat -f %m "$CARDS_INBOX"/*.md 2>/dev/null | sort -n | tail -1)
  if [ "${_LATEST_INBOX_MTIME:-0}" -gt "${_LAST_RUN_EPOCH:-0}" ] 2>/dev/null; then
    exit 0
  fi
fi

# ── 条件 2: active 有 status: done 卡 ───────────────────
if grep -lq '^status: done' "$CARDS_ACTIVE"/*.md 2>/dev/null; then
  exit 0
fi

# ── 条件 3: clarification_response 行数增加 ─────────────
if [ -f "$CLARIFY_FILE" ] && [ -f "$GATE_STATE" ]; then
  current_lines=$(wc -l < "$CLARIFY_FILE" 2>/dev/null | tr -d ' ')
  gate_lines=$(python3 -c "
import json
try: print(json.load(open('$GATE_STATE')).get('clarify_lines', 0))
except: print(0)
" 2>/dev/null || echo 0)
  if [ "${current_lines:-0}" -gt "${gate_lines:-0}" ] 2>/dev/null; then
    exit 0
  fi
fi

# ── 条件 4: wechat daily_raw mtime 增加 ─────────────────
if [ -f "$WECHAT_FILE" ] && [ -f "$GATE_STATE" ]; then
  current_mtime=$(stat -f %m "$WECHAT_FILE" 2>/dev/null || stat -c %Y "$WECHAT_FILE" 2>/dev/null || echo 0)
  gate_mtime=$(python3 -c "
import json
try: print(json.load(open('$GATE_STATE')).get('wechat_mtime', 0))
except: print(0)
" 2>/dev/null || echo 0)
  if [ "${current_mtime:-0}" -gt "${gate_mtime:-0}" ] 2>/dev/null; then
    exit 0
  fi
fi

# ── 条件 5 / 6 / 7: 到期项、脏状态、可派发候选 ───────────
python3 - "$CARDS_ACTIVE" "$TODAY" "${_LAST_RUN_EPOCH:-0}" "$HOST" <<'PYEOF' && exit 0
import os, re, sys
from datetime import datetime, timedelta

cards_dir = sys.argv[1]
today_str = sys.argv[2]
last_run_epoch = int(sys.argv[3] or 0)
host = sys.argv[4]
now = datetime.now()
stale_claim_before = now - timedelta(minutes=30)

if not os.path.isdir(cards_dir):
    sys.exit(1)

verify_re = re.compile(r'^blocked_on:\s*.*verify-after:\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?', re.MULTILINE)
field_re = lambda key: re.compile(rf'^{re.escape(key)}:\s*(.*?)\s*$', re.MULTILINE)
acceptance_re = re.compile(r'^##\s*(验收标准|Acceptance Criteria)\b', re.MULTILINE)
worklog_re = re.compile(r'^##\s*(工作记录|Work History)\b', re.MULTILINE)

def field(content, key):
    m = field_re(key).search(content)
    return (m.group(1) if m else '').strip()

def meaningful(value):
    s = str(value or '').strip().lower()
    return s not in ('', 'null', 'none', 'undefined')

for fn in os.listdir(cards_dir):
    if not fn.endswith('.md'):
        continue
    if '.sync-conflict-' in fn:
        continue
    path = os.path.join(cards_dir, fn)
    try:
        with open(path, encoding='utf-8', errors='ignore') as f:
            content = f.read()
        stat = os.stat(path)
    except Exception:
        continue

    status = field(content, 'status').lower()
    blocked_on = field(content, 'blocked_on')
    deferred_until = field(content, 'deferred_until')
    needs_owner = field(content, 'needs_owner')
    claimed_by = field(content, 'claimed_by')
    ready_for_work = field(content, 'ready_for_work').lower()
    owner_response = field(content, 'owner_response')
    card_type = field(content, 'type').lower()
    runs_on = field(content, 'runs_on')
    assignee = field(content, 'assignee')
    priority = field(content, 'priority').lower()
    energy_raw = field(content, 'energy')

    # 条件 5: verify-after 到期
    m = verify_re.search(content)
    if m:
        try:
            date_str = m.group(1)
            time_str = m.group(2) or '00:00'
            dt = datetime.strptime(f'{date_str} {time_str}', '%Y-%m-%d %H:%M')
            if now >= dt:
                sys.exit(0)
        except Exception:
            pass

    # 条件 6: deferred_until 到期（<=today）
    if meaningful(deferred_until):
        try:
            if deferred_until <= today_str:
                sys.exit(0)
        except Exception:
            pass

    # 条件 7a: 新的 owner-facing 项，需要 triage 审核是否真的该推给 Owner
    if stat.st_mtime > last_run_epoch and (meaningful(needs_owner) or status == 'in_review' or meaningful(owner_response)):
        sys.exit(0)

    # 条件 7b: 僵尸 work 锁 / 状态错位，需要 triage 收口
    if meaningful(claimed_by) and claimed_by.startswith('work-'):
        if datetime.fromtimestamp(stat.st_mtime) <= stale_claim_before:
            sys.exit(0)
    if status in ('inbox', 'done', 'dismissed', 'archive'):
        sys.exit(0)

    # 条件 7c: 有可派发候选，让 triage 继续喂 work
    if card_type not in ('task', 'project'):
        continue
    if status not in ('', 'active', 'pending'):
        continue
    if meaningful(blocked_on):
        continue
    if meaningful(deferred_until):
        continue
    if meaningful(runs_on) and runs_on != host:
        continue
    if meaningful(claimed_by):
        continue
    if ready_for_work == 'true':
        continue
    if meaningful(needs_owner):
        continue
    if assignee == 'user':
        continue
    try:
        energy = float(energy_raw) if meaningful(energy_raw) else None
    except Exception:
        energy = None
    if energy is not None and energy < 0.3 and priority != '1':
        continue
    if card_type == 'task' and not acceptance_re.search(content):
        continue
    if card_type == 'project' and not worklog_re.search(content):
        continue
    sys.exit(0)

sys.exit(1)
PYEOF

# 全部 6 个条件都不满足 → 跳过本 tick
exit 1
