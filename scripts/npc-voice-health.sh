#!/usr/bin/env bash
# NPC 音质 4 层栈健康检查（2026-04-21 固化）
#
# 任何 NPC-related skill（npc-create / voice-clone / voice-clip-picker）
# 启动时必须先跑这个脚本。任一层被回退 → 立即 halt，不继续建 NPC。
#
# 4 层栈定义见 Projects/pios/docs/npc-voice-sop.md
# 历史血泪：2026-04-15 repetition_penalty=1.3 改过后又被回退成 1.05，导致所有
# clone voice 口吃。本脚本是防回退的第一道防线。
#
# 用法：bash Projects/pios/scripts/npc-voice-health.sh
# 返回：0 = 全部通过；1 = 有一层被回退（stderr 打印恢复指南）

set -e

FAIL=0
QWEN_HOME="${QWEN_HOME:-$HOME/qwen-voice}"
PIOS_VAULT="${PIOS_VAULT:-$HOME/PiOS}"
QWEN_APP="$QWEN_HOME/app.py"
QWEN_PY="$QWEN_HOME/bin/python"
SANITIZE_JS="$PIOS_VAULT/Projects/pios/backend/tts-sanitize.js"
FILTER_JS="$PIOS_VAULT/Projects/pios/backend/voice-filter.js"
SOP="Projects/pios/docs/npc-voice-sop.md"
# 可选：用户自己存一份 app.py 参考快照路径（防上游配置漂移）
REF_APP="${PIOS_QWEN_REF_APP:-}"

ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; FAIL=1; }
digest_stdin() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum | awk '{print $1}'
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

echo "=== NPC 音质 4 层栈健康检查 ==="

# ── 第 1 层 · Node sanitize ──
echo "[1] Node sanitize (tts-sanitize.js)"
if [ ! -f "$SANITIZE_JS" ]; then
  fail "$SANITIZE_JS 不存在"
elif ! grep -q "stripTechTokens" "$SANITIZE_JS"; then
  fail "stripTechTokens 缺失（扩展名/单位 → 中文规则）— 看 $SOP 第 1 层"
elif ! grep -q "EXT_MAP" "$SANITIZE_JS" || ! grep -q "UNIT_MAP" "$SANITIZE_JS"; then
  fail "EXT_MAP / UNIT_MAP 缺失 — 看 $SOP 第 1 层"
else
  ok "stripTechTokens + EXT_MAP + UNIT_MAP 在位"
fi

# ── 第 2 层 · 服务端 WeText ──
echo "[2] 服务端 WeText (qwen-voice app.py)"
if [ ! -x "$QWEN_PY" ]; then
  fail "qwen-voice venv Python 不存在：$QWEN_PY"
elif ! "$QWEN_PY" -c "import wetext" 2>/dev/null; then
  fail "wetext 未装 — 恢复：$QWEN_PY -m pip install wetext"
else
  ok "wetext 已装"
fi
if [ ! -f "$QWEN_APP" ]; then
  fail "qwen-voice app.py 不存在"
elif ! grep -q "from wetext import Normalizer" "$QWEN_APP"; then
  fail "app.py 未 import wetext — 看 $SOP 第 2 层"
elif ! grep -q "_normalize_text" "$QWEN_APP"; then
  fail "app.py 缺 _normalize_text 前置 — 看 $SOP 第 2 层"
else
  ok "app.py WeText 前置在位"
fi

# ── 第 3 层 · app.py clone 分支采样参数（防回退核心）──
echo "[3] app.py clone 分支采样参数（防回退核心）"
# 要求：clone 分支两处 (do_tts + do_tts_stream) 都有 repetition_penalty=1.3
CLONE_OK=$(grep -cE "repetition_penalty=1\.3" "$QWEN_APP" 2>/dev/null || echo 0)
# CLONE_OK 应 >= 4：clone 两处 + custom 两处 = 4 行
if [ "$CLONE_OK" -lt 4 ]; then
  fail "repetition_penalty=1.3 出现 $CLONE_OK 次（应 ≥ 4：clone+custom 各两处）"
  fail "⚠️ 历史上有人改回过 1.05 导致全面口吃 — 绝不允许！看 $SOP 第 3 层恢复"
