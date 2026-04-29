---
taskId: daily-world-feed
cron: '0 8 * * *'
engines:
  - codex-cli
  - claude-cli
enabled: true
needs_browser: false
description: 生成每日世界动态摘要。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch'
permission_mode: default
requires:
  - web-search
budget: medium
last_run: null
last_session_id: null
---

抓取外部世界信号，写入 `{vault}/{owner}/Pipeline/AI_World_Digest/{target_date}.md`。

若外部源不可用，记录缺口，不编造内容。
