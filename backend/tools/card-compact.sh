#!/usr/bin/env bash
# card-compact.sh — PiOS L2 v3.1 §5.3 工作记录压缩 infra-task
#
# 每日凌晨跑一次，扫 Cards/active/*.md，把超 40KB body 或 >10 轮工作记录的卡压缩：
#   - 保留最近 3 轮 `### tick N` 原文
#   - 老条目合并到 frontmatter `history_summary` 字段
#   - 原子写：tmp + rename + mtime recheck（防 UI / Worker 并发）
#
# 不改 frontmatter 其他字段。不删卡片。不改 `## 验收标准` / `## Context Pack`。
#
# Usage: bash card-compact.sh [--dry-run]

set -euo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
CARDS_DIR="$VAULT/Cards/active"
LOG_FILE="$VAULT/Pi/Log/card-compact.log"
DRY_RUN=0

[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SIZE_THRESHOLD=$((40 * 1024))  # 40KB
TICK_THRESHOLD=10              # 10 条 tick
KEEP_RECENT=3                  # 保留最近 3 条

log() {
  echo "[$(date +'%Y-%m-%dT%H:%M:%S')] $*" >> "$LOG_FILE"
}

compact_card() {
  local card="$1"
  local tmp="${card}.tmp.$$"
  local orig_mtime
  orig_mtime=$(stat -f '%m' "$card")

  python3 - "$card" "$tmp" "$KEEP_RECENT" <<'PYEOF'
import sys, re
card_path = sys.argv[1]
tmp_path = sys.argv[2]
keep_recent = int(sys.argv[3])

with open(card_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Split frontmatter / body
m = re.match(r'^---\n(.*?)\n---\n(.*)$', content, re.DOTALL)
if not m:
    sys.exit(2)  # no frontmatter, skip
fm_text, body = m.group(1), m.group(2)

# Find `## 工作记录` section
wh_match = re.search(r'(##\s*工作记录[^\n]*\n)(.*?)(?=\n##\s|\Z)', body, re.DOTALL)
if not wh_match:
    sys.exit(3)  # no work history, skip

wh_header = wh_match.group(1)
wh_body = wh_match.group(2)

# Split tick entries (### tick N (...) 或 ### sense-maker note (...))
tick_pattern = re.compile(r'^###\s+', re.MULTILINE)
parts = tick_pattern.split(wh_body)
# parts[0] 是第一个 ### 之前的内容（通常空或前言）
pre = parts[0]
ticks = ['### ' + p for p in parts[1:]] if len(parts) > 1 else []

if len(ticks) <= keep_recent:
    sys.exit(4)  # not enough ticks to compact

old_ticks = ticks[:-keep_recent]
recent_ticks = ticks[-keep_recent:]

# Build history_summary: 每条 tick 取前 2 行
summary_lines = []
for t in old_ticks:
    lines = t.strip().split('\n')
    title = lines[0]  # ### tick N (...)
    first_detail = next((l for l in lines[1:] if l.strip()), '')
    summary_lines.append(f'- {title[4:]}: {first_detail.strip()[:100]}')
summary = '\n'.join(summary_lines)

# Update frontmatter: add/replace history_summary
fm_lines = fm_text.split('\n')
has_history_summary = any(l.startswith('history_summary:') for l in fm_lines)
new_summary_block = 'history_summary: |\n  [前 {} 轮压缩于 {}]\n'.format(
    len(old_ticks),
    __import__('datetime').datetime.now().strftime('%Y-%m-%dT%H:%M')
) + '\n'.join('  ' + l for l in summary.split('\n'))

if has_history_summary:
    # Replace existing multiline history_summary block
    new_fm = re.sub(
        r'^history_summary:.*?(?=^[a-zA-Z_]|\Z)',
        new_summary_block + '\n',
        fm_text,
        count=1,
        flags=re.MULTILINE | re.DOTALL
    )
else:
    new_fm = fm_text.rstrip() + '\n' + new_summary_block

# Rebuild body: pre + header + recent ticks
new_wh_body = pre + '\n'.join(recent_ticks) + '\n'
new_body = body[:wh_match.start()] + wh_header + new_wh_body + body[wh_match.end():]

new_content = f'---\n{new_fm}\n---\n{new_body}'

with open(tmp_path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f'OK compact {len(old_ticks)} old ticks, keep {len(recent_ticks)}')
PYEOF
  local rc=$?

  if [ $rc -ne 0 ]; then
    rm -f "$tmp"
    case $rc in
      2) log "skip: no frontmatter: $card" ;;
      3) log "skip: no work history: $card" ;;
      4) log "skip: not enough ticks: $card" ;;
      *) log "error rc=$rc: $card" ;;
    esac
    return 0
  fi

  # Recheck mtime before commit
  local now_mtime
  now_mtime=$(stat -f '%m' "$card")
  if [ "$now_mtime" != "$orig_mtime" ]; then
    rm -f "$tmp"
    log "skip: mtime changed during compact (concurrent write): $card"
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN would commit: $card"
    rm -f "$tmp"
    return 0
  fi

  mv "$tmp" "$card"
  log "compacted: $card"
}

# Main
mkdir -p "$(dirname "$LOG_FILE")"
log "=== card-compact start (dry-run=$DRY_RUN) ==="

total=0
candidates=0
compacted=0

for card in "$CARDS_DIR"/*.md; do
  [ -f "$card" ] || continue
  [[ "$(basename "$card")" == *".sync-conflict-"* ]] && continue
  total=$((total + 1))

  body_size=$(wc -c < "$card")
  tick_count=$(awk '/^### tick / { n++ } END { print n+0 }' "$card")

  if [ "$body_size" -lt "$SIZE_THRESHOLD" ] && [ "$tick_count" -lt "$TICK_THRESHOLD" ]; then
    continue
  fi
  candidates=$((candidates + 1))

  if compact_card "$card"; then
    compacted=$((compacted + 1))
  fi
done

log "=== card-compact done · scanned=$total candidates=$candidates compacted=$compacted ==="
echo "- card-compact: scanned=$total candidates=$candidates compacted=$compacted"
