#!/bin/bash
# auth-manager.sh — PiOS Auth 统一管理
#
# 管理所有 AI 引擎的 token 生命周期：采集、刷新、切号、告警。
# credentials.json 是唯一数据源，Syncthing 同步到所有机器。
#
# 用法:
#   auth-manager.sh check                        # 定时健康检查（采集+刷新+切号）
#   auth-manager.sh login <provider> [--account <name>]  # 登录
#   auth-manager.sh status                       # 查看所有 provider/account 状态
#   auth-manager.sh switch <provider> <account>  # 切换活跃账号

set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Load proxy (worker-host needs it)
if [ -f /etc/environment ] && [ -z "${HTTPS_PROXY:-}" ]; then
  eval $(grep -E '^(HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|NO_PROXY|no_proxy)=' /etc/environment 2>/dev/null)
  export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy 2>/dev/null
fi

VAULT="${PIOS_VAULT:-$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)}"
CREDS_FILE="$VAULT/Pi/Config/credentials.json"
STATE_DIR="$VAULT/Pi/Log"
PAUSE_FILE="$VAULT/Pi/State/auth-pause.json"

# shellcheck source=lib/host-resolve.sh
source "$VAULT/Pi/Tools/lib/host-resolve.sh"
HOST=$(pios_resolve_host)

AUTH_STATE_FILE="$STATE_DIR/auth-state-${HOST}.json"

log() { echo "[$(date '+%H:%M:%S')] [auth-manager] $*"; }
notify() {
  bash "$VAULT/Pi/Tools/notify.sh" critical "$1"
  log "NOTIFY: $1"
}

# ── JSON helpers (python3) ──────────────────────────────

# Read a field from credentials.json: _creds_get "providers.claude-cli.active_account"
_creds_get() {
  python3 -c "
import json, functools
d = json.load(open('$CREDS_FILE'))
keys = '$1'.split('.')
try:
    val = functools.reduce(lambda o, k: o[k], keys, d)
    if isinstance(val, (dict, list)):
        print(json.dumps(val))
    elif val is None:
        print('')
    else:
        print(val)
except (KeyError, TypeError):
    print('')
" 2>/dev/null
}

# Update credentials.json atomically
_creds_update() {
  # Usage: _creds_update 'python code that modifies d'
  python3 -c "
import json, os, tempfile
creds_path = '$CREDS_FILE'
with open(creds_path) as f:
    d = json.load(f)
$1
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(creds_path))
with os.fdopen(fd, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')
os.replace(tmp, creds_path)
" 2>/dev/null
}

# Write auth-state-{HOST}.json
_state_write() {
  python3 -c "
import json, os, tempfile
state_path = '$AUTH_STATE_FILE'
$1
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_path))
with os.fdopen(fd, 'w') as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write('\n')
os.replace(tmp, state_path)
" 2>/dev/null
}

# ── check: 核心健康检查 ────────────────────────────────

cmd_check() {
  log "check started on $HOST"

  [ -f "$CREDS_FILE" ] || { log "ERROR: $CREDS_FILE not found"; return 1; }

  local version
  version=$(_creds_get "version")
  if [ "$version" != "2" ]; then
    log "ERROR: credentials.json version=$version, expected 2"
    return 1
  fi

  local changes_made=false
  local any_active=false
  local state_observations="{}"

  # Iterate providers
  local providers
  providers=$(python3 -c "
import json
d = json.load(open('$CREDS_FILE'))
for p in d.get('providers', {}):
    print(p)
" 2>/dev/null)

  for provider in $providers; do
    local ptype
    ptype=$(_creds_get "providers.${provider}.type")

    case "$ptype" in
      oauth)
        _check_oauth_provider "$provider"
        ;;
      api-key)
        # API keys don't expire, just log status
        local status
        status=$(_creds_get "providers.${provider}.accounts.$(_creds_get "providers.${provider}.active_account").status")
        log "$provider: api-key, status=$status"
        [ "$status" = "active" ] && any_active=true
        ;;
    esac
  done

  # Write auth-state
  _state_write "
