#!/bin/bash
# notify-wechat.sh — PiOS → 微信主动推送
# 用法: notify-wechat.sh "消息内容"
#
# 配置优先级：环境变量 > ~/.pios/config.json > 跳过
#
# config.json 字段（在 owner 的 ~/.pios/config.json 里）:
#   openclaw_target       — 微信目标 wxid（owner 自己的微信号）
#   openclaw_remote       — 远程兜底机器 (user@host)，本机没装 openclaw 时走 SSH
#   openclaw_remote_path  — 远程机 PATH 前置（含 openclaw binary 的目录）
#   openclaw_http_proxy   — openclaw 走的代理（默认 http://127.0.0.1:8080）
#
# Env override（同义，方便 ad-hoc 调试）:
#   PIOS_OPENCLAW_TARGET / PIOS_OPENCLAW_REMOTE / PIOS_OPENCLAW_REMOTE_PATH / OPENCLAW_HTTP_PROXY
#
# 判断逻辑：本机不仅要有 openclaw binary，还要 auth-profiles.json 才算真连通。
# 裸装 openclaw 会返回假 messageId 但不上行——典型坑见上游 SOP。

set -euo pipefail

MESSAGE="${1:-}"
if [ -z "$MESSAGE" ]; then
  echo "用法: notify-wechat.sh \"消息内容\"" >&2
  exit 1
fi

# config.json 读字段（jq 装了就读，没装就走 env）
_PIOS_CFG="$HOME/.pios/config.json"
_cfg_get() {
  local key="$1"
  if [ -r "$_PIOS_CFG" ] && command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$key" '.[$k] // empty' "$_PIOS_CFG" 2>/dev/null
  fi
}

WECHAT_TARGET="${PIOS_OPENCLAW_TARGET:-$(_cfg_get openclaw_target)}"
OPENCLAW_REMOTE_VAL="${PIOS_OPENCLAW_REMOTE:-$(_cfg_get openclaw_remote)}"
OPENCLAW_REMOTE_PATH_VAL="${PIOS_OPENCLAW_REMOTE_PATH:-$(_cfg_get openclaw_remote_path)}"
OPENCLAW_HTTP_PROXY_VAL="${OPENCLAW_HTTP_PROXY:-$(_cfg_get openclaw_http_proxy)}"
OPENCLAW_HTTP_PROXY_VAL="${OPENCLAW_HTTP_PROXY_VAL:-http://127.0.0.1:8080}"

if [ -z "$WECHAT_TARGET" ]; then
  echo "[notify-wechat] 跳过：未配置 openclaw_target（~/.pios/config.json 或 PIOS_OPENCLAW_TARGET env）" >&2
  exit 0
fi

# 真连通判定：binary 存在 + auth-profiles.json 存在
_has_openclaw_auth() {
  { command -v openclaw >/dev/null 2>&1 || [ -x "$HOME/.npm-global/bin/openclaw" ] || [ -x "/opt/homebrew/bin/openclaw" ]; } \
    && [ -r "$HOME/.openclaw/agents/main/agent/auth-profiles.json" ]
}

if _has_openclaw_auth; then
  # 本机真有 openclaw + auth
  export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:$PATH"
  export HTTP_PROXY="$OPENCLAW_HTTP_PROXY_VAL"
  openclaw message send \
    --channel openclaw-weixin \
    --target "$WECHAT_TARGET" \
    --message "$MESSAGE" \
    --json 2>/dev/null
elif [ -n "$OPENCLAW_REMOTE_VAL" ]; then
  # 本机无 auth → SSH 到远程兜底机器
  REMOTE_PATH_FINAL="${OPENCLAW_REMOTE_PATH_VAL:-\$HOME/.npm-global/bin}"
  ssh -o ConnectTimeout=5 "$OPENCLAW_REMOTE_VAL" \
    "PATH=${REMOTE_PATH_FINAL}:\$PATH HTTP_PROXY=${OPENCLAW_HTTP_PROXY_VAL} openclaw message send --channel openclaw-weixin --target '$WECHAT_TARGET' --message '$MESSAGE' --json" 2>/dev/null
else
  echo "[notify-wechat] 跳过：本机无 openclaw auth 且未配置 openclaw_remote" >&2
  exit 0
fi
