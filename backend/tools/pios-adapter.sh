#!/bin/bash
# pios-adapter.sh — PiOS Runtime Adapter
#
# 根据 runtime 类型调用对应的 AI CLI 执行 Agent prompt。
# 统一接口：pios-adapter.sh <runtime> <prompt> <allowed_tools> <log_file> [agent_name] [session_id] [permission_mode]
#
# 支持的 runtime:
#   claude-cli  — Claude Code CLI (默认)
#   codex-cli   — OpenAI Codex CLI
#   openclaw    — OpenClaw Agent (通过 Gateway 或 --local 嵌入执行)
#   local       — 直接用 bash 执行 prompt（用于简单脚本任务）
#   echo        — 调试模式，只打印 prompt 不执行
#
# Run State: 执行前/后写 JSON run record 到 Pi/State/runs/
# Fallback: claude-cli 遇到已知的登录/额度/二进制错误时自动回退到 codex-cli

set -uo pipefail

# Ensure homebrew and common paths are available (cron has minimal PATH)
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Load proxy settings (cron 不加载 /etc/environment)
if [ -f /etc/environment ] && [ -z "${HTTPS_PROXY:-}" ]; then
  eval $(grep -E '^(HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|NO_PROXY|no_proxy)=' /etc/environment)
  export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy 2>/dev/null
fi

# Claude CLI 认证策略（2026-04-15 简化）：
# claude CLI 自己管 credentials（OAuth flow + 自动 refresh），adapter 不插手。
# 首次登录通过 `claude auth login`（或 PiBrowser UI 的 Login 按钮），写入
# ~/.claude/.credentials.json + Keychain。之后 claude -p 被调用时 CLI 自己
# 用 refresh token 续命。adapter 只要把 task prompt 喂给 claude 二进制就行，
# 不读也不写任何 credentials 文件，更不做 token 同步 / account 切换。
_AUTH_STRATEGY="claude-native"

