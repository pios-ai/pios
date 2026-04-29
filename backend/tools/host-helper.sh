# host-helper.sh — 共享函数，shell 脚本 source 本文件
#
# 功能：
#   resolve_host() — 返回当前机器的 HOST（优先 config.json host_map，否则 hostname -s）
#   get_primary_host() — 返回 config.json 里的 primary_host
#
# 用法：
#   source "$(dirname "$0")/host-helper.sh"
#   HOST=$(resolve_host)
#   [ "$HOST" = "$(get_primary_host)" ] && echo "I'm primary"

resolve_host() {
  local raw=$(hostname -s)
  local cfg="$HOME/.pios/config.json"
  if [ -f "$cfg" ]; then
    local mapped
    mapped=$(python3 -c "
import json, sys
try:
    c = json.load(open('$cfg'))
    print(c.get('host_map', {}).get('$raw', '$raw'))
except Exception: print('$raw')
" 2>/dev/null)
    echo "${mapped:-$raw}"
  else
    echo "$raw"
  fi
}

get_primary_host() {
  local cfg="$HOME/.pios/config.json"
  if [ -f "$cfg" ]; then
    python3 -c "
import json
try:
    c = json.load(open('$cfg'))
    print(c.get('primary_host', ''))
except Exception: pass
" 2>/dev/null
  fi
}
