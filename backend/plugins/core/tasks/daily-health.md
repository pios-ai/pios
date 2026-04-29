---
taskId: daily-health
cron: '40 0 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 采集并汇总昨日健康数据。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires:
  - health
budget: medium
last_run: null
last_session_id: null
---

从 Health 数据源生成 `{vault}/{owner}/Pipeline/AI_Health_Digest/daily_health/{target_date}.md`。

先做幂等检查：若目标文件已存在则跳过；若数据源缺失，写明缺口后退出。
