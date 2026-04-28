#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dist/mac-arm64/PiOS.app"
DST="/Applications/PiOS.app"

if [ ! -d "$SRC" ]; then
  echo "[install-app] missing build output: $SRC" >&2
  echo "[install-app] run: npm run build:dir" >&2
  exit 1
fi

if pgrep -x PiOS >/dev/null 2>&1; then
  echo "[install-app] quitting running PiOS"
  osascript -e 'tell application "PiOS" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -x PiOS >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

if pgrep -x PiOS >/dev/null 2>&1; then
  echo "[install-app] PiOS is still running; please quit it and retry" >&2
  exit 1
fi

# 清孤儿 worker：PiOS 死后 pios-tick / pios-adapter 因为 detached spawn 被 init 接管继续跑，
# 它们指向旧 app.asar.unpacked 路径。如果不清就装新版，老 worker 还在用老脚本 → 路径错乱
# + 重装后再启 PiOS 会和老 tick 并行（多组孤儿堆积）。adapter 收 SIGTERM 会 finalize
# run.json（已有 trap）所以是安全的。
_orphans=$(pgrep -f 'pios-tick\.sh|pios-adapter\.sh' 2>/dev/null || true)
if [ -n "$_orphans" ]; then
  echo "[install-app] cleaning up orphan workers: $(echo $_orphans | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -TERM $_orphans 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f 'pios-tick\.sh|pios-adapter\.sh' >/dev/null 2>&1 || break
    sleep 0.5
  done
  # 还赖着 → SIGKILL（已经给过 5 秒 graceful 窗口）
  _stuck=$(pgrep -f 'pios-tick\.sh|pios-adapter\.sh' 2>/dev/null || true)
  if [ -n "$_stuck" ]; then
    echo "[install-app] SIGKILL stuck workers: $(echo $_stuck | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill -9 $_stuck 2>/dev/null || true
  fi
fi

if [ ! -d "$DST" ]; then
  echo "[install-app] first install: copying full app $SRC -> $DST"
  ditto "$SRC" "$DST"
else
  echo "[install-app] updating app payload in $DST"
  cp "$SRC/Contents/Resources/app.asar" "$DST/Contents/Resources/app.asar"
  # ditto 整个 asar.unpacked（含 backend/ + renderer/）——之前只 ditto
  # renderer/assets 漏了 backend/tools/*，导致 pios-tick.sh / pios-adapter.sh
  # 永远停在首装版本，build 后改动跑不到（2026-04-28 redis 锁部署踩坑）
  ditto "$SRC/Contents/Resources/app.asar.unpacked" "$DST/Contents/Resources/app.asar.unpacked"
fi
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true

if ! cmp -s "$SRC/Contents/Resources/app.asar" "$DST/Contents/Resources/app.asar"; then
  echo "[install-app] app.asar mismatch after copy" >&2
  exit 1
fi

echo "[install-app] installed payload and verified: $DST"
