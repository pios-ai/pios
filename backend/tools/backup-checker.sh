#!/bin/bash
# Pi Backup Health Checker
# 用途：检查 Syncthing 和 Time Machine 是否在运行，由 pi-maintenance 定期调用
# 返回值：0=健康，1=需要关注

ISSUES=""

# 检查 Syncthing 是否运行
if ! pgrep -x "syncthing" > /dev/null 2>&1; then
    ISSUES="$ISSUES\n⚠️ Syncthing 未运行"
fi

# 检查 Time Machine 最近一次备份
TM_LATEST=$(tmutil latestbackup 2>/dev/null)
if [ -z "$TM_LATEST" ]; then
    ISSUES="$ISSUES\n⚠️ 无法获取 Time Machine 最近备份信息"
else
    # 提取备份时间戳（格式：/Volumes/.../2026-04-05-123456.backup）
    TM_DATE=$(basename "$TM_LATEST" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
    if [ -n "$TM_DATE" ]; then
        TM_EPOCH=$(date -j -f "%Y-%m-%d" "$TM_DATE" "+%s" 2>/dev/null)
        NOW_EPOCH=$(date "+%s")
        DIFF_HOURS=$(( (NOW_EPOCH - TM_EPOCH) / 3600 ))
        if [ "$DIFF_HOURS" -gt 24 ]; then
            ISSUES="$ISSUES\n⚠️ Time Machine 最近备份超过 24 小时（${DIFF_HOURS}h 前）"
        fi
    fi
fi

if [ -n "$ISSUES" ]; then
    echo -e "备份健康检查：$ISSUES"
    bash "${PIOS_VAULT:-$HOME/PiOS}/Pi/Tools/notify.sh" critical "备份异常：请检查 Syncthing 和 Time Machine"
    exit 1
else
    echo "备份健康检查通过：Syncthing 运行中，Time Machine 备份正常"
    exit 0
fi
