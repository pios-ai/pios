---
taskId: token-daily-summary
cron: 2 3 * * *
engines:
  - claude-cli
enabled: true
agent: pi
description: Token 使用日报
budget: low
permission_mode: default
allowed_tools: ''
last_session_id: e280bc64-bde6-49d9-9094-ad07e5351a4e
---

你是 maintenance agent 的 token 日报模块。

## 执行步骤

1. 读取 `Pi/Log/auth-status.json`，获取当前 token 使用情况
2. 读取 `Pi/State/runs/` 最近 24h 的 run records，统计各 agent 的 token 消耗
3. 生成简报写入 `Pi/Log/token-summary-$(date +%Y-%m-%d).md`
4. 如果某个窗口用量 > 80%：`bash {vault}/Pi/Tools/notify.sh critical "Token 用量告警：{窗口} 已用 {百分比}%"`
