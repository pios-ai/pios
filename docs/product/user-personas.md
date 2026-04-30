---
title: PiOS User Personas
version: 0.7.2
date: 2026-04-22
audience: 准备尝试 PiOS 的人
purpose: 5 种典型用户 + 第一周路径
---

# PiOS User Personas

> 下面 5 种 persona 是按 owner（PiOS 创建者）为原型延伸出来的。它们不是营销画像，是"现在这版 PiOS 能真正帮到的人"的具体描述。
>
> 如果你在其中某一段里看到自己——往下读那段的"关键功能"和"第一周路径"。如果完全看不到自己——PiOS 当前可能还不适合你，[positioning.md](positioning.md) §3 有劝退清单。

---

## Persona 1 — 独立研究者 / Indie Hacker（原型：owner 自己）

### 人设

40 岁上下，技术背景，前创业者或资深工程师。现在自由状态，同时在建 2-4 个项目（可能是开源工具、可能是小生意、可能是研究）。没有老板，没有团队，没有 deadline 盯着，但有一堆自己给自己定的方向。

一天的样子：早上喝咖啡看行业新闻，9 点开始写代码，中午被一个新想法打断，下午调研这个新想法，晚上发现这个新想法其实两周前写在某个 Obsidian 笔记里，情绪崩溃 30 分钟，再捡起来继续。

### 痛点

- **想法散**：灵感在各种地方（推特、微信、纸条、Obsidian、Claude 对话），没地方汇总
- **项目多**：手上同时 3-4 个项目，每个都停在不同阶段，切回去要半小时回忆
- **没助理**：请真人助理成本高、管理成本更高
- **自我对抗**：最大的执行障碍是自己跟自己拉扯，需要一个"替他把想法写下来、下次提醒他"的外部装置

### PiOS 怎么帮

- 所有新想法扔进 `Cards/inbox/`（一句话也行）
- triage 每 15 分钟分类、去重、挂到正确的 parent project
- intel / scout plugin 每天扫行业新闻，有东西了创建 Card 进 inbox
- reflect agent 每天凌晨 4 点复盘系统运行情况
- PiOS.app Home 显示所有 needs_owner 的决策点，不会错过

### 关键功能

- **intel radar** — 行业雷达，每天扫关键词给你出新机会 Card
- **Cards lifecycle** — triage → work → done 的闭环
- **reflect** — Pi 对自己的运行做复盘（不是对你做绩效考核）

### 第一周路径

- Day 1：装 PiOS，完成 setup wizard，看 `welcome-to-pios.md`
- Day 2：把现有 3-4 个项目各创建一张 parent Card 在 `Cards/active/`
- Day 3：连续一周把所有冒出来的想法扔 inbox，什么都不过滤
- Day 4：看 triage 分得对不对，错的手动改
- Day 5-6：看 daily-briefing（每早 8:09 生成），调整优先级
- Day 7：装 intel plugin，设 3-5 个关键词，看一周后给你扫出什么

---

## Persona 2 — 自由职业者 / Freelancer

### 人设

30 岁上下，设计师 / 咨询师 / 独立开发 / 翻译 / 摄影师。同时服务 3-8 个客户，每个客户一个节奏：A 客户月初结款、B 客户周二例会、C 客户突然想加需求、D 客户可能要催款。

一天的样子：早上刷邮件 + 微信，发现 A 忘了发素材，B 把会议改到明天，C 的方案要今天改完，D 的发票还没寄。然后开始第一项具体工作时已经 11 点。

### 痛点

- **Context switch 成本高**：每个客户都要切一次脑子
- **掉球**：小事特别容易忘，忘了又很严重（客户关系）
- **所有东西散在邮箱 + 微信 + 云盘**：没有统一的"客户 X 的所有事"
- **不敢请人**：收入不稳定，分不出精力管别人

### PiOS 怎么帮

- 每个客户一张 parent project Card（`client/{name}.md`）
- 每个具体任务是 child Card，挂到对应客户下
- triage 定优先级时能看到"这个客户已经两周没进展了"
- daily-briefing 每早给你一份"今天 needs_owner 的 3 件事"
- 所有通知可以配成"critical 才响，其他静默"（见 notification-spec）

### 关键功能

- **Things Need You**（PiOS.app Home）— 只显示需要你拍板的事
- **priority** — triage 按紧急度 + 客户重要度排序
- **notify report** — 每天固定时间汇总，不打断工作流

### 第一周路径

