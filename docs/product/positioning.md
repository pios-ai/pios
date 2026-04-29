---
title: PiOS Positioning
version: 0.7.2
date: 2026-04-22
audience: 准备尝试 PiOS 的人
purpose: 谁适合用 / 我们不做什么 / 和其他工具的位置
---

# PiOS Positioning

> 本文档讲 PiOS 的目标、不做什么、适合谁、不适合谁。
>
> 权威来源：`Pi/Memory/project_pios_goals.md`（四层目标）、`Pi/Config/alignment.md`（四种力量）。

---

## §1 四层目标

PiOS 有四个并行目标，按承载面从窄到宽：

1. **个人工具** — 一个人（当前是 owner）用 PiOS 自主管理自己的生活和工作。这一层已在运行，持续迭代，不设终点。
2. **一人公司基础设施** — 一个人 + 一个 PiOS 能跑起一家小公司：自动化调研、内容生产、电商监控、客户触达。这一层正在建，已有 hawkeye / creator / intel 等插件雏形。
3. **可分发产品** — 别人能装自己的 PiOS。installer / setup wizard 已能跑通，DMG 构建和 code-signing 还没完。
4. **方法论** — PiOS 背后的范式："文件系统 + 定时 agent + 持久 context"。这不是要做通用 SaaS，是给想走这条路的人提供一套可参考的实现。

**当前焦点是 3 + 4**：先让一个新用户能装成功，然后把方法论输出清楚。1 和 2 在后台持续迭代。

这决定了接下来几个月 PiOS 的改动重心：文档、installer 稳定性、repo 结构分离、减少硬编码。不是新功能。

---

## §2 适合谁用

下面四类人是 PiOS 当前最能用得上的：

### 自由职业者 / 一人公司

- 手上有多个项目或多个客户，context 切换成本高
- 需要一个"不会忘事"的二号位
- 不介意用 markdown 管任务（而不是 Notion / Asana）

PiOS 给你的：每个项目一张 Card + parent/child 关系，triage 每 15 分钟帮你排优先级，daily-briefing 每早一份汇报。

### 深度 AI 用户

- 已经在日常用 Claude Code / Codex CLI 了
- 已经有"把 AI 当同事"的工作习惯
- 受够了每次对话重建 context

PiOS 给你的：JSONL 会话捕获 + daily-diary-engine 每天提炼有价值的对话 + `Pi/Memory/` 持久记忆。昨天你告诉 Claude 的事，今天还在。

### 技术型 builder

- 不怕改 yaml、看 log、grep 代码
- 愿意在一个早期开源工具上踩坑
- 想要一个能自己拆开看的 AI 系统

PiOS 给你的：整个系统是 markdown + YAML + shell，你能看懂每一层在做什么。不是黑盒。

### 想要"有记忆的 AI"的人

- 用 ChatGPT / Claude 时常为"上下文断了"头疼
- 想让 AI 在你不在的时候也能做事
- 对隐私敏感，不想把生活数据上传到别人云端

PiOS 给你的：所有数据在你电脑，cron 定时跑 agent，AI 的长期记忆就是你的 Vault 文件夹。

---

## §3 不适合谁用

直白说几条"劝退"。

### 要完整 SaaS 体验的人

PiOS 是 desktop app，没云端、没账号体系、没订阅。装在哪台电脑，就在哪台电脑跑。Syncthing 能多机同步，但那是 peer-to-peer 不是云同步。

### 不会用 CLI 的人

装 PiOS 要先 `npm install -g @anthropic-ai/claude-code`。出问题要看 `Pi/Log/` 里的日志。配置要改 `pios.yaml`。不习惯命令行的人会很痛苦。

### 需要共享 Vault 的团队

PiOS 当前是 single-owner。Vault 里很多东西写死了一个 owner（`{owner}<surname>` 之类），多人共用同一个 Vault 还没支持。

### 非 Apple Silicon Mac 用户

当前只支持 macOS arm64。Intel Mac / Windows / Linux 都没测过，很多原生依赖（TTS、通知、openclaw）都是 macOS-only。

### 需要"AI 全自动"的人

