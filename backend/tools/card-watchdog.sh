#!/usr/bin/env bash
# card-watchdog.sh — PiOS L2 v3.1 §5.2 escalation 巡检 infra-task
#
# 每小时跑一次，扫 Cards/active/*.md 检测：
#   1. owner_timeout: needs_owner 挂超过 owner_timeout_hours（缺省 48h）→ status: escalated
#   2. interaction_ceiling: interaction_round > interaction_ceiling（缺省 5）→ status: escalated
#
# 设 escalation_reason + 追加 note；不碰 needs_owner（triage 还要读）
# 不改 escalated 卡的 status（只升级一次）
#
# Usage: bash card-watchdog.sh [--dry-run]

set -euo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
CARDS_DIR="$VAULT/Cards/active"
LOG_FILE="$VAULT/Pi/Log/card-watchdog.log"
DRY_RUN=0

[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

DEFAULT_TIMEOUT_HOURS=48
DEFAULT_CEILING=5

log() {
  echo "[$(date +'%Y-%m-%dT%H:%M:%S')] $*" >> "$LOG_FILE"
}

check_and_escalate() {
  local card="$1"

  python3 - "$card" "$DEFAULT_TIMEOUT_HOURS" "$DEFAULT_CEILING" "$DRY_RUN" <<'PYEOF'
import sys, re, os, datetime
card_path = sys.argv[1]
default_timeout = int(sys.argv[2])
default_ceiling = int(sys.argv[3])
dry_run = sys.argv[4] == '1'

with open(card_path, 'r', encoding='utf-8') as f:
    content = f.read()

m = re.match(r'^---\n(.*?)\n---\n(.*)$', content, re.DOTALL)
if not m:
    sys.exit(0)  # no frontmatter
fm_text, body = m.group(1), m.group(2)

def fm_get(key, default=None):
    mm = re.search(rf'^{key}:\s*(.+)$', fm_text, re.MULTILINE)
    if not mm:
        return default
    v = mm.group(1).strip().strip("'\"")
    return v

status = fm_get('status', '')
# Terminal / already escalated → skip
if status in ('done', 'dismissed', 'escalated', 'archive', 'archived'):
    sys.exit(0)

needs_owner = fm_get('needs_owner', '')
needs_owner_set_at = fm_get('needs_owner_set_at', '')
try:
    interaction_round = int(fm_get('interaction_round', '0') or '0')
except ValueError:
    interaction_round = 0
try:
    ceiling = int(fm_get('interaction_ceiling', str(default_ceiling)) or default_ceiling)
except ValueError:
    ceiling = default_ceiling
try:
    timeout_hours = int(fm_get('owner_timeout_hours', str(default_timeout)) or default_timeout)
except ValueError:
    timeout_hours = default_timeout

reason = None
detail = None
now = datetime.datetime.now()

# Check 1: timeout (needs_owner 挂过久)
if needs_owner and needs_owner.lower() != 'null':
    # Use needs_owner_set_at if present, else file mtime as fallback
    ref_iso = needs_owner_set_at
    if ref_iso:
        try:
            ref_time = datetime.datetime.strptime(ref_iso[:16], '%Y-%m-%dT%H:%M')
        except ValueError:
            ref_time = None
    else:
        ref_time = datetime.datetime.fromtimestamp(os.path.getmtime(card_path))

    if ref_time is not None:
        elapsed_h = (now - ref_time).total_seconds() / 3600.0
        if elapsed_h > timeout_hours:
            reason = 'timeout'
            detail = f'needs_owner 挂 {elapsed_h:.0f}h 超过 owner_timeout_hours={timeout_hours}'

# Check 2: interaction_ceiling
if not reason and interaction_round > ceiling:
    reason = 'ceiling'
    detail = f'interaction_round={interaction_round} > interaction_ceiling={ceiling}'

if not reason:
    sys.exit(0)

# Build updated frontmatter
iso_now = now.strftime('%Y-%m-%dT%H:%M')

new_fm = fm_text
# Replace or add status
if re.search(r'^status:', new_fm, re.MULTILINE):
    new_fm = re.sub(r'^status:.*$', f'status: escalated', new_fm, count=1, flags=re.MULTILINE)
else:
    new_fm = f'status: escalated\n' + new_fm

# Replace or add escalation_reason
if re.search(r'^escalation_reason:', new_fm, re.MULTILINE):
    new_fm = re.sub(r'^escalation_reason:.*$', f'escalation_reason: {reason}', new_fm, count=1, flags=re.MULTILINE)
else:
    new_fm = new_fm.rstrip() + f'\nescalation_reason: {reason}'

# Append note to body
note = f'\n\n---\n*card-watchdog {iso_now} escalated: {detail}*\n'
new_body = body.rstrip() + note
new_content = f'---\n{new_fm}\n---\n{new_body}'

if dry_run:
    print(f'DRY-RUN would escalate {card_path}: reason={reason} detail={detail}')
    sys.exit(11)

# Atomic write
tmp = card_path + '.tmp.' + str(os.getpid())
orig_mtime = os.path.getmtime(card_path)
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(new_content)

# Recheck mtime before commit
if os.path.getmtime(card_path) != orig_mtime:
    os.remove(tmp)
    print(f'skip: mtime changed during watchdog (concurrent write): {card_path}')
    sys.exit(12)

os.rename(tmp, card_path)
print(f'escalated {card_path}: reason={reason} detail={detail}')
sys.exit(10)
PYEOF
  return $?
}

# Main
mkdir -p "$(dirname "$LOG_FILE")"
log "=== card-watchdog start (dry-run=$DRY_RUN) ==="

total=0
escalated=0
dryrun_flagged=0

for card in "$CARDS_DIR"/*.md; do
  [ -f "$card" ] || continue
  [[ "$(basename "$card")" == *".sync-conflict-"* ]] && continue
  total=$((total + 1))

  output=$(check_and_escalate "$card" 2>&1) || rc=$? && rc=${rc:-0}
  case "$rc" in
    10) escalated=$((escalated + 1)); log "$output" ;;
    11) dryrun_flagged=$((dryrun_flagged + 1)); log "$output" ;;
    12) log "$output" ;;
    0)  : ;;
    *)  log "unexpected rc=$rc: $output" ;;
  esac
done

log "=== card-watchdog done · scanned=$total escalated=$escalated dryrun_flagged=$dryrun_flagged ==="
echo "- card-watchdog: scanned=$total escalated=$escalated dryrun_flagged=$dryrun_flagged"
