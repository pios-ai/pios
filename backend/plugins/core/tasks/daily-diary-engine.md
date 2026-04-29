---
taskId: daily-diary-engine
cron: '30 1 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 聚合全部 pipeline 产物，生成每日日记。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

读取 `{vault}/{owner}/Pipeline/` 下的最新产物、`{vault}/Pi/Owner_Status.md` 与关键系统日志，写入 `{vault}/{owner}/Personal/Daily/{target_date}.md`。

先做幂等检查：若目标文件已存在则跳过。
