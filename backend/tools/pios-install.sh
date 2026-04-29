#!/bin/bash
# pios-install.sh — PiOS Installer for new users
#
# Creates a Vault directory with all necessary structure, installs core plugin,
# and sets up pios-tick cron job.
#
# Usage:
#   pios-install.sh [VAULT_PATH]
#   VAULT_PATH defaults to ~/PiOS-Vault

set -euo pipefail

# ── Config ──────────────────────────────────────────────
INSTALLER_DIR="$(cd "$(dirname "$0")" && pwd)"
PIOS_ROOT="$(cd "$INSTALLER_DIR/../.." && pwd)"
VAULT="${1:-$HOME/PiOS-Vault}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[pios]${NC} $*"; }
ok()    { echo -e "${GREEN}[pios]${NC} $*"; }
warn()  { echo -e "${YELLOW}[pios]${NC} $*"; }
fail()  { echo -e "${RED}[pios]${NC} $*"; exit 1; }

# ── Prerequisites ───────────────────────────────────────
info "Checking prerequisites..."

command -v python3 >/dev/null 2>&1 || fail "python3 not found. Install Python 3.9+."
command -v bash    >/dev/null 2>&1 || fail "bash not found."

python3 -c "import yaml" 2>/dev/null || {
  warn "PyYAML not found. Installing..."
  pip3 install --user pyyaml || fail "Failed to install pyyaml. Run: pip3 install pyyaml"
}

# ── Engine auto-detection ──────────────────────────────
info "Detecting AI engines..."

DETECTED_ENGINES=""
DEFAULT_ENGINE=""

if command -v claude >/dev/null 2>&1; then
  DETECTED_ENGINES="${DETECTED_ENGINES} claude-cli"
  DEFAULT_ENGINE="claude-cli"
  ok "  ✓ Claude CLI found: $(which claude)"
fi

if command -v openclaw >/dev/null 2>&1; then
  DETECTED_ENGINES="${DETECTED_ENGINES} openclaw"
  [ -z "$DEFAULT_ENGINE" ] && DEFAULT_ENGINE="openclaw"
  ok "  ✓ OpenClaw found: $(which openclaw)"
fi

if command -v codex >/dev/null 2>&1; then
  DETECTED_ENGINES="${DETECTED_ENGINES} codex-cli"
  [ -z "$DEFAULT_ENGINE" ] && DEFAULT_ENGINE="codex-cli"
  ok "  ✓ Codex CLI found: $(which codex)"
fi

if [ -z "$DETECTED_ENGINES" ]; then
  fail "No AI engine found. Install at least one:\n  - Claude CLI: https://docs.anthropic.com/en/docs/claude-code\n  - OpenClaw: https://openclaw.ai\n  - Codex CLI: https://openai.com/codex"
fi

ok "Default engine: $DEFAULT_ENGINE"

# ── Owner name ──────────────────────────────────────────
OWNER_NAME=""
if [ -d "$VAULT/Pi" ]; then
  # Re-run: read existing owner from pios.yaml
  OWNER_NAME=$(python3 -c "import yaml; print(yaml.safe_load(open('$VAULT/Pi/Config/pios.yaml')).get('owner',''))" 2>/dev/null || true)
fi
if [ -z "$OWNER_NAME" ]; then
  DEFAULT_OWNER=$(python3 -c "import os; n=os.environ.get('USER',''); print(n.capitalize() if n else 'User')" 2>/dev/null || echo "User")
  echo ""
  read -p "$(echo -e "${BLUE}[pios]${NC} Your display name (used for personalization) [${DEFAULT_OWNER}]: ")" OWNER_INPUT
  OWNER_NAME="${OWNER_INPUT:-$DEFAULT_OWNER}"
fi
ok "Owner: $OWNER_NAME"

# ── Vault creation ──────────────────────────────────────
if [ -d "$VAULT/Pi" ]; then
  warn "Vault already exists at $VAULT"
  warn "Re-running installer will only add missing files (won't overwrite)."
fi

info "Creating Vault at $VAULT ..."

