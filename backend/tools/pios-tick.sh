#!/bin/bash
# pios-tick.sh — PiOS 统一调度器（读 pios.yaml manifest）
#
# 每分钟被 cron 调用一次。任何机器都跑同一份代码。
# 从 pios.yaml 读 agent + task 定义，按 cron 匹配调度。
# 锁文件放在 Vault（Syncthing 同步），实现跨机互斥。
#
# 用法: pios-tick.sh
# crontab: * * * * * PIOS_VAULT=/path/to/vault bash /path/to/pios-tick.sh

set -uo pipefail

# 2026-04-28：剥宿主 OAuth env，避免 PiOS Electron 父进程 token 污染下游
# claude-cli。Spawn 链：PiOS(Electron) → pios-tick → adapter → claude-cli。
# 父进程 env 的 OAuth token 属于另一 session/scope，对 cron-spawned cli 死
# → 401 logged-out → fallback codex-cli（laptop-host 4-18 起调度全 logged-out
# 根因；feedback_spawn_env_strip_oauth.md 漏了这条 spawn 路径）。
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_ENTRYPOINT CLAUDECODE ANTHROPIC_API_KEY 2>/dev/null || true

# PATH 兜底：cron / PiOS.app spawn 子进程默认 PATH 极简，看不到 brew 装的工具
# （redis-cli, gtimeout 在 /opt/homebrew/bin）。2026-04-28 教训：laptop-host redis
# 锁因此整天没生效，走了 vault fallback 但不写 event（_redis_available 误判）。
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

VAULT="${PIOS_VAULT:-$(cd "$(dirname "$0")/../.." && pwd)}"
RAW_HOST=$(hostname -s)
MANIFEST="$VAULT/Pi/Config/pios.yaml"

# shellcheck source=lib/host-resolve.sh
source "$VAULT/Pi/Tools/lib/host-resolve.sh"
HOST=$(pios_resolve_host "$RAW_HOST")

# 能力声明：先读 ~/.pios/config.json host_caps（用户 override），
# 否则按 uname 推断默认 cap。产品 bundle 不硬编码任何 owner 私有 host 名。
# 用户要细分多机角色可在 ~/.pios/config.json 写 host_caps.{hostname}: "..."
if [ -f "$HOME/.pios/config.json" ] && command -v jq >/dev/null 2>&1; then
  _user_caps=$(jq -r --arg h "$HOST" '.host_caps[$h] // empty' "$HOME/.pios/config.json" 2>/dev/null)
else
  _user_caps=""
fi
if [ -n "$_user_caps" ]; then
  CAPS="$_user_caps"
elif [ "$(uname -s)" = "Darwin" ]; then
  CAPS="mac,hardware,interactive,browser,shell"
elif [ "$(uname -s)" = "Linux" ]; then
  CAPS="batch,browser,shell"
else
  CAPS="shell"
fi

ADAPTER="$VAULT/Pi/Tools/pios-adapter.sh"
LOG_DIR="$VAULT/Pi/Log/cron"
LOCKS_DIR="$VAULT/Pi/State/locks"
TODAY=$(date +%Y-%m-%d)
TICK_LOG="$LOG_DIR/pios-tick-${HOST}-${TODAY}.log"

mkdir -p "$LOG_DIR" "$LOCKS_DIR"
touch "$TICK_LOG"

# ── 插件自愈：~/.pios/config.json 列了的 optional plugin 若 vault 里缺，从 bundle 自动补 ──
# 背景：开发期手工搭的 vault 或 syncthing 同步漏掉时，config.plugins 标记装了但
# vault/Pi/Plugins/<id>/ 不存在 → Resources tab 看不到激活按钮 → 用户以为功能
# 消失。每次 tick 检查一遍，缺了从 bundle 现拷过去（cp -rn 不覆盖用户改动）。
_selfheal_plugins() {
  local cfg="$HOME/.pios/config.json"
  [ -f "$cfg" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local installed
  installed=$(jq -r '.plugins[]? // empty' "$cfg" 2>/dev/null) || return 0
  [ -z "$installed" ] && return 0

  # 找 bundle 目录（按候选顺序）
  local bundle=""
  for cand in \
      "/Applications/PiOS.app/Contents/Resources/app.asar.unpacked/backend/plugins" \
      "$VAULT/Projects/pios/backend/plugins" \
      "$(dirname "$0")/../../backend/plugins"; do
    if [ -d "$cand" ]; then bundle="$cand"; break; fi
  done
  [ -z "$bundle" ] && return 0

  while IFS= read -r pid; do
    case "$pid" in vault|shell|web-search|browser|"") continue ;; esac
    local dest="$VAULT/Pi/Plugins/$pid"
    [ -f "$dest/plugin.yaml" ] && continue
    local src="$bundle/$pid"
    [ -d "$src" ] || continue
    cp -rn "$src" "$VAULT/Pi/Plugins/" 2>/dev/null && \
      echo "[$(date '+%H:%M:%S')] self-heal: copied plugin $pid from bundle to vault" >> "$TICK_LOG"
  done <<<"$installed"
}
_selfheal_plugins

# ── HTTPS_PROXY 自动注入 ─────────────────────────────
# 背景：cron 是裸 env，不继承 shell 的 HTTPS_PROXY。Node/Python 等
# 下游 CLI（尤其 codex-cli @openai/codex）不会读 macOS 系统代理，
# 只认 HTTPS_PROXY 环境变量。无代理 → 直连 api.openai.com → GFW
# 黑洞 → stream-disconnect → fallback 到 claude-cli。
# 2026-04-24 laptop-host Tailscale exit 关闭后暴露此坑，故在此统一注入。
# 检测策略：仅当本机 127.0.0.1:7897 可连（Clash 存活）才注入，
# 否则写 WARN 日志，避免静默失败。NO_PROXY 排除 Tailscale /
# 局域网段，防止内部流量被绕出去。
if [ -z "${HTTPS_PROXY:-}" ] && command -v nc >/dev/null 2>&1; then
  if nc -z -G 1 127.0.0.1 7897 2>/dev/null; then
    export HTTP_PROXY="http://127.0.0.1:7897"
    export HTTPS_PROXY="http://127.0.0.1:7897"
    export NO_PROXY="localhost,127.0.0.1,::1,.local,.ts.net,100.64.0.0/10,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12"
    export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" no_proxy="$NO_PROXY"
  else
    echo "[$(date '+%H:%M:%S')] WARN: Clash 127.0.0.1:7897 unreachable; codex/openai 任务将直连 GFW 并失败" >> "$TICK_LOG"
  fi
fi

