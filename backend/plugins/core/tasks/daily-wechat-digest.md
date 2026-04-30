---
taskId: daily-wechat-digest
cron: '7 0 * * *'
engines:
  - codex-cli
  - claude-cli
enabled: true
needs_browser: false
description: 提取昨日微信消息并生成摘要。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires:
  - wechat
budget: medium
last_run: null
last_session_id: null
---

从本机微信数据提取昨日私聊消息，生成 `{vault}/{owner}/Pipeline/AI_Wechat_Digest/daily_wechat/{target_date}.md`。

先做幂等检查：若目标文件已存在则跳过。
