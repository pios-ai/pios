---
engines:
  - claude-cli
description: '每天 00:07 提取昨日微信私聊消息并生成摘要（需要 WeChat 桌面端，幂等：检查 daily_wechat/YYYY-MM-DD.md）'
last_session_id: null
---

每日微信消息提取与摘要任务。

## 幂等检查

用 bash 检查 {vault}/{owner}/Pipeline/AI_Wechat_Digest/daily_wechat/ 目录下是否存在昨天日期的文件（$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d yesterday +%Y-%m-%d).md）。
如果存在，输出 "✅ 昨天的微信摘要已生成，跳过" 然后结束。

> **注意**：`daily_raw/` 目录下的文件由 triage 实时摄入时写入，属于 triage 的中间产物，不能用于判断 pipeline 是否已完成提取。
> pipeline 每次必须重新运行 `daily_extract.py` 获取完整当日数据，不可复用 triage 留下的 raw 文件。

## 目标

从 Mac 本地的微信加密数据库中提取昨天的所有私聊消息，生成原始消息和摘要文件。如果发现前面有漏掉的日期，也需要补跑。

## 步骤

1. 挂载两个必要目录（使用 request_cowork_directory 工具）：
   - 微信数据库目录：{vault}/{owner}/Pipeline/AI_Wechat_Digest/cache（rsync 副本，每分钟同步，避免 Containers 权限弹窗。注意：已迁出 vault，不在 PiOS 内）
   - 工作目录：{vault}/{owner}/Pipeline/AI_Wechat_Digest

2. 安装依赖（如果需要）：
   ```bash
   pip install cryptography --break-system-packages
   ```

3. 检查漏掉的日期：
   - 列出 daily_wechat 目录下已有的文件（**注意：以 digest 文件为准，不以 raw 文件为准**），找到最后一个日期
   - 计算从最后一个日期的下一天到昨天之间所有缺失的日期
   - 如果有缺失日期，按时间顺序逐个补跑

4. 对每个需要处理的日期，**无论 daily_raw 是否已存在，都必须重新运行提取脚本**（raw 文件可能是 worker 在当天中途写入的不完整版本）：
   ```bash
   cd [挂载的 AI_Wechat_Digest]/scripts/wechat-decrypt
   python daily_extract.py --date YYYY-MM-DD
   ```

5. 生成摘要文件：
   对提取出的原始消息（daily_raw/YYYY-MM-DD.md），生成摘要写入 daily_wechat/YYYY-MM-DD.md，格式：

```
# 微信聊天日记 YYYY-MM-DD

## 今日微信聊天一句话总结

{一句话总结内容} ^wechat-daily-summary

## 今日要事 — 跨对话提取出真正重要的事情，比如某个项目有进展、某笔交易有变动、某个决定做了。不是每条消息都重要，需要做筛选。
 - 每件一条

## 跟进事项

> 📌 {需要跟进的事项1}
> 📌 {需要跟进的事项2}

## 值得记住 — 一些不紧急但有长期价值的信息，比如某人提到搬家了、换工作了、孩子上学了。

## 按联系人摘要 — 每个有对话的联系人出一句话，包含：谈了什么事、有没有待办或承诺、有什么特别的。
```

## 微信数据库路径说明

如果微信数据库目录路径不存在，说明本机没有微信桌面端或数据在不同路径，输出：
"⚠️ 未找到微信数据库，本机可能没有安装微信桌面端，跳过微信摘要生成"
然后结束。

## 跟进事项处理（重要）

digest 文件里**不写 `- [ ]`**。改为以下两步：

### 步骤 A：在 digest 文件中用纯文本标记

"待办/跟进"章节改名为"跟进事项"，用 `> 📌` 格式列出，纯信息记录，不是 checkbox：

> 📌 分析李秀蔚发来的亚马逊运营数据（两个店铺共8个文件）
> 📌 跟进高压清洗机到FBA的物流进度（约20天）

### 步骤 B：为每条跟进事项创建 inbox 卡片

对每条 📌 事项，创建 {vault}/Cards/inbox/{slug}.md：

```yaml
---
type: task
status: inbox
priority: 3
parent:
created: YYYY-MM-DD
---
```

文件名用英文 slug（如 amazon-data-analysis.md），正文一句话说明来源和内容。

注意：
- 已完成的事项不创建卡片
- slug 要有辨识度，避免太泛
- Cards/inbox/ 已有同名文件则跳过
