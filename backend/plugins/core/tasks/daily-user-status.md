---
taskId: daily-user-status
cron: '10 1 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 汇总 pipeline 数据，生成 Owner_Status 面板。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

读取最新 pipeline 产物和 Cards 状态，覆盖写入 `{vault}/Pi/Owner_Status.md`。

如果今天已经更新过，则跳过，避免双写。