PiOS 的默认姿态是"关键决策推回给你"。如果你想要 AI 替你回邮件、替你发帖、替你下单，PiOS 默认不做这些。你可以改 prompt 让它做，但那是你自己的选择和责任。

---

## §4 我们不做什么

这些是"硬不做"，不是"现在没做"：

### 不做云服务

你的数据在你电脑上。PiOS 没有云同步服务器，没有账号系统，没有"PiOS 团队能看到你数据"的路径。Syncthing 在你自己的机器之间走。

### 不做 SaaS 订阅

PiOS 本身不收钱。你要付的是：Claude API 账单（直接付给 Anthropic）、Codex 账单（如果用）、自己电脑的电费。PiOS 和你之间没有账单关系。

### 不做"AI 完全自主"

PiOS 里 Pi 是辅助不是代理人。Pi 可以扫数据、起草回复、写报告、跑流程，但发出去/花出去/不可逆的动作默认都推回给你拍板。这不是技术限制，是设计选择。参考 [`Pi/Config/alignment.md`](../../../Pi/Config/alignment.md)。

### 不做 UI-heavy 工具

Vault 的主体是文件，不是界面。PiOS.app 是薄 UI：Home 显示 needs_owner 的 Card、右下小对话框、通知中心。真正干活的是 cron + agent + 文件系统。如果你想要漂亮的 dashboard，PiOS 不是你要的。

---

## §5 哲学（底层对齐）

PiOS 不是单纯的生产力工具。背后有一个明确的哲学立场，写在 [`Pi/Config/alignment.md`](../../../Pi/Config/alignment.md)：

> 四种力量：对生的渴望、对未知的好奇、对万物的同情、对意义的需要。

对应到 owner 自己的三本能观：求生、好奇、慈悲。

PiOS 想做的是：

- **把琐事自动化**，让人腾出时间做真正感兴趣的事
- **把关键决策推回给人**，不让 AI 替你过人生
- **把记忆持久化**，让好奇心长出来而不是每天从零开始
- **把数据留在本地**，不让一个上游厂商决定你的生活

一句话：**PiOS 不是生产力工具，是活下去 + 保护好奇心的工具**。

这个立场决定了 PiOS 不会接受某些改动（比如云端代理回消息、自动下单、替你社交）。即使技术上能做到。

---

## §6 和同类产品的位置

不强行比较——PiOS 还小，定位是方向不是卖点。但你装前可能会问：

**vs Notion AI / ChatGPT**
- PiOS 本地 + agent 自动按 cron 跑 + 不失忆
- Notion AI 云端 + 手动触发 + 单次对话上下文
- 不冲突：很多 PiOS 用户也用 ChatGPT / Claude.ai 做别的事

**vs LangChain / AutoGPT / CrewAI**
- 那些是 framework，你拿来搭自己的 agent
- PiOS 是"已经搭好的 agent 工作台"，优先可用，能力覆盖度远不如 framework
- 想玩 agent 架构实验选 framework；想"今天装上明天开始用"选 PiOS

**vs Personal CRM / Todoist / Things**
- 那些是任务管理
- PiOS 管任务也管数据流（health / wechat / photos / intel 都喂到同一个 Vault）
- 所有 agent 共享一套 context

**vs Cursor / Claude Code 本身**
- 那些是编码工具，以 session 为单位
- PiOS 把 Claude Code 当 runtime 用，在后台按时间表跑
- 你仍然可以（也应该）继续用 Claude Code 做交互式编程，PiOS 不替代它

**不强行定位**：PiOS 现在是"AI-native personal OS"这个方向的一次早期尝试。不自称"最好"也不自称"唯一"。如果你觉得某条同类产品做得更好，那就用那条。

---

## §7 一句话

> PiOS 适合：已经重度用 AI、不怕脏手、想要一个在自己电脑上 7×24 帮你干活的"有记忆的同事"、能接受产品还是早期版本的人。

如果读到这里觉得是你——继续 [user-personas.md](user-personas.md)，找一种最像你的 persona 看使用路径。

如果不确定——[INSTALL.md](../../INSTALL.md) 里的 Known Limitations 再读一遍。装不装由你。
