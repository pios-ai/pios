#!/bin/bash
# 微信数据库定时同步到普通目录，避免 macOS Containers 权限弹窗
# 由 launchd 每小时执行一次

WECHAT_USER_DIR="${WECHAT_USER_DIR:-<your-wxid>}"
SRC="${HOME}/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/${WECHAT_USER_DIR}/db_storage/"
DST="${WECHAT_DB_DIR:-${HOME}/L0_data/wechat-db/}"

mkdir -p "$DST"
/usr/bin/rsync -a --delete "$SRC" "$DST" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] sync done, exit=$?" >> /tmp/wechat-db-sync.log
