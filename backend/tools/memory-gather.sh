#!/usr/bin/env bash
# memory-gather.sh — 每日 audit + OpenClaw 引擎归集
#
# 2026-04-24 重构后：Claude Code memory 由 launchd com.pios.memory-reconcile
# 实时同步（< 5s），本脚本不再做 Claude Code 拷贝。
#
# 仍保留：
#   1. OpenClaw workspace memory → Pi/Memory/openclaw/ （单引擎，无 watcher）
#   2. Audit：对比 ~/.claude/.../memory/ 与 Pi/Memory/worker/ 一致性
#   3. 把 audit 结果写到 healthcheck-report.md
#
# Usage: memory-gather.sh [--dry-run]

set -euo pipefail

VAULT="${VAULT:-$HOME/PiOS}"
DEST_BASE="$VAULT/Pi/Memory"
WORKER_MEM="$DEST_BASE/worker"
LOG="$VAULT/Pi/Log/cleanup-log.md"
HEALTH="$VAULT/Pi/healthcheck-report.md"
DATE=$(date +%Y-%m-%d)
HOSTNAME=$(hostname -s)
DRY_RUN="${1:-}"

CLAUDE_KEY=$(echo "$VAULT" | sed 's|^/|-|; s|/|-|g; s|_|-|g')
CLAUDE_MEM="$HOME/.claude/projects/$CLAUDE_KEY/memory"

log() {
    echo "[memory-gather $DATE $HOSTNAME] $*" | tee -a "$LOG"
}

# --- 1. OpenClaw memory copy (no watcher for this engine) ---
for dir in "$HOME/.openclaw/workspace/memory" "$HOME/openclaw/workspace/memory"; do
    [ -d "$dir" ] || continue
    for f in "$dir"/*.md; do
        [ -f "$f" ] || continue
        fname=$(basename "$f")
        dest="$DEST_BASE/openclaw/$fname"
        if [ -f "$dest" ] && diff -q "$f" "$dest" >/dev/null 2>&1; then
            continue
        fi
        if [ -f "$dest" ]; then
            dest="${dest%.md}-$HOSTNAME.md"
            log "OpenClaw conflict, writing $dest"
        fi
        if [ "$DRY_RUN" = "--dry-run" ]; then
            log "DRY: $f -> $dest"
        else
            mkdir -p "$(dirname "$dest")"
            cp "$f" "$dest"
            log "Gathered openclaw: $fname"
        fi
    done
done

# --- 2. Audit: ~/.claude vs Pi/Memory/worker ---
WORKER_COUNT=0
CLAUDE_COUNT=0
DRIFT_FILES=""
ONLY_WORKER=""
ONLY_CLAUDE=""
AUDIT_SKIPPED=0

if [ -d "$WORKER_MEM" ]; then
    WORKER_COUNT=$(find "$WORKER_MEM" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
fi

# Audit only meaningful on hosts that actually run Claude Code workers (~/.claude memory exists)
if [ -d "$CLAUDE_MEM" ] && [ "$(find "$CLAUDE_MEM" -maxdepth 1 -name '*.md' 2>/dev/null | head -1)" ]; then
    CLAUDE_COUNT=$(find "$CLAUDE_MEM" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

    for f in "$WORKER_MEM"/*.md; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        if [ ! -f "$CLAUDE_MEM/$base" ]; then
            ONLY_WORKER="$ONLY_WORKER $base"
        elif ! cmp -s "$f" "$CLAUDE_MEM/$base"; then
            DRIFT_FILES="$DRIFT_FILES $base"
        fi
    done
    for f in "$CLAUDE_MEM"/*.md; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        if [ ! -f "$WORKER_MEM/$base" ]; then
            ONLY_CLAUDE="$ONLY_CLAUDE $base"
        fi
    done
else
    AUDIT_SKIPPED=1
fi

# --- 3. Write to healthcheck-report.md (idempotent block replace) ---
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$AUDIT_SKIPPED" = "1" ]; then
    STATUS="SKIP"
    DETAIL="vault-only host (no ~/.claude memory) · worker=$WORKER_COUNT"
else
    STATUS="OK"
    DETAIL="worker=$WORKER_COUNT claude=$CLAUDE_COUNT"
    if [ -n "$DRIFT_FILES$ONLY_WORKER$ONLY_CLAUDE" ]; then
        STATUS="DRIFT"
        [ -n "$DRIFT_FILES" ] && DETAIL="$DETAIL · drift:$(echo $DRIFT_FILES | wc -w | tr -d ' ')"
        [ -n "$ONLY_WORKER" ] && DETAIL="$DETAIL · only-worker:$(echo $ONLY_WORKER | wc -w | tr -d ' ')"
        [ -n "$ONLY_CLAUDE" ] && DETAIL="$DETAIL · only-claude:$(echo $ONLY_CLAUDE | wc -w | tr -d ' ')"
    fi
fi

if [ -f "$HEALTH" ] && [ "$DRY_RUN" != "--dry-run" ]; then
    MARKER_START="<!-- MEMORY-AUDIT-$HOSTNAME-START -->"
    MARKER_END="<!-- MEMORY-AUDIT-$HOSTNAME-END -->"
    BLOCK="${MARKER_START}
**Memory audit ($HOSTNAME @ $TS)**: $STATUS — $DETAIL
${MARKER_END}"

    if grep -q "$MARKER_START" "$HEALTH" 2>/dev/null; then
        awk -v start="$MARKER_START" -v end="$MARKER_END" -v block="$BLOCK" '
            $0 == start { in_block=1; print block; next }
            $0 == end { in_block=0; next }
            !in_block { print }
        ' "$HEALTH" > "$HEALTH.tmp" && mv "$HEALTH.tmp" "$HEALTH"
    else
        echo "" >> "$HEALTH"
        echo "$BLOCK" >> "$HEALTH"
    fi
fi

log "Audit: $STATUS · $DETAIL"
[ -n "$DRIFT_FILES" ] && log "  drift:$DRIFT_FILES"
[ -n "$ONLY_WORKER" ] && log "  only-worker:$ONLY_WORKER"
[ -n "$ONLY_CLAUDE" ] && log "  only-claude:$ONLY_CLAUDE"
log "Done."