# ── scheduler 开关检查 ───────────────────────────────
# pios.yaml scheduler: pios-tick | openclaw
SCHEDULER=$(python3 -c "
import yaml
m = yaml.safe_load(open('$MANIFEST'))
print(m.get('scheduler', 'pios-tick'))
" 2>/dev/null || echo "pios-tick")

if [ "$SCHEDULER" = "openclaw" ]; then
  # OpenClaw 模式：跳过 task 调度，仅保留健康巡检
  exit 0
fi

# ── cron 表达式匹配 ──────────────────────────────────

cron_field_matches() {
  local field="$1" value="$2"
  [ "$field" = "*" ] && return 0
  if [[ "$field" == */* ]]; then
    local step="${field#*/}"
    local base="${field%/*}"
    if [ "$base" = "*" ]; then
      [ $((value % step)) -eq 0 ] && return 0
    else
      [ "$value" -ge "$base" ] && [ $(( (value - base) % step )) -eq 0 ] && return 0
    fi
    return 1
  fi
  IFS=',' read -ra parts <<< "$field"
  for part in "${parts[@]}"; do
    if [[ "$part" == *-* ]]; then
      local lo="${part%-*}" hi="${part#*-}"
      [ "$value" -ge "$lo" ] && [ "$value" -le "$hi" ] && return 0
    else
      [ "$part" -eq "$value" ] 2>/dev/null && return 0
    fi
  done
  return 1
}

cron_matches() {
  local schedule="$1"
  local min hour dom mon dow
  read -r min hour dom mon dow <<< "$schedule"
  local now_min=$(date +%-M)
  local now_hour=$(date +%-H)
  local now_dom=$(date +%-d)
  local now_mon=$(date +%-m)
  local now_dow=$(date +%u)
  [ "$now_dow" -eq 7 ] && now_dow=0
  cron_field_matches "$min" "$now_min" || return 1
  cron_field_matches "$hour" "$now_hour" || return 1
  cron_field_matches "$dom" "$now_dom" || return 1
  cron_field_matches "$mon" "$now_mon" || return 1
  cron_field_matches "$dow" "$now_dow" || return 1
  return 0
}

# ── 分布式锁（vpn-host redis 强一致 + Vault 文件锁兜底）──────
#
# 2026-04-27 引入 redis 层。背景：vault 文件锁通过 Syncthing 同步，eventual
# consistency 的 race window 导致每天 ~6 起多机同任务同分钟双跑（见 fallback
# events.jsonl）。redis SET NX EX 是原子的，跨机强一致。
#
# vpn-host 不可达 → 自动 fallback 到 vault lock（保留现状），并写一条
# fallback-events.jsonl {kind:"lock-fallback"} 供 maintenance 巡检。
# 详见 verify-redis-distributed-lock-2026-04-27.md。

LOCK_TTL=600  # 10 分钟 TTL
# REDIS_HOST 不硬编码默认值。优先级：env > ~/.pios/config.json (redis_host 字段) >
# 空（跳过 redis 层走 vault 文件锁兜底）。
REDIS_HOST="${PIOS_REDIS_HOST:-}"
if [ -z "$REDIS_HOST" ] && [ -r "$HOME/.pios/config.json" ] && command -v jq >/dev/null 2>&1; then
  REDIS_HOST=$(jq -r '.redis_host // empty' "$HOME/.pios/config.json" 2>/dev/null)
fi
REDIS_PASS_FILE="$VAULT/Pi/State/.redis-pass"
REDIS_PASS=""
[ -f "$REDIS_PASS_FILE" ] && REDIS_PASS=$(cat "$REDIS_PASS_FILE" 2>/dev/null)

# 平台 timeout 命令：macOS coreutils 装 gtimeout，Linux 自带 timeout
if command -v gtimeout >/dev/null 2>&1; then
  _TIMEOUT_CMD=gtimeout
else
  _TIMEOUT_CMD=timeout
fi

_redis_cli() {
  $_TIMEOUT_CMD 1 redis-cli -h "$REDIS_HOST" -a "$REDIS_PASS" --no-auth-warning "$@" 2>/dev/null
}

_redis_available() {
  [ -n "$REDIS_HOST" ] || return 1
  [ -n "$REDIS_PASS" ] || return 1
  command -v redis-cli >/dev/null 2>&1 || return 1
  command -v "$_TIMEOUT_CMD" >/dev/null 2>&1 || return 1
  return 0
}

try_acquire_lock() {
  local name="$1"

  if _redis_available; then
    # 层 1: redis SETNX 原子拿锁
    local owner="${HOST}:$$:$(date +%s)"
    local result
    result=$(_redis_cli SET "pios:lock:${name}" "$owner" NX EX "$LOCK_TTL")
    if [ "$result" = "OK" ]; then
      mkdir -p "$LOCKS_DIR"
      echo "$owner" > "$LOCKS_DIR/${name}.redis-owner"
      return 0
    fi
    # SET 没返回 OK：要么锁被别人占了，要么 redis 不通。PING 一下区分
    if [ "$(_redis_cli PING)" = "PONG" ]; then
      return 1  # redis 通但锁被占 → 别人在跑，跳过
    fi
    # redis 不通 → fallback 到 vault lock + 记 event
    printf '{"at":"%s","kind":"lock-fallback","host":"%s","task":"%s","reason":"redis-unreachable"}\n' \
      "$(date -Iseconds)" "$HOST" "$name" >> "$VAULT/Pi/Log/fallback-events.jsonl" 2>/dev/null
  else
    # _redis_available=false：redis 配置缺失（无密码 / 无 redis-cli / 无 timeout）
    # 也写一条 event，避免 silent fallback 整天没人发现（2026-04-28 laptop-host 教训）
    local why="redis-not-configured"
    [ -z "$REDIS_HOST" ] && why="no-host-set"
    [ -z "$REDIS_PASS" ] && why="no-pass-file"
    command -v redis-cli >/dev/null 2>&1 || why="no-redis-cli"
    command -v "$_TIMEOUT_CMD" >/dev/null 2>&1 || why="no-timeout-cmd"
    printf '{"at":"%s","kind":"lock-fallback","host":"%s","task":"%s","reason":"%s"}\n' \
      "$(date -Iseconds)" "$HOST" "$name" "$why" >> "$VAULT/Pi/Log/fallback-events.jsonl" 2>/dev/null
  fi

  # 层 2: vault file lock (fallback / redis 未配置)
  _try_acquire_vault_lock "$name"
}

release_lock() {
  local name="$1"
  local owner_file="$LOCKS_DIR/${name}.redis-owner"

  # 拿的是 redis 锁（owner 文件存在）→ Lua CAS 只删自己的，防误删续接者
  if [ -f "$owner_file" ] && _redis_available; then
    local owner; owner=$(cat "$owner_file")
    _redis_cli EVAL "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" \
      1 "pios:lock:${name}" "$owner" >/dev/null
    rm -f "$owner_file"
  fi

  # vault lock 兜底清理（fallback 路径 / 历史残留）
  rm -f "$LOCKS_DIR/${name}.lock.json"
}

# ── vault 文件锁（fallback 路径，保留原实现）──────────────
_try_acquire_vault_lock() {
  local name="$1"
  local lock_file="$LOCKS_DIR/${name}.lock.json"

  if [ -f "$lock_file" ]; then
    local expired
    expired=$(python3 -c "
import json
from datetime import datetime, timezone
try:
    d = json.load(open('$lock_file'))
    exp = datetime.fromisoformat(d['expires_at'])
    if exp.tzinfo is None: exp = exp.replace(tzinfo=timezone.utc)
    print('yes' if datetime.now(timezone.utc) >= exp else 'no')
except: print('yes')
" 2>/dev/null)
    [ "$expired" = "no" ] && return 1  # 锁有效
  fi

  local now expires
  now=$(date -Iseconds)
  expires=$(python3 -c "
from datetime import datetime, timezone, timedelta
print((datetime.now(timezone.utc) + timedelta(seconds=$LOCK_TTL)).isoformat())
" 2>/dev/null)

  cat > "$lock_file" <<EOF
{"host":"${HOST}","pid":$$,"task":"${name}","started_at":"${now}","expires_at":"${expires}"}
EOF
  return 0
}

# ── 过期锁清理 ──────────────────────────────────────

cleanup_expired_locks() {
  for lock_file in "$LOCKS_DIR"/*.lock.json; do
    [ -f "$lock_file" ] || continue
    local expired
    expired=$(python3 -c "
import json
from datetime import datetime, timezone
try:
    d = json.load(open('$lock_file'))
    exp = datetime.fromisoformat(d['expires_at'])
    if exp.tzinfo is None: exp = exp.replace(tzinfo=timezone.utc)
    print('yes' if datetime.now(timezone.utc) > exp else 'no')
except: print('yes')
" 2>/dev/null)
    if [ "$expired" = "yes" ]; then
      rm -f "$lock_file"
      echo "[$(date +%H:%M)] EXPIRED-LOCK: $(basename "$lock_file" .lock.json) (cleaned)" >> "$TICK_LOG"
    fi
  done
}

cleanup_expired_locks

# ── 孤儿 adapter reaper ───────────────────────────────
# PiOS GUI 用 spawn(...{detached:true}).unref() 启 pios-tick，PiOS 死后 tick 被 init
# 接管。tick 主流程 `&` 派生的 adapter 也一样。如果 adapter 卡（claude CLI hang）
# adapter 自身 watchdog 30min 才介入。在此期间 tick 重复触发 → 又一组孤儿，堆积。
#
# 这里：启动时把 PPID=1 + 命令含 pios-adapter.sh + etime >5min（给当前活 task 留余地）
# 的孤儿 SIGTERM 掉。adapter 自带 TERM trap finalize run.json，安全。
reap_orphan_adapters() {
  local orphans
  orphans=$(ps -A -o pid,ppid,etime,command 2>/dev/null \
    | awk '$2==1 && $0 ~ /pios-adapter\.sh/ {
        e=$3
        if (e ~ /-/) { print $1; next }
        if (e ~ /^[0-9]+:[0-9]+:[0-9]+$/) { print $1; next }
        split(e, p, ":")
        if (length(p) >= 2 && p[1]+0 >= 5) print $1
      }' 2>/dev/null)
  [ -z "$orphans" ] && return 0
  echo "[$(date +%H:%M)] REAP-ORPHAN: $(echo $orphans | tr '\n' ' ')" >> "$TICK_LOG"
  # shellcheck disable=SC2086
  kill -TERM $orphans 2>/dev/null || true
}
reap_orphan_adapters

# ── Stale run reaper ───────────────────────────────
# 背景：pios-adapter.sh 在被 TERM/INT/HUP 信号杀时会写 finish record（trap），
# 但 SIGKILL / 断电 / 重启 / OOM 接不住，run.json 永远卡在 status=running，
# 导致 dashboard 一直显示 "running"。
#
# 策略：每 tick 扫一次 $RUNS_DIR，把同机（host == HOST）+ status=running
# + started_at 老于 STALE_MINUTES 的 record 强制改成 status=failed。
# 跨机绝不动（无法探活远端进程，避免误杀正在跑的远端任务）。
#
# 触发场景：当一台机器重启回来，下一次 tick 自然把自己留下的孤儿 run 清掉。
#
# 阈值：默认 60 分钟（经验上单 task < 30 min，2x 缓冲）。可通过
# PIOS_RUN_STALE_MINUTES 覆盖。

STALE_RUN_MINUTES="${PIOS_RUN_STALE_MINUTES:-60}"

cleanup_stale_runs() {
  local runs_dir="$VAULT/Pi/State/runs"
  [ -d "$runs_dir" ] || return 0
  python3 <<PYEOF 2>>"$TICK_LOG"
import json, os, time
from datetime import datetime, timezone

RUNS_DIR = "$runs_dir"
HOST = "$HOST"
STALE_MIN = int("$STALE_RUN_MINUTES")
TICK_LOG = "$TICK_LOG"

now = datetime.now().astimezone()
now_epoch = time.time()
# 性能：只看近 24h mtime 的文件，避开 400+ 老 record
RECENT_WINDOW = 24 * 3600

reaped = []
try:
    entries = os.listdir(RUNS_DIR)
except FileNotFoundError:
    entries = []

for name in entries:
    if not name.endswith(".json"):
        continue
    path = os.path.join(RUNS_DIR, name)
    try:
        st = os.stat(path)
    except OSError:
        continue
    if now_epoch - st.st_mtime > RECENT_WINDOW:
        continue
    try:
        with open(path, "r") as f:
            d = json.load(f)
    except Exception:
        continue
    if d.get("status") != "running":
        continue
    if d.get("host") != HOST:
        continue  # 跨机绝不动
    started_raw = d.get("started_at")
    if not started_raw:
        continue
    try:
        started = datetime.fromisoformat(started_raw)
    except ValueError:
        continue
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    age_sec = (now - started).total_seconds()
    if age_sec < STALE_MIN * 60:
        continue
    # Reap
    d["finished_at"] = now.isoformat(timespec="seconds")
    d["status"] = "failed"
    d["exit_code"] = -9
    d["error"] = f"stale (no finish record after {int(age_sec/60)}min, likely killed by reboot/SIGKILL/OOM)"
    try:
        with open(path, "w") as f:
            json.dump(d, f, indent=2)
        reaped.append((d.get("run_id", name), int(age_sec / 60)))
    except OSError:
        continue

if reaped:
    hhmm = datetime.now().strftime("%H:%M")
    with open(TICK_LOG, "a") as f:
        for rid, age in reaped:
            f.write(f"[{hhmm}] STALE-RUN: {rid} age={age}min (reaped)\n")
PYEOF
}

cleanup_stale_runs

select_preferred_host() {
  local hosts_csv="$1"
  local engines_csv="$2"
  [ -n "$hosts_csv" ] || { echo "any"; return 0; }
  [ "$hosts_csv" = "-" ] && { echo "any"; return 0; }
  python3 <<PYEOF
import json, os, time
from pathlib import Path

vault = Path("$VAULT")
today = "$TODAY"
hosts = [h.strip() for h in "$hosts_csv".split(",") if h.strip() and h.strip() != "any"]
engines = [e.strip() for e in "$engines_csv".split(",") if e.strip() and e.strip() != "-"]
heartbeat_ttl = int(os.environ.get("PIOS_HOST_HEARTBEAT_TTL_MINUTES", "10"))
now = time.time()

if not hosts:
    print("any")
    raise SystemExit

def heartbeat_fresh(host):
    tick_log = vault / "Pi" / "Log" / "cron" / f"pios-tick-{host}-{today}.log"
    try:
        return (now - tick_log.stat().st_mtime) <= heartbeat_ttl * 60
    except FileNotFoundError:
        return False

def host_can_run(host):
    if not engines or engines == ["local"]:
        return True
    auth_path = vault / "Pi" / "Log" / f"auth-status-{host}.json"
    try:
        data = json.loads(auth_path.read_text())
        engine_states = data.get("engines", {})
    except Exception:
        return True
    saw_explicit_false = False
    for engine in engines:
        if engine == "local":
            return True
        info = engine_states.get(engine)
        if not info or info.get("ok") is None:
            return True
        if info.get("ok") is True:
            return True
        if info.get("ok") is False:
            saw_explicit_false = True
    return not saw_explicit_false

for host in hosts:
    if not heartbeat_fresh(host):
        continue
    if host_can_run(host):
        print(host)
        raise SystemExit

print("")
PYEOF
}

# ── 提醒（纯 bash，零 AI 调用）───────────────────────
# 2026-04-28 改：reminder 不再单一 host-only。owner 设计原则：interactive host
# 死了/掉线/关机都属于可能事件；不在电脑前必须把通知给到 IM。always-on host 兜底。
# reminder.sh 内部用 redis 锁防双机双发（interactive 优先，always-on 5s 延迟接班）。
REMINDER_SCRIPT="$VAULT/Pi/Tools/reminder.sh"
if [ -x "$REMINDER_SCRIPT" ]; then
  bash "$REMINDER_SCRIPT" 2>>"$TICK_LOG" || true
fi

# ── Auth-pause 检查 ──────────────────────────────────
AUTH_PAUSED=false
AUTH_PAUSE_FILE="$VAULT/Pi/State/auth-pause.json"
if [ -f "$AUTH_PAUSE_FILE" ]; then
  _ap=$(python3 -c "import json; print(json.load(open('$AUTH_PAUSE_FILE')).get('all_exhausted', False))" 2>/dev/null)
  [ "$_ap" = "True" ] && AUTH_PAUSED=true && echo "[$(date +%H:%M)] AUTH-PAUSED: skipping AI tasks" >> "$TICK_LOG"
fi

# ── Python 路径（pyyaml 依赖）─────────────────────────
PYAML="/usr/bin/python3"
command -v "$PYAML" >/dev/null 2>&1 || PYAML="python3"

# ── pios.yaml 验证 + fallback ────────────────────────
MANIFEST_BACKUP="$VAULT/Pi/State/.pios-yaml-last-valid"

if [ ! -f "$MANIFEST" ]; then
  echo "[$(date +%H:%M)] ERROR: pios.yaml not found at $MANIFEST" >> "$TICK_LOG"
  exit 1
fi

# Schema 验证：确保 YAML 可解析且有 agents 字段
# 错误处理（issue #2）：python 抛错时把完整 traceback 落到 ~/.pios/logs/config-validation.log，
# 通知里给具体文件路径 + 行号 hint，避免"fail: python error"这种黑盒提示。
_CFG_LOG_DIR="$HOME/.pios/logs"
mkdir -p "$_CFG_LOG_DIR"
_CFG_LOG="$_CFG_LOG_DIR/config-validation.log"
_VALID=$($PYAML -c "
import yaml, sys, traceback
try:
    m = yaml.safe_load(open('$MANIFEST'))
    assert isinstance(m, dict), 'not a dict'
    assert 'agents' in m, 'no agents key'
    assert isinstance(m['agents'], dict), 'agents not dict'
    print('ok')
except yaml.YAMLError as e:
    # YAMLError 通常自带 line/column 上下文
    mark = getattr(e, 'problem_mark', None)
    loc = f' (line {mark.line+1} col {mark.column+1})' if mark else ''
    print(f'yaml: {type(e).__name__}{loc}: {getattr(e, \"problem\", str(e))}')
    sys.stderr.write(traceback.format_exc())
except Exception as e:
    print(f'schema: {type(e).__name__}: {e}')
    sys.stderr.write(traceback.format_exc())
" 2>"$_CFG_LOG.stderr.tmp" || echo "exec: python interpreter failed (check $PYAML)")
# 把本次 stderr 拼到累积 log（保留最近 50 次失败的上下文，超了截断）
if [ -s "$_CFG_LOG.stderr.tmp" ]; then
  {
    echo "─── $(date '+%Y-%m-%d %H:%M:%S') ───"
    cat "$_CFG_LOG.stderr.tmp"
    echo ""
  } >> "$_CFG_LOG"
  # 截断到最新 500 行
  tail -500 "$_CFG_LOG" > "$_CFG_LOG.tmp" && mv -f "$_CFG_LOG.tmp" "$_CFG_LOG"
fi
rm -f "$_CFG_LOG.stderr.tmp"

if [[ "$_VALID" != "ok" ]]; then
  echo "[$(date +%H:%M)] SCHEMA-FAIL: pios.yaml invalid: $_VALID" >> "$TICK_LOG"
  echo "[$(date +%H:%M)] full traceback: $_CFG_LOG" >> "$TICK_LOG"
  _ROLLED_BACK=0
  if [ -f "$MANIFEST_BACKUP" ]; then
    echo "[$(date +%H:%M)] FALLBACK: using last valid pios.yaml" >> "$TICK_LOG"
    cp "$MANIFEST_BACKUP" "$MANIFEST"
    _ROLLED_BACK=1
  fi
  if [ "$_ROLLED_BACK" -eq 1 ]; then
    bash "$VAULT/Pi/Tools/notify.sh" warn "pios.yaml 格式错误 ($_VALID)，已自动回退到上次有效版本。完整 traceback 见 $_CFG_LOG" 2>/dev/null || true
  else
    bash "$VAULT/Pi/Tools/notify.sh" critical "pios.yaml 格式错误 ($_VALID)，且无可回退备份，调度暂停。完整 traceback 见 $_CFG_LOG" 2>/dev/null || true
  fi
  exit 1
fi

# 验证通过，保存备份（原子写：cp 到临时文件再 mv，防 Syncthing 看到半写状态）
# 2026-04-19：该文件已加入 .stignore（本机缓存不同步），但原子写仍保证本机 fallback 不读到半截
cp "$MANIFEST" "${MANIFEST_BACKUP}.tmp.$$" && mv -f "${MANIFEST_BACKUP}.tmp.$$" "$MANIFEST_BACKUP"

# 解析 manifest，输出每个 task 一行 TSV:
# agent_id \t task_id \t agent_status \t enabled \t cron \t runtime \t host \t prompt_path \t soul_path \t depends_on

TASK_LIST=$($PYAML -c "
import yaml

manifest = yaml.safe_load(open('$MANIFEST'))
agents = manifest.get('agents', {})
for aid, agent in agents.items():
    a_status = agent.get('status', 'active')
    # 2026-04-17: agent.hosts/runtimes (数组) 取代 agent.host/runtime (单值)。向后兼容老字段。
    # task.host 缺失时继承 agent.hosts[0]，task.runtimes 缺失时继承 agent.runtimes。
    a_hosts = agent.get('hosts')
    if not a_hosts:
        _legacy_host = agent.get('host')
        a_hosts = [_legacy_host] if _legacy_host else ['any']
    a_host = a_hosts[0]

    a_runtimes = agent.get('runtimes')
    if not a_runtimes:
        _legacy_rt = agent.get('runtime')
        a_runtimes = [_legacy_rt] if _legacy_rt else ['claude-cli']
    a_runtime = a_runtimes[0]

    a_soul = agent.get('soul', '')
    for tid, task in agent.get('tasks', {}).items():
        t_enabled = str(task.get('enabled', True)).lower()
        trigger = task.get('trigger', {})
        cron = trigger.get('cron', '')
        # task.runtimes (新) 优先；engines (老) 兼容；runtime (单值) 最后
        t_runtimes = task.get('runtimes') or task.get('engines') or []
        if t_runtimes:
            t_runtime = t_runtimes[0]
        else:
            t_runtime = task.get('runtime', a_runtime)
            t_runtimes = [t_runtime] if t_runtime else a_runtimes
        t_host = task.get('host', a_host)
        t_hosts = task.get('hosts', [])
        t_hosts_csv = ','.join(t_hosts) if t_hosts else ''
        # 下游 select_preferred_host 仍用 engines_csv 变量名（内部实现细节，不改名）
        t_engines_csv = ','.join(t_runtimes) if t_runtimes else ''
        t_prompt = task.get('prompt', '')
        deps = task.get('depends_on', [])
        deps_str = ','.join(deps) if deps else ''
        # catch-up 策略：task 覆盖 agent，agent 覆盖默认值（true / 720 分钟）
        cu_flag = str(task.get('catch_up', agent.get('catch_up', True))).lower()
        try:
            cu_window = int(task.get('catch_up_window_minutes', agent.get('catch_up_window_minutes', 720)))
        except (TypeError, ValueError):
            cu_window = 720
        # 空字段统一写占位符 dash，bash IFS tab 会把连续 tab 合并成一个
        # 分隔符（因为 tab 是 whitespace），导致后续字段左移，占位符防 shift
        for _var in ('cron','t_runtime','t_host','t_prompt','a_soul','deps_str','t_hosts_csv','t_engines_csv'):
            if not locals()[_var]:
                locals()[_var]  # no-op, placeholder logic below
        cron_out    = cron    or '-'
        runtime_out = t_runtime or '-'
        host_out    = t_host  or '-'
        hosts_out   = t_hosts_csv or '-'
        engines_out = t_engines_csv or '-'
        prompt_out  = t_prompt or '-'
        soul_out    = a_soul  or '-'
        deps_out    = deps_str or '-'
        # pre_gate：bash shell 表达式，返回 0 才启动 adapter（用于高频 task 的哑门）
        pre_gate = task.get('pre_gate', '') or ''
        pre_gate_out = pre_gate if pre_gate else '-'
        # timeout_sec：单 task 覆盖 adapter 默认 1800s 超时
        try:
            t_timeout_sec = int(task.get('timeout_sec') or 0)
        except (TypeError, ValueError):
            t_timeout_sec = 0
        timeout_out = str(t_timeout_sec) if t_timeout_sec > 0 else '-'
        print(f'{aid}\t{tid}\t{a_status}\t{t_enabled}\t{cron_out}\t{runtime_out}\t{host_out}\t{prompt_out}\t{soul_out}\t{deps_out}\t{cu_flag}\t{cu_window}\t{pre_gate_out}\t{hosts_out}\t{engines_out}\t{timeout_out}')
" 2>>"$TICK_LOG")

if [ -z "$TASK_LIST" ]; then
  echo "[$(date +%H:%M)] WARN: no tasks found in manifest" >> "$TICK_LOG"
  exit 0
fi

# ── depends_on 检查 ──────────────────────────────────
# 检查一个 task 的所有前置依赖是否已在"健康窗口"内完成（有 run record）
# 支持精确 task id 和通配符 "pipeline:*"（pipeline agent 下所有采集 task）
#
# 2026-04-23 bug 修复（feedback_wechat_extract_silent_zero.md 同场教训）：
# 原来固定查 TODAY + YESTERDAY 两天。但周任务（如 profile-refresh，cron '30 1 * * 0'）
# 只周日跑一次，周一到周六永远找不到 run record → 上游（daily-user-status / daily-diary-engine）
# 永久 block。实际证据：04-23 daily-diary-engine 一整天没跑，04-22 日记空档。
#
# 修复：从 TASK_LIST 读该 task 的 cron 表达式，解析第 5 字段（dow）推算"健康窗口"：
#   - dow 非 * 或 月字段 非 * → 周/月任务 → 窗口 8 天
#   - 否则日任务 → 窗口 2 天（TODAY + YESTERDAY，原行为）

RUNS_DIR="$VAULT/Pi/State/runs"
TODAY_COMPACT="${TODAY//-/}"
YESTERDAY_COMPACT=$(date -v-1d +%Y%m%d 2>/dev/null || date -d "yesterday" +%Y%m%d 2>/dev/null || echo "")

# 根据 task 的 cron 推算健康窗口天数（TASK_LIST 第 5 列 = cron）
# 返回：2（日任务）或 8（周/月任务）
_dep_window_days() {
  local task_id="$1"
  local cron
  cron=$(echo "$TASK_LIST" | awk -F'\t' -v t="$task_id" '$2 == t { print $5; exit }')
  [ -z "$cron" ] || [ "$cron" = "-" ] && { echo 2; return; }
  # cron 5 字段：minute hour day-of-month month day-of-week
  local dom mon dow
  dom=$(echo "$cron" | awk '{print $3}')
  mon=$(echo "$cron" | awk '{print $4}')
  dow=$(echo "$cron" | awk '{print $5}')
  # 周/月任务：dow 非 * 或 dom 非 * 或 mon 非 *
  if [ -n "$dow" ] && [ "$dow" != "*" ]; then echo 8; return; fi
  if [ -n "$dom" ] && [ "$dom" != "*" ]; then echo 8; return; fi
  if [ -n "$mon" ] && [ "$mon" != "*" ]; then echo 8; return; fi
  echo 2
}

# 检查一个 dep task 是否在健康窗口内有 run record
# 返回：
#   0  健康（窗口内有 run，或历史上从未跑过 → 视为未部署、放行）
#   1  stale（历史上跑过，但不在窗口内）
# 2026-04-23 补：profile-refresh 历史上 0 run record → 永久 block daily-user-status。
# 区分"未部署"（从未跑过）和"stale"（跑过但过期），前者放行后者 block。
_dep_has_recent_run() {
  local task_id="$1"
  local window_days
  window_days=$(_dep_window_days "$task_id")
  local d
  for ((d=0; d<window_days; d++)); do
    local dt
    dt=$(date -v-${d}d +%Y%m%d 2>/dev/null || date -d "-${d} days" +%Y%m%d 2>/dev/null)
    [ -z "$dt" ] && continue
    if ls "$RUNS_DIR/${task_id}-${dt}"*.json &>/dev/null; then
      return 0
    fi
  done
  # 窗口内找不到 → 判断是"历史上从未跑过"还是"跑过但过期"
  # 看 runs 目录是否**任何日期**有该 task 的 record
  if ! ls "$RUNS_DIR/${task_id}-"*.json &>/dev/null; then
    # 从未跑过：视为未部署（新加或永久禁用），放行但记 WARN
    echo "[$(date +%H:%M)] WARN: dep task '${task_id}' has never run — treating as not-deployed, allowing upstream" >> "$TICK_LOG"
    return 0
  fi
  return 1
}

check_depends_on() {
  local deps_str="$1" self_task="$2"
  [ -z "$deps_str" ] && return 0  # 无依赖，直接通过

  IFS=',' read -ra deps <<< "$deps_str"
  for dep in "${deps[@]}"; do
    if [[ "$dep" == "pipeline:"* ]]; then
      # 通配符：等 pipeline agent 下所有采集 task（排除自身和合成类 task）
      local pipeline_tasks
      pipeline_tasks=$(echo "$TASK_LIST" | awk -F'\t' '$1 == "pipeline" { print $2 }')
      for ptask in $pipeline_tasks; do
        # 跳过自身和合成类 task（daily-user-status, daily-diary-engine）
        [[ "$ptask" == "$self_task" ]] && continue
        [[ "$ptask" == "daily-user-status" ]] && continue
        [[ "$ptask" == "daily-diary-engine" ]] && continue
        # 健康窗口检查：日任务 2 天、周/月任务 8 天
        if ! _dep_has_recent_run "$ptask"; then
          local w; w=$(_dep_window_days "$ptask")
          echo "[$(date +%H:%M)] DEPENDS: ${self_task} waiting for ${ptask} (window=${w}d)" >> "$TICK_LOG"
          return 1
        fi
      done
    else
      # 精确依赖（按该 dep 自己的健康窗口）
      if ! _dep_has_recent_run "$dep"; then
        local w; w=$(_dep_window_days "$dep")
        echo "[$(date +%H:%M)] DEPENDS: ${self_task} waiting for ${dep} (window=${w}d)" >> "$TICK_LOG"
        return 1
      fi
    fi
  done
  return 0
}

# ── Catch-up 预计算 ──────────────────────────────────
# 对每个 task 判定：是否错过了最近一次应触发时间，且新于该 task 最新 run record。
# 用单次 Python 扫一遍 RUNS_DIR + 解析所有 task 的 cron，输出 TSV：
#   task_id \t missed_fire_iso \t age_minutes
# 后续主循环遇到 cron 不匹配但 task_id 在此表中 → catch-up（受速率限制）。
#
# 防坑 checklist：
#   - 只对在过去 7 天内至少跑过一次的 task 补跑（proven-healthy），避免新装/遗弃 task 启动时雪崩
#   - 窗口外（默认 12h）的 miss 不补，仅记录 MISSED-OVERAGE
#   - 主循环里仍按 host / enabled / auth-pause / engine-down / depends_on / lock 全量过滤
#   - 速率限制：每 tick 最多 $PIOS_CATCHUP_MAX（默认 2）个 catch-up 新起
#   - 跨午夜 task（如 23:58）的补跑 run record 日期 = 补跑发生日（不是原触发日），
#     但 depends_on 检查在 TODAY+YESTERDAY 范围内查 run record，兼容

CATCHUP_TSV=$($PYAML <<PYEOF 2>>"$TICK_LOG"
import os, re
from datetime import datetime, timedelta

RUNS_DIR = "$RUNS_DIR"
HOST = "$HOST"
TASK_LIST = """$TASK_LIST"""
now = datetime.now()
seven_days_ago = now - timedelta(days=7)

# 扫 run records：每个 task 最新时间戳
task_newest = {}
file_re = re.compile(r'^(.+)-(\d{8})-(\d{6})\.json$')
try:
    entries = os.listdir(RUNS_DIR)
except FileNotFoundError:
    entries = []
for f in entries:
    m = file_re.match(f)
    if not m: continue
    tid, ymd, hms = m.groups()
    try:
        ts = datetime.strptime(ymd + hms, '%Y%m%d%H%M%S')
    except ValueError:
        continue
    cur = task_newest.get(tid)
    if cur is None or ts > cur:
        task_newest[tid] = ts

def match_field(field, value):
    if field == '*': return True
    if '/' in field:
        base, step = field.split('/')
        try: step = int(step)
        except ValueError: return False
        if base == '*':
            return value % step == 0
        try: base = int(base)
        except ValueError: return False
        return value >= base and (value - base) % step == 0
    for p in field.split(','):
        if '-' in p:
            try: lo, hi = map(int, p.split('-'))
            except ValueError: continue
            if lo <= value <= hi: return True
        else:
            try:
                if int(p) == value: return True
            except ValueError: pass
    return False

def last_fire_before(cron_expr, now_, window_min):
    parts = cron_expr.split()
    if len(parts) != 5: return None
    mn, hr, dom, mon, dow_ = parts
    for i in range(1, window_min + 2):
        t = now_ - timedelta(minutes=i)
        dow_val = t.isoweekday() % 7  # cron: 0=Sun
        if (match_field(mn, t.minute) and match_field(hr, t.hour) and
            match_field(dom, t.day) and match_field(mon, t.month) and
            match_field(dow_, dow_val)):
            # 2026-04-16: 归零秒数/微秒 — cron 精度是分钟，带秒会让 newest<last_fire 差几秒就误判 missed
            return t.replace(second=0, microsecond=0)
    return None

for line in TASK_LIST.splitlines():
    parts = line.split('\t')
    if len(parts) < 12: continue
    aid, tid, a_status, enabled, cron, runtime, t_host, _prompt, _soul, _deps, cu_flag, cu_window = parts[:12]
    # 占位符 "-" → 空（与 bash 主循环保持一致）
    if cron == '-': cron = ''
    if runtime == '-': runtime = ''
    if t_host == '-': t_host = ''
    if enabled != 'true' or a_status != 'active' or cu_flag != 'true' or not cron:
        continue
    if t_host and t_host != 'any' and t_host != HOST:
        continue
    try: w = int(cu_window)
    except ValueError: w = 720
    last_fire = last_fire_before(cron, now, w)
    if last_fire is None:
        continue
    newest = task_newest.get(tid)
    # Proven-healthy gate：从未跑过 / 7 天内无记录 → 不补跑
    if newest is None or newest < seven_days_ago:
        continue
    if newest >= last_fire:
        continue  # 已跑过这次 fire 或之后
    age_min = int((now - last_fire).total_seconds() / 60)
    print(f"{tid}\t{last_fire.strftime('%Y-%m-%dT%H:%M')}\t{age_min}")
PYEOF
)

CATCH_UP_MAX_PER_TICK="${PIOS_CATCHUP_MAX:-2}"
CATCH_UP_COUNT=0
PIOS_DRY_RUN="${PIOS_DRY_RUN:-0}"

if [ -n "$CATCHUP_TSV" ]; then
  while IFS=$'\t' read -r _tid _mts _age; do
    echo "[$(date +%H:%M)] CATCHUP-CANDIDATE ${_tid} missed=${_mts} age=${_age}min [${HOST}]" >> "$TICK_LOG"
  done <<< "$CATCHUP_TSV"
fi

# ── 主调度循环 ────────────────────────────────────────

while IFS=$'\t' read -r agent_id task_id agent_status enabled cron runtime task_host prompt_path soul_path depends_on catch_up_flag catch_up_window_min pre_gate task_hosts engine_list task_timeout_sec; do
  # 占位符 "-" → 空（防 bash IFS 合并连续 tab 的 field-shift）
  [ "$cron" = "-" ] && cron=""
  [ "$runtime" = "-" ] && runtime=""
  [ "$task_host" = "-" ] && task_host=""
  [ "$prompt_path" = "-" ] && prompt_path=""
  [ "$soul_path" = "-" ] && soul_path=""
  [ "$depends_on" = "-" ] && depends_on=""
  [ "$pre_gate" = "-" ] && pre_gate=""
  [ "$task_hosts" = "-" ] && task_hosts=""
  [ "$engine_list" = "-" ] && engine_list=""

  # 跳过禁用的
  [ "$enabled" != "true" ] && continue
  [ "$agent_status" != "active" ] && continue
  [ -z "$cron" ] && continue

  # Host fallback：按 hosts 顺序选第一台当前可用机器；没有 hosts 时退回单 host 旧逻辑。
  _selected_host="$task_host"
  if [ -n "$task_hosts" ]; then
    _selected_host=$(select_preferred_host "$task_hosts" "${engine_list:-$runtime}")
    if [ -z "$_selected_host" ]; then
      echo "[$(date +%H:%M)] HOST-DOWN skip ${task_id} hosts=${task_hosts} runtime=${runtime} [${HOST}]" >> "$TICK_LOG"
      continue
    fi
    # 2026-04-17: host fallback 事件——当 selected != hosts[0] 且是本机时产出一条
    # （只在本机写，避免多机重复记录同一事件）
    _primary_host=$(echo "$task_hosts" | cut -d',' -f1)
    if [ "$_selected_host" = "$HOST" ] && [ "$_selected_host" != "$_primary_host" ]; then
      _FB_LOG="$VAULT/Pi/Log/fallback-events.jsonl"
      mkdir -p "$(dirname "$_FB_LOG")"
      printf '{"at":"%s","kind":"host","task":"%s","intended_host":"%s","actual_host":"%s","reason":"primary-host-unhealthy"}\n' \
        "$(date -Iseconds)" "${task_id}" "${_primary_host}" "${_selected_host}" \
        >> "$_FB_LOG"
    fi
  fi
  if [ -n "$_selected_host" ] && [ "$_selected_host" != "any" ] && [ "$_selected_host" != "$HOST" ]; then
    continue
  fi

  # Auth-pause：跳过需要 AI 的任务
  if [ "$AUTH_PAUSED" = "true" ] && [ "$runtime" != "local" ]; then
    continue
  fi

  # 引擎状态检查：down / auth_expired / quota_exhausted 一律跳过
  # （不浪费 tick 去试再 fallback，也避免爆 quota 通知）
  if [ "$runtime" != "local" ]; then
    _engine_status=$(python3 -c "
import yaml
m = yaml.safe_load(open('$MANIFEST'))
print(m.get('infra',{}).get('runtimes',{}).get('$runtime',{}).get('status','unknown'))
" 2>/dev/null || echo "unknown")
    if [ "$_engine_status" = "down" ] || [ "$_engine_status" = "auth_expired" ] || [ "$_engine_status" = "quota_exhausted" ]; then
      # 检查 task 有没有备选引擎（engines 列表）
      _alt_engine=$(python3 -c "
import yaml
DOWN_STATUSES = ('down','auth_expired','quota_exhausted','unknown')
m = yaml.safe_load(open('$MANIFEST'))
for aid, a in m.get('agents',{}).items():
    for tid, t in a.get('tasks',{}).items():
        if tid == '$task_id':
            engines = t.get('engines', [])
            rts = m.get('infra',{}).get('runtimes',{})
            for e in engines:
                if e != '$runtime' and rts.get(e,{}).get('status','unknown') not in DOWN_STATUSES:
                    print(e)
                    exit()
" 2>/dev/null)
      if [ -n "$_alt_engine" ]; then
        echo "[$(date +%H:%M)] ENGINE-SWITCH ${task_id} ${runtime}(${_engine_status}) → ${_alt_engine} [${HOST}]" >> "$TICK_LOG"
        runtime="$_alt_engine"
      else
        echo "[$(date +%H:%M)] ENGINE-DOWN skip ${task_id} runtime=${runtime} status=${_engine_status} [${HOST}]" >> "$TICK_LOG"
        continue
      fi
    fi
  fi

  # Cron 匹配 或 catch-up
  _run_reason=""
  if cron_matches "$cron"; then
    _run_reason="normal"
  else
    _cu_info=$(awk -v t="$task_id" -F'\t' '$1==t {print $2"\t"$3; exit}' <<< "$CATCHUP_TSV")
    if [ -n "$_cu_info" ]; then
      if [ "$CATCH_UP_COUNT" -ge "$CATCH_UP_MAX_PER_TICK" ]; then
        # 达到 per-tick 上限，下一个 tick 再试
        continue
      fi
      _missed_ts=$(cut -f1 <<< "$_cu_info")
      _age_min=$(cut -f2 <<< "$_cu_info")
      _run_reason="catchup missed=${_missed_ts} age=${_age_min}min"
    else
      continue
    fi
  fi

  # depends_on 检查（前置 task 今天必须有 run record）
  check_depends_on "$depends_on" "$task_id" || continue

  # pre_gate 检查（bash 层哑门，不启动 claude-cli 就能判定"无活"）
  # 用途：高频 task（work / triage）在 bash 层跑一次廉价 shell expr 判断是否有活干。
  # 无活 → 跳过本 tick，不启动 Claude session → 0 token 秒退（省 $4.6/天 work 空转开销）
  # 有活 → 正常走锁 + 启动 adapter
  #
  # 关键：pre_gate skip 必须写一条轻量 run record，否则 catch-up 机制会认为
  # task 错过了这次 fire，下一分钟重复触发 → pre_gate 无限重入（虽然 0 token，
  # 但会占用 per-tick catch-up 配额 + 污染日志）。写了 status=gate_skipped
  # 的 run record 后，catch-up 就能识别"来过了"，不再重试。
  if [ -n "$pre_gate" ]; then
    if ! eval "$pre_gate" >/dev/null 2>&1; then
      echo "[$(date +%H:%M)] GATE-SKIP ${task_id} [${HOST}] (pre_gate unsatisfied)" >> "$TICK_LOG"
      _skip_ts=$(date +%Y%m%d-%H%M%S)
      _skip_iso=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)
      cat > "$RUNS_DIR/${task_id}-${_skip_ts}.json" <<EOF
{
  "run_id": "${task_id}-${_skip_ts}",
  "agent": "${agent_id}",
  "task": "${task_id}",
  "host": "${HOST}",
  "started_at": "${_skip_iso}",
  "finished_at": "${_skip_iso}",
  "status": "gate_skipped",
  "exit_code": 0,
  "reason": "pre_gate unsatisfied"
}
EOF
      continue
    fi
  fi

  # work task 跨机器 claimed_by 锁检查：防止双机并发同一张卡覆盖彼此成果
  # 若 ready_for_work 的卡 claimed_by 非空且非本机且声明时间 < 30min → 跳过
  if [ "$task_id" = "work" ]; then
    _cross_msg=$(python3 <<PYEOF 2>/dev/null
import os, sys, time
vault = "$VAULT"
host  = "$HOST"
active_dir = os.path.join(vault, "Cards", "active")
skip_reason = ""
try:
    cards = sorted([
        os.path.join(active_dir, f)
        for f in os.listdir(active_dir)
        if f.endswith(".md") and ".sync-conflict-" not in f
    ])
except Exception:
    sys.exit(0)
for card in cards:
    try:
        text = open(card).read()
        if "ready_for_work: true" not in text:
            continue
        claimed_by = ""
        in_fm = False
        for line in text.split("\n"):
            if line.strip() == "---":
                if not in_fm:
                    in_fm = True
                    continue
                else:
                    break
            if in_fm and line.startswith("claimed_by:"):
                claimed_by = line.split(":", 1)[1].strip()
        if not claimed_by:
            sys.exit(0)
        if host in claimed_by:
            sys.exit(0)
        age_s = time.time() - os.path.getmtime(card)
        if age_s > 1800:
            sys.exit(0)
        skip_reason = "skip: claimed by {}".format(claimed_by)
    except Exception:
        sys.exit(0)
print(skip_reason or "skip: all ready_for_work cards cross-claimed")
sys.exit(1)
PYEOF
    )
    _cross_exit=$?
    if [ "$_cross_exit" -ne 0 ]; then
      echo "[$(date +%H:%M)] GATE-SKIP work [${HOST}] (${_cross_msg})" >> "$TICK_LOG"
      _skip_ts=$(date +%Y%m%d-%H%M%S)
      _skip_iso=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)
      cat > "$RUNS_DIR/${task_id}-${_skip_ts}.json" <<EOF
{
  "run_id": "${task_id}-${_skip_ts}",
  "agent": "${agent_id}",
  "task": "${task_id}",
  "host": "${HOST}",
  "started_at": "${_skip_iso}",
  "finished_at": "${_skip_iso}",
  "status": "gate_skipped",
  "exit_code": 0,
  "reason": "${_cross_msg}"
}
EOF
      continue
    fi
  fi

  # Dry-run：只打日志不启动
  if [ "$PIOS_DRY_RUN" = "1" ]; then
    echo "[$(date +%H:%M)] DRYRUN would-run ${task_id} reason=${_run_reason} [${HOST}]" >> "$TICK_LOG"
    [ "$_run_reason" != "normal" ] && CATCH_UP_COUNT=$((CATCH_UP_COUNT + 1))
    continue
  fi

  # 抢锁
  try_acquire_lock "$task_id" || continue

  # catch-up 计数递增（在锁之后，保证真正起来才计数）
  [ "$_run_reason" != "normal" ] && CATCH_UP_COUNT=$((CATCH_UP_COUNT + 1))

  SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
  if [ "$_run_reason" = "normal" ]; then
    echo "[$(date +%H:%M)] START ${task_id} (agent=${agent_id}, runtime=${runtime}) [${HOST}]" >> "$TICK_LOG"
  else
    echo "[$(date +%H:%M)] START ${task_id} (agent=${agent_id}, runtime=${runtime}) [${HOST}] CATCHUP missed=${_missed_ts} age=${_age_min}min" >> "$TICK_LOG"
  fi

  (
    task_log="$LOG_DIR/${task_id}-${TODAY}-${HOST}.log"
    echo "[$(date)] [${HOST}] START: ${task_id} (agent=${agent_id})" >> "$task_log"

    # per-task timeout 覆盖（pios.yaml timeout_sec 字段）
    [ -n "$task_timeout_sec" ] && [ "$task_timeout_sec" != "-" ] && \
      export ADAPTER_TIMEOUT_SEC="$task_timeout_sec"

    # 检查 prompt 文件是否存在
    prompt_file="$VAULT/Pi/Config/$prompt_path"
    if [ -f "$prompt_file" ]; then
      # --task 模式：adapter 参数顺序 = taskId sessionId logFile promptFile
      "$ADAPTER" --task "$task_id" "$SESSION_ID" "$task_log" "$prompt_file"
    else
      # 无 prompt 文件：用 SOUL + 默认指令
      soul_file="$VAULT/Pi/Config/$soul_path"
      soul_content=""
      [ -f "$soul_file" ] && soul_content=$(cat "$soul_file")

      full_prompt="你是 ${agent_id}，PiOS Agent。当前机器：${HOST}。

${soul_content}

检查你负责的 Cards（assignee: ${agent_id}），执行可做的任务。
更新 Card 状态，产出写到 Pi/Output/。"

      allowed_tools="Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch"
      "$ADAPTER" "$runtime" "$full_prompt" "$allowed_tools" "$task_log" "$agent_id"
    fi
    exit_code=$?

    echo "[$(date)] [${HOST}] END: ${task_id} (exit=$exit_code)" >> "$task_log"
    release_lock "$task_id"
    echo "[$(date +%H:%M)] END ${task_id} [${HOST}] (exit=$exit_code)" >> "$TICK_LOG"
  ) &

done <<< "$TASK_LIST"

# ── 紧急 Card 检查（due 在 24h 内的 card 唤醒 assignee）──

check_urgent_cards() {
  local cards_dir="$VAULT/Cards/active"
  [ -d "$cards_dir" ] || return 0

  local tomorrow
  tomorrow=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d 2>/dev/null)
  [ -z "$tomorrow" ] && return 0

  for card in "$cards_dir"/*.md; do
    [ -f "$card" ] || continue
    [[ "$(basename "$card")" == *".sync-conflict-"* ]] && continue
    local due
    due=$(grep '^due:' "$card" 2>/dev/null | awk '{print $2}')
    [ -z "$due" ] && continue

    if [[ "$due" < "$tomorrow" ]] || [[ "$due" == "$tomorrow" ]]; then
      local assignee
      assignee=$(grep '^assignee:' "$card" 2>/dev/null | awk '{print $2}')
      [ -z "$assignee" ] && continue

      # 检查今天是否已有 run record
      if ls "$VAULT/Pi/State/runs/${assignee}-${TODAY//-/}"*.json &>/dev/null; then
        continue
      fi

      echo "[$(date +%H:%M)] URGENT: $(basename "$card" .md) due=$due assignee=$assignee [${HOST}]" >> "$TICK_LOG"
      # 直接用 adapter 跑该 agent 的 SOUL + card 指令
      local soul_path
      local _agent_info
      _agent_info=$($PYAML -c "
import yaml
m = yaml.safe_load(open('$MANIFEST'))
a = m.get('agents',{}).get('$assignee',{})
print(a.get('soul','') + '\t' + a.get('runtime','claude-cli'))
" 2>/dev/null)
      soul_path=$(echo "$_agent_info" | cut -f1)
      local urgent_runtime
      urgent_runtime=$(echo "$_agent_info" | cut -f2)
      urgent_runtime="${urgent_runtime:-claude-cli}"
      if [ -n "$soul_path" ] && [ -f "$VAULT/Pi/Config/$soul_path" ]; then
        try_acquire_lock "$assignee-urgent" || continue
        (
          local soul_content=$(cat "$VAULT/Pi/Config/$soul_path")
          local urgent_prompt="你是 ${assignee}，PiOS Agent。紧急任务：$(basename "$card" .md) 即将到期（due=$due）。
${soul_content}
读取并执行这张卡片。"
          "$ADAPTER" "$urgent_runtime" "$urgent_prompt" "Read,Write,Edit,Bash,Glob,Grep" "$LOG_DIR/${assignee}-${TODAY}-${HOST}.log" "$assignee"
          release_lock "$assignee-urgent"
        ) &
      fi
    fi
  done
}

check_urgent_cards

# ── Infra tasks（非 AI，纯脚本）──────────────────────

INFRA_TASKS=$($PYAML -c "
import yaml
m = yaml.safe_load(open('$MANIFEST'))
infra = m.get('infra', {}).get('infra-tasks', {})
for tid, task in infra.items():
    enabled = str(task.get('enabled', True)).lower()
    trigger = task.get('trigger', {})
    cron = trigger.get('cron', '')
    host = task.get('host', 'any')
    script = task.get('script', '')
    print(f'{tid}\t{enabled}\t{cron}\t{host}\t{script}')
" 2>>"$TICK_LOG")

while IFS=$'\t' read -r tid enabled cron ihost script; do
  [ -z "$tid" ] && continue
  [ "$enabled" != "true" ] && continue
  [ -z "$cron" ] && continue
  if [ -n "$ihost" ] && [ "$ihost" != "any" ] && [ "$ihost" != "$HOST" ]; then
    continue
  fi
  cron_matches "$cron" || continue
  script_path="$VAULT/$script"
  [ -f "$script_path" ] || continue

  echo "[$(date +%H:%M)] INFRA ${tid} [${HOST}]" >> "$TICK_LOG"
  case "$script_path" in
    *.py) /usr/bin/env python3 "$script_path" >> "$LOG_DIR/${tid}-${TODAY}-${HOST}.log" 2>&1 & ;;
    *)    bash "$script_path" >> "$LOG_DIR/${tid}-${TODAY}-${HOST}.log" 2>&1 & ;;
  esac
done <<< "$INFRA_TASKS"
