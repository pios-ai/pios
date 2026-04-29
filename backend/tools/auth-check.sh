#!/bin/bash
# auth-check.sh — PiOS Auth Health Monitor
# Checks Claude CLI, Codex CLI, Anthropic API key
# Writes: Pi/Config/pios.yaml infra.runtimes.{engine}.status
# Notifies small豆 if any engine is unhealthy

set -euo pipefail

# Ensure homebrew binaries are available in cron environment
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NOW_TS=$(date +%s)

# ── Helpers ──
age_hours() {
  local file="$1"
  if [ ! -f "$file" ]; then echo 9999; return; fi
  local mtime
  mtime=$(stat -f "%m" "$file" 2>/dev/null || echo 0)
  echo $(( (NOW_TS - mtime) / 3600 ))
}

write_notify() {
  bash "$VAULT/Pi/Tools/notify.sh" critical "$1"
}

# ── Update engine status in pios.yaml (with file locking) ──
update_engine_status() {
  local engine="$1" new_status="$2" error_msg="${3:-}"
  python3 -c "
import yaml, datetime, fcntl, os

manifest_path = '$VAULT/Pi/Config/pios.yaml'
lock_path = '$VAULT/Pi/State/locks/pios-yaml.lock'

os.makedirs(os.path.dirname(lock_path), exist_ok=True)
lock_fd = open(lock_path, 'w')
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except:
    exit(0)

try:
    with open(manifest_path) as f:
        m = yaml.safe_load(f)
    rt = m.get('infra', {}).get('runtimes', {}).get('$engine', {})
    old_status = rt.get('status', 'unknown')
    rt['status'] = '$new_status'
    now = datetime.datetime.now().strftime('%Y-%m-%dT%H:%M')
    if '$new_status' == 'ok':
        rt['last_success'] = now
        rt['error'] = None
        rt.pop('down_since', None)
    else:
        rt['error'] = '''$error_msg'''[:200] or None
        if old_status in ('ok', 'unknown'):
            rt['down_since'] = now
    m['infra']['runtimes']['$engine'] = rt
    # 原子写入：tmp → rename，避免 tick reader 读到 truncate 后的空文件
    # （过去 3 天整点报 'fail: not a dict' 就是这个竞态，2026-04-17 修复）
    import os as _os
    tmp = manifest_path + '.tmp.' + str(_os.getpid())
    with open(tmp, 'w') as f:
        yaml.dump(m, f, default_flow_style=False, allow_unicode=True, width=120)
    _os.rename(tmp, manifest_path)
    print('Updated pios.yaml: $engine → $new_status')
finally:
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    lock_fd.close()
" 2>/dev/null
}

# ── 1. Claude CLI ──
# 只信 `claude auth status` —— claude CLI 自己管 OAuth 生命周期（自动 refresh），
# auth-check 不再去 stat token 文件的 mtime 或同步 Keychain。
# 如果 CLI 说 loggedIn:true → engine ok；否则 → engine logged_out，UI 会显示 Login 按钮。
#
# macOS + cron 特殊情况（2026-04-15 修正诊断）：
# 之前的注释说"cron 读不到 Keychain"是错的——4/11-4/12 和 4/15 凌晨 cron 里 claude-cli 都跑通过。
# 真实原因：PiBrowser 的 `claude auth logout && claude auth login` 流程会重写 Keychain entry，
# 新 ACL 把 decrypt 权限限制到只允许 /usr/bin/security 命令，导致 launchd 后台上下文
# 下 claude CLI 走不通。修法见 feedback_claude_cron_env_var.md：PiBrowser 周期性把
# Keychain token harvest 到 ~/.claude-code-cron-token，pios-adapter 跑 claude 前
# export CLAUDE_CODE_OAUTH_TOKEN 绕开 Keychain。
#
# 这里的行为仍然保留"headless macOS 跳过 claude auth 检查"：因为 auth-check.sh 本身
# 也在 cron 里跑，调 `claude auth status` 会撞同样的 ACL 问题，得到假阴性。由 PiBrowser
# 前端做 live probe 给出真实状态。
claude_ok=false
claude_detail="unknown"
IS_HEADLESS=false
if ! [ -t 0 ]; then IS_HEADLESS=true; fi

