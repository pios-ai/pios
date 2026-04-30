#!/bin/bash
# outbox-drain.sh — 扫描 openclaw-outbox.jsonl，按 expires_at 归档或重试发送
#
# 逻辑：
#   - expires_at < now           → 移到 Pi/Log/outbox-archive.jsonl，不发
#   - expires_at 缺失             → 按 level 默认 TTL 计算（critical=10min / reminder=30min / report=2h / info=4h）
#                                    再判断是否过期
#   - 未过期且 openclaw 可用      → 尝试 notify-wechat.sh 发送；成功归档；失败留 outbox 下轮
#   - 未过期但 openclaw down      → 留 outbox，下次 drain 再试（不做 ssh 探活，避免阻塞）
#
# 触发：cron 每 60s / 手动跑；幂等，多次运行安全。
# 归档：outbox 文件按"保留未过期未发送"的方式重写（atomic tmp+rename）。
#
# 2026-04-22 Afterward 事件教训：不加 TTL 判定的 retry 会把昨天的 critical 当今天的新事实发。

set -euo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
OUTBOX="$VAULT/Pi/Inbox/openclaw-outbox.jsonl"
ARCHIVE="$VAULT/Pi/Log/outbox-archive.jsonl"
MANIFEST="$VAULT/Pi/Config/pios.yaml"
NOTIFY_WECHAT_SH="$VAULT/Pi/Tools/notify-wechat.sh"

if [ ! -f "$OUTBOX" ]; then
  exit 0  # 没 outbox 就没事做
fi

if [ ! -s "$OUTBOX" ]; then
  exit 0  # 空文件
fi

mkdir -p "$(dirname "$ARCHIVE")" 2>/dev/null || true

# openclaw 状态：抄 pi-route.js 的逻辑（status=down 且 down_since 未超 2h 视为 down）
_openclaw_down() {
  python3 - "$MANIFEST" <<'PY'
import sys, time, datetime
try:
    import yaml
except ImportError:
    sys.exit(1)
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        m = yaml.safe_load(f)
except Exception:
    sys.exit(1)
runtime = (m or {}).get('infra', {}).get('runtimes', {}).get('openclaw', {})
if runtime.get('status') != 'down':
    sys.exit(1)
ds = runtime.get('down_since')
if ds:
    try:
        t = datetime.datetime.fromisoformat(str(ds).replace('Z','+00:00')).timestamp()
        if time.time() - t > 2*3600:
            sys.exit(1)  # stale down marker → assume up
    except Exception:
        pass
sys.exit(0)  # still down
PY
}

OPENCLAW_DOWN=0
if _openclaw_down; then
  OPENCLAW_DOWN=1
fi

# Python 脚本做核心活：读 outbox → 对每条决策（archive / retry / keep）→ 重写 outbox
python3 - "$OUTBOX" "$ARCHIVE" "$OPENCLAW_DOWN" "$NOTIFY_WECHAT_SH" <<'PY'
import json, os, sys, time, datetime, subprocess
outbox_path, archive_path, openclaw_down_flag, wechat_sh = sys.argv[1:5]
openclaw_down = (openclaw_down_flag == '1')

LEVEL_DEFAULT_TTL = {
    'critical': 600,
    'warning':  1800,
    'reminder': 1800,
    'report':   7200,
    'info':     14400,
}

def parse_iso(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace('Z','+00:00')).timestamp()
    except Exception:
        return None

def ttl_default_for(source):
    # source 形如 "notify.sh-critical" / "pi-route" / 其他
    if isinstance(source, str):
        for lvl in LEVEL_DEFAULT_TTL:
            if lvl in source:
                return LEVEL_DEFAULT_TTL[lvl]
    return 1800  # 默认 30min

now = time.time()

# 读全量，按行解析；解析失败的行原样保留（宁可保守别丢）
try:
    with open(outbox_path, 'r', encoding='utf-8', errors='replace') as f:
        raw_lines = [ln for ln in f.read().splitlines() if ln.strip()]
except FileNotFoundError:
    sys.exit(0)

keep = []       # 留在 outbox 下轮再处理的
archived = []   # 本轮处理掉的（带 reason）

for line in raw_lines:
    try:
        obj = json.loads(line)
    except Exception:
        keep.append(line)
        continue

    # 计算 effective expires_at
    exp_at = obj.get('expires_at')
    exp_ts = parse_iso(exp_at) if exp_at else None
    if exp_ts is None:
        # 按 source 推 TTL，从 ts + ttl
        ts_raw = obj.get('ts')
        ts_ts = parse_iso(ts_raw) if ts_raw else None
        if ts_ts is not None:
            default_ttl = ttl_default_for(obj.get('source', ''))
            exp_ts = ts_ts + default_ttl
            obj['_inferred_expires_at'] = datetime.datetime.utcfromtimestamp(exp_ts).strftime('%Y-%m-%dT%H:%M:%SZ')
        else:
            exp_ts = None  # 无法判断，保守保留

    # 过期 → 归档
    if exp_ts is not None and exp_ts < now:
        obj['_archived_at'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
        obj['_archived_reason'] = 'expired'
        archived.append(obj)
        continue

    # 未过期但 openclaw down → 留着
    if openclaw_down:
        keep.append(line)
        continue

    # 未过期且 openclaw 可用 → 尝试发
    text = obj.get('text', '')
    if not text:
        obj['_archived_at'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
        obj['_archived_reason'] = 'empty_text'
        archived.append(obj)
        continue

    try:
        # notify-wechat.sh 10s 超时
        proc = subprocess.run(
            ['bash', wechat_sh, text],
            capture_output=True, timeout=15, text=True,
        )
        if proc.returncode == 0:
            obj['_archived_at'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
            obj['_archived_reason'] = 'sent'
            obj['_send_output'] = (proc.stdout or '')[:200]
            archived.append(obj)
        else:
            obj['_last_retry_at'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
            obj['_last_retry_err'] = (proc.stderr or proc.stdout or '')[:200]
            keep.append(json.dumps(obj, ensure_ascii=False))
    except subprocess.TimeoutExpired:
        obj['_last_retry_at'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
        obj['_last_retry_err'] = 'timeout'
        keep.append(json.dumps(obj, ensure_ascii=False))
    except Exception as e:
        obj['_last_retry_at'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
        obj['_last_retry_err'] = str(e)[:200]
        keep.append(json.dumps(obj, ensure_ascii=False))

# 写 archive（append）
if archived:
    with open(archive_path, 'a', encoding='utf-8') as f:
        for obj in archived:
            f.write(json.dumps(obj, ensure_ascii=False) + '\n')

# 重写 outbox（atomic tmp + rename）
tmp = outbox_path + '.tmp.' + str(os.getpid())
with open(tmp, 'w', encoding='utf-8') as f:
    if keep:
        f.write('\n'.join(keep) + '\n')
os.replace(tmp, outbox_path)

# 报告
print(f'[outbox-drain] scanned={len(raw_lines)} archived={len(archived)} kept={len(keep)} openclaw_down={openclaw_down}')
PY
