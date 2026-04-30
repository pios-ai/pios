#!/bin/bash
# pios-register-cron.sh — 将 PiOS tasks 注册为 OpenClaw cron jobs
#
# 用法:
#   pios-register-cron.sh           注册所有 enabled tasks
#   pios-register-cron.sh --dry-run 仅显示将要注册的 jobs
#   pios-register-cron.sh --list    列出已注册的 PiOS cron jobs
#
# 前提: OpenClaw Gateway 必须在运行中

set -uo pipefail

VAULT="${PIOS_VAULT:-$(cd "$(dirname "$0")/../.." && pwd)}"
MANIFEST="$VAULT/Pi/Config/pios.yaml"
PYAML="/usr/bin/python3"
command -v "$PYAML" >/dev/null 2>&1 || PYAML="python3"

DRY_RUN=false
LIST_ONLY=false

case "${1:-}" in
  --dry-run) DRY_RUN=true ;;
  --list) LIST_ONLY=true ;;
esac

# ── 检查 OpenClaw 是否可用 ──────────────────────────────

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[pios-register-cron] OpenClaw not installed, skipping"
  exit 0
fi

# ── List 模式 ────────────────────────────────────────────

if $LIST_ONLY; then
  echo "OpenClaw cron jobs (PiOS registered):"
  openclaw cron list --json 2>/dev/null | $PYAML -c "
import json, sys
try:
    jobs = json.load(sys.stdin)
    for j in jobs:
        name = j.get('name', j.get('id', '?'))
        cron = j.get('cron', j.get('schedule', '?'))
        enabled = 'on' if j.get('enabled', True) else 'off'
        print(f'  {name:30s} {cron:20s} [{enabled}]')
except:
    print('  (无法解析或 Gateway 未运行)')
" 2>/dev/null || echo "  (Gateway 未运行)"
  exit 0
fi

# ── 获取已有 jobs ────────────────────────────────────────

existing_jobs=""
if openclaw cron list --json 2>/dev/null > /tmp/pios-cron-existing.json; then
  existing_jobs=$(cat /tmp/pios-cron-existing.json)
fi

# ── 从 pios.yaml 提取 tasks ─────────────────────────────

tasks=$($PYAML -c "
import yaml, json, sys

manifest = yaml.safe_load(open('$MANIFEST'))
agents = manifest.get('agents', {})
tasks = []

for aid, agent in agents.items():
    if agent.get('status') == 'paused':
        continue
    for tid, task in (agent.get('tasks') or {}).items():
        if not task.get('enabled', True):
            continue
        cron = ''
        trigger = task.get('trigger', {})
        if isinstance(trigger, dict):
            cron = trigger.get('cron', '')
        prompt_path = task.get('prompt', '')
        tasks.append({
            'id': tid,
            'agent': aid,
            'cron': cron,
            'prompt': prompt_path,
        })

print(json.dumps(tasks))
")

# ── 注册 ─────────────────────────────────────────────────

registered=0
skipped=0
failed=0

echo "$tasks" | $PYAML -c "
import json, sys
for t in json.loads(sys.stdin.read()):
    print(f\"{t['id']}\t{t['agent']}\t{t['cron']}\t{t['prompt']}\")
" | while IFS=$'\t' read -r task_id agent_id cron prompt_path; do
  [ -z "$cron" ] && continue

  # 检查是否已存在
  if echo "$existing_jobs" | $PYAML -c "
import json, sys
jobs = json.loads(sys.stdin.read()) if sys.stdin.read().strip() else []
names = [j.get('name', '') for j in jobs]
sys.exit(0 if '$task_id' in names else 1)
" 2>/dev/null; then
    echo "  skip: $task_id (already registered)"
    skipped=$((skipped + 1))
    continue
  fi

  # OpenClaw 方式：让 agent 读文件（workspace 内），不 inline 全部内容
  # prompt_path 类似 ../Agents/pipeline/tasks/daily-health.md
  # 在 agent workspace (Pi/Agents/<agent>/) 内是 tasks/<task-id>.md
  message="Read and follow the task instructions in tasks/${task_id}.md"

  if $DRY_RUN; then
    echo "  would register: $task_id (agent=$agent_id, cron=$cron)"
    continue
  fi

  # 注册
  if openclaw cron add \
    --name "$task_id" \
    --cron "$cron" \
    --agent "$agent_id" \
    --session isolated \
    --message "$message" \
    --json 2>/dev/null; then
    echo "  ✓ $task_id"
    registered=$((registered + 1))
  else
    echo "  ✗ $task_id (failed)"
    failed=$((failed + 1))
  fi
done

rm -f /tmp/pios-cron-existing.json

if $DRY_RUN; then
  echo "[dry-run] Done."
else
  echo "[pios-register-cron] Done. registered=$registered skipped=$skipped failed=$failed"
fi
