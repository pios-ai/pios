---
taskId: daily-ai-diary
cron: '7 0 * * *'
engines:
  - claude-cli
enabled: true
needs_browser: false
description: 生成昨日 AI 对话日记。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

总结昨天在 PiBrowser 和 CLI 上产生的 AI 对话，写入 `{vault}/{owner}/Pipeline/AI_Conversation_Digest/daily_ai/{target_date}.md`。

先做幂等检查：若目标文件已存在则跳过。
若缺数据源，记录缺口并继续处理其他可读输入。