- Day 1：装 PiOS，把每个客户创建一张 parent Card，frontmatter 填 `project: client-{name}`
- Day 2：把过去一周所有客户沟通里的"我该做的事"一条条扔进 inbox
- Day 3：看 triage 分得对不对，把归错客户的手动改 parent
- Day 4-5：每早看 daily-briefing，按 Home 里的 needs_owner 排序做事
- Day 6：配 `notify.sh` 的 severity 过滤（critical 才响）
- Day 7：回顾一周，看哪些客户 Card 堆积，是不是该提价或放弃

---

## Persona 3 — 内容创作者 / Creator

### 人设

25-35 岁，小红书 / B 站 / YouTube / Twitter / 公众号作者，可能兼职可能全职。有自己的账号体系、选题库、素材库。可能同时在运营 2-3 个平台或账号。

一天的样子：早上看昨天数据，想今天发什么，翻素材库找图，写文案，发出去，看评论，晚上刷灵感看到一个好主题，存到某个地方下次用。一周后忘了。

### 痛点

- **灵感散**：看到好东西存了 10 个地方（截图 / 飞书 / 备忘录 / 微信收藏）
- **数据分散**：各平台数据各自看，没法横向对比
- **日程和健康脱节**：凌晨写稿第二天崩溃，没地方告诉自己"昨晚睡太少"
- **创作节奏难持续**：凭状态发内容，状态不好就断更

### PiOS 怎么帮

- **content plugin** 有 creator agent，读你的风格档案 + 日常数据，每天帮你起草选题
- **health plugin** 自动拉 Apple Health 数据（睡眠 / 步数 / 心率），和创作节奏做关联
- **wechat digest** 每天把微信里有价值的消息摘出来
- **daily-diary-engine** 把 Claude 对话 JSONL 里的价值内容提炼成日记，灵感不丢

### 关键功能

- **creator agent** — 基于你的风格 + 数据起草内容
- **pipeline**（health / wechat / photos）— 原始数据汇总到 `{owner}/Pipeline/`
- **daily-diary-engine** — 自动从对话里提炼

### 第一周路径

- Day 1：装 PiOS，setup wizard 里勾选 health / wechat / photos 插件
- Day 2：导入过去一个月的 Apple Health 数据（插件 README 有步骤）
- Day 3：写一份 `Pi/Config/creator-style.md`，告诉 creator agent 你的调性
- Day 4：看 creator 第一次给你起的选题稿，改 prompt 调到对
- Day 5-6：每早看 daily-diary，看 Pi 从你昨天的对话里挑了什么出来
- Day 7：把一周的数据看一眼（睡眠 vs 创作量、微信 vs 灵感），找自己的节奏

---

## Persona 4 — 深度 AI 用户 / Builder

### 人设

25-35 岁，工程师 / 研究员 / 技术产品经理。日常重度用 Claude Code、Codex CLI、Cursor。每天跟 AI 对话 3-5 小时以上。

一天的样子：开 Claude Code 窗口写代码，解释项目 context 给它听（又一次），问它某个决策，得到答案，关窗口。第二天打开新窗口，又从头解释一次"我这个项目是干嘛的"。

### 痛点

- **Context 反复重建**：同一个项目对 AI 解释过 50 遍
- **昨天干啥忘了**：Claude 对话关了就没了，记不住昨天讨论到哪
- **Memory 写了但没管理**：`~/.claude/projects/*/memory/` 堆了一堆，没人整理
- **多个工具数据孤岛**：Claude Code 的 JSONL / Cursor 的 chat / ChatGPT 的 history 各自独立

### PiOS 怎么帮

- **JSONL 捕获**：Claude Code 会话自动写到 `~/.claude/projects/*/jsonl`，PiOS 的 daily-diary-engine 每天凌晨扫
- **`Pi/Memory/` 持久化**：重要教训以 `feedback_*.md` 形式落盘，下次对话自动读
- **token-daily-summary**：每天 3:02 汇总昨天的 token 花销，帮你管预算
- **worker-knowledge**：把各种操作纪律（不要 `mv` 用户数据、不要自动同步 token 等）压成一份，所有 worker 机器共享

### 关键功能

- **daily-diary-engine** — 每日从 JSONL 提炼价值对话到日记
- **Memory 持久化** — feedback 文件是可读的纯 markdown，不是黑盒
- **token-daily-summary** — Claude token 精确监控（5h / 7d 用量）

### 第一周路径

