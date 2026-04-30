---
taskId: daily-photo-diary
cron: '58 23 * * *'
engines:
  - claude-cli
  - codex-cli
enabled: true
needs_browser: true
description: 读取昨日照片并生成照片日记。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch'
permission_mode: default
requires:
  - photos
budget: medium
last_run: null
last_session_id: null
---

读取昨日照片与相关上下文，写入 `{vault}/{owner}/Pipeline/AI_Photo_Digest/daily_photo/{target_date}.md`。

先做幂等检查：若目标文件已存在则跳过。
