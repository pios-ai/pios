#!/bin/bash
# vault-snapshot.sh — 每日增量快照 PiOS，hardlink 节省空间，保留30天
# 由 scheduled task 每日 03:00 调用

set -euo pipefail

VAULT="${PIOS_VAULT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SNAP_BASE="${HOME}/L0_data/vault-snapshots"
TODAY=$(date +%Y-%m-%d)
SNAP_DIR="$SNAP_BASE/$TODAY"
LOG="/tmp/vault-snapshot.log"
RETAIN_DAYS=30

# 找到最近一次快照用于 --link-dest（hardlink 未变文件）
LATEST=$(ls -1d "$SNAP_BASE"/20??-??-?? 2>/dev/null | sort | tail -1 || true)
LINK_DEST=""
if [ -n "$LATEST" ] && [ "$LATEST" != "$SNAP_DIR" ]; then
    LINK_DEST="--link-dest=$LATEST"
fi

mkdir -p "$SNAP_DIR"

# 排除大文件/非核心目录
/usr/bin/rsync -a --delete \
    --exclude='.git/' \
    --exclude='**/venv/' \
    --exclude='**/.venv/' \
    --exclude='**/node_modules/' \
    --exclude='**/__pycache__/' \
    --exclude='**/db_storage_copy/' \
    --exclude='**/videos/' \
    --exclude='Projects/voice-companion/kokoro-multi-lang-v1_1/' \
    --exclude='Projects/voice-companion/vits-melo-tts-zh_en/' \
    --exclude='Projects/voice-companion/kokoro-multi-lang-v1_1.tar.bz2' \
    --exclude='Projects/mac-echo/src/macecho/tts/kokoro/' \
    --exclude='owner/Personal/Attachments/' \
    --exclude='.DS_Store' \
    $LINK_DEST \
    "$VAULT/" "$SNAP_DIR/"

# 清理超过30天的快照
find "$SNAP_BASE" -maxdepth 1 -type d -name "20??-??-??" -mtime +$RETAIN_DAYS -exec rm -rf {} \;

# 大文件告警：扫描 vault 内 >50MB 的文件
LARGE_FILES=$(find "$VAULT" -type f -size +50M \
    -not -path '*/.git/*' \
    -not -path '*/venv/*' \
    -not -path '*/.venv/*' \
    -not -path '*/node_modules/*' \
    -not -path '*/kokoro*' \
    -not -path '*/Attachments/*' \
    -not -path '*/videos/*' \
    2>/dev/null || true)

if [ -n "$LARGE_FILES" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: large files in vault:" >> "$LOG"
    echo "$LARGE_FILES" >> "$LOG"
fi

SNAP_SIZE=$(du -sh "$SNAP_DIR" | cut -f1)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] snapshot=$TODAY size=$SNAP_SIZE link_dest=${LATEST:-none} exit=0" >> "$LOG"