else
  ok "repetition_penalty=1.3 × $CLONE_OK 处（clone + custom 全覆盖）"
fi
# 禁止出现 repetition_penalty=1.05
if grep -q "repetition_penalty=1\.05" "$QWEN_APP" 2>/dev/null; then
  fail "!!! 发现 repetition_penalty=1.05（低温贪心采样必定口吃）— 立即恢复到 1.3"
else
  ok "无 repetition_penalty=1.05 残留"
fi
# 禁止出现 temperature=0.05 + top_k=5（低温贪心组合）
if grep -q "temperature=0\.05.*top_k=5\|top_k=5.*temperature=0\.05" "$QWEN_APP" 2>/dev/null; then
  fail "!!! 发现 temperature=0.05 + top_k=5（低温贪心组合，和 1.3 逻辑冲突）— 看 $SOP 第 3 层"
else
  ok "无低温贪心残留"
fi

# ── 第 4 层 · 客户端分段 + filter 三档磁性 ──
echo "[4] 客户端 filter 三档磁性 + raw 档"
if [ ! -f "$FILTER_JS" ]; then
  fail "$FILTER_JS 不存在"
elif ! grep -q "MAGNETIC_ECHO" "$FILTER_JS"; then
  fail "MAGNETIC_ECHO 映射缺失 — 看 $SOP 第 4 层"
else
  SOFT=$(grep -c "soft:" "$FILTER_JS" 2>/dev/null || echo 0)
  MID=$(grep -c "mid:" "$FILTER_JS" 2>/dev/null || echo 0)
  STRONG=$(grep -c "strong:" "$FILTER_JS" 2>/dev/null || echo 0)
  RAW=$(grep -c "raw:" "$FILTER_JS" 2>/dev/null || echo 0)
  if [ "$SOFT" -lt 1 ] || [ "$MID" -lt 1 ] || [ "$STRONG" -lt 1 ] || [ "$RAW" -lt 1 ]; then
    fail "MAGNETIC_ECHO 档位不全 (soft=$SOFT mid=$MID strong=$STRONG raw=$RAW)"
  else
    ok "四档齐全：raw / soft / mid / strong"
  fi
fi

# ── qwen-voice 服务健康 ──
echo "[5] qwen-voice 服务可用性"
if curl -s -m 3 http://localhost:7860/api/voices 2>/dev/null | grep -q '"ready":true'; then
  ok "localhost:7860 ready=true"
else
  fail "qwen-voice 服务未就绪 — 看 $SOP 第 3 层启停指引"
fi

# ── 参考快照对比（可选；export PIOS_QWEN_REF_APP=/path/to/app.py 启用）──
if [ -n "$REF_APP" ] && [ -f "$REF_APP" ]; then
  echo "[6] app.py 关键段与参考快照一致性"
  REF_SIG=$(grep -E "repetition_penalty=|_normalize_text|from wetext" "$REF_APP" | sort | digest_stdin)
  CUR_SIG=$(grep -E "repetition_penalty=|_normalize_text|from wetext" "$QWEN_APP" | sort | digest_stdin)
  if [ "$REF_SIG" = "$CUR_SIG" ]; then
    ok "关键段签名与参考一致"
  else
    echo "  ⚠ 关键段与参考不完全一致（可能是合法新增；如疑似回退请对比：diff $REF_APP $QWEN_APP）"
  fi
fi

echo "==="
if [ $FAIL -eq 0 ]; then
  echo "健康检查全部通过 ✓"
  exit 0
else
  echo "健康检查有失败项 ✗ — 禁止在此状态下建 NPC 或跑 voice-clone！"
  echo "恢复步骤见 $SOP"
  exit 1
fi