VAULT="${PIOS_VAULT:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Engine health pre-check: if ALL AI runtimes are down, skip early.
# "down" = auth-check 或上次 adapter 失败标记的状态。正常情况下只有 openclaw
# 这种特定引擎会 down，不会整体都 down。
_ALL_DOWN=$(python3 -c "
import yaml
try:
    m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml'))
    rts = m.get('infra',{}).get('runtimes',{})
    ai_engines = [k for k,v in rts.items() if k != 'local']
    down = [k for k in ai_engines if rts[k].get('status') == 'down']
    print('true' if len(down) == len(ai_engines) and ai_engines else 'false')
except: print('false')
" 2>/dev/null)
if [ "$_ALL_DOWN" = "true" ]; then
  echo "[adapter] ALL AI engines down (pios.yaml), skipping" >> "${4:-/dev/null}"
  exit 1
fi

RUNS_DIR="$VAULT/Pi/State/runs"
mkdir -p "$RUNS_DIR"
TAIL_LINES="${PIOS_ADAPTER_TAIL_LINES:-80}"
FALLBACK_FROM=""
FALLBACK_REASON=""

# ── --task 模式：从 task 文件读取所有配置 ──
if [ "${1:-}" = "--task" ]; then
  TASK_ID="${2:?'--task requires taskId'}"
  # pios-tick 调用格式: --task taskId sessionId logFile promptFile
  # $5 = prompt 文件路径（pios-tick 传），否则从 pios.yaml 查
  if [ -n "${5:-}" ] && [ -f "${5}" ]; then
    TASK_FILE="${5}"
  elif [ -n "${4:-}" ] && [ -f "${4}" ] && head -1 "${4}" 2>/dev/null | grep -q '^---$'; then
    # 兼容旧调用格式（$4 是 prompt 文件，判断有 frontmatter）
    TASK_FILE="${4}"
  else
    # 从 pios.yaml 查 prompt 路径
    _prompt_path=$(python3 -c "
import yaml
m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml'))
for a in m.get('agents',{}).values():
  for tid, t in (a.get('tasks') or {}).items():
    if tid == '$TASK_ID':
      print(t.get('prompt',''))
      break
" 2>/dev/null)
    if [ -n "$_prompt_path" ] && [ -f "$VAULT/Pi/Config/$_prompt_path" ]; then
      TASK_FILE="$VAULT/Pi/Config/$_prompt_path"
    else
      TASK_FILE="$VAULT/Pi/Agents/*/tasks/${TASK_ID}.md"
      TASK_FILE=$(ls $TASK_FILE 2>/dev/null | head -1)
    fi
  fi
  [ -f "$TASK_FILE" ] || { echo "[adapter] ERROR: task file not found for $TASK_ID" >&2; exit 1; }
  [ -f "$TASK_FILE" ] || { echo "[adapter] ERROR: task file not found: $TASK_FILE" >&2; exit 1; }

  # 解析 frontmatter（支持单行值和 YAML 多行数组）
  _fm() { awk -v key="$1" '/^---$/{c++; next} c==1 && $0 ~ "^"key":"{sub("^"key": *",""); gsub(/"/,""); print; exit}' "$TASK_FILE"; }
  # 解析 YAML 数组（支持 [a,b] 单行 和 \n  - a\n  - b 多行）
  _fm_array() {
    awk -v key="$1" '
    /^---$/{c++; next}
    c!=1{next}
    $0 ~ "^"key":" {
      val=$0; sub("^"key": *","",val); gsub(/"/,"",val)
      if (val ~ /^\[/) { gsub(/[\[\] '"'"']/,"",val); print val; exit }
      if (val != "" && val != "[]") { print val; exit }
      collecting=1; next
    }
    collecting && /^  +- / { gsub(/^ *- */, ""); gsub(/['"'"'"]/,""); items = items ? items "," $0 : $0; next }
    collecting { print items; exit }
    ' "$TASK_FILE"
  }

  _manifest_runtime=$(python3 -c "
import yaml
m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml'))
for aid, a in m.get('agents', {}).items():
  t = (a.get('tasks') or {}).get('$TASK_ID')
  if t is not None:
    print(t.get('runtime') or a.get('runtime') or '')
    break
" 2>/dev/null)
  # 读 task.runtimes（新字段）优先，engines（老字段）兜底，runtime 单值最后
  # task.runtimes 缺省 → 继承 agent.runtimes（整个 fallback 链）
  _manifest_engines=$(python3 -c "
import yaml
m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml'))
for aid, a in m.get('agents', {}).items():
  t = (a.get('tasks') or {}).get('$TASK_ID')
  if t is not None:
    rts = t.get('runtimes') or t.get('engines')
    if not rts:
      rts = a.get('runtimes') or ([a['runtime']] if a.get('runtime') else [])
    print(','.join(str(e) for e in rts))
    break
" 2>/dev/null)
  _manifest_agent_engines=$(python3 -c "
import yaml
m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml'))
for aid, a in m.get('agents', {}).items():
  if '$TASK_ID' in (a.get('tasks') or {}):
    rts = a.get('runtimes') or ([a['runtime']] if a.get('runtime') else [])
    print(','.join(str(e) for e in rts))
    break
" 2>/dev/null)
  _manifest_agent=$(python3 -c "
import yaml
m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml'))
for aid, a in m.get('agents', {}).items():
  if '$TASK_ID' in (a.get('tasks') or {}):
    print(aid)
    break
" 2>/dev/null)

  # frontmatter 里的 runtimes (新) 或 engines (老)
  engines_raw=$(_fm_array runtimes)
  [ -z "$engines_raw" ] && engines_raw=$(_fm_array engines)
  engines_raw=$(echo "$engines_raw" | tr -d ' ')
  if [ -n "$_manifest_engines" ]; then
    REQUESTED_RUNTIME=$(echo "$_manifest_engines" | cut -d',' -f1)
    FALLBACK_ENGINE=$(echo "$_manifest_engines" | cut -d',' -f2 -s)
  elif [ -n "$_manifest_runtime" ]; then
    REQUESTED_RUNTIME="$_manifest_runtime"
    FALLBACK_ENGINE=""
  elif [ -n "$engines_raw" ]; then
    REQUESTED_RUNTIME=$(echo "$engines_raw" | cut -d',' -f1)
    FALLBACK_ENGINE=$(echo "$engines_raw" | cut -d',' -f2 -s)
  else
    REQUESTED_RUNTIME=$(_fm engine)
    FALLBACK_ENGINE=""
  fi
  [ "$REQUESTED_RUNTIME" = "code" ] && REQUESTED_RUNTIME="claude-cli"
  [ "$FALLBACK_ENGINE" = "code" ] && FALLBACK_ENGINE="claude-cli"
  # task 只声明主引擎时，继承 agent 的备用链，避免像 daily-briefing 这种
  # 任务级单值把 agent 级 fallback 意外截断。
  if [ -z "${FALLBACK_ENGINE:-}" ] && [ -n "$_manifest_agent_engines" ]; then
    _agent_primary=$(echo "$_manifest_agent_engines" | cut -d',' -f1)
    _agent_fallback=$(echo "$_manifest_agent_engines" | cut -d',' -f2 -s)
    if [ -n "$_agent_fallback" ] && [ "$REQUESTED_RUNTIME" = "$_agent_primary" ]; then
      FALLBACK_ENGINE="$_agent_fallback"
    fi
  fi
  REQUESTED_RUNTIME="${REQUESTED_RUNTIME:-claude-cli}"
  RUNTIME="$REQUESTED_RUNTIME"

  # allowed_tools / permission 三层继承链：task(manifest 或 frontmatter) > agent.capabilities > hardcoded default
  _MANIFEST_TASK_TOOLS_PERM=$(/usr/bin/python3 -c "
import yaml
try:
    m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml'))
    for aid, a in m.get('agents', {}).items():
        t = (a.get('tasks') or {}).get('$TASK_ID')
        if t is None: continue
        caps = a.get('capabilities', {}) or {}
        # allowed_tools: task 显式 > agent.capabilities > default
        tt = t.get('allowed_tools')
        if tt is None:
            tt = caps.get('allowed_tools')
            if isinstance(tt, list): tt = ','.join(tt)
        if tt is None: tt = ''
        # permission: task 显式 > agent.capabilities > default
        pp = t.get('permission_mode') or caps.get('permission') or ''
        print(f'{tt}|{pp}')
        break
except Exception: print('|')
" 2>/dev/null)
  _MF_TOOLS=$(echo "$_MANIFEST_TASK_TOOLS_PERM" | cut -d'|' -f1)
  _MF_PERM=$(echo "$_MANIFEST_TASK_TOOLS_PERM" | cut -d'|' -f2)
  ALLOWED_TOOLS="${_MF_TOOLS:-$(_fm allowed_tools)}"
  ALLOWED_TOOLS="${ALLOWED_TOOLS:-Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch}"
  PERMISSION_MODE="${_MF_PERM:-$(_fm permission_mode)}"
  BUDGET=$(_fm budget)
  BUDGET="${BUDGET:-medium}"
  AGENT_NAME="$TASK_ID"
  SESSION_ID="${3:-}"
  LOG_FILE="${4:-/dev/null}"

  # 读取 prompt body（frontmatter 之后的内容）
  PROMPT=$(awk 'BEGIN{fm=0} /^---$/{fm++; next} fm>=2{print}' "$TASK_FILE")

  # 如果有关联 agent，加载 SOUL.md 作前缀
  agent_field=$(_fm agent)
  case "${agent_field:-}" in
    null|"'null'"|\"null\") agent_field="" ;;
  esac
  [ -z "$agent_field" ] && agent_field="$_manifest_agent"
  if [ -n "$agent_field" ] && [ "$agent_field" != "null" ]; then
    soul_file="$VAULT/Pi/Agents/$agent_field/SOUL.md"
    if [ -f "$soul_file" ]; then
      SOUL=$(cat "$soul_file")
      PROMPT="${SOUL}

---

${PROMPT}"
    fi
  fi

  # 变量替换（运行时注入）
  # {owner} / {vault} 是两个固定模板；display_names.* dict 里每个 key 自动变成
  # {<key>_name} 模板变量（比如 display_names.wechat: "<owner-display-name>" → {wechat_name}）。
  # 规则：per-user 整串显示名必须整体配置（<owner-display-name>→Tony 时不会是 Tony<surname>），
  # prompt 里禁止 {owner}+字面量拼接。
  _OWNER=$(/usr/bin/python3 -c "import yaml; print(yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml')).get('owner','User'))" 2>/dev/null || echo "User")
  PROMPT="${PROMPT//\{owner\}/$_OWNER}"
  PROMPT="${PROMPT//\{vault\}/$VAULT}"

  # display_names dict → {<key>_name} 模板变量
  _DN_PAIRS=$(/usr/bin/python3 -c "
import yaml
try:
    m = yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml')) or {}
    dn = m.get('display_names') or {}
    for k, v in dn.items():
        if isinstance(v, str):
            print(f'{k}={v}')
except: pass
" 2>/dev/null)
  while IFS='=' read -r _dn_k _dn_v; do
    [ -z "$_dn_k" ] && continue
    PROMPT="${PROMPT//\{${_dn_k}_name\}/$_dn_v}"
  done <<< "$_DN_PAIRS"

  # 注入执行上下文（local 引擎直接 bash 执行，不需要 AI 上下文）
  _CTX_HOST=$(hostname -s 2>/dev/null || echo "unknown")
  _CTX_AGENT="${agent_field:-${TASK_ID}}"
  if [ "$REQUESTED_RUNTIME" != "local" ]; then
    PROMPT="PiOS_CONTEXT: engine=${REQUESTED_RUNTIME} agent=${_CTX_AGENT} task=${TASK_ID} host=${_CTX_HOST}
PiOS_LOG_RULE: 在回复末尾用 \`- \` 开头的行输出本次执行摘要（动作、产出、发现），adapter 会自动提取写入 worker-log。不要写文件，只输出文本。

${PROMPT}"
  fi
else
  # ── 传统模式：参数传入（兼容 pios-tick.sh agent 扫描）──
  REQUESTED_RUNTIME="${1:-claude-cli}"
  RUNTIME="$REQUESTED_RUNTIME"
  FALLBACK_ENGINE=""
  PROMPT="${2:-}"
  ALLOWED_TOOLS="${3:-Read,Write,Edit,Bash,Glob,Grep}"
  LOG_FILE="${4:-/dev/null}"
  AGENT_NAME="${5:-unknown}"
  agent_field="${AGENT_NAME}"
  SESSION_ID="${6:-}"
  PERMISSION_MODE="${7:-}"
fi

if [ -z "$PROMPT" ]; then
  echo "Usage: pios-adapter.sh <runtime> <prompt> ... OR pios-adapter.sh --task <taskId> [session_id] [log_file]" >&2
  exit 1
fi

# ── Trap: 进程被杀时写 finish record ──
_write_killed_record() {
  local ts
  ts=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)
  local run_file
  run_file=$(ls -t "$RUNS_DIR/${AGENT_NAME}"-*.json 2>/dev/null | head -1)
  [ -f "$run_file" ] || return
  # Only update if still "running"
  grep -q '"status": "running"' "$run_file" 2>/dev/null || return
  python3 -c "
import json, os
try:
  with open('$run_file') as f:
    d=json.load(f)
  if d.get('status')=='running':
    d['status']='failed'; d['error']='killed (signal)'; d['finished_at']='$ts'
    tmp='$run_file.tmp'
    with open(tmp,'w') as f:
      json.dump(d,f,indent=2)
    os.rename(tmp,'$run_file')
except Exception: pass
" 2>/dev/null
  RUN_FINALIZED=1
}
trap '_write_killed_record' TERM INT HUP

finalize_run_record() {
  [ "${RUN_FINALIZED:-0}" = "1" ] && return 0
  [ -n "${RUN_FILE:-}" ] || return 0
  [ -f "$RUN_FILE" ] || return 0

  local _exit_code="${1:-${EXIT_CODE:-0}}"
  local _ended
  _ended=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)

  local _status="success"
  [ "$_exit_code" -ne 0 ] && _status="failed"
  [ -n "${FALLBACK_FROM:-}" ] && [ "$_exit_code" -eq 0 ] && _status="degraded"

  local _session_id_json="null"
  [ -n "${SESSION_ID:-}" ] && _session_id_json="\"${SESSION_ID}\""

  local _permission_mode_json="null"
  [ -n "${PERMISSION_MODE:-}" ] && _permission_mode_json="\"${PERMISSION_MODE}\""

  local _fallback_from_json="null"
  [ -n "${FALLBACK_FROM:-}" ] && _fallback_from_json="\"${FALLBACK_FROM}\""

  local _fallback_reason_json="null"
  [ -n "${FALLBACK_REASON:-}" ] && _fallback_reason_json="\"${FALLBACK_REASON}\""

  # 原子写：tmp + rename 防止并发读拿到半成品
  cat > "${RUN_FILE}.tmp" <<EOF
{
  "run_id": "${RUN_ID}",
  "agent": "${agent_field:-$AGENT_NAME}",
  "plugin_name": "${AGENT_NAME}",
  "runtime": "${RUNTIME}",
  "requested_runtime": "${REQUESTED_RUNTIME}",
  "host": "${HOST_SHORT}",
  "started_at": "${STARTED}",
  "finished_at": "${_ended}",
  "status": "${_status}",
  "exit_code": ${_exit_code},
  "session_id": ${_session_id_json},
  "permission_mode": ${_permission_mode_json},
  "fallback_from": ${_fallback_from_json},
  "fallback_reason": ${_fallback_reason_json},
  "trigger_source": "${_TRIGGER_SOURCE:-cron}",
  "checkpoint": ${CHECKPOINT}
}
EOF
  mv "${RUN_FILE}.tmp" "$RUN_FILE"
  RUN_FINALIZED=1
}

# ── Update engine status in pios.yaml (only on state change) ──
_update_engine_status() {
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
    if old_status == '$new_status':
        exit(0)
    rt['status'] = '$new_status'
    now = datetime.datetime.now().strftime('%Y-%m-%dT%H:%M')
    if '$new_status' == 'ok':
        rt['last_success'] = now
        rt['error'] = None
        rt.pop('down_since', None)
    else:
        rt['error'] = '''${error_msg}'''[:200] or None
        if old_status == 'ok' or old_status == 'unknown':
            rt['down_since'] = now
    m['infra']['runtimes']['$engine'] = rt
    with open(manifest_path, 'w') as f:
        yaml.dump(m, f, default_flow_style=False, allow_unicode=True, width=120)
finally:
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    lock_fd.close()
" 2>/dev/null
}

append_log_tail() {
  local output_file="$1"
  [ -s "$output_file" ] || return 0
  tail -n "$TAIL_LINES" "$output_file" >> "$LOG_FILE"
}

# ─────────────────────────────────────────────────────────────
# configs.{runtime} → runtime 原生 config 文件
# 新 schema（2026-04-18）：agent.configs.{claude-cli,codex-cli,openclaw} 是
# 各 runtime 原生 schema 块。adapter 读出来 emit 到对应 runtime 的 config 文件。
#
# 切换开关：PIOS_ENFORCE_MODE
#   未设置 或 configs  → 默认（2026-04-19 起）。读 configs.{runtime}，emit
#                        对应 config 文件 + hook 硬拦。configs 空时回退 legacy
#   legacy             → 强制旧行为（仅 --allowedTools + --permission-mode，无 hook 强制）
#
# Kill switch：`export PIOS_ENFORCE_MODE=legacy` 立即回到旧行为。
# ─────────────────────────────────────────────────────────────

# Emit claude-cli settings.json + 通过 stdout 返回 permissions.allow 的 JSON array
#
# Claude-cli `permissions.allow` 语义是 **auto-approve**（跳过审批），不是硬白名单——
# 未命中的工具调用在非交互模式下默认 ask → 实际行为不可预测。真正的硬强制要靠
# **PreToolUse hook 拦截**。所以这里 emit 的 settings.json 同时：
#   1. 把 configs.claude-cli.permissions 写进 settings（auto-approve 自己的规则）
#   2. 把 hooks.PreToolUse 指向 pios-pretool-hook.sh（硬拦截未命中）
#   3. 返回 allow 数组给 adapter，adapter export 成 PIOS_CLAUDE_ALLOW env，hook 读它
#
# 这样 claude-cli 从"声明"变"硬强制"：
#   - 规则命中 → 自动批准（无 user prompt）
#   - 规则未命中 → hook deny（带 reason）
emit_claude_settings_file() {
  local agent_id="$1"
  local settings_file="$2"
  local task_id="${3:-}"
  local hook_script="${VAULT}/Pi/Tools/pios-pretool-hook.sh"
  # stdout = allow 数组 JSON（给 adapter export env）；文件 = settings.json
  AGENT_ID="$agent_id" TASK_ID="$task_id" VAULT_DIR="$VAULT" HOOK_SCRIPT="$hook_script" SETTINGS_OUT="$settings_file" /usr/bin/python3 <<'PYEOF'
import os, yaml, json, sys
try:
    vault = os.environ['VAULT_DIR']
    with open(f"{vault}/Pi/Config/pios.yaml") as f:
        doc = yaml.safe_load(f)
    owner = doc.get('owner') or 'User'

    def expand(s):
        if not isinstance(s, str): return s
        s = s.replace('{owner}', owner).replace('{vault}', vault)
        if s.startswith('~/'): s = os.path.expanduser(s)
        return s

    def deep_merge(base, override):
        """task override 合并到 agent base：
             list → concat + dedup（保顺序：先 base 再 override 新项）
             dict → 递归
             其他（str/int）→ override 覆盖
        """
        if isinstance(base, dict) and isinstance(override, dict):
            out = dict(base)
            for k, v in override.items():
                if k in out:
                    out[k] = deep_merge(out[k], v)
                else:
                    out[k] = v
            return out
        if isinstance(base, list) and isinstance(override, list):
            seen, merged = set(), []
            for x in list(base) + list(override):
                key = json.dumps(x, sort_keys=True) if not isinstance(x, str) else x
                if key not in seen:
                    seen.add(key); merged.append(x)
            return merged
        return override  # scalar / type mismatch → override wins

    agent = (doc.get('agents') or {}).get(os.environ['AGENT_ID']) or {}
    agent_cfg = (agent.get('configs') or {}).get('claude-cli') or {}

    # task-level override（可选）
    tid = os.environ.get('TASK_ID') or ''
    task_cfg = {}
    if tid:
        task = (agent.get('tasks') or {}).get(tid) or {}
        task_cfg = (task.get('configs') or {}).get('claude-cli') or {}

    cfg = deep_merge(agent_cfg, task_cfg) if task_cfg else agent_cfg
    if not cfg:
        sys.exit(0)

    perms = cfg.get('permissions') or {}
    allow = [expand(r) for r in (perms.get('allow') or []) if r]
    deny  = [expand(r) for r in (perms.get('deny') or [])  if r]

    out = {}
    if isinstance(perms, dict):
        out['permissions'] = {'allow': allow, 'deny': deny}
    if 'permission_mode' in cfg:
        out['permissionMode'] = cfg['permission_mode']

    user_hooks = cfg.get('hooks') or {}
    merged_hooks = dict(user_hooks) if isinstance(user_hooks, dict) else {}
    pios_entry = {
        'matcher': 'Read|Write|Edit|NotebookEdit|Bash|Grep|Glob|WebFetch|WebSearch',
        'hooks': [{'type': 'command', 'command': f"bash {os.environ['HOOK_SCRIPT']}", 'timeout': 5000}]
    }
    existing_pre = merged_hooks.get('PreToolUse') or []
    if not isinstance(existing_pre, list):
        existing_pre = []
    merged_hooks['PreToolUse'] = existing_pre + [pios_entry]
    out['hooks'] = merged_hooks

    with open(os.environ['SETTINGS_OUT'], 'w') as f:
        json.dump(out, f, ensure_ascii=False)
    sys.stdout.write(json.dumps(allow, ensure_ascii=False))
except Exception as e:
    sys.stderr.write(f'[emit_claude_settings_file] ERROR: {e}\n')
PYEOF
  [ -s "$settings_file" ] || return 1
  return 0
}

run_claude_cli() {
  local output_file="$1"
  local claude_bin
  claude_bin="${CLAUDE_BIN:-$(which claude 2>/dev/null || echo /opt/homebrew/bin/claude)}"

  if [ ! -x "$claude_bin" ]; then
    printf '[adapter] ERROR: claude binary not found\n' > "$output_file"
    return 127
  fi

  # macOS cron/launchd 触发的任务运行在系统 domain，不在 GUI session 里，
  # **读不到 login Keychain**。Claude CLI 2.1.92+ 在 macOS 又把 OAuth token
  # 存 Keychain → cron 里 claude 报 "Not logged in"。
  # 解法：owner 在 Terminal 里跑一次 `claude setup-token`（1 年有效期长效 token），
  # 存到 ~/.claude-code-cron-token（600 权限）。adapter 跑 claude 前 export 为
  # CLAUDE_CODE_OAUTH_TOKEN，CLI 直接用这把 token，不碰 Keychain。
  # 每年续期一次：`claude setup-token` → 覆盖写这个文件。
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r "$HOME/.claude-code-cron-token" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.claude-code-cron-token")"
  fi

  # Build optional args
  local session_args=()
  local resume_mode=0
  if [ -n "${SESSION_ID:-}" ]; then
    if [ "${PIOS_RESUME:-0}" = "1" ]; then
      session_args+=(--resume "$SESSION_ID")
      resume_mode=1
    else
      session_args+=(--session-id "$SESSION_ID")
    fi
  fi

  local permission_args=()
  if [ -n "${PERMISSION_MODE:-}" ] && [ "$PERMISSION_MODE" != "default" ]; then
    permission_args+=(--permission-mode "$PERMISSION_MODE")
  fi

  # 新 schema：如果 PIOS_ENFORCE_MODE=configs，从 configs.claude-cli emit settings.json
  # + 把 permissions.allow export 成 PIOS_CLAUDE_ALLOW（hook 读）
  local settings_args=()
  local _settings_file=""
  if [ "${PIOS_ENFORCE_MODE:-configs}" = "configs" ]; then
    _settings_file=$(mktemp "${TMPDIR:-/tmp}/pios-claude-settings-${AGENT_NAME}-XXXXXX")
    local _allow_json
    # --task 模式下 AGENT_NAME=TASK_ID，传入 emit 做 task-level override 合并；
    # legacy 模式下 AGENT_NAME=agent_id，task_id 传空
    local _task_arg=""
    [ "$agent_field" != "$AGENT_NAME" ] && _task_arg="$AGENT_NAME"
    _allow_json=$(emit_claude_settings_file "$agent_field" "$_settings_file" "$_task_arg" 2>/dev/null)
    if [ -s "$_settings_file" ] && [ -n "$_allow_json" ]; then
      settings_args+=(--settings "$_settings_file")
      export PIOS_CLAUDE_ALLOW="$_allow_json"
      export PIOS_VAULT="$VAULT"
      local _nrules
      _nrules=$(echo "$_allow_json" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null || echo '?')
      local _task_info=""
      [ -n "$_task_arg" ] && _task_info=" (+ task.$_task_arg.configs)"
      echo "[adapter] claude-cli configs-mode: --settings $_settings_file + hook 强制 (${_nrules} allow rules)${_task_info}" >> "$LOG_FILE"
    else
      rm -f "$_settings_file"; _settings_file=""
      echo "[adapter] claude-cli configs-mode: agent.configs.claude-cli 空，回退 legacy（仅 --allowedTools，无 hook 强制）" >> "$LOG_FILE"
    fi
  fi

  # 模型选择：budget 决定模型，PIOS_MODEL 环境变量可覆盖
  local model_args=()
  if [ -n "${PIOS_MODEL:-}" ]; then
    model_args+=(--model "$PIOS_MODEL")
  elif [ "${BUDGET:-medium}" = "high" ]; then
    model_args+=(--model "opus")
  fi
  # low/medium 不传 --model，用 claude 默认（sonnet）

  local json_output="${output_file}.json"

  cd "$VAULT" || true
  if [ "$resume_mode" = "1" ]; then
    # Resume: 不重发整个 prompt，只发简短续命消息
    "$claude_bin" -p "继续执行上次未完成的任务。如果上次已完成，回复'已完成'即可。" \
      --allowedTools "$ALLOWED_TOOLS" \
      --output-format json \
      ${model_args[@]+"${model_args[@]}"} \
      ${session_args[@]+"${session_args[@]}"} \
      ${permission_args[@]+"${permission_args[@]}"} \
      ${settings_args[@]+"${settings_args[@]}"} \
      > "$json_output" 2>&1
  else
    "$claude_bin" -p "$PROMPT" \
      --allowedTools "$ALLOWED_TOOLS" \
      --output-format json \
      ${model_args[@]+"${model_args[@]}"} \
      ${session_args[@]+"${session_args[@]}"} \
      ${permission_args[@]+"${permission_args[@]}"} \
      ${settings_args[@]+"${settings_args[@]}"} \
      > "$json_output" 2>&1
  fi
  local _exit=$?

  # 清理临时 settings 文件（如果生成过）
  [ -n "$_settings_file" ] && [ -f "$_settings_file" ] && rm -f "$_settings_file"

  # Extract text result, token stats, and log bullet lines from JSON output
  if [ -f "$json_output" ]; then
    python3 -c "
import json, sys
try:
    d = json.load(open('$json_output'))
    result = d.get('result', '') or ''
    # Write text result to output_file (for legacy log tail)
    with open('$output_file', 'w') as f:
        f.write(result)
    # Extract bullet lines from AI response for worker-log
    bullets = [l for l in result.splitlines() if l.startswith('- ')]
    # Token stats + bullets
    stats = {}
    stats['input_tokens'] = d.get('usage', {}).get('input_tokens', 0)
    stats['output_tokens'] = d.get('usage', {}).get('output_tokens', 0)
    stats['cache_read'] = d.get('usage', {}).get('cache_read_input_tokens', 0)
    stats['cache_create'] = d.get('usage', {}).get('cache_creation_input_tokens', 0)
    stats['cost_usd'] = d.get('total_cost_usd', 0)
    stats['num_turns'] = d.get('num_turns', 0)
    stats['session_id'] = d.get('session_id', '')
    stats['log_bullets'] = bullets
    json.dump(stats, open('${json_output}.stats', 'w'), ensure_ascii=False)
except Exception as e:
    import shutil
    shutil.copy('$json_output', '$output_file')
" 2>/dev/null
    rm -f "$json_output"
  fi

  return $_exit
}

# Emit codex-cli native args from agent.configs.codex-cli
# 输出：每行一个 arg（通过 stdout），adapter 用 while-read 装成数组
# 映射（2026-04-19 修正：codex exec 没有 -a flag）:
#   configs.codex-cli.sandbox_mode       → -s <mode>
#   configs.codex-cli.approval_policy    → -c 'approval_policy="<policy>"'（TOML key；exec 下 noop）
#   configs.codex-cli.add_dirs[]         → --add-dir <dir>（重复）
#   configs.codex-cli.network_access     → -c 'sandbox_workspace_write.network_access=true'（workspace-write 下）
emit_codex_cli_args() {
  local agent_id="$1"
  local task_id="${2:-}"
  AGENT_ID="$agent_id" TASK_ID="$task_id" VAULT_DIR="$VAULT" /usr/bin/python3 <<'PYEOF'
import os, yaml, json, sys
try:
    vault = os.environ['VAULT_DIR']
    with open(f"{vault}/Pi/Config/pios.yaml") as f:
        doc = yaml.safe_load(f)
    owner = doc.get('owner') or 'User'

    def expand(s):
        if not isinstance(s, str): return s
        s = s.replace('{owner}', owner).replace('{vault}', vault)
        if s.startswith('~/'): s = os.path.expanduser(s)
        if s and not s.startswith('/') and not s.startswith('~'):
            s = os.path.join(vault, s)
        return s

    def deep_merge(base, override):
        if isinstance(base, dict) and isinstance(override, dict):
            out = dict(base)
            for k, v in override.items():
                out[k] = deep_merge(out[k], v) if k in out else v
            return out
        if isinstance(base, list) and isinstance(override, list):
            seen, merged = set(), []
            for x in list(base) + list(override):
                key = json.dumps(x, sort_keys=True) if not isinstance(x, str) else x
                if key not in seen:
                    seen.add(key); merged.append(x)
            return merged
        return override

    agent = (doc.get('agents') or {}).get(os.environ['AGENT_ID']) or {}
    agent_cfg = (agent.get('configs') or {}).get('codex-cli') or {}
    tid = os.environ.get('TASK_ID') or ''
    task_cfg = {}
    if tid:
        task = (agent.get('tasks') or {}).get(tid) or {}
        task_cfg = (task.get('configs') or {}).get('codex-cli') or {}
    cfg = deep_merge(agent_cfg, task_cfg) if task_cfg else agent_cfg
    if not cfg: sys.exit(0)

    args = []
    sm = cfg.get('sandbox_mode')
    if sm: args.extend(['-s', str(sm)])

    # codex exec 没有 -a flag（那是 interactive codex 的），改走 -c approval_policy=...
    ap = cfg.get('approval_policy')
    if ap: args.extend(['-c', f'approval_policy="{ap}"'])

    # add_dirs → --add-dir (codex CLI 语法糖，等价 -c sandbox_workspace_write.writable_roots=[...])
    for d in (cfg.get('add_dirs') or []):
        if d: args.extend(['--add-dir', expand(str(d))])

    # network_access: codex workspace-write 默认拦 DNS（EAI_NONAME），联网任务必开。
    # 未声明时默认 true（避免 cron pipeline 挂）；显式 false 才严格沙箱。
    net = cfg.get('network_access')
    if net is None: net = True
    if net and (sm or 'workspace-write') == 'workspace-write':
        args.extend(['-c', 'sandbox_workspace_write.network_access=true'])

    # codex 无"额外 RO"概念（workspace-write 模式下非 writable 自动 RO），
    # 故 configs.codex-cli 不提供 read_only_access 字段。

    for a in args:
        print(a)
except Exception as e:
    sys.stderr.write(f'[emit_codex_cli_args] ERROR: {e}\n')
PYEOF
}

extract_codex_cli_stats() {
  local output_file="$1"
  local stats_file="$2"
  local session_id="${3:-}"
  local rollout_file="${4:-}"

  [ -f "$output_file" ] || return 0

  /usr/bin/python3 -c "
import json, re, sys

output_file = '$output_file'
stats_file = '$stats_file'
session_id = '$session_id'
rollout_file = '$rollout_file'

try:
    text = open(output_file, encoding='utf-8', errors='replace').read()
except Exception:
    text = ''

lines = text.splitlines()
last_tok = -1
for i, line in enumerate(lines):
    if line.strip() == 'tokens used':
        last_tok = i

token_total = 0
if last_tok >= 0 and last_tok + 1 < len(lines):
    m = re.search(r'([0-9][0-9,]*)', lines[last_tok + 1])
    if m:
        token_total = int(m.group(1).replace(',', ''))

search_from = last_tok + 2 if last_tok >= 0 else 0
bullets = []
for line in lines[search_from:]:
    if line.startswith('- '):
        bullets.append(line)

stats = {
    'input_tokens': 0,
    'output_tokens': token_total,
    'cache_read': 0,
    'cache_create': 0,
    'cost_usd': 0,
    'num_turns': 1 if text.strip() else 0,
    'session_id': session_id,
    'rollout_file': rollout_file,
    'log_bullets': bullets,
}

with open(stats_file, 'w', encoding='utf-8') as f:
    json.dump(stats, f, ensure_ascii=False)
" 2>/dev/null || true
}

run_codex_cli() {
  local output_file="$1"
  local codex_bin
  codex_bin="${CODEX_BIN:-$(which codex 2>/dev/null || echo /opt/homebrew/bin/codex)}"

  if [ ! -x "$codex_bin" ]; then
    printf '[adapter] ERROR: codex binary not found\n' > "$output_file"
    return 127
  fi

  # 刀 3: 跑完后从 ~/.codex/sessions/ 里找刚写的 rollout 文件，提取 thread_id
  # 作为 session_id 写进 run record 的 ${output_file}.stats，让 PiBrowser 的
  # RunSessionAdapter 能 tail 这个文件做实时监听和接管。
  local pre_ts
  pre_ts=$(date +%s)
  local session_id=""
  local rollout_file=""
  local stats_file="${output_file}.json.stats"

  local codex_args=()
  # 2026-04-17 owner: cron 跑的 task 本身就在 externally sandboxed 环境（我们信任的
  # 机器 + vault 边界内），codex --full-auto 自带的 --sandbox workspace-write
  # 会拦 DNS 导致后台联网 call 全挂（症状: urllib URLError EAI_NONAME）。
  # 默认走 bypass，per-task 粒度的权限管理在另一条 session 里做。
  #
  # 2026-04-18 新增：PIOS_ENFORCE_MODE=configs 时，读 agent.configs.codex-cli
  # 生成原生 -s / -a / --add-dir / -c args。用户自己对 DNS 影响负责——
  # 如果需要网络就声明 sandbox_mode: danger-full-access 或切 legacy。
  if [ "${PIOS_ENFORCE_MODE:-configs}" = "configs" ]; then
    local _codex_config_args _codex_task_arg=""
    [ "$agent_field" != "$AGENT_NAME" ] && _codex_task_arg="$AGENT_NAME"
    _codex_config_args=$(emit_codex_cli_args "$agent_field" "$_codex_task_arg" 2>/dev/null)
    if [ -n "$_codex_config_args" ]; then
      while IFS= read -r _line; do
        [ -n "$_line" ] && codex_args+=("$_line")
      done <<< "$_codex_config_args"
      local _task_info=""
      [ -n "$_codex_task_arg" ] && _task_info=" (+ task.$_codex_task_arg.configs)"
      echo "[adapter] codex-cli configs-mode: ${codex_args[*]}${_task_info}" >> "$LOG_FILE"
    else
      echo "[adapter] codex-cli configs-mode: agent.configs.codex-cli 空，回退 bypass" >> "$LOG_FILE"
      codex_args+=(--dangerously-bypass-approvals-and-sandbox)
    fi
  else
    case "${PERMISSION_MODE:-default}" in
      *)
        codex_args+=(--dangerously-bypass-approvals-and-sandbox)
        ;;
    esac
  fi

  # 后台 thread_id watcher：用 pre-snapshot diff 找新增 rollout 文件
  # （不是 mtime 最新，避免同时多个 codex 跑时串到别的 task 的 rollout）。
  # 尽早把 thread_id 写进 run record 的 session_id，让 PiBrowser late-attach 接 tail。
  local _pre_snapshot_file
  _pre_snapshot_file=$(mktemp "${TMPDIR:-/tmp}/pios-codex-snapshot-XXXXXX")
  find "${HOME}/.codex/sessions" -name 'rollout-*.jsonl' 2>/dev/null | sort > "$_pre_snapshot_file"

  local _tid_watcher_script='
import os, sys, time, json, pathlib
snap_file = "'"$_pre_snapshot_file"'"
run_file = "'"${RUN_FILE:-}"'"
sessions_dir = os.path.expanduser("~/.codex/sessions")
try:
    with open(snap_file) as f:
        pre = set(l.strip() for l in f if l.strip())
except Exception:
    pre = set()
deadline = time.time() + 60  # 最多等 60s，避免僵尸 watcher
while time.time() < deadline:
    try:
        cur = set()
        base = pathlib.Path(sessions_dir)
        if base.exists():
            for p in base.rglob("rollout-*.jsonl"):
                cur.add(str(p))
        new_files = cur - pre
        # 只要一个新文件就能 match（同 adapter 启动的 codex 一定只创一个 rollout）
        if new_files:
            target = max(new_files, key=lambda p: os.stat(p).st_mtime)
            with open(target) as f:
                line = f.readline()
            d = json.loads(line)
            if d.get("type") == "session_meta":
                tid = (d.get("payload") or {}).get("id")
                if tid and run_file and os.path.exists(run_file):
                    with open(run_file) as f:
                        r = json.load(f)
                    # codex 路径无条件覆盖：pios-tick 传给 adapter 的 SESSION_ID 是
                    # 随机 UUID（给 claude --session-id 用的），对 codex 是假的 —
                    # 必须用 rollout 里的真 thread_id 替换。
                    if r.get("session_id") != tid:
                        r["session_id"] = tid
                        tmp = run_file + ".tmp"
                        with open(tmp, "w") as f:
                            json.dump(r, f, indent=2)
                        os.rename(tmp, run_file)
                    sys.exit(0)
    except Exception:
        pass
    time.sleep(1)
'
  python3 -c "$_tid_watcher_script" &
  local _tid_watcher_pid=$!

  # ChatGPT 账号：不传 -m，用 codex config.toml 默认（随 codex CLI 版本升级自动跟进，当前 gpt-5.5）
  "$codex_bin" exec "$PROMPT" \
    -C "$VAULT" \
    ${codex_args[@]+"${codex_args[@]}"} \
    > "$output_file" 2>&1
  local _exit=$?
  # codex 跑完了，watcher 要么自己退出要么清理掉
  kill "$_tid_watcher_pid" 2>/dev/null; wait "$_tid_watcher_pid" 2>/dev/null
  rm -f "$_pre_snapshot_file"

  # 找这次 exec 新建的 rollout 文件（mtime 在 pre_ts 之后的最新一个）
  # 路径格式：~/.codex/sessions/YYYY/MM/DD/rollout-{iso-ts}-{thread_id}.jsonl
  local codex_sessions_dir="${HOME}/.codex/sessions"
  if [ -d "$codex_sessions_dir" ]; then
    rollout_file=$(find "$codex_sessions_dir" -name 'rollout-*.jsonl' -newermt "@${pre_ts}" 2>/dev/null \
      | xargs -I{} stat -f "%m %N" {} 2>/dev/null \
      | sort -rn | head -1 | awk '{print $2}')
    if [ -n "$rollout_file" ] && [ -f "$rollout_file" ]; then
      # 从 session_meta 第一行提取 payload.id
      session_id=$(head -1 "$rollout_file" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
    if d.get("type") == "session_meta":
        p = d.get("payload", {})
        if isinstance(p, dict) and p.get("id"):
            print(p["id"])
except Exception:
    pass
' 2>/dev/null)
    fi
  fi

  extract_codex_cli_stats "$output_file" "$stats_file" "$session_id" "$rollout_file"

  return $_exit
}

run_openclaw() {
  local output_file="$1"
  local openclaw_bin
  openclaw_bin="${OPENCLAW_BIN:-$(which openclaw 2>/dev/null || echo /opt/homebrew/bin/openclaw)}"

  if [ ! -x "$openclaw_bin" ]; then
    printf '[adapter] ERROR: openclaw binary not found\n' > "$output_file"
    return 127
  fi

  # 2026-04-19: OpenClaw 没有 per-session CLI flag 注入权限配置（无 --sandbox /
  # --approval-policy 参数）。它的权限走 ~/.openclaw/openclaw.json 全局 +
  # `openclaw approvals allowlist` 命令行管理。adapter 无法 per-task emit
  # （多 task 并发写同文件会竞态），所以 configs-mode 只 log 声明，不改配置。
  # V2：如果需要严格权限，由 onboarding 一次性写入 ~/.openclaw/openclaw.json。
  if [ "${PIOS_ENFORCE_MODE:-configs}" = "configs" ]; then
    local _oc_summary
    _oc_summary=$(AGENT_ID="$agent_field" VAULT_DIR="$VAULT" /usr/bin/python3 <<'PYEOF'
import os, yaml, sys
try:
    with open(f"{os.environ['VAULT_DIR']}/Pi/Config/pios.yaml") as f:
        doc = yaml.safe_load(f)
    agent = (doc.get('agents') or {}).get(os.environ['AGENT_ID']) or {}
    cfg = (agent.get('configs') or {}).get('openclaw') or {}
    if cfg:
        parts = []
        if cfg.get('approval_policy'): parts.append(f"approval={cfg['approval_policy']}")
        print(' '.join(parts) if parts else 'empty')
    else:
        print('not-declared')
except Exception as e:
    sys.stderr.write(f'ERR: {e}\n')
PYEOF
)
    echo "[adapter] openclaw configs-mode: ${_oc_summary:-n/a} (仅声明，openclaw 权限走 ~/.openclaw/openclaw.json 全局，adapter 不改)" >> "${LOG_FILE:-/dev/null}"
  fi

  # Build args
  local agent_arg="${OPENCLAW_AGENT:-${agent_field:-main}}"
  local timeout_arg="${OPENCLAW_TIMEOUT:-600}"

  cd "$VAULT" || true
  local json_output="${output_file}.json"

  # 每次用新 session，避免 openclaw 复用上次 session context 导致模型偷懒
  local session_arg=""
  [ -n "${SESSION_ID:-}" ] && session_arg="--session-id ${SESSION_ID}"

  "$openclaw_bin" agent \
    --agent "$agent_arg" \
    --message "$PROMPT" \
    --json \
    --timeout "$timeout_arg" \
    $session_arg \
    > "$json_output" 2>&1
  local _exit=$?

  # 自动注册：如果 agent 不存在，注册后重试一次
  if grep -q "Unknown agent id" "$json_output" 2>/dev/null && [ "$agent_arg" != "main" ]; then
    echo "[adapter] openclaw agent '$agent_arg' not found, auto-registering..." >> "${LOG_FILE:-/dev/null}"
    python3 -c "
import json, os
oc = os.path.expanduser('~/.openclaw/openclaw.json')
if not os.path.exists(oc): exit(1)
d = json.load(open(oc))
agents = d.get('agents',{}).get('list',[])
if any(a.get('id')=='$agent_arg' for a in agents): exit(0)
agents.append({'id':'$agent_arg','name':'$agent_arg','workspace':'$VAULT/Pi/Agents/$agent_arg','agentDir':os.path.expanduser('~/.openclaw/agents/$agent_arg/agent')})
os.makedirs(os.path.expanduser('~/.openclaw/agents/$agent_arg/agent'), exist_ok=True)
with open(oc,'w') as f: json.dump(d,f,indent=2,ensure_ascii=False)
" 2>/dev/null
    # 重试
    "$openclaw_bin" agent \
      --agent "$agent_arg" \
      --message "$PROMPT" \
      --json \
      --timeout "$timeout_arg" \
      $session_arg \
      > "$json_output" 2>&1
    _exit=$?
  fi

  # Extract result text, token stats, and bullet lines from OpenClaw JSON
  if [ -f "$json_output" ]; then
    python3 -c "
import json, sys
try:
    d = json.load(open('$json_output'))
    # Extract text from payloads
    payloads = d.get('result', {}).get('payloads', [])
    result = '\n'.join(p.get('text', '') for p in payloads if p.get('text'))
    with open('$output_file', 'w') as f:
        f.write(result)
    # Bullet lines for worker-log
    bullets = [l for l in result.splitlines() if l.startswith('- ')]
    # Token stats
    meta = d.get('result', {}).get('meta', {})
    agent_meta = meta.get('agentMeta', {})
    usage = agent_meta.get('usage', {})
    stats = {
        'input_tokens': usage.get('input', 0),
        'output_tokens': usage.get('output', 0),
        'cache_read': agent_meta.get('lastCallUsage', {}).get('cacheRead', 0),
        'cache_create': agent_meta.get('lastCallUsage', {}).get('cacheWrite', 0),
        'cost_usd': 0,  # OpenClaw JSON 不含 cost，后续可从 token 估算
        'num_turns': 1,
        'session_id': agent_meta.get('sessionId', ''),
        'log_bullets': bullets
    }
    json.dump(stats, open('${json_output}.stats', 'w'), ensure_ascii=False)
except Exception as e:
    # JSON 解析失败，原样输出
    import shutil
    shutil.copy('$json_output', '$output_file')
" 2>/dev/null
    rm -f "$json_output"
  fi

  return $_exit
}

openclaw_should_fallback() {
  local output_file="$1"
  grep -Eiq "No API key found|gateway closed|FailoverError|openclaw binary not found" "$output_file"
}

claude_should_fallback() {
  # 任何让 claude-cli 跑不出结果的错误都会走 fallback，让调用方决定是否切引擎。
  # 不再区分 "quota" / "auth" —— 那种分类只在我们想自动切号时才有意义，而 CLI 自管
  # OAuth 之后 adapter 不切号，也就不需要区分。
  local output_file="$1"
  grep -Eiq "Please run /login|Not logged in|Failed to authenticate|API Error: 40[0-9]|Request not allowed|You've hit your limit|claude binary not found|API Error: Request timed out|Request timed out|timed out\. Check your internet connection|network timeout|ETIMEDOUT" "$output_file"
}

claude_fallback_reason() {
  local output_file="$1"
  if grep -Eiq "Please run /login|Not logged in|Failed to authenticate|API Error: 401" "$output_file"; then
    echo "logged-out"   # claude CLI 未登录或 OAuth 失效 → 需要 PiBrowser UI Login 按钮
  elif grep -Eiq "API Error: Request timed out|Request timed out|timed out\. Check your internet connection|network timeout|ETIMEDOUT" "$output_file"; then
    echo "api-timeout"
  elif grep -Eiq "claude binary not found" "$output_file"; then
    echo "missing-binary"
  else
    echo "runtime-error"
  fi
}

codex_should_fallback() {
  # codex-cli 跑不出结果的错误：上游容量/限流/网络中断/auth/binary 缺失。
  # 触发后由调用方决定是否切到下一个 engine（通常是 claude-cli）。
  local output_file="$1"
  grep -Eiq "Selected model is at capacity|stream disconnected before completion|Reconnecting\.\.\. 5/5|An error occurred while processing your request|HTTP (401|403|429|5[0-9][0-9])|Unauthorized|rate.?limit|quota|codex binary not found" "$output_file"
}

codex_fallback_reason() {
  local output_file="$1"
  if grep -Eiq "Selected model is at capacity" "$output_file"; then
    echo "upstream-capacity"
  elif grep -Eiq "stream disconnected before completion|Reconnecting\.\.\. 5/5" "$output_file"; then
    echo "stream-disconnect"
  elif grep -Eiq "HTTP 429|rate.?limit|quota" "$output_file"; then
    echo "rate-limit"
  elif grep -Eiq "HTTP (401|403)|Unauthorized" "$output_file"; then
    echo "logged-out"
  elif grep -Eiq "codex binary not found" "$output_file"; then
    echo "missing-binary"
  else
    echo "runtime-error"
  fi
}

# ── Worker-log: unified entry (deferred write to avoid interleaving) ──
# shellcheck source=lib/host-resolve.sh
source "$VAULT/Pi/Tools/lib/host-resolve.sh"
HOST_SHORT=$(pios_resolve_host)
WORKER_LOG_FILE="$VAULT/Pi/Log/worker-log-${HOST_SHORT}.md"

# Resolve agent name for logging
_LOG_AGENT="${agent_field:-${AGENT_NAME}}"

# Header metadata is built at write time so it reflects the final runtime after any
# engine-level fallback (for example claude-cli -> codex-cli).
# _LOG_TS is deferred to _assign_and_write() so it reflects completion time, not start time.

_ADAPTER_START_EPOCH=$(date +%s)

# ── Run record ──
RUN_ID="${AGENT_NAME}-$(date +%Y%m%d-%H%M%S)"
RUN_FILE="$RUNS_DIR/${RUN_ID}.json"
STARTED=$(date -Iseconds)

# Build checkpoint: snapshot of what this run intends to process
# For pi-triage/scout: list inbox + active cards as context for crash recovery
CHECKPOINT="null"
if [ "$AGENT_NAME" = "pi-triage" ] || [ "$AGENT_NAME" = "scout" ]; then
  INBOX_CARDS=$(ls "$VAULT/Cards/inbox/"*.md 2>/dev/null | xargs -I{} basename {} .md | head -10 | paste -sd',' - 2>/dev/null || echo "")
  ACTIVE_COUNT=$(ls "$VAULT/Cards/active/"*.md 2>/dev/null | wc -l | tr -d ' ')
  CHECKPOINT=$(_INBOX="$INBOX_CARDS" _ACTIVE="$ACTIVE_COUNT" python3 -c "
import json, os
inbox_raw = os.environ.get('_INBOX','')
inbox = [c.strip() for c in inbox_raw.split(',') if c.strip()]
active = int(os.environ.get('_ACTIVE','0') or '0')
print(json.dumps({'inbox_cards': inbox, 'active_count': active}))
" 2>/dev/null) || CHECKPOINT="null"
  # Validate
  echo "$CHECKPOINT" | python3 -m json.tool > /dev/null 2>&1 || CHECKPOINT="null"
fi

# Write run record: started (unified format — Shell + Python both read this)
SESSION_ID_JSON="null"
[ -n "$SESSION_ID" ] && SESSION_ID_JSON="\"$SESSION_ID\""
PERMISSION_MODE_JSON="null"
[ -n "$PERMISSION_MODE" ] && PERMISSION_MODE_JSON="\"$PERMISSION_MODE\""

# trigger_source：由调用方通过 env var 设置
# - cron（默认，pios-tick.sh 启的）
# - manual（PiBrowser UI 按钮触发）
# - cli（命令行手动调用）
_TRIGGER_SOURCE="${PIOS_TRIGGER_SOURCE:-cron}"

_HEARTBEAT_TS=$(date +%s)
# 原子写：先写 .tmp 再 rename，避免并发读拿到半成品 JSON
cat > "${RUN_FILE}.tmp" <<EOF
{
  "run_id": "${RUN_ID}",
  "agent": "${agent_field:-$AGENT_NAME}",
  "plugin_name": "${AGENT_NAME}",
  "runtime": "${RUNTIME}",
  "requested_runtime": "${REQUESTED_RUNTIME}",
  "host": "${HOST_SHORT}",
  "started_at": "${STARTED}",
  "status": "running",
  "session_id": ${SESSION_ID_JSON},
  "permission_mode": ${PERMISSION_MODE_JSON},
  "adapter_pid": $$,
  "heartbeat_at": ${_HEARTBEAT_TS},
  "trigger_source": "${_TRIGGER_SOURCE}",
  "checkpoint": ${CHECKPOINT}
}
EOF
mv "${RUN_FILE}.tmp" "$RUN_FILE"

# 后台心跳：每 30s 更新 run record 的 heartbeat_at 字段，让 PiBrowser 能区分
# "真正在跑" vs "进程死了 trap 没触发的 zombie"。adapter 退出时 EXIT trap 会 kill 这个子进程。
_heartbeat_loop() {
  while true; do
    sleep 30
    [ -f "$RUN_FILE" ] || break
    grep -q '"status": "running"' "$RUN_FILE" 2>/dev/null || break
    python3 -c "
import json, os
try:
  with open('$RUN_FILE') as f:
    d=json.load(f)
  if d.get('status')=='running':
    d['heartbeat_at']=$(date +%s)
    tmp='$RUN_FILE.tmp'
    with open(tmp,'w') as f:
      json.dump(d,f,indent=2)
    os.rename(tmp,'$RUN_FILE')
except Exception: pass
" 2>/dev/null
  done
}
_heartbeat_loop &
_HEARTBEAT_PID=$!

# Timeout watchdog：跑超过 ADAPTER_TIMEOUT_SEC（默认 30 分钟）→ 标记 timeout 并 SIGTERM 自杀。
# 防止 codex hang 在网络 IO / 失控 task 永远卡住占住 cron tick。
# 单个 task 想覆盖默认超时：在 task 命令前加 `ADAPTER_TIMEOUT_SEC=600 pios-tick.sh ...`。
_ADAPTER_TIMEOUT_SEC="${ADAPTER_TIMEOUT_SEC:-1800}"
_timeout_watchdog() {
  sleep "$_ADAPTER_TIMEOUT_SEC"
  [ -f "$RUN_FILE" ] || exit 0
  grep -q '"status": "running"' "$RUN_FILE" 2>/dev/null || exit 0
  python3 -c "
import json, os
try:
  with open('$RUN_FILE') as f:
    d=json.load(f)
  if d.get('status')=='running':
    d['status']='timeout'
    d['error']='watchdog timeout after ${_ADAPTER_TIMEOUT_SEC}s'
    d['finished_at']='$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)'
    tmp='$RUN_FILE.tmp'
    with open(tmp,'w') as f:
      json.dump(d,f,indent=2)
    os.rename(tmp,'$RUN_FILE')
except Exception: pass
" 2>/dev/null
  # 杀所有直接子进程（codex / claude exec）→ adapter 自己等 wait 自然结束
  # 不用 kill -- -$$ 因为 cron 启动的 shell 不保证是 process group leader
  pkill -TERM -P $$ 2>/dev/null
  sleep 5
  pkill -KILL -P $$ 2>/dev/null
  exit 124  # 标准 timeout 退出码
}
_timeout_watchdog &
_TIMEOUT_PID=$!

trap '
  finalize_run_record ${EXIT_CODE:-$?}
  [ -n "${_HEARTBEAT_PID:-}" ] && kill -TERM "$_HEARTBEAT_PID" 2>/dev/null
  [ -n "${_TIMEOUT_PID:-}" ] && kill -TERM "$_TIMEOUT_PID" 2>/dev/null
' EXIT

# ── Budget soft wall: check daily spend before executing ──
BUDGET_LIMIT=""
case "${BUDGET:-medium}" in
  low)    BUDGET_LIMIT="2.00" ;;
  medium) BUDGET_LIMIT="5.00" ;;
  high)   BUDGET_LIMIT="20.00" ;;
esac

if [ -n "$BUDGET_LIMIT" ]; then
  _TODAY=$(date +%Y%m%d)
  _DAILY_SPEND=$(python3 -c "
import json, glob, os
total = 0.0
for f in glob.glob('$RUNS_DIR/${AGENT_NAME}-${_TODAY}*.json'):
    try:
        d = json.load(open(f))
        # Read cost from stats file if available
        sf = f + '.stats' if os.path.exists(f + '.stats') else None
        if sf:
            total += json.load(open(sf)).get('cost_usd', 0)
    except: pass
print(f'{total:.4f}')
" 2>/dev/null || echo "0")

  _OVER=$(python3 -c "print('yes' if float('$_DAILY_SPEND') >= float('$BUDGET_LIMIT') else 'no')" 2>/dev/null)
  if [ "$_OVER" = "yes" ]; then
    echo "[adapter] BUDGET-WALL: ${AGENT_NAME} daily spend \$${_DAILY_SPEND} >= limit \$${BUDGET_LIMIT} (budget=${BUDGET}), notifying owner" >> "$LOG_FILE"
    # Notify owner for decision instead of silently skipping
    _NOTIFY_OWNER=$(/usr/bin/python3 -c "import yaml; print(yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml')).get('owner',''))" 2>/dev/null)
    bash "$VAULT/Pi/Tools/notify.sh" warning "${_NOTIFY_OWNER:-User}，${AGENT_NAME} 今日消耗 \$${_DAILY_SPEND} 已超预算 \$${BUDGET_LIMIT}（${BUDGET}），本次暂停执行。如需继续请回复确认。" 2>/dev/null
    # Update run record as budget-paused (not skipped — owner may override)
    ENDED=$(date -Iseconds)
    cat > "$RUN_FILE" <<BEOF
{
  "run_id": "${RUN_ID}",
  "agent": "${agent_field:-$AGENT_NAME}",
  "runtime": "${RUNTIME}",
  "host": "${HOST_SHORT}",
  "started_at": "${STARTED}",
  "finished_at": "${ENDED}",
  "status": "budget-paused",
  "budget": "${BUDGET}",
  "daily_spend": "${_DAILY_SPEND}",
  "budget_limit": "${BUDGET_LIMIT}"
}
BEOF
    exit 0
  fi
fi

# ── Execute ──
EXIT_CODE=0

case "$RUNTIME" in
  claude-cli)
    claude_output=$(mktemp "${TMPDIR:-/tmp}/pios-claude-${AGENT_NAME}-XXXXXX")
    codex_output=$(mktemp "${TMPDIR:-/tmp}/pios-codex-${AGENT_NAME}-XXXXXX")
    OUT_FILE="$claude_output"  # 默认读 Claude stats；fallback 成功后切到 codex_output

    if run_claude_cli "$claude_output"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi
    append_log_tail "$claude_output"

    # 失败处理：不再插手 credentials.json / auth-state / 账号切换。
    # claude CLI 自己管 OAuth，失败就失败，由 engine-level fallback（codex-cli）
    # 或 PiBrowser UI 的 Login 按钮处理。adapter 只做日志 + 可选的引擎回退。
    if claude_should_fallback "$claude_output"; then
      FALLBACK_REASON="$(claude_fallback_reason "$claude_output")"
      FALLBACK_FROM="claude-cli"
      echo "[adapter] CLAUDE-FAIL: reason=$FALLBACK_REASON (CLI 自管 auth，不写 credentials.json)" >> "$LOG_FILE"

      # Engine-level fallback: 如果 task 声明了备用引擎就切过去
      if [ -n "${FALLBACK_ENGINE:-}" ]; then
        echo "[adapter] ENGINE-FALLBACK: claude-cli -> ${FALLBACK_ENGINE} (reason=${FALLBACK_REASON})" >> "$LOG_FILE"
        if [ "$FALLBACK_ENGINE" = "codex-cli" ]; then
          OUT_FILE="$codex_output"  # 刀 3: 同上，fallback 路径也要
          if run_codex_cli "$codex_output"; then
            EXIT_CODE=0
          else
            EXIT_CODE=$?
          fi
          append_log_tail "$codex_output"
        fi
        RUNTIME="$FALLBACK_ENGINE"
      fi
    fi

    # Capture token stats from claude run (before or after fallback)
    _STATS_FILE="${claude_output}.json.stats"
    [ -f "$_STATS_FILE" ] || _STATS_FILE="${codex_output}.json.stats"

    # Detect 0-tok auth-error exits before output file is removed
    _AUTH_ERR_FLAG=0
    if [ "$EXIT_CODE" -eq 0 ] && [ -f "${claude_output}.json.stats" ]; then
      _atok=$(python3 -c "
import json
try:
    d = json.load(open('${claude_output}.json.stats'))
    inp = d.get('input_tokens',0); out = d.get('output_tokens',0); turns = d.get('num_turns',0)
    print('zero' if inp + out == 0 and turns == 0 else 'ok')
except: print('ok')
" 2>/dev/null || echo ok)
      if [ "$_atok" = "zero" ]; then
        if grep -Eiq "Please run /login|Not logged in|Failed to authenticate|API Error: 401|unauthorized" "$claude_output" 2>/dev/null; then
          _AUTH_ERR_FLAG=2  # confirmed auth error
        else
          _AUTH_ERR_FLAG=1  # suspected (empty output, no specific auth keywords)
        fi
      fi
    fi

    rm -f "$claude_output" "$codex_output"
    ;;

  codex-cli)
    codex_output=$(mktemp "${TMPDIR:-/tmp}/pios-codex-${AGENT_NAME}-XXXXXX")
    claude_output=$(mktemp "${TMPDIR:-/tmp}/pios-claude-${AGENT_NAME}-XXXXXX")
    OUT_FILE="$codex_output"  # 刀 3: run_codex_cli 会写 ${OUT_FILE}.json.stats 带 session_id
    if run_codex_cli "$codex_output"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi
    append_log_tail "$codex_output"
    _STATS_FILE="${codex_output}.json.stats"

    # Engine-level fallback: codex-cli 上游限流/容量/网络挂时切下一个引擎（通常 claude-cli）
    # 对称 claude-cli 分支的 fallback 逻辑，2026-04-23 补缺。
    if codex_should_fallback "$codex_output"; then
      FALLBACK_REASON="$(codex_fallback_reason "$codex_output")"
      FALLBACK_FROM="codex-cli"
      echo "[adapter] CODEX-FAIL: reason=$FALLBACK_REASON" >> "$LOG_FILE"

      if [ -n "${FALLBACK_ENGINE:-}" ]; then
        echo "[adapter] ENGINE-FALLBACK: codex-cli -> ${FALLBACK_ENGINE} (reason=${FALLBACK_REASON})" >> "$LOG_FILE"
        if [ "$FALLBACK_ENGINE" = "claude-cli" ]; then
          OUT_FILE="$claude_output"
          if run_claude_cli "$claude_output"; then
            EXIT_CODE=0
          else
            EXIT_CODE=$?
          fi
          append_log_tail "$claude_output"
          _STATS_FILE="${claude_output}.json.stats"
        fi
        RUNTIME="$FALLBACK_ENGINE"
      fi
    fi

    rm -f "$codex_output" "$claude_output"
    ;;

  openclaw)
    openclaw_output=$(mktemp "${TMPDIR:-/tmp}/pios-openclaw-${AGENT_NAME}-XXXXXX")

    if run_openclaw "$openclaw_output"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi
    append_log_tail "$openclaw_output"

    # Fallback: openclaw 失败时尝试 claude-cli
    if openclaw_should_fallback "$openclaw_output"; then
      FALLBACK_REASON="openclaw-fail"
      FALLBACK_FROM="openclaw"
      if [ -n "${FALLBACK_ENGINE:-}" ]; then
        echo "[adapter] ENGINE-FALLBACK: openclaw -> ${FALLBACK_ENGINE} (reason=${FALLBACK_REASON})" >> "$LOG_FILE"
        if [ "$FALLBACK_ENGINE" = "claude-cli" ]; then
          claude_output=$(mktemp "${TMPDIR:-/tmp}/pios-claude-${AGENT_NAME}-XXXXXX")
          if run_claude_cli "$claude_output"; then
            EXIT_CODE=0
          else
            EXIT_CODE=$?
          fi
          append_log_tail "$claude_output"
          _STATS_FILE="${claude_output}.json.stats"
          rm -f "$claude_output"
        elif [ "$FALLBACK_ENGINE" = "codex-cli" ]; then
          codex_output=$(mktemp "${TMPDIR:-/tmp}/pios-codex-${AGENT_NAME}-XXXXXX")
          if run_codex_cli "$codex_output"; then
            EXIT_CODE=0
          else
            EXIT_CODE=$?
          fi
          append_log_tail "$codex_output"
          rm -f "$codex_output"
        fi
        RUNTIME="$FALLBACK_ENGINE"
      fi
    fi

    # Notify on openclaw fallback (once per day, not every tick)
    if [ -n "$FALLBACK_FROM" ] && [ "$FALLBACK_FROM" = "openclaw" ]; then
      _FALLBACK_FLAG="$VAULT/Pi/State/openclaw-fallback-$(date +%Y%m%d).flag"
      if [ ! -f "$_FALLBACK_FLAG" ]; then
        touch "$_FALLBACK_FLAG"
        _NOTIFY_OWNER=$(/usr/bin/python3 -c "import yaml; print(yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml')).get('owner',''))" 2>/dev/null)
        bash "$VAULT/Pi/Tools/notify.sh" warning "${_NOTIFY_OWNER:-User}，OpenClaw 引擎故障，任务已降级到 ${FALLBACK_ENGINE}。需要排查 OpenClaw auth。" 2>/dev/null
      fi
    fi

    # Token stats from openclaw run
    [ -z "${_STATS_FILE:-}" ] && _STATS_FILE="${openclaw_output}.json.stats"

    rm -f "$openclaw_output"
    ;;

  local)
    echo "$PROMPT" | bash 2>&1 | tail -80 >> "$LOG_FILE"
    EXIT_CODE=${PIPESTATUS[0]}
    ;;

  echo)
    echo "[adapter] DEBUG runtime=echo, prompt length=${#PROMPT}" >> "$LOG_FILE"
    echo "$PROMPT" | head -5 >> "$LOG_FILE"
    ;;

  *)
    echo "[adapter] ERROR: unknown runtime '$RUNTIME'" >> "$LOG_FILE"
    EXIT_CODE=1
    ;;
esac

# ── Update run record: completed (unified format, preserve checkpoint) ──
ENDED=$(date -Iseconds)
STATUS="success"
[ "$EXIT_CODE" -ne 0 ] && STATUS="failed"
# Fallback happened = degraded, not success (even if fallback exit=0)
[ -n "$FALLBACK_FROM" ] && [ "$EXIT_CODE" -eq 0 ] && STATUS="degraded"
FALLBACK_FROM_JSON="null"
FALLBACK_REASON_JSON="null"
[ -n "$FALLBACK_FROM" ] && FALLBACK_FROM_JSON="\"$FALLBACK_FROM\""
[ -n "$FALLBACK_REASON" ] && FALLBACK_REASON_JSON="\"$FALLBACK_REASON\""

# 2026-04-17: engine-level fallback 事件落地到全局 jsonl，UI / 监控订阅
# 格式：单行 JSON，append-only。每次 fallback 发生时产出一条。
if [ -n "$FALLBACK_FROM" ]; then
  _FB_LOG="$VAULT/Pi/Log/fallback-events.jsonl"
  mkdir -p "$(dirname "$_FB_LOG")"
  # append 单行 JSON（小于 PIPE_BUF 的单 write 原子）
  _HOST_NOW=$(hostname -s 2>/dev/null || echo unknown)
  printf '{"at":"%s","kind":"engine","task":"%s","run_id":"%s","host":"%s","intended_engine":"%s","actual_engine":"%s","reason":"%s","status":"%s"}\n' \
    "$ENDED" "${AGENT_NAME:-unknown}" "${RUN_ID:-unknown}" "$_HOST_NOW" \
    "$FALLBACK_FROM" "$RUNTIME" "${FALLBACK_REASON:-unknown}" "$STATUS" \
    >> "$_FB_LOG"
fi

# 刀 3: 如果 stats 文件里有 session_id（Codex / Claude 都可能写），优先用它
# （Claude 路径的 SESSION_ID 是命令行传进来的，已经在 SESSION_ID_JSON 里）
if [ -z "$SESSION_ID" ] && [ -f "${OUT_FILE}.json.stats" ]; then
  STATS_SID=$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    if d.get("session_id"): print(d["session_id"])
except Exception:
    pass
' "${OUT_FILE}.json.stats" 2>/dev/null)
  if [ -n "$STATS_SID" ]; then
    SESSION_ID="$STATS_SID"
    SESSION_ID_JSON="\"$STATS_SID\""
  fi
fi

cat > "$RUN_FILE" <<EOF
{
  "run_id": "${RUN_ID}",
  "agent": "${agent_field:-$AGENT_NAME}",
  "plugin_name": "${AGENT_NAME}",
  "runtime": "${RUNTIME}",
  "requested_runtime": "${REQUESTED_RUNTIME}",
  "host": "${HOST_SHORT}",
  "started_at": "${STARTED}",
  "finished_at": "${ENDED}",
  "status": "${STATUS}",
  "exit_code": ${EXIT_CODE},
  "session_id": ${SESSION_ID_JSON},
  "permission_mode": ${PERMISSION_MODE_JSON},
  "fallback_from": ${FALLBACK_FROM_JSON},
  "fallback_reason": ${FALLBACK_REASON_JSON},
  "checkpoint": ${CHECKPOINT}
}
EOF

# Update engine status based on execution result.
# Policy: adapter only writes "ok" (on success), NEVER writes "down" on failure.
# Rationale: engine status is global (Syncthing-shared pios.yaml). A failure on
# one host (e.g. worker-host's stale credentials) must not poison the status for
# other hosts whose claude CLI is healthy. The baseline "down" signal comes from
# auth-check.sh which runs `claude auth status` hourly per host. Adapter's
# success write only has upside: it can recover a stale "down" back to "ok"
# when a task actually succeeds.
if [ "$EXIT_CODE" -eq 0 ] && [ -z "$FALLBACK_FROM" ]; then
  _update_engine_status "$RUNTIME" "ok"
fi
if [ -n "$FALLBACK_FROM" ] && [ "$EXIT_CODE" -eq 0 ]; then
  # Fallback engine succeeded — mark the fallback engine ok.
  _update_engine_status "$RUNTIME" "ok"
fi

# ── Worker-log: append completion line with token stats ──
_ADAPTER_END_EPOCH=$(date +%s)
_DURATION=$(( _ADAPTER_END_EPOCH - _ADAPTER_START_EPOCH ))
if [ "$_DURATION" -ge 60 ]; then
  _DUR_DISPLAY="$(( _DURATION / 60 ))m$(( _DURATION % 60 ))s"
else
  _DUR_DISPLAY="${_DURATION}s"
fi

# Read token stats + AI bullet lines from stats file
# (codex-cli sets _BULLETS_FILE and _TOKEN_LINE earlier, skip if already populated)
_TOKEN_LINE="${_TOKEN_LINE:-}"
_BULLETS_FILE="${_BULLETS_FILE:-${TMPDIR:-/tmp}/pios-bullets-${AGENT_NAME}-$$.txt}"
_STATS_FILE="${_STATS_FILE:-}"
if [ -f "$_STATS_FILE" ]; then
  python3 -c "
import json
d = json.load(open('$_STATS_FILE'))
# Token line
inp = d.get('input_tokens',0)
out = d.get('output_tokens',0)
cache_r = d.get('cache_read',0)
cache_c = d.get('cache_create',0)
cost = d.get('cost_usd',0)
turns = d.get('num_turns',0)
total = inp + out + cache_r + cache_c
parts = [f'{total:,} tok', f'in:{inp:,}', f'out:{out:,}']
if cache_r: parts.append(f'cache_r:{cache_r:,}')
if cache_c: parts.append(f'cache_c:{cache_c:,}')
parts.append(f'\${cost:.4f}')
parts.append(f'{turns} turns')
with open('${_BULLETS_FILE}.tok', 'w') as f:
    f.write(' | '.join(parts))
# Bullet lines from AI response
bullets = d.get('log_bullets', [])
if bullets:
    with open('$_BULLETS_FILE', 'w') as f:
        f.write('\n'.join(bullets) + '\n')
" 2>/dev/null
  _TOKEN_LINE=""
  [ -f "${_BULLETS_FILE}.tok" ] && _TOKEN_LINE=$(cat "${_BULLETS_FILE}.tok")
  rm -f "$_STATS_FILE" "${_BULLETS_FILE}.tok"
fi

# Build completion line
if [ "$EXIT_CODE" -ne 0 ]; then
  _COMPLETION="- 失败：exit=${EXIT_CODE}，耗时 ${_DUR_DISPLAY}${_TOKEN_LINE:+ | ${_TOKEN_LINE}}"
elif [ "${_AUTH_ERR_FLAG:-0}" = "2" ]; then
  _COMPLETION="- 失败：exit=auth_error，耗时 ${_DUR_DISPLAY}${_TOKEN_LINE:+ | ${_TOKEN_LINE}}"
elif [ "${_AUTH_ERR_FLAG:-0}" = "1" ]; then
  _COMPLETION="- 完成（空输出，疑似 auth 错误）：耗时 ${_DUR_DISPLAY}${_TOKEN_LINE:+ | ${_TOKEN_LINE}}"
else
  _COMPLETION="- 完成：耗时 ${_DUR_DISPLAY}${_TOKEN_LINE:+ | ${_TOKEN_LINE}}"
fi

# Atomic write: header + AI bullets + completion → worker-log
# tick# assigned at write time with lockfile to prevent race conditions
_TICK_LOCK="$VAULT/Pi/State/locks/tick-counter.lock"
_assign_and_write() {
  local _waited=0
  while ! shlock -p $$ -f "$_TICK_LOCK" 2>/dev/null; do
    sleep 0.5
    _waited=$(( _waited + 1 ))
    [ "$_waited" -ge 60 ] && break
  done

  local _last_tick
  _last_tick=$(grep -o 'tick #[0-9]*' "$VAULT/Pi/Log/worker-log"*.md 2>/dev/null | sed 's/.*tick #//' | sort -n | tail -1)
  local _tick=$(( ${_last_tick:-0} + 1 ))

  local _write_ts
  _write_ts=$(date '+%Y-%m-%d %H:%M')

  local _header_meta
  _header_meta="[${HOST_SHORT}] | engine:${RUNTIME} | agent:${_LOG_AGENT} | task:${AGENT_NAME}"
  if [ -n "$FALLBACK_FROM" ]; then
    _header_meta="${_header_meta} | fallback:${FALLBACK_FROM}->${RUNTIME}"
  fi

  {
    echo ""
    echo "### ${_write_ts} ${_header_meta} | tick #${_tick}"
    [ -s "$_BULLETS_FILE" ] && cat "$_BULLETS_FILE"
    echo "$_COMPLETION"
  } >> "$WORKER_LOG_FILE"

  rm -f "$_TICK_LOCK"
}
_assign_and_write

# Save bullets content before cleanup (for auto-notify decision)
_SAVED_BULLETS=""
[ -s "$_BULLETS_FILE" ] && _SAVED_BULLETS=$(cat "$_BULLETS_FILE")
rm -f "$_BULLETS_FILE"

# Notify PiBrowser（只在非认证类的真实失败时通知）
# 认证失败已通过 notify.sh 通知（line 433），不重复发 PiBrowser 通知
if [ "$EXIT_CODE" -ne 0 ] && [ -z "$FALLBACK_FROM" ]; then
  _fail_body="${AGENT_NAME} 执行失败 (exit ${EXIT_CODE})，详见 worker-log"
  curl -s -X POST "http://127.0.0.1:17891/pios/notify" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"⚠ ${AGENT_NAME}\",\"body\":\"${_fail_body}\"}" \
    >/dev/null 2>&1 &
  # 非已知 pattern 的失败也通知用户（避免静默失败）
  bash "$VAULT/Pi/Tools/notify.sh" warning "${AGENT_NAME} 执行失败 (exit ${EXIT_CODE})，非认证错误，请检查日志" 2>/dev/null &
fi

# ── Pi 主动说话：有实际产出 → 发结构化事件到 PiBrowser，由 AI 生成通知 ──
if [ "$EXIT_CODE" -eq 0 ] && [ -n "$_SAVED_BULLETS" ]; then
  python3 -c "
import re, json, urllib.request
bullets = '''${_SAVED_BULLETS}'''
dur = '${_DUR_DISPLAY}'
cost = '${_TOKEN_LINE}'

fields = {}
for line in bullets.splitlines():
    for key in ['动作','action','产出','output','自省','reflection','triage','归档','archive']:
        if re.match(rf'^- {key}：', line):
            fields[key] = re.sub(r'^- [^：]*：\s*', '', line).strip()

action = fields.get('动作') or fields.get('action') or ''
# Skip idle ticks
if not action or re.search(r'无事|无动作|无需|退出|跳过|skip|idle|no action', action, re.I):
    exit(0)

# Build structured event
event = {
    'type': 'task_complete',
    'agent': '${_LOG_AGENT}',
    'task': '${AGENT_NAME}',
    'action': action,
    'output': fields.get('产出') or fields.get('output') or '',
    'reflection': fields.get('自省') or fields.get('reflection') or '',
    'triage': fields.get('triage') or '',
    'archive': fields.get('归档') or fields.get('archive') or '',
    'duration': dur,
}
# Extract cost
m = re.search(r'\\\$[\d.]+', cost)
if m: event['cost'] = m.group()

data = json.dumps(event, ensure_ascii=False).encode()
try:
    req = urllib.request.Request('http://127.0.0.1:17891/pios/event',
        data=data, headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=5)
except:
    pass  # PiBrowser 不在线，静默跳过
" 2>/dev/null &
fi

# ── agent-event-inbox auto-emit (2026-04-22 Phase 2b §1) ──
# worker 完成（非 idle）自动写一条 worker_done 事件到 Pi/State/agent-event-inbox-{host}.jsonl。
# 前台 Pi（PiBrowser / WeChat 派总）下一轮对话 context-injector 会 glob 所有分片注入，
# 让 Pi 真正"知道后台在做什么"。和上面的 /pios/event POST 同源数据，但走 event-emit.sh
# 分片 schema（Syncthing-safe）。skip idle 用和 /pios/event 同款启发式。
if [ "$EXIT_CODE" -eq 0 ] && [ -n "$_SAVED_BULLETS" ]; then
  python3 <<PY 2>/dev/null &
import re, subprocess
bullets = """${_SAVED_BULLETS}"""
fields = {}
for line in bullets.splitlines():
    for key in ['动作','action','产出','output','自省','reflection']:
        if re.match(rf'^- {key}：', line):
            fields[key] = re.sub(r'^- [^：]*：\s*', '', line).strip()

action = fields.get('动作') or fields.get('action') or ''
if not action or re.search(r'无事|无动作|无需|退出|跳过|skip|idle|no action|本轮无', action, re.I):
    raise SystemExit(0)

output = fields.get('产出') or fields.get('output') or ''
reflection = fields.get('自省') or fields.get('reflection') or ''

card_id = ''
summary = action[:120]
m = re.match(r'^([^:]{1,160}):\s*(.+)$', action)
if m and re.match(r'^[A-Za-z0-9._/-]+$', m.group(1)):
    card_id = m.group(1)
    summary = f"{card_id}: {m.group(2)[:96]}"

detail_parts = []
if output: detail_parts.append(f"产出: {output}")
if reflection: detail_parts.append(f"自省: {reflection}")
detail = ' | '.join(detail_parts)[:400]

cmd = [
    "${VAULT}/Pi/Tools/event-emit.sh",
    '--type', 'worker_done',
    '--level', 'report',
    '--priority', '2',
    '--summary', summary,
    '--detail', detail,
    '--source', "work-${HOST_SHORT}",
    '--ttl', '14400',
]
if card_id:
    cmd.extend(['--card', card_id])

subprocess.run(cmd, check=False, timeout=5)
PY
fi

# ── Cleanup: keep only last 50 run records per agent ──
ls -1t "$RUNS_DIR/${AGENT_NAME}"-*.json 2>/dev/null | tail -n +51 | xargs rm -f 2>/dev/null

exit $EXIT_CODE
