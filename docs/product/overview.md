---
title: PiOS Overview
version: 0.7.2
date: 2026-04-22
audience: 准备尝试 PiOS 的人（安装前读）
status: honest — 当前能力边界在 §5
---

# PiOS Overview

> 这份文档是给还没装 PiOS 的人读的。读完你会知道 PiOS 是什么、解决什么问题、现在能做到什么、现在做不到什么。
>
> 权威架构文档是 [ARCHITECTURE.md](../../ARCHITECTURE.md)，这份 overview 不重写架构，只做入口。

---

## §1 这是什么

PiOS 是一个 AI-native 的个人操作系统。它在你自己的电脑上跑一组 AI agent，按 cron 定时执行，帮你管任务、采数据、在关键决策点把选择权推回给你。

核心体验是一条 Card 生命周期：

- 你把任务扔进 `Cards/inbox/`（一个 markdown 文件）
- triage agent 每 15 分钟扫一次 inbox，定优先级、归档重复项、派发给执行者
- work agent 每 5 分钟跑一次，挑一张 ready 的 Card 执行
- 执行完成后，如果需要你拍板，Card 进入 `needs_owner` 状态，推到 PiOS.app Home
- 你在 Home 点一下，写一句话，triage 下一轮把卡清掉

PiOS 没有数据库。所有状态都是 markdown 文件 + YAML 配置 + JSON run records。Vault 目录通过 Syncthing 在多机之间同步。你在 laptop-host 写的卡，2 秒后 worker-host 那边也能看到。

这意味着两件事：
- 你的数据在你自己电脑里，不经云
- 你可以用 git、`rg`、Obsidian、VS Code 这些工具直接操作 PiOS 的"状态"

---

## §2 为什么做这个

AI 模型很聪明，但每次对话都从零开始。你告诉 ChatGPT 你有强直性脊柱炎，它这一轮记得；下一个对话窗口打开，它又问你"请问您的身体状况如何？"。

市面上的 AI agent 产品基本分两种：
- **云端 agent**（Zapier AI、各种 SaaS）：能记住，但你的数据在别人服务器上
- **一次性 agent**（LangChain demo、AutoGPT）：跑完一轮就散了，没持久 context

PiOS 的答案是第三条路：给 AI 一个持久的工作台。这个工作台是你电脑上的一个文件夹（Vault）。AI 读文件、写文件、按时间表跑任务。你早上醒来，`{owner}/Personal/Daily/` 里多了昨天的日记；`Pi/Output/intel/` 里多了昨夜扫的行业新闻；`Cards/active/` 里可能多了一张 needs_owner 的卡等你拍板。

底层赌注：**AI 的瓶颈不是智能，是 context 和反馈回路**。PiOS 就是一套把 context 持久化、把反馈回路建起来的基础设施。

---

## §3 核心体验：Card 生命周期

