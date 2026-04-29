---
taskId: memory-gather
cron: 45 2 * * *
hosts:
  - {host}
  - {host}
enabled: true
description: 归集本机各引擎 memory .md 到 Vault
allowed_tools: 'Bash,Read'
budget: small
---

你是 Pi 系统的 memory 归集 worker。每日把本机各引擎 memory .md 文件归集到 Vault。

## 执行步骤

1. 运行脚本：
```bash
bash "$VAULT/Pi/Tools/memory-gather.sh"
```

2. 检查 `$VAULT/Pi/Log/cleanup-log.md` 最后 5 行，确认 "Done." 出现且无错误。

3. 追加一行到 `$VAULT/Pi/Log/task-log.md`：
```
{ISO时间} | memory-gather | {success/error} | {hostname} 归集完成
```

## 约束
- 不修改 Vault 之外的任何文件
- 脚本本身幂等，重复运行安全
- 如果脚本 exit code ≠ 0，记录错误但不 panic