# Core directories
mkdir -p "$VAULT/Pi/Config"
mkdir -p "$VAULT/Pi/Tools"
mkdir -p "$VAULT/Pi/Log/cron"
mkdir -p "$VAULT/Pi/State/runs"
mkdir -p "$VAULT/Pi/State/locks"
mkdir -p "$VAULT/Pi/Agents/intel/workspace"
mkdir -p "$VAULT/Pi/Agents/creator/workspace"
mkdir -p "$VAULT/Pi/Output/infra"
mkdir -p "$VAULT/Pi/Inbox"
mkdir -p "$VAULT/Pi/Agents"
mkdir -p "$VAULT/Pi/Plugins"
mkdir -p "$VAULT/Cards/inbox"
mkdir -p "$VAULT/Cards/active"
mkdir -p "$VAULT/Cards/archive"
mkdir -p "$VAULT/Pipeline"
mkdir -p "$VAULT/Personal/Daily"
mkdir -p "$VAULT/Personal/Profile"
# Owner-namespaced Pipeline dirs (tasks reference {owner}/Pipeline/...)
mkdir -p "$VAULT/$OWNER_NAME/Pipeline/AI_Conversation_Digest/daily_ai"
mkdir -p "$VAULT/$OWNER_NAME/Pipeline/sleep-log"

ok "Directory structure created"

# ── Copy core scripts ───────────────────────────────────
info "Installing core scripts..."

