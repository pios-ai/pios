#!/usr/bin/env bash
# memory-reconcile.sh — 双向同步 ~/.claude/.../memory/ ↔ Pi/Memory/worker/
#
# Single-source-of-truth: Pi/Memory/worker/ (走 Syncthing 跨机一致)
# Local cache:           ~/.claude/projects/{key}/memory/ (Claude Code worker 读写)
#
# 机制：rsync --update 双向，mtime 新者胜，幂等可重跑
# 调用：fswatch watcher 触发 + 02:45 cron 兜底
#
# Usage: memory-reconcile.sh [--dry-run] [--verbose]

set -euo pipefail

VAULT="${VAULT:-$HOME/PiOS}"
WORKER_MEM="$VAULT/Pi/Memory/worker"
LOG="$VAULT/Pi/Log/memory-reconcile.log"
HOST=$(hostname -s)

# Derive Claude Code memory path from VAULT (project key = vault path with / and _ → -)
CLAUDE_KEY=$(echo "$VAULT" | sed 's|^/|-|; s|/|-|g; s|_|-|g')
CLAUDE_MEM="$HOME/.claude/projects/$CLAUDE_KEY/memory"

DRY=""
VERBOSE=""
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY="--dry-run" ;;
        --verbose) VERBOSE="-v" ;;
    esac
done

log() {
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "[$ts $HOST] $*" >> "$LOG"
    [ -n "$VERBOSE" ] && echo "[$ts $HOST] $*"
}

mkdir -p "$WORKER_MEM" "$CLAUDE_MEM" "$(dirname "$LOG")"

# Early exit: if both dirs have identical .md content, skip rsync entirely
# (prevents launchd WatchPaths from being self-triggered by rsync's attribute touches)
NEEDS_SYNC=0
for f in "$CLAUDE_MEM"/*.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    if [ ! -f "$WORKER_MEM/$base" ] || ! cmp -s "$f" "$WORKER_MEM/$base"; then
        NEEDS_SYNC=1
        break
    fi
done
if [ "$NEEDS_SYNC" = "0" ]; then
    for f in "$WORKER_MEM"/*.md; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        if [ ! -f "$CLAUDE_MEM/$base" ]; then
            NEEDS_SYNC=1
            break
        fi
    done
fi

if [ "$NEEDS_SYNC" = "1" ]; then
    # Direction 1: ~/.claude → worker
    rsync -rt --update $DRY \
        --include='*.md' --exclude='*' \
        "$CLAUDE_MEM/" "$WORKER_MEM/" >/dev/null 2>&1 || true

    # Direction 2: worker → ~/.claude
    rsync -rt --update $DRY \
        --include='*.md' --exclude='*' \
        "$WORKER_MEM/" "$CLAUDE_MEM/" >/dev/null 2>&1 || true

    SYNC_NOTE="synced"
else
    SYNC_NOTE="noop"
fi

# Count files (post-reconcile)
COUNT_W=$(find "$WORKER_MEM" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
COUNT_C=$(find "$CLAUDE_MEM" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')

if [ "$COUNT_W" = "$COUNT_C" ]; then
    # Only log when actually doing work, not noops
    if [ "$SYNC_NOTE" = "synced" ] || [ -n "$VERBOSE" ]; then
        log "OK  worker=$COUNT_W claude=$COUNT_C $SYNC_NOTE ${DRY:-(live)}"
    fi
else
    log "DRIFT worker=$COUNT_W claude=$COUNT_C $SYNC_NOTE — investigate"
fi

# Trim log (keep last 1000 lines)
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
    tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
