#!/bin/bash
# Pi Security Audit Hook
# 用途：作为 Claude Code postToolUse hook，记录所有 Bash 命令到审计日志
# 注册方式：在 ~/.claude/settings.json 的 hooks.postToolUse 中添加此脚本
#
# Hook 环境变量（Claude Code 传入）：
#   CLAUDE_TOOL_NAME  — 工具名（Bash, Read, Write, Edit 等）
#   CLAUDE_TOOL_INPUT — 工具输入（JSON）
#   CLAUDE_SESSION_ID — 会话 ID

AUDIT_LOG="$HOME/PiOS/Pi/Log/audit.log"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

# 只记录 Bash 工具调用（最高风险）
if [ "$CLAUDE_TOOL_NAME" = "Bash" ]; then
    # 提取命令（从 JSON 输入中取 command 字段）
    CMD=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command','<parse-error>'))" 2>/dev/null || echo "<parse-error>")
    echo "$TIMESTAMP | session:${CLAUDE_SESSION_ID:-unknown} | BASH | $CMD" >> "$AUDIT_LOG"
fi

# 也记录 Write 工具（文件创建/覆盖）
if [ "$CLAUDE_TOOL_NAME" = "Write" ]; then
    FILE=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path','<parse-error>'))" 2>/dev/null || echo "<parse-error>")
    echo "$TIMESTAMP | session:${CLAUDE_SESSION_ID:-unknown} | WRITE | $FILE" >> "$AUDIT_LOG"
fi

# 记录 Edit 工具（文件修改）
if [ "$CLAUDE_TOOL_NAME" = "Edit" ]; then
    FILE=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path','<parse-error>'))" 2>/dev/null || echo "<parse-error>")
    echo "$TIMESTAMP | session:${CLAUDE_SESSION_ID:-unknown} | EDIT | $FILE" >> "$AUDIT_LOG"
fi