- Day 1：装 PiOS，setup wizard 里默认启用 Claude Code CLI
- Day 2：看第一次 daily-diary（明早生成），看 Pi 从你的对话里提炼了什么
- Day 3：翻 `Pi/Memory/`，看有哪些 feedback 已经沉淀，手动补 2-3 条你自己的教训
- Day 4：装 Codex CLI（可选），看 PiOS 怎么同时管两个 runtime
- Day 5：看 token-daily-summary，调整 agent 调度频率避免超预算
- Day 6：写一张自己的 parent project Card，让 triage + work 帮你推进
- Day 7：回顾：这一周有没有哪次 AI 对话是"我不用重新解释 context 的"

---

## Persona 5 — 一人公司老板 / Solo CEO（原型：owner 的目标形态）

### 人设

35-45 岁，做小生意或个人品牌。可能是跨境电商、独立 SaaS、自媒体矩阵、知识付费。一个人扮演 CEO + 运营 + 客服 + 财务 + 司机。营收可能 50 万到 500 万。

一天的样子：早上看昨天订单 + 投流数据 + 客服消息 + 账户余额 + 对手动态，还没开始干活已经看了 6 个 dashboard。一旦哪个 dashboard 漏看，就可能出大事（库存断、广告费超、客户投诉）。

### 痛点

- **多角色切换**：一天在 5 种身份间切，每种都要 context 完整
- **数据孤岛**：Shopify / Amazon / 微信 / 银行 / 广告平台 各自独立
- **没人兜底**：请人管不过来，不请人自己累死
- **关键时刻怕漏事**：大事小事都混在同一个脑子里

### PiOS 怎么帮

- **hawkeye plugin** — 电商监控，盯 ASIN 价格、库存、竞品、评价，异常发 critical 通知
- **creator plugin** — 内容自动化，creator agent 按你风格日产选题
- **maintenance + reflect** — 系统管家，每天帮你对账 / 查日志 / 发现异常
- **sense-maker** — 每 2 小时把 Cards 和现实对一次账，不让某张卡僵在那
- **notify critical** — 重要的才打断你，其他汇总每天看一次

### 关键功能

- **多 agent 并行**（triage / work / hawkeye / creator / intel）
- **notify severity 分级** — critical 立即响，其他静默走日报
- **sense-maker 对账** — 防止"Card 写着 done 实际没做"的偏差

### 第一周路径

- Day 1：装 PiOS，setup wizard 勾 ecommerce / content / intel 插件
- Day 2：配 hawkeye 要监控的 ASIN 列表（在 plugin config）
- Day 3：配 creator agent 的风格档案
- Day 4：把过去一周在各 dashboard 发现的所有"本来要做但忘了的事"全扔 inbox
- Day 5：看 sense-maker 第一次对账结果，Card 状态和现实对不上的地方手动纠偏
- Day 6：配 notify 过滤规则，只让 critical 和 daily-briefing 打断你
- Day 7：跑满一周，看 PiOS 替你看了哪些 dashboard、漏了哪些。漏的补 plugin 或 prompt。

---

## 不在这 5 种里？

如果你读完 5 个 persona 都觉得不是自己——有两种可能：

1. **你的场景 PiOS 现在还做不了**。比如团队协作、Windows 用户、需要云端的场景。[positioning.md §3](positioning.md#3-不适合谁用) 有更直白的劝退。
2. **你的场景 PiOS 能做但插件还没建**。比如律师的案件管理、研究者的论文追踪、家长的孩子日程。PiOS 是插件化的，但当前的官方插件覆盖度有限。如果你愿意自己写 plugin.yaml + agent prompt，PiOS 能支持；如果想开箱即用，可能还要等。

---

## 如果你是上面任何一种

建议按这个顺序读：

1. [INSTALL.md](../../INSTALL.md) — 装。先看 Known Limitations 一段。
2. [overview.md](overview.md) §5 — Known Gaps，装之前你要知道的 9 个边界
3. [../user-guide/getting-started.md](../user-guide/getting-started.md) — 装完第一次开机怎么走
4. 装完之后：`Cards/inbox/welcome-to-pios.md` 是你的第一个入口

装完第一天可能撞到问题 → [../user-guide/troubleshoot.md](../user-guide/troubleshoot.md)。`Pi/Log/` 里有日志，Known Gaps 清单里写了常见情况。遇到问题先查日志、再查 Gaps、再问。

不要装完 10 分钟没动静就判死刑——triage 每 15 分钟跑一次，work 每 5 分钟跑一次，第一轮至少 15 分钟。
