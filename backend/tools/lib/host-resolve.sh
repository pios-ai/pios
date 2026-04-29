#!/bin/bash
# host-resolve.sh — 产品版（不含任何私有 fleet 映射）
#
# 行为：
#   1. $PIOS_HOST env override → 直接用
#   2. ~/.pios/config.json `host_map[hostname]` 用户自定义别名
#   3. 默认：hostname -s 小写 + 去 .local
#
# 私有 fleet 映射请写进 ~/.pios/config.json 的 host_map，或各自 vault 的
# Pi/Tools/lib/host-resolve.sh（installer 不覆盖已存在的 vault 副本）。
# 产品 bundle 里**禁止**硬编码任何 owner 身份。
pios_resolve_host() {
  local raw="${1:-}"
  if [ -z "$raw" ]; then
    raw=$(hostname -s 2>/dev/null || echo unknown)
  fi
  if [ -n "${PIOS_HOST:-}" ]; then
    printf '%s\n' "$PIOS_HOST"
    return
  fi
  local cfg="$HOME/.pios/config.json"
  if [ -f "$cfg" ] && command -v jq >/dev/null 2>&1; then
    local mapped
    mapped=$(jq -r --arg h "$raw" '.host_map[$h] // empty' "$cfg" 2>/dev/null)
    if [ -n "$mapped" ] && [ "$mapped" != "null" ]; then
      printf '%s\n' "$mapped"
      return
    fi
  fi
  # 默认：小写 + 剥 .local
  printf '%s\n' "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/\.local$//'
}