if [ "$IS_HEADLESS" = "true" ] && [ "$(uname)" = "Darwin" ]; then
  # macOS cron 上下文：ACL 把 claude auth status 打假阴性，直接跳过验证
  claude_ok=true
  claude_detail="skipped in headless macOS context (ACL restricts keychain access in cron)"
elif command -v claude >/dev/null 2>&1; then
  claude_json=$(claude auth status 2>/dev/null || echo '{}')
  logged_in=$(echo "$claude_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('loggedIn','false'))" 2>/dev/null || echo false)
  auth_method=$(echo "$claude_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('authMethod',''))" 2>/dev/null || echo "")
  if [ "$logged_in" = "True" ] || [ "$logged_in" = "true" ]; then
    claude_ok=true
    claude_detail="ok (authMethod=${auth_method})"
  else
    claude_ok=false
    claude_detail="not logged in — run \`claude auth login\` or use PiBrowser UI Login button"
  fi
else
  claude_detail="claude binary not found"
fi

# ── 2. Codex CLI ──
codex_ok=false
codex_detail="unknown"
codex_auth="$HOME/.codex/auth.json"
if [ -f "$codex_auth" ]; then
  read -r codex_has_token codex_last_refresh <<< $(python3 - <<'PYEOF'
import json, sys, os
try:
    with open(os.path.expanduser('~/.codex/auth.json')) as f:
        d = json.load(f)
    tokens = d.get('tokens', {})
    has = bool(tokens.get('access_token'))
    lr = d.get('last_refresh', '')
    print(('true' if has else 'false'), lr)
except:
    print('false', '')
PYEOF
)
  if [ "$codex_has_token" = "true" ]; then
    if [ -n "$codex_last_refresh" ]; then
      # Parse ISO timestamp and check age
      refresh_ts=$(python3 -c "
import datetime, sys
try:
    s = '${codex_last_refresh}'.replace('Z', '+00:00')
    dt = datetime.datetime.fromisoformat(s)
    import time
    print(int(dt.timestamp()))
except:
    print(0)
")
      refresh_age=$(( (NOW_TS - refresh_ts) / 3600 ))
      if [ "$refresh_age" -gt 168 ]; then  # 7 days
        codex_ok=false
        codex_detail="token stale (${refresh_age}h since refresh)"
      else
        codex_ok=true
        codex_detail="ok (refreshed ${refresh_age}h ago)"
      fi
    else
      codex_ok=true
      codex_detail="ok (no refresh time recorded)"
    fi
  else
    codex_ok=false
    codex_detail="no access_token in auth.json"
  fi
else
  codex_detail="auth.json not found"
fi

# ── 3. Anthropic API Key ──
# REMOVED 2026-04-15: the anthropic-api "engine" was a placeholder. The env var
# is injected by Claude Desktop at runtime (not on disk), so cron can never
# verify it, and we marked it `ok=true, detail=not_verifiable` unconditionally —
# a UI card with zero information value. No current agent uses raw API key
# (everything goes through claude-cli / codex-cli), so the card is gone.
# If a future agent needs raw ANTHROPIC_API_KEY, re-add a real probe that
# calls the API once per hour to verify the key works.

# ── 3. Openclaw ──
openclaw_ok=false
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:$PATH"
if command -v openclaw >/dev/null 2>&1; then
  _oc_status=$(openclaw status --deep 2>/dev/null || echo "")
  if echo "$_oc_status" | grep -q "openclaw-weixin.*OK"; then
    openclaw_ok=true
  fi
fi

# ── Update pios.yaml infra.runtimes ──
if [ "$claude_ok" = "true" ]; then
  update_engine_status "claude-cli" "ok" ""
else
  update_engine_status "claude-cli" "down" "$claude_detail"
fi

if [ "$codex_ok" = "true" ]; then
  update_engine_status "codex-cli" "ok" ""
else
  update_engine_status "codex-cli" "down" "$codex_detail"
fi

if [ "$openclaw_ok" = "true" ]; then
  update_engine_status "openclaw" "ok" ""
elif command -v openclaw >/dev/null 2>&1; then
  update_engine_status "openclaw" "down" "weixin channel not OK"
fi

# ── Write per-host auth status JSON (consumed by PiBrowser /pios/auth-status) ──
# Per-host file so each machine writes its own view; backend aggregates them.
# Schema:
#   { "host": "laptop-host", "updated_at": "...", "engines": {
#       "claude-cli": { "ok": true|false, "detail": "...", "login_supported": true },
#       "codex-cli":  { "ok": ..., "detail": "..." }
#   }}
# shellcheck source=lib/host-resolve.sh
source "$VAULT/Pi/Tools/lib/host-resolve.sh"
_AUTH_STATUS_HOST=$(pios_resolve_host)
_AUTH_STATUS_FILE="$VAULT/Pi/Log/auth-status-${_AUTH_STATUS_HOST}.json"
python3 -c "
import json, datetime, os, tempfile
path = '$_AUTH_STATUS_FILE'
data = {
    'host': '$_AUTH_STATUS_HOST',
    'updated_at': datetime.datetime.now().astimezone().isoformat(),
    'engines': {
        'claude-cli': {
            'ok': '$claude_ok' == 'true',
            'detail': '''$claude_detail'''.strip()[:200],
            'login_supported': True,
        },
        'codex-cli': {
            'ok': '$codex_ok' == 'true',
            'detail': '''$codex_detail'''.strip()[:200],
            'login_supported': True,
        },
    },
}
os.makedirs(os.path.dirname(path), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
os.replace(tmp, path)
" 2>/dev/null || echo "warning: failed to write $_AUTH_STATUS_FILE"

# ── Notify if any engine is unhealthy ──
problems=()
[ "$claude_ok" != "true" ] && problems+=("Claude CLI: $claude_detail")
[ "$codex_ok" != "true" ] && problems+=("Codex CLI: $codex_detail")
[ "$openclaw_ok" != "true" ] && problems+=("Openclaw: weixin channel not OK")

if [ ${#problems[@]} -gt 0 ]; then
  _owner=$(/usr/bin/python3 -c "import yaml; print(yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml')).get('owner',''))" 2>/dev/null)
  msg="${_owner:-User}，AI 引擎授权异常："
  for p in "${problems[@]}"; do
    msg="$msg $p；"
  done
  # 附上可执行的修复指令
  fix_hints=""
  [ "$claude_ok" != "true" ] && fix_hints="${fix_hints} 修复：在 laptop-host 终端跑 claude login ；"
  [ "$codex_ok" != "true" ] && fix_hints="${fix_hints} 修复：在 laptop-host 终端跑 codex login ；"
  [ -n "$fix_hints" ] && msg="$msg$fix_hints"
  write_notify "$msg"
  echo "⚠️  Auth problems found, notified 小豆"
  exit 1
else
  echo "✅ All auth engines healthy"
  # 清除 auth-pause（如果存在，说明之前 quota 用完，现在恢复了）
  PAUSE_FILE="$VAULT/Pi/State/auth-pause.json"
  if [ -f "$PAUSE_FILE" ]; then
    rm -f "$PAUSE_FILE"
    echo "✅ Auth-pause cleared (engines recovered)"
    bash "$VAULT/Pi/Tools/notify.sh" info "AI 引擎恢复正常，auth-pause 已清除" 2>/dev/null
  fi
  exit 0
fi
