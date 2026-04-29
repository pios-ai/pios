#!/bin/bash
# Pi Security Anomaly Scanner
# 用途：扫描审计日志，检测可疑操作，由 pi-maintenance 定期调用
# 返回值：0=正常，1=发现异常（异常详情写入 stdout）

AUDIT_LOG="$HOME/PiOS/Pi/Log/audit.log"
FOUND_ANOMALY=0
ALERTS=""

if [ ! -f "$AUDIT_LOG" ]; then
    echo "审计日志不存在，跳过扫描"
    exit 0
fi

# 只扫描最近 24 小时的日志（按日期过滤）
YESTERDAY=$(date -v-1d "+%Y-%m-%d" 2>/dev/null || date -d "yesterday" "+%Y-%m-%d" 2>/dev/null)
TODAY=$(date "+%Y-%m-%d")

# 规则 1：读取 SSH 私钥
if grep -E "BASH.*\.(ssh/(id_rsa|id_ed25519|id_ecdsa)|\.pem)" "$AUDIT_LOG" | grep -E "($TODAY|$YESTERDAY)" > /dev/null 2>&1; then
    ALERTS="$ALERTS\n⚠️ 检测到读取 SSH 私钥的操作"
    FOUND_ANOMALY=1
fi

# 规则 2：向外部发送敏感数据
if grep -E "BASH.*(curl|wget).*(-d|-X POST|--data).*\b(key|token|password|secret|api_key|API_KEY)\b" "$AUDIT_LOG" | grep -E "($TODAY|$YESTERDAY)" > /dev/null 2>&1; then
    ALERTS="$ALERTS\n⚠️ 检测到可能泄露密钥的外部请求"
    FOUND_ANOMALY=1
fi

# 规则 3：git push 到非已知 remote
if grep -E "BASH.*git push" "$AUDIT_LOG" | grep -v -E "(origin|upstream)" | grep -E "($TODAY|$YESTERDAY)" > /dev/null 2>&1; then
    ALERTS="$ALERTS\n⚠️ 检测到 git push 到未知 remote"
    FOUND_ANOMALY=1
fi

# 规则 4：破坏性命令
if grep -E "BASH.*(rm -rf /|dd if=|mkfs\.|> /dev/)" "$AUDIT_LOG" | grep -E "($TODAY|$YESTERDAY)" > /dev/null 2>&1; then
    ALERTS="$ALERTS\n⚠️ 检测到破坏性命令"
    FOUND_ANOMALY=1
fi

# 规则 5：修改系统文件
if grep -E "BASH.*(EDIT|WRITE).*/etc/|\.zshrc|\.bashrc|\.bash_profile" "$AUDIT_LOG" | grep -E "($TODAY|$YESTERDAY)" > /dev/null 2>&1; then
    ALERTS="$ALERTS\n⚠️ 检测到修改系统配置文件"
    FOUND_ANOMALY=1
fi

# 规则 6：读取 .env 文件并外发
if grep -E "BASH.*cat.*\.env" "$AUDIT_LOG" | grep -E "($TODAY|$YESTERDAY)" > /dev/null 2>&1; then
    # 检查同一会话是否有 curl/wget
    SESSION=$(grep -E "BASH.*cat.*\.env" "$AUDIT_LOG" | grep -E "($TODAY|$YESTERDAY)" | head -1 | grep -oE "session:[^ |]*")
    if [ -n "$SESSION" ] && grep -E "$SESSION.*(curl|wget)" "$AUDIT_LOG" > /dev/null 2>&1; then
        ALERTS="$ALERTS\n🚨 高危：读取 .env 后同会话有外部请求"
        FOUND_ANOMALY=1
    fi
fi

if [ $FOUND_ANOMALY -eq 1 ]; then
    echo -e "安全异常检测结果：$ALERTS"
    bash "${PIOS_VAULT:-$HOME/PiOS}/Pi/Tools/notify.sh" critical "Pi 安全扫描发现异常操作，请检查 audit.log"
    exit 1
else
    echo "安全扫描完成，未发现异常"
    exit 0
fi