import datetime
state = {
    'host': '$HOST',
    'last_check': datetime.datetime.now().astimezone().isoformat(),
    'observations': $state_observations
}
"

  # Check if all accounts exhausted → pause
  if [ "$any_active" = "false" ]; then
    log "ALL accounts exhausted or unavailable"
    echo "{\"all_exhausted\": true, \"since\": \"$(date -Iseconds)\", \"host\": \"$HOST\"}" > "$PAUSE_FILE"
    notify "owner，所有 AI 账号不可用，非核心任务已暂停"
  else
    # Clear pause if it exists
    if [ -f "$PAUSE_FILE" ]; then
      rm -f "$PAUSE_FILE"
      log "auth-pause cleared, at least one account active"
      notify "owner，AI 账号已恢复，任务恢复运行"
    fi
  fi

  log "check completed"
}

_check_oauth_provider() {
  local provider="$1"
  local active
  active=$(_creds_get "providers.${provider}.active_account")
  [ -z "$active" ] && return

  log "$provider: checking accounts (active=$active)"

  # Get all account names
  local accounts
  accounts=$(python3 -c "
import json
d = json.load(open('$CREDS_FILE'))
for a in d.get('providers', {}).get('$provider', {}).get('accounts', {}):
    print(a)
" 2>/dev/null)

  local active_found=false

  for account in $accounts; do
    local status
    status=$(_creds_get "providers.${provider}.accounts.${account}.status")

    # 1. Quota recovery check
    if [ "$status" = "quota_exhausted" ]; then
      local resets_at
      resets_at=$(_creds_get "providers.${provider}.accounts.${account}.quota_resets_at")
      if [ -n "$resets_at" ]; then
        local is_past
        is_past=$(python3 -c "
from datetime import datetime, timezone
try:
    r = datetime.fromisoformat('$resets_at')
    if r.tzinfo is None: r = r.replace(tzinfo=timezone.utc)
    print('yes' if datetime.now(timezone.utc) > r else 'no')
except: print('no')
" 2>/dev/null)
        if [ "$is_past" = "yes" ]; then
          log "$provider/$account: quota reset time passed, marking active"
          _creds_update "
d['providers']['$provider']['accounts']['$account']['status'] = 'active'
d['providers']['$provider']['accounts']['$account']['quota_resets_at'] = None
"
          status="active"
          changes_made=true
        fi
      fi
    fi

    # 2. 读 auth-state 中 adapter 的失败观察，合并到 credentials.json
    _merge_adapter_observations "$provider" "$account"

    # 3. Token harvest (local .oauth-token → credentials.json)
    if [ "$account" = "$active" ]; then
      _harvest_local_token "$provider" "$account"
    fi

    # 4. Sync credentials to local CLI — 已禁用（2026-04-16）
    # 自动同步 token 到 ~/.claude/.credentials.json 和 ~/.codex/auth.json 会导致
    # 跨机 Syncthing 同步的空 token 覆盖本机有效 token（4/16 全局 401 的元凶）。
    # 认证只能从 PiBrowser 手动 re-login，不再做任何自动 token 写入。
    # if [ "$account" = "$active" ]; then
    #   _sync_local_cli_credentials "$provider" "$account"
    #   _sync_local_codex_credentials "$provider" "$account"
    # fi

    # 5. Refresh codex token if near expiry (only works on non-blocked hosts)
    if [ "$account" = "$active" ]; then
      _refresh_codex_token "$provider" "$account"
    fi

    # Re-read status after potential changes
    status=$(_creds_get "providers.${provider}.accounts.${account}.status")
    [ "$status" = "active" ] && active_found=true

    log "$provider/$account: status=$status"
  done

  # 4. Auto-switch if active account is down
  local active_status
  active_status=$(_creds_get "providers.${provider}.accounts.${active}.status")
  if [ "$active_status" != "active" ]; then
    for account in $accounts; do
      local s
      s=$(_creds_get "providers.${provider}.accounts.${account}.status")
      if [ "$s" = "active" ] && [ "$account" != "$active" ]; then
        log "$provider: switching $active → $account (reason: $active_status)"
        _creds_update "d['providers']['$provider']['active_account'] = '$account'"
        notify "AI 账号自动切换：$provider $active → $account（原因：$active_status）"
        active="$account"
        break
      fi
    done
  fi

  [ "$active_found" = "true" ] && any_active=true
}

_merge_adapter_observations() {
  # 读所有 auth-state-*.json 的 observations，把 adapter 记录的失败合并到 credentials.json
  local provider="$1" account="$2"

  local current_status
  current_status=$(_creds_get "providers.${provider}.accounts.${account}.status")

  # 如果 credentials.json 已经标记了非 active 状态，不用再查 auth-state
  [ "$current_status" != "active" ] && return

  # 扫所有机器的 auth-state
  local worst_status=""
  local reset_msg=""
  for state_file in "$STATE_DIR"/auth-state-*.json; do
    [ -f "$state_file" ] || continue
    local obs_status
    obs_status=$(python3 -c "
import json
try:
    d = json.load(open('$state_file'))
    obs = d.get('observations', {}).get('$account', {})
    print(obs.get('status', ''))
except: pass
" 2>/dev/null)
    if [ "$obs_status" = "quota" ] || [ "$obs_status" = "quota_exhausted" ]; then
      worst_status="quota_exhausted"
      reset_msg=$(python3 -c "
import json
try:
    d = json.load(open('$state_file'))
    print(d.get('observations', {}).get('$account', {}).get('raw_message', ''))
except: pass
" 2>/dev/null)
    elif [ "$obs_status" = "auth" ] && [ -z "$worst_status" ]; then
      worst_status="token_expired"
    fi
  done

  if [ -n "$worst_status" ]; then
    log "$provider/$account: adapter reported $worst_status, updating credentials.json"
    if [ "$worst_status" = "quota_exhausted" ]; then
      # 尝试解析 reset 时间（"resets Apr 15, 12am"）
      local resets_at=""
      if [ -n "$reset_msg" ]; then
        resets_at=$(python3 -c "
import re, datetime
msg = '''$reset_msg'''
# Try to parse 'resets Apr 15' or 'resets Apr 15, 12am'
m = re.search(r'resets?\s+(\w+\s+\d+)', msg)
if m:
    from dateutil import parser as dp
    try:
        dt = dp.parse(m.group(1) + ' 2026')
        print(dt.astimezone().isoformat())
    except:
        # Fallback: 5 days from now
        print((datetime.datetime.now() + datetime.timedelta(days=5)).astimezone().isoformat())
else:
    print((datetime.datetime.now() + datetime.timedelta(days=5)).astimezone().isoformat())
" 2>/dev/null)
      fi
      [ -z "$resets_at" ] && resets_at=$(python3 -c "
import datetime
print((datetime.datetime.now() + datetime.timedelta(days=5)).astimezone().isoformat())
" 2>/dev/null)
      _creds_update "
d['providers']['$provider']['accounts']['$account']['status'] = 'quota_exhausted'
d['providers']['$provider']['accounts']['$account']['quota_resets_at'] = '$resets_at'
"
    else
      _creds_update "d['providers']['$provider']['accounts']['$account']['status'] = '$worst_status'"
    fi
    changes_made=true

    # 清除已合并的 auth-state observations
    for state_file in "$STATE_DIR"/auth-state-*.json; do
      [ -f "$state_file" ] || continue
      python3 -c "
import json, os, tempfile
state_path = '$state_file'
try:
    d = json.load(open(state_path))
    obs = d.get('observations', {})
    if '$account' in obs:
        del obs['$account']
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_path))
        with os.fdopen(fd, 'w') as f:
            json.dump(d, f, indent=2)
        os.replace(tmp, state_path)
except: pass
" 2>/dev/null
    done
  fi
}

_harvest_local_token() {
  local provider="$1" account="$2"

  # Read local .oauth-token file
  local token_file_rel
  token_file_rel=$(_creds_get "providers.${provider}.local_token_file")
  [ -z "$token_file_rel" ] && return

  local token_file="$HOME/$token_file_rel"
  [ -f "$token_file" ] || return

  # Read token: plain text file (.oauth-token) or JSON file (.codex/auth.json)
  local local_token local_refresh_token=""
  if echo "$token_file" | grep -q '\.json$'; then
    # JSON token file - extract access_token and refresh_token fields
    read -r local_token local_refresh_token <<< $(python3 -c "
import json, sys
d = json.load(open('$token_file'))
t = d.get('tokens', {})
access = t.get('access_token', '') or d.get('access_token', '') or d.get('token', '')
refresh = t.get('refresh_token', '') or d.get('refresh_token', '')
print(access, refresh)
" 2>/dev/null)
  else
    local_token=$(cat "$token_file" 2>/dev/null | tr -d '\n')
  fi
  [ -z "$local_token" ] && return

  local creds_token
  creds_token=$(_creds_get "providers.${provider}.accounts.${account}.accessToken")

  if [ "$local_token" != "$creds_token" ]; then
    # Compare JWT expiry — only harvest if local token is actually newer
    local should_harvest="true"
    if echo "$local_token" | grep -q '^ey' && echo "$creds_token" | grep -q '^ey'; then
      should_harvest=$(python3 -c "
import json, base64
def get_exp(t):
    try:
        payload = json.loads(base64.b64decode(t.split('.')[1] + '=='))
        return payload.get('exp', 0)
    except: return 0
local_exp = get_exp('$local_token')
creds_exp = get_exp('$creds_token')
print('true' if local_exp > creds_exp else 'false')
" 2>/dev/null)
    fi

    if [ "$should_harvest" = "true" ]; then
      log "$provider/$account: harvesting newer local token"
      _creds_update "
import datetime
d['providers']['$provider']['accounts']['$account']['accessToken'] = '$local_token'
"
      changes_made=true
    else
      log "$provider/$account: local token is older than creds, skipping harvest"
    fi
  fi

  # Also harvest refresh_token from JSON token file if present and different
  if [ -n "$local_refresh_token" ]; then
    local creds_refresh
    creds_refresh=$(_creds_get "providers.${provider}.accounts.${account}.refreshToken")
    if [ "$local_refresh_token" != "$creds_refresh" ]; then
      log "$provider/$account: harvesting refresh_token from local token file"
      _creds_update "d['providers']['$provider']['accounts']['$account']['refreshToken'] = '$local_refresh_token'"
      changes_made=true
    fi
  fi

  # On macOS, also harvest refresh_token from Keychain if available
  local keychain_svc
  keychain_svc=$(_creds_get "providers.${provider}.keychain_service")
  if [ -n "$keychain_svc" ] && command -v security &>/dev/null; then
    local keychain_json
    keychain_json=$(security find-generic-password -s "$keychain_svc" -w 2>/dev/null)
    if [ -n "$keychain_json" ]; then
      local kc_refresh
      kc_refresh=$(echo "$keychain_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('claudeAiOauth',{}).get('refreshToken',''))" 2>/dev/null)
      local creds_refresh
      creds_refresh=$(_creds_get "providers.${provider}.accounts.${account}.refreshToken")
      if [ -n "$kc_refresh" ] && [ "$kc_refresh" != "$creds_refresh" ]; then
        log "$provider/$account: harvesting newer refresh_token from Keychain"
        _creds_update "d['providers']['$provider']['accounts']['$account']['refreshToken'] = '$kc_refresh'"
        changes_made=true
      fi
    fi
  fi
}

_sync_local_cli_credentials() {
  # 把 credentials.json 中 active_account 的完整 OAuth 信息
  # 写到本机 ~/.claude/.credentials.json，让 CLI 用原生认证自动刷新
  local provider="$1" account="$2"

  local access_token refresh_token expires_at
  access_token=$(_creds_get "providers.${provider}.accounts.${account}.accessToken")
  refresh_token=$(_creds_get "providers.${provider}.accounts.${account}.refreshToken")
  expires_at=$(_creds_get "providers.${provider}.accounts.${account}.expiresAt")

  [ -z "$refresh_token" ] && { log "$provider/$account: no refresh_token, can't sync to local CLI"; return; }

  # 检查本地 .credentials.json 是否已经是这个账号的
  local local_creds="$HOME/.claude/.credentials.json"
  local local_refresh=""
  if [ -f "$local_creds" ]; then
    local_refresh=$(python3 -c "
import json
try:
    d = json.load(open('$local_creds'))
    print(d.get('claudeAiOauth', {}).get('refreshToken', ''))
except: pass
" 2>/dev/null)
  fi

  # 只有 refresh_token 不同时才写（避免不必要的写入）
  if [ "$local_refresh" = "$refresh_token" ]; then
    return  # 已经是同一个账号的 credentials
  fi

  log "$provider/$account: syncing credentials to local CLI (~/.claude/.credentials.json)"

  mkdir -p "$HOME/.claude"
  python3 -c "
import json, os, tempfile
cli_creds = {
    'claudeAiOauth': {
        'accessToken': '$access_token',
        'refreshToken': '$refresh_token',
        'expiresAt': int('${expires_at:-0}'),
        'scopes': ['user:file_upload', 'user:inference', 'user:mcp_servers', 'user:profile', 'user:sessions:claude_code'],
        'subscriptionType': 'max'
    }
}
creds_path = os.path.expanduser('~/.claude/.credentials.json')
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(creds_path))
with os.fdopen(fd, 'w') as f:
    json.dump(cli_creds, f, indent=2)
os.replace(tmp, creds_path)
os.chmod(creds_path, 0o600)
" 2>/dev/null
}

_sync_local_codex_credentials() {
  # Reverse sync: credentials.json → ~/.codex/auth.json
  # Needed because worker-host can't refresh OpenAI tokens directly (region block)
  local provider="$1" account="$2"

  [ "$provider" != "codex-cli" ] && return

  local token_file_rel
  token_file_rel=$(_creds_get "providers.${provider}.local_token_file")
  [ -z "$token_file_rel" ] && return

  local token_file="$HOME/$token_file_rel"
  [ -f "$token_file" ] || return

  local creds_token
  creds_token=$(_creds_get "providers.${provider}.accounts.${account}.accessToken")
  [ -z "$creds_token" ] && return

  # Read current local token
  local local_token
  local_token=$(python3 -c "
import json
d = json.load(open('$token_file'))
print(d.get('tokens', {}).get('access_token', ''))
" 2>/dev/null)

  [ "$local_token" = "$creds_token" ] && return

  # Check if creds token is actually newer
  local should_sync="true"
  if echo "$local_token" | grep -q '^ey' && echo "$creds_token" | grep -q '^ey'; then
    should_sync=$(python3 -c "
import json, base64
def get_exp(t):
    try:
        payload = json.loads(base64.b64decode(t.split('.')[1] + '=='))
        return payload.get('exp', 0)
    except: return 0
creds_exp = get_exp('$creds_token')
local_exp = get_exp('$local_token')
print('true' if creds_exp > local_exp else 'false')
" 2>/dev/null)
  fi

  [ "$should_sync" != "true" ] && return

  log "$provider/$account: syncing newer token from credentials.json → $token_file"
  python3 -c "
import json, os, tempfile
token_path = '$token_file'
d = json.load(open(token_path))
d['tokens']['access_token'] = '$creds_token'
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(token_path))
with os.fdopen(fd, 'w') as f:
    json.dump(d, f, indent=4)
os.replace(tmp, token_path)
os.chmod(token_path, 0o600)
" 2>/dev/null
}

_refresh_codex_token() {
  # Refresh OpenAI/Codex token using refresh_token from ~/.codex/auth.json
  # Only runs on machines that can reach OpenAI (laptop-host via Tailscale)
  local provider="$1" account="$2"

  [ "$provider" != "codex-cli" ] && return

  local token_file_rel
  token_file_rel=$(_creds_get "providers.${provider}.local_token_file")
  [ -z "$token_file_rel" ] && return

  local token_file="$HOME/$token_file_rel"
  [ -f "$token_file" ] || return

  # Check if current token is expired or near expiry (<6h)
  local needs_refresh
  needs_refresh=$(python3 -c "
import json, base64, time
d = json.load(open('$token_file'))
token = d.get('tokens', {}).get('access_token', '')
refresh = d.get('tokens', {}).get('refresh_token', '')
if not refresh:
    print('no_refresh')
elif not token.startswith('ey'):
    print('yes')
else:
    try:
        payload = json.loads(base64.b64decode(token.split('.')[1] + '=='))
        exp = payload.get('exp', 0)
        remaining_h = (exp - time.time()) / 3600
        print('yes' if remaining_h < 6 else 'no')
    except:
        print('yes')
" 2>/dev/null)

  [ "$needs_refresh" = "no" ] && return
  [ "$needs_refresh" = "no_refresh" ] && { log "$provider/$account: no refresh_token in local file, can't refresh"; return; }

  # Try to refresh — will fail on region-blocked machines (expected)
  log "$provider/$account: attempting token refresh"
  local result
  result=$(python3 -c "
import json, urllib.request, time

d = json.load(open('$token_file'))
refresh_token = d['tokens']['refresh_token']

req_data = json.dumps({
    'grant_type': 'refresh_token',
    'refresh_token': refresh_token,
    'client_id': 'app_EMoamEEZ73f0CkXaXp7hrann'
}).encode()

req = urllib.request.Request(
    'https://auth.openai.com/oauth/token',
    data=req_data,
    headers={'Content-Type': 'application/json'},
    method='POST'
)

try:
    resp = urllib.request.urlopen(req, timeout=15)
    result = json.loads(resp.read())
    new_access = result.get('access_token', '')
    new_refresh = result.get('refresh_token', '')
    new_id = result.get('id_token', '')

    if new_access:
        d['tokens']['access_token'] = new_access
        if new_refresh:
            d['tokens']['refresh_token'] = new_refresh
        if new_id:
            d['tokens']['id_token'] = new_id
        d['last_refresh'] = time.strftime('%Y-%m-%dT%H:%M:%S.000000000Z', time.gmtime())

        import os, tempfile
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname('$token_file'))
        with os.fdopen(fd, 'w') as f:
            json.dump(d, f, indent=4)
        os.replace(tmp, '$token_file')
        os.chmod('$token_file', 0o600)
        print('OK:' + new_access[:30])
    else:
        print('FAIL:no_access_token')
except Exception as e:
    print('FAIL:' + str(e)[:80])
" 2>/dev/null)

  if echo "$result" | grep -q '^OK:'; then
    log "$provider/$account: token refreshed successfully"
    # Harvest the new token into credentials.json
    _harvest_local_token "$provider" "$account"
  else
    local reason="${result#FAIL:}"
    log "$provider/$account: refresh failed ($reason) — expected on region-blocked hosts"
  fi
}

# ── login: 登录新账号 ──────────────────────────────────

cmd_login() {
  local provider="${1:-claude-cli}"
  local account=""

  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --account) account="$2"; shift 2 ;;
      *) account="$1"; shift ;;
    esac
  done

  [ -z "$account" ] && { echo "Usage: auth-manager.sh login <provider> --account <name>"; return 1; }

  log "login: provider=$provider account=$account"

  case "$provider" in
    claude-cli)
      echo "Running 'claude login'... Complete the browser OAuth flow."
      claude login
      local exit_code=$?
      if [ $exit_code -ne 0 ]; then
        log "claude login failed (exit=$exit_code)"
        return 1
      fi

      # Extract credentials from Keychain (macOS) or .credentials.json (Linux)
      local oauth_json=""
      local keychain_svc
      keychain_svc=$(_creds_get "providers.${provider}.keychain_service")

      if [ -n "$keychain_svc" ] && command -v security &>/dev/null; then
        oauth_json=$(security find-generic-password -s "$keychain_svc" -w 2>/dev/null)
      elif [ -f "$HOME/.claude/.credentials.json" ]; then
        oauth_json=$(cat "$HOME/.claude/.credentials.json")
      fi

      if [ -z "$oauth_json" ]; then
        log "WARNING: could not extract full OAuth (refresh_token missing)"
        # Fall back to just the access token
        local token
        token=$(cat "$HOME/.claude/.oauth-token" 2>/dev/null | tr -d '\n')
        [ -z "$token" ] && { log "ERROR: no token found"; return 1; }
        _creds_update "
d.setdefault('providers', {}).setdefault('$provider', {'type': 'oauth', 'accounts': {}, 'active_account': '$account'})
d['providers']['$provider']['accounts']['$account'] = {
    'accessToken': '$token',
    'status': 'active',
    'quota_resets_at': None
}
d['providers']['$provider']['active_account'] = '$account'
"
      else
        # Full OAuth with refresh_token
        _creds_update "
import json
oauth = json.loads('''$oauth_json''')
cai = oauth.get('claudeAiOauth', oauth)
d.setdefault('providers', {}).setdefault('$provider', {'type': 'oauth', 'accounts': {}, 'active_account': '$account'})
d['providers']['$provider']['accounts']['$account'] = {
    'email': '$account',
    'accessToken': cai.get('accessToken', ''),
    'refreshToken': cai.get('refreshToken', ''),
    'expiresAt': cai.get('expiresAt', 0),
    'status': 'active',
    'quota_resets_at': None
}
d['providers']['$provider']['active_account'] = '$account'
"
      fi

      log "login complete: $provider/$account"
      ;;
    *)
      echo "Login for provider '$provider' not implemented. Add token manually to credentials.json."
      return 1
      ;;
  esac
}

# ── status: 显示所有状态 ───────────────────────────────

cmd_status() {
  [ -f "$CREDS_FILE" ] || { echo "credentials.json not found"; return 1; }

  python3 -c "
import json, datetime, os, glob

d = json.load(open('$CREDS_FILE'))
now = datetime.datetime.now(datetime.timezone.utc)

print('=== PiOS Auth Status ===')
print()

for pname, prov in d.get('providers', {}).items():
    active = prov.get('active_account', '?')
    ptype = prov.get('type', '?')
    print(f'[{pname}] type={ptype} active={active}')

    for aname, acct in prov.get('accounts', {}).items():
        status = acct.get('status', '?')
        marker = ' ← ACTIVE' if aname == active else ''

        if ptype == 'oauth' and 'expiresAt' in acct:
            exp = acct.get('expiresAt', 0)
            if exp:
                exp_dt = datetime.datetime.fromtimestamp(exp / 1000, tz=datetime.timezone.utc)
                remaining = (exp_dt - now).total_seconds() / 3600
                has_refresh = bool(acct.get('refreshToken'))
                print(f'  {aname}: status={status}, token expires in {remaining:.1f}h, refresh_token={\"yes\" if has_refresh else \"NO\"}{marker}')
            else:
                print(f'  {aname}: status={status}, no expiry info{marker}')
        elif ptype == 'api-key':
            source = acct.get('source', '?')
            print(f'  {aname}: status={status}, source={source}{marker}')
        else:
            print(f'  {aname}: status={status}{marker}')

        if status == 'quota_exhausted':
            resets = acct.get('quota_resets_at', '?')
            print(f'         quota resets at: {resets}')

    print()

# Show per-host auth states
print('=== Per-Host State ===')
for sf in sorted(glob.glob('$STATE_DIR/auth-state-*.json')):
    try:
        s = json.load(open(sf))
        host = s.get('host', os.path.basename(sf))
        last = s.get('last_check', '?')
        print(f'  {host}: last_check={last}')
    except:
        pass

# Show pause status
if os.path.exists('$PAUSE_FILE'):
    print()
    print('⚠️  AUTH-PAUSE ACTIVE — non-essential tasks paused')
    try:
        p = json.load(open('$PAUSE_FILE'))
        print(f'  since: {p.get(\"since\", \"?\")}')
    except:
        pass
" 2>/dev/null
}

# ── switch: 切换活跃账号 ──────────────────────────────

cmd_switch() {
  local provider="${1:?Usage: auth-manager.sh switch <provider> <account>}"
  local account="${2:?Usage: auth-manager.sh switch <provider> <account>}"

  local current
  current=$(_creds_get "providers.${provider}.active_account")

  local target_status
  target_status=$(_creds_get "providers.${provider}.accounts.${account}.status")

  if [ -z "$target_status" ]; then
    echo "Account '$account' not found in provider '$provider'"
    return 1
  fi

  _creds_update "d['providers']['$provider']['active_account'] = '$account'"
  log "switch: $provider $current → $account"
  echo "Switched $provider active account: $current → $account (status=$target_status)"
}

# ── Main ───────────────────────────────────────────────

case "${1:-help}" in
  check)  cmd_check ;;
  login)  shift; cmd_login "$@" ;;
  status) cmd_status ;;
  switch) shift; cmd_switch "$@" ;;
  help|*)
    echo "Usage: auth-manager.sh <command>"
    echo "  check                        Health check (harvest + refresh + switch)"
    echo "  login <provider> --account <name>  Login to a provider"
    echo "  status                       Show all provider/account status"
    echo "  switch <provider> <account>  Switch active account"
    ;;
esac
