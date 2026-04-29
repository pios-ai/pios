#!/usr/bin/env bash
# pios-stop.sh — 完全停 PiOS：GUI + 全部 worker（pios-tick / pios-adapter）+ claude/codex CLI 子进程
#
# 用途：调试/排查混乱时一键清场。adapter 收 SIGTERM 自动 finalize run.json（trap 已实现）所以安全。
# 给的 graceful 窗口：5 秒 SIGTERM + 5 秒后强杀。
#
# 用法：bash scripts/pios-stop.sh
#       直接：pgrep 找不到任何 PiOS 进程则秒退；找到则按上面流程清。
set -uo pipefail

echo "[pios-stop] === before ==="
ps -A -o pid,ppid,etime,command 2>/dev/null | grep -E "MacOS/PiOS$|pios-tick\.sh|pios-adapter\.sh" | grep -v grep || echo "  (no PiOS processes)"

# 1. GUI graceful quit（让 PiOS 自己 cleanup before-quit hooks）
if pgrep -x PiOS >/dev/null 2>&1; then
  echo "[pios-stop] osascript quit PiOS (GUI)"
  osascript -e 'tell application "PiOS" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -x PiOS >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

# 2. SIGTERM worker：tick + adapter（adapter trap finalize run.json）
_workers=$(pgrep -f 'pios-tick\.sh|pios-adapter\.sh' 2>/dev/null || true)
if [ -n "$_workers" ]; then
  echo "[pios-stop] SIGTERM workers: $(echo $_workers | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -TERM $_workers 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f 'pios-tick\.sh|pios-adapter\.sh' >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

# 3. 还赖着 → SIGKILL（adapter 之前已经有 5s 写 run.json 的窗口）
_stuck=$(pgrep -f 'pios-tick\.sh|pios-adapter\.sh' 2>/dev/null || true)
if [ -n "$_stuck" ]; then
  echo "[pios-stop] SIGKILL stuck: $(echo $_stuck | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -9 $_stuck 2>/dev/null || true
fi

# 4. PiOS 主 GUI 还在（osascript quit 未生效）→ SIGTERM 主进程
_pios_main=$(pgrep -f 'MacOS/PiOS$' 2>/dev/null || true)
if [ -n "$_pios_main" ]; then
  echo "[pios-stop] SIGTERM PiOS main: $_pios_main"
  # shellcheck disable=SC2086
  kill -TERM $_pios_main 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f 'MacOS/PiOS$' >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

# 5. 验证终态
sleep 1
echo "[pios-stop] === after ==="
_remain=$(ps -A -o pid,ppid,etime,command 2>/dev/null | grep -E "MacOS/PiOS$|pios-tick\.sh|pios-adapter\.sh" | grep -v grep || true)
if [ -n "$_remain" ]; then
  echo "$_remain"
  echo "[pios-stop] WARN: 仍有进程未退（请手动 kill -9）"
  exit 2
fi
echo "  (clean)"
echo "[pios-stop] done."
