#!/usr/bin/env bash
# PiOS 统一提醒脚本 — 纯 bash，零 AI 调用
# 由 pios-tick.sh 每分钟调用，检查 reminders.yaml 中是否有当前时间的提醒
set -euo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
CONFIG="$VAULT/Pi/Agents/life/reminders.yaml"
# shellcheck source=lib/host-resolve.sh
source "$VAULT/Pi/Tools/lib/host-resolve.sh"
HOST_SHORT=$(pios_resolve_host)
LOG_FILE="$VAULT/Pi/Log/worker-log-${HOST_SHORT}.md"
# 动态查找用户 Pipeline 目录（兼容任意用户名）
TRACKING_BASE=""
for _d in "$VAULT"/*/Pipeline/AI_Health_Digest; do
  [ -d "$_d" ] && TRACKING_BASE="$_d" && break
done
[ -z "$TRACKING_BASE" ] && TRACKING_BASE="$VAULT/Pi/Output/health"

[ -f "$CONFIG" ] || exit 1

NOW_HHMM=$(date +%H:%M)
TODAY=$(date +%Y-%m-%d)
DOW=$(date +%u)  # 1=Mon ... 7=Sun

# 用 awk 从 YAML 中提取当前时间的提醒
eval "$(awk -v now="$NOW_HHMM" -v dow="$DOW" '
BEGIN { found=0; in_rotate=0 }
/^- time:/ {
  gsub(/[" ]/, "", $3)
  if ($3 == now) { found=1; in_rotate=0 }
  else { found=0 }
  next
}
!found { next }
/^  category:/ { gsub(/^ *category: */, ""); cat=$0 }
/^  tracking:/ { gsub(/^ *tracking: */, ""); tr=$0 }
/^  message:/ {
  gsub(/^ *message: *"/, ""); gsub(/"$/, "")
  msg=$0; in_rotate=0
}
/^  weekday_rotate:/ { in_rotate=1; next }
in_rotate && $0 ~ "^    "dow":" {
  gsub(/^ *[0-9]+: *"/, ""); gsub(/"$/, "")
  msg=$0
}
END {
  if (msg == "") { print "MATCHED=0"; exit }
  gsub(/"/, "\\\"", msg)
  print "MATCHED=1"
  print "R_CATEGORY=\"" cat "\""
  print "R_TRACKING=\"" tr "\""
  print "R_MESSAGE=\"" msg "\""
}
' "$CONFIG")"

[ "${MATCHED:-0}" = "0" ] && exit 0

# 写追踪记录（幂等）
if [ -n "${R_TRACKING:-}" ] && [ "$R_TRACKING" != "null" ]; then
  tracking_dir="$TRACKING_BASE/$R_TRACKING"
  tracking_file="$tracking_dir/${TODAY}.md"
  mkdir -p "$tracking_dir"

  if [ ! -f "$tracking_file" ]; then
    printf -- '---\ndate: %s\ntype: %s\n---\n' "$TODAY" "$R_TRACKING" > "$tracking_file"
  fi

  # 幂等检查
  if grep -q "^- \[.\] ${NOW_HHMM}" "$tracking_file" 2>/dev/null; then
    exit 0
  fi

  echo "- [ ] ${NOW_HHMM} ${R_CATEGORY} — 已提醒" >> "$tracking_file"
fi

# 发通知
# 读 owner name 从 pios.yaml
_OWNER=$(/usr/bin/python3 -c "import yaml; m=yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml')); print(m.get('owner',''))" 2>/dev/null)
_OWNER="${_OWNER:-User}"
bash "$VAULT/Pi/Tools/notify.sh" reminder "${_OWNER}，${R_MESSAGE}"

# 写日志（标准 ### 标头格式，含引擎/agent/task 元数据）
echo "### $(date '+%Y-%m-%d %H:%M') [${HOST_SHORT}] | engine:bash | agent:reminder | task:reminder-${R_CATEGORY}" >> "$LOG_FILE"
echo "- 动作：${NOW_HHMM} ${R_CATEGORY} 提醒已发送" >> "$LOG_FILE"