这是 PiOS 里最常见的一条路径。完整版本在 [ARCHITECTURE.md §4.1](../../ARCHITECTURE.md#41-card-lifecycle)。

```
用户创建 Card              Plugin 任务创建 Card
(或扔进 inbox/)            (例如 scout 发现机会)
        │                           │
        ▼                           ▼
   Cards/inbox/                Cards/inbox/
        │                           │
        └───────────┬───────────────┘
                    ▼
            triage (*/15 min)
            · 定优先级
            · 匹配 parent project
            · 查重
            · 移到 active/
                    │
                    ▼
            Cards/active/
            (status: active, 等派发)
                    │
            triage 派发:
            · 计算目标 backlog
            · 按优先级/能量挑候选
            · 写 ready_for_work: true
                    │
                    ▼
            work (*/5 min)
            · 挑一张 ready_for_work 的 Card
            · 读 context, 执行任务
            · 更新 Card 状态
            · 置 status: done 或 needs_owner
                    │
              ┌─────┴──────┐
              ▼             ▼
        status: done   needs_owner: ...
              │             │
              │             ▼
              │        PiOS.app Home
              │        显示 Decision
              │             │
              │        用户回复
              │             │
              │        triage 清 needs_owner
              │             │
              ▼             ▼
        triage 归档      回 active
        → Cards/archive/  (下一轮 work)
```

这条流不是"AI 替你决策"，是"AI 替你跑流程，关键决策推回给你"。PiOS 默认不会把钱花出去、不会回复别人的消息、不会发帖。它会做完所有准备工作，把"发不发"这一下留给你。

---

## §4 五层架构

PiOS 分五层，每层有明确的 owner 和修改规则。这里只给一句话概述；想真正理解系统边界，读 [ARCHITECTURE.md §3](../../ARCHITECTURE.md#3-five-layers)。

1. **Engine**（Layer 1）— `pios-tick.sh` / `pios-adapter.sh` / `main.js` / installer。纯代码，PiOS 升级时整体替换。
2. **Core Agents**（Layer 2）— triage / work / sense-maker / reflect 四个核心 agent 的 prompt。产品随 PiOS 升级，但 Pi 自己不改。
3. **Plugins**（Layer 3）— 可装可卸的能力包（health / wechat / photos / ecommerce / content / intel / diary / browser / location）。
4. **User Configuration**（Layer 4）— `pios.yaml` / `alignment.md` / `BOOT.md`。你的，PiOS 升级不覆盖。
5. **Runtime Data**（Layer 5）— Cards / Pi/State / Pi/Log / Pi/Output / Pi/Memory / {User}/。Pi 自由读写。

五层的分界线不是装饰。决定修改哪个文件、谁负责维护、升级时会不会被覆盖，全靠这条边界。

---

## §5 当前能力边界（诚实版）

PiOS 还在求生期，不是成熟产品。[ARCHITECTURE.md §9](../../ARCHITECTURE.md#9-known-gaps-current--target) 列了 9 个 Known Gaps，这里原样搬过来，每条加一句"装之前你要知道"。

| # | Gap | Impact | 当前缓解 |
|---|-----|--------|----------|
| 1 | PiOS.app 还不嵌 scheduler | 要在系统 cron 里注册 `pios-tick.sh`，没装 cron 就不会自动跑任务 | installer 替你注册 cron；但卸载 PiOS 后要手动清 |
| 2 | Core agent prompts 硬编码用户信息 | triage/work 里写着 `{owner}<surname>`、WeChat DB 的绝对路径 | 已在用 `{owner}` `{vault}` 变量替换，但不完全，需要手动 grep 检查 |
| 3 | Plugin prompts 硬编码用户配置 | hawkeye 插件里写着 Amazon ASIN，health 插件里写着身体指标阈值 | 装插件后要手动编辑 prompt 里的参数；计划移到 plugin 配置文件 |
| 4 | Plugins 不注册 data sources / hooks | triage agent 里硬编码了各 plugin 的分类逻辑 | 添加新插件要同步改 triage prompt；插件不能真正自描述 |
| 5 | Product code 还在 user Vault | `Projects/pios/` 和 `Pi/Tools/` 混在用户 Vault 里，不好做 repo 分离 | 已规划 repo split（见 ARCHITECTURE §8），尚未执行 |
| 6 | `pios-tick.sh` 存在 3 份拷贝 | Vault、app bundle、`~/.pios/tools/` 各一份，升级时可能不一致 | 以 `~/.pios/tools/` 为准；修改前用 `diff` 对一下 |
| 7 | 命名不一致 | 代码里混用 pios / pi-browser / PiOS / PiBrowser 四个名字 | 文档用 PiOS / PiBrowser；代码里暂不动 |
| 8 | `main.js` 5283 行单文件 | 所有 Electron 主进程逻辑在一个文件，不好改 | 已有拆分规划；第三方贡献前需先拆 |
| 9 | 没自动化测试 | Card 流或 UI 改动没 CI 兜底，只能手测 | 关键改动前先跑 `scripts/npc-voice-health.sh` 等健康脚本；全面测试未建 |

这些不是"以后再说"，是"装之前你要知道"。装完第一天你大概率会撞到其中 2-3 条。

另外几条 INSTALL.md 里写明的限制：
- 只支持 macOS arm64（Apple Silicon），Intel Mac / Windows / Linux 都没测
- 没做 code sign，没过 notarization，Gatekeeper 第一次开会拦
- Claude Code CLI 不自动装，要你先 `npm install -g @anthropic-ai/claude-code`
- DMG 构建在部分 macOS host 上有 `hdiutil` 故障，maintainer 目前用 `npm run build:dir` 出 `.app`

完整限制清单见 [INSTALL.md §Known Limitations](../../INSTALL.md#known-limitations)。

---

## §6 技术栈

- **平台**：macOS arm64（Apple Silicon）。其他平台未支持。
- **壳**：Electron（`PiOS.app`）。主进程 `main.js`，渲染层 `renderer/`。
- **AI Runtime**：Claude Code CLI 为主，Codex CLI 可选。两个 CLI 都是本地进程，调用官方 API。PiOS 不自己部署模型。
- **调度**：macOS cron 跑 `pios-tick.sh`，每分钟一次。Agent 执行由 `pios-adapter.sh` 拉起 CLI 会话。
- **存储**：markdown + YAML + JSON，零数据库。
- **同步**：Syncthing（可选，单机也能用）。多机之间通过 Vault 同步。
- **通知**：本地 toast + 可选 TTS + 可选微信（通过 openclaw 发到你自己账号）。

---

## §7 下一步读啥

按顺序：

1. **[positioning.md](positioning.md)** — 谁适合用、我们不做什么、和其他工具的位置
2. **[user-personas.md](user-personas.md)** — 5 种典型用户，看看有没有你
3. **[../../INSTALL.md](../../INSTALL.md)** — 装。平均 20 分钟。
4. **[../../ARCHITECTURE.md](../../ARCHITECTURE.md)** — 装完想改东西前读

如果你只想看一段话决定装不装：

> PiOS 是给"已经重度用 Claude / Codex、想让 AI 在你电脑上 7×24 跑、不怕改 yaml 看 log、能接受产品还在求生期"的人的工具。如果这几条里有一条不符合，先别装。