for script in pios-tick.sh pios-adapter.sh pios-plugin.sh notify.sh; do
  src="$PIOS_ROOT/Pi/Tools/$script"
  dest="$VAULT/Pi/Tools/$script"
  if [ -f "$src" ] && [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    chmod +x "$dest"
    ok "  + $script"
  elif [ -f "$dest" ]; then
    echo "  ~ $script (exists)"
  else
    warn "  ! $script not found in source"
  fi
done

# Copy utility scripts from core plugin
CORE_PLUGIN="$PIOS_ROOT/Pi/Plugins/core"
if [ -d "$CORE_PLUGIN/scripts" ]; then
  for src in "$CORE_PLUGIN/scripts"/*; do
    [ -f "$src" ] || continue
    scriptfile=$(basename "$src")
    dest="$VAULT/Pi/Tools/$scriptfile"
    if [ ! -f "$dest" ]; then
      cp -L "$src" "$dest"
      chmod +x "$dest" 2>/dev/null
      ok "  + $scriptfile"
    fi
  done
fi

# ── Install core plugin agents + tasks ──────────────────
info "Installing core agents and tasks..."

AGENT_COUNT=0
TASK_COUNT=0

# Copy SOUL files from core plugin
if [ -d "$CORE_PLUGIN/agents" ]; then
  for soul in "$CORE_PLUGIN/agents"/*/SOUL.md; do
    [ -f "$soul" ] || continue
    agent_name=$(basename "$(dirname "$soul")")
    dest_dir="$VAULT/Pi/Agents/$agent_name"
    mkdir -p "$dest_dir/tasks"
    if [ ! -f "$dest_dir/SOUL.md" ]; then
      cp -L "$soul" "$dest_dir/SOUL.md"
      ok "  + agent: $agent_name"
    fi
    AGENT_COUNT=$((AGENT_COUNT + 1))
  done
fi

# Copy task prompts from core plugin
if [ -d "$CORE_PLUGIN/tasks" ]; then
  for src in "$CORE_PLUGIN/tasks"/*.md; do
    [ -f "$src" ] || continue
    taskfile=$(basename "$src")
    task_id="${taskfile%.md}"

    # Find which agent this task belongs to (from plugin.yaml)
    agent_for_task=$(python3 -c "
import yaml
p = yaml.safe_load(open('$CORE_PLUGIN/plugin.yaml'))
for tid, tdef in (p.get('tasks') or {}).items():
    if tid == '$task_id':
        agent = tdef.get('agent', '')
        if agent and agent != 'null':
            print(agent)
        break
" 2>/dev/null)

    if [ -n "$agent_for_task" ]; then
      dest_dir="$VAULT/Pi/Agents/$agent_for_task/tasks"
    else
      dest_dir="$VAULT/Pi/Agents/_infra/tasks"
    fi
    mkdir -p "$dest_dir"
    dest="$dest_dir/$taskfile"
    if [ ! -f "$dest" ]; then
      cp -L "$src" "$dest"
      ok "  + task: $task_id → $agent_for_task"
    fi
    TASK_COUNT=$((TASK_COUNT + 1))
  done
fi

# ── Generate default pios.yaml ──────────────────────────
MANIFEST="$VAULT/Pi/Config/pios.yaml"
if [ ! -f "$MANIFEST" ]; then
  info "Generating pios.yaml..."

  # shellcheck source=lib/host-resolve.sh
  source "$VAULT/Pi/Tools/lib/host-resolve.sh"
  HOST=$(pios_resolve_host)

  python3 -c "
import yaml, os

host = '$HOST'
vault = '$VAULT'
owner = '$OWNER_NAME'
default_engine = '$DEFAULT_ENGINE'
detected_engines = '$DETECTED_ENGINES'.split()

# Build manifest from core plugin.yaml
core_plugin = yaml.safe_load(open('$CORE_PLUGIN/plugin.yaml'))

manifest = {
    'owner': owner,
    'scheduler': 'pios-tick',
    'agents': {},
    'plugins': {
        'core': {
            'enabled': True,
            'path': 'Plugins/core',
        }
    },
    'infra': {
        'runtimes': {e: {'detected': True} for e in detected_engines},
        'default_runtime': default_engine,
        'instances': {
            host: {'capabilities': 'interactive,shell', 'status': 'active'}
        },
        'infra-tasks': {}
    }
}

# Register agents
for agent_id, agent_def in core_plugin.get('agents', {}).items():
    soul_path = f'../Agents/{agent_id}/SOUL.md'
    agent_host = agent_def.get('host', host).replace('{primary}', host).replace('{secondary}', host)
    plugins_list = agent_def.get('plugins', ['vault'])
    manifest['agents'][agent_id] = {
        'name': agent_id,
        'soul': soul_path,
        'plugins': plugins_list,
        'runtime': default_engine,
        'host': agent_host,
        'status': 'active',
        'tasks': {},
    }

# Register tasks
for task_id, task_def in core_plugin.get('tasks', {}).items():
    agent_id = task_def.get('agent')
    cron = task_def.get('cron', '')
    enabled = task_def.get('enabled', True)
    script = task_def.get('script')

    if agent_id and agent_id != 'null' and agent_id in manifest['agents']:
        manifest['agents'][agent_id]['tasks'][task_id] = {
            'enabled': enabled,
            'prompt': f'../Agents/{agent_id}/tasks/{task_id}.md',
            'trigger': {'cron': cron},
        }
    elif script:
        # Infra task (local script, no AI)
        manifest['infra']['infra-tasks'][task_id] = {
            'enabled': enabled,
            'script': f'Pi/Tools/{os.path.basename(script)}',
            'host': host,
            'trigger': {'cron': cron},
        }

with open('$MANIFEST', 'w') as f:
    yaml.dump(manifest, f, default_flow_style=False, allow_unicode=True, width=120)
print('pios.yaml generated')
"
  ok "pios.yaml created with $AGENT_COUNT agents, $TASK_COUNT tasks"
else
  warn "pios.yaml already exists, skipping"
fi

# ── Copy card-spec.md ───────────────────────────────────
CARD_SPEC_SRC="$PIOS_ROOT/Pi/Config/card-spec.md"
CARD_SPEC_DST="$VAULT/Pi/Config/card-spec.md"
if [ -f "$CARD_SPEC_SRC" ] && [ ! -f "$CARD_SPEC_DST" ]; then
  cp "$CARD_SPEC_SRC" "$CARD_SPEC_DST"
  ok "card-spec.md installed"
fi

# ── Create CLAUDE.md ────────────────────────────────────
CLAUDE_MD="$VAULT/CLAUDE.md"
if [ ! -f "$CLAUDE_MD" ]; then
  cat > "$CLAUDE_MD" << 'CLAUDEEOF'
# PiOS — Claude Code Instructions

> Read `Pi/BOOT.md` for context. This file supplements with Claude Code specific behavior.

## Token Monitoring

When conversation slows or shows rate limit warnings, notify:
```bash
bash Pi/Tools/notify.sh critical "Token running low, suggest handoff"
```
CLAUDEEOF
  ok "CLAUDE.md created"
fi

# ── Create BOOT.md ──────────────────────────────────────
BOOT_MD="$VAULT/Pi/BOOT.md"
if [ ! -f "$BOOT_MD" ]; then
  cat > "$BOOT_MD" << 'BOOTEOF'
# PiOS Boot Context

PiOS is a personal AI operating system. Agents run on a schedule (pios-tick.sh)
and coordinate through Cards (inbox → active → archive).

## Key Paths

- `Cards/` — Task and project cards
- `Pi/Config/pios.yaml` — Agent and task definitions
- `Pi/Agents/` — Agent SOUL files and task prompts
- `Pi/Output/` — Agent output files
- `Pi/Tools/` — Scripts and utilities
- `Pi/State/` — Runtime state (locks, runs, gate)
- `Pi/Log/` — Logs

## Card Flow

1. New cards land in `Cards/inbox/`
2. pi-triage triages them to `Cards/active/`
3. Workers execute tasks from `Cards/active/`
4. Done cards move to `Cards/archive/`
BOOTEOF
  ok "BOOT.md created"
fi

# ── Create Profile template ────────────────────────────
PROFILE="$VAULT/Personal/Profile/about.md"
if [ ! -f "$PROFILE" ]; then
  cat > "$PROFILE" << 'PROFEOF'
# About Me

<!-- Fill in your info so PiOS agents can tailor their work to you -->

## Name

<!-- Your name -->

## Role

<!-- e.g., software engineer, designer, student -->

## Current Focus

<!-- What are you working on right now? -->

## Preferences

<!-- How do you prefer to work? Any constraints? -->
PROFEOF
  ok "Profile template created"
fi

# ── Create Owner_Status.md template ───────────────────
OWNER_STATUS="$VAULT/Pi/Owner_Status.md"
if [ ! -f "$OWNER_STATUS" ]; then
  cat > "$OWNER_STATUS" << OWNEREOF
---
updated: $(date +%Y-%m-%d)
owner: $OWNER_NAME
---

# $OWNER_NAME 状态总览

<!-- Updated daily by daily-user-status task. Edit the sections below to reflect your current focus. -->

## 关注方向

<!-- What are you working on right now? What matters most this week? (5-10 lines) -->
- Getting started with PiOS

## 近期思考

<!-- Reflections, ideas, things on your mind -->

## 项目状态

<!-- One-line status for each active project -->

## 生活事件

<!-- Anything significant happening in your life -->
OWNEREOF
  ok "Owner_Status.md template created"
fi

# ── Install core plugin skills ──────────────────────────
if [ -d "$CORE_PLUGIN/skills" ]; then
  SKILLS_DIR="$VAULT/.agents/skills"
  for skill_dir in "$CORE_PLUGIN/skills"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    dest_dir="$SKILLS_DIR/$skill_name"
    if [ ! -d "$dest_dir" ]; then
      mkdir -p "$dest_dir"
      for f in "$skill_dir"*; do
        [ -f "$f" ] && cp -L "$f" "$dest_dir/"
      done
      ok "  + skill: $skill_name"
    fi
  done
fi

# ── Copy dedup-check.py ─────────────────────────────────
DEDUP_SRC="$PIOS_ROOT/Pi/Tools/dedup-check.py"
DEDUP_DST="$VAULT/Pi/Tools/dedup-check.py"
if [ -f "$DEDUP_SRC" ] && [ ! -f "$DEDUP_DST" ]; then
  cp "$DEDUP_SRC" "$DEDUP_DST"
  ok "dedup-check.py installed"
fi

# ── Setup cron ──────────────────────────────────────────
info "Setting up cron..."
CRON_LINE="* * * * * PIOS_VAULT=\"$VAULT\" bash \"$VAULT/Pi/Tools/pios-tick.sh\" >> \"$VAULT/Pi/Log/cron/pios-cron.log\" 2>&1"

if crontab -l 2>/dev/null | grep -qF "pios-tick.sh"; then
  warn "pios-tick.sh already in crontab"
else
  echo ""
  info "Add this to your crontab (crontab -e):"
  echo ""
  echo "  $CRON_LINE"
  echo ""
  read -p "Add to crontab now? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    ok "Cron job added"
  else
    info "Skipped. Add it manually when ready."
  fi
fi

# ── Summary ─────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "PiOS installed at $VAULT"
echo ""
info "Agents:  $AGENT_COUNT (pi-triage, maintenance, sense-maker, pipeline)"
info "Tasks:   $TASK_COUNT"
info "Vault:   $VAULT"
echo ""
info "Next steps:"
echo "  1. Edit $VAULT/Personal/Profile/about.md"
echo "  2. Edit $VAULT/Pi/Owner_Status.md  (your current focus — agents read this)"
echo "  3. Ensure Claude CLI is installed"
echo "  4. Verify cron is running: crontab -l"
echo "  5. Create your first card: Cards/inbox/my-first-task.md"
echo "  6. Install optional plugins: bash $VAULT/Pi/Tools/pios-plugin.sh list"
echo ""
info "Notes:"
echo "  - reminder.sh: optional personal script (place at $VAULT/Pi/Tools/reminder.sh)"
echo "  - optional plugins (e.g. wechat, diary): pios-plugin.sh requires the Plugins/"
echo "    directory from the PiOS repo. Either clone the repo as source, or copy the"
echo "    desired plugin directory into $VAULT/Pi/Plugins/ manually."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
