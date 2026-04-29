#!/bin/bash
# vault-mcp-wrapper.sh — 启动 vault MCP server（基于 @modelcontextprotocol/server-filesystem）
#
# Step E.1 MVP：权限源 = PIOS_PATH_READ_ALLOW + PIOS_PATH_WRITE_ALLOW（由 pios-adapter.sh
# 从 agents.{id}.capabilities 注入的 env）。
#
# 妥协（写在表面上，Step E V2 再收紧）：
#   - server-filesystem 只接受目录，不支持 glob / 单文件 —— 会降级到父目录
#   - server-filesystem 单一 allowlist 控制读+写 —— read/write 语义被碾平
#   - 文件级精确权限 / read-only 隔离 要等自写 vault MCP server
#
# 调用：由 claude-cli 通过 --mcp-config 启动（stdio transport），继承父进程 env。
# 预装加速：npm i -g @modelcontextprotocol/server-filesystem；没装则 npx 兜底。

set -uo pipefail

if [ -z "${PIOS_PATH_READ_ALLOW:-}" ] && [ -z "${PIOS_PATH_WRITE_ALLOW:-}" ]; then
  echo "[vault-mcp] ERROR: no PIOS_PATH_*_ALLOW env — refusing to start" >&2
  exit 2
fi

_DIRS=$(/usr/bin/python3 <<'PYEOF'
import os

def to_dir(p):
    p = (p or '').strip()
    if not p:
        return None
    # 去掉尾部 /** 或 /*
    while p.endswith('/**') or p.endswith('/*'):
        p = p.rsplit('/', 1)[0]
    # 中段 glob（如 gate-state-*.json）→ 取父目录
    if any(c in p for c in '*?[') :
        p = p.rsplit('/', 1)[0]
    # 文件路径（最后一段含 .）→ 取父目录（注意：不依赖文件存在）
    base = p.rsplit('/', 1)[-1]
    if '.' in base and base != '.' and base != '..':
        p = p.rsplit('/', 1)[0] or '/'
    # 归一化：去掉末尾 /（除根）
    if len(p) > 1 and p.endswith('/'):
        p = p.rstrip('/')
    return p or None

raw = []
raw += (os.environ.get('PIOS_PATH_READ_ALLOW')  or '').split('|')
raw += (os.environ.get('PIOS_PATH_WRITE_ALLOW') or '').split('|')

dirs = set()
for p in raw:
    d = to_dir(p)
    if d:
        dirs.add(d)

# 最短前缀 dedup：若 /a/b 已在白名单，则丢弃 /a/b/c
sorted_dirs = sorted(dirs, key=len)
final = []
for d in sorted_dirs:
    if not any(d == f or d.startswith(f + '/') for f in final):
        final.append(d)

for d in final:
    print(d)
PYEOF
)

# 读成 bash 数组（避免路径含空格被拆词）
_DIR_ARR=()
while IFS= read -r _d; do
  [ -n "$_d" ] && _DIR_ARR+=("$_d")
done <<< "$_DIRS"

if [ ${#_DIR_ARR[@]} -eq 0 ]; then
  echo "[vault-mcp] ERROR: no allowed dirs after normalization" >&2
  exit 3
fi

# Debug: PIOS_DEBUG=1 时把解析出的目录列表写到 stderr（不污染 stdio MCP 协议）
if [ "${PIOS_DEBUG:-0}" = "1" ]; then
  echo "[vault-mcp] allowed dirs (${#_DIR_ARR[@]}): ${_DIR_ARR[*]}" >&2
fi

# 预装优先，npx 兜底
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v mcp-server-filesystem >/dev/null 2>&1; then
  exec mcp-server-filesystem "${_DIR_ARR[@]}"
else
  exec npx -y @modelcontextprotocol/server-filesystem "${_DIR_ARR[@]}"
fi
