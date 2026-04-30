---
title: PiOS 核心概念字典
audience: 刚走完 getting-started.md 的终端用户
updated: 2026-04-22
---

# PiOS 核心概念字典

> 这份是 PiOS 的语义字典 —— 你在 UI、卡片、日志里会反复看到这些词，这里给你精确定义。不复述字段表细节，只讲"它是什么、在哪用、最容易搞错的是什么"，然后链接到权威源。
>
> 读这份的前提：你已经走完 [`./getting-started.md`](./getting-started.md)，装机成功、welcome 卡跑通。
>
> 上游权威：
> - [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) —— 五层架构
> - `Pi/Config/card-spec.md` —— Card frontmatter SSoT
> - `Pi/Self/pios-capabilities-overview.md` —— agent / task / pipeline 全景
> - [`../components/things-need-you.md`](../components/things-need-you.md) —— 9 按钮 × 后端权威表
> - `Pi/Config/notification-spec.md` —— 通知 5 级
> - `Pi/Config/infra-topology.md` —— 多机拓扑

---

## §1 Card —— 统一工作单元

**一个 md 文件 = 一个 Card。** 任务、项目、验证卡、备忘 —— 都是 md。PiOS 没有数据库，所有状态都在文件里（ARCHITECTURE §1 "All state is files"）。

**生命周期三阶段**（目录就是状态）：

```
Cards/inbox/   新来的卡 —— triage 每 15 min 扫 → 判优先级 / 挂 parent / 去重 → 搬走
Cards/active/  在做的卡 —— work 每 5 min 抢一张跑一步；blocked / needs_owner 的也留在这里
Cards/archive/ 已归档 —— status: done（做完）或 dismissed（不做了）。终态，triage 和 worker 都不再碰
```

**三种卡类型**（`type` 字段）：

| `type` | 含义 | 何时用 |
|---|---|---|
| `task` | 具体的事，做完就完 | 绝大多数卡 |
| `project` | 容器，下面会挂子卡 | 子卡 > 1 张时改成 project |
| `verify` | 延迟验证卡（`assignee: pi` + `blocked_on: verify-after:...`） | Pi 自己闭环某变更时建 |

**谁建 Card**（决定放哪）：

| 创建者 | 目的 | 放哪 | 例子 |
|---|---|---|---|
| 你（UI / 手写）| 让 Pi 调研/执行 | `Cards/inbox/` | "帮我调研 xhs 中文号策略" |
| 你（UI / 手写）| 给自己加 todo | `Cards/active/` + `assignee: user` | "周五前给韩明星发邮件" |
| Pi worker | 验证卡 / 拆出的子卡 | `Cards/active/` | `verify-npc-voice-2026-04-22.md` |
| Plugin | 插件发现的机会 | `Cards/inbox/` | `scout` 找到一条情报 |

**权威**：`Pi/Config/card-spec.md` —— 字段表、命名规则、task 三要素、幂等规则全在这里。

---

## §2 Frontmatter 核心字段（日常能见到的 8 个）

> 完整字段表在 `Pi/Config/card-spec.md` 和 `Pi/Self/pios-capabilities-overview.md` §六"Frontmatter 字段运行时效果表"。这里只列你在 UI 和卡里反复见到的 8 个。

```yaml
---
type: task              # task / project / verify
status: active          # inbox / active / in_review / done / dismissed / error
priority: 2             # 1(最高) - 5(最低)
assignee: pi            # pi / user / <agent>
needs_owner: respond    # alert / respond / act / check —— 留空 = 不用你决策
created: 2026-04-22
parent: ai-ecommerce    # 父卡文件名（不含 .md）
blocked_on: data        # 非人类阻塞原因；verify-after:YYYY-MM-DD HH:MM 是特殊值
---
```

**最关键的一句话**（2026-04-22 owner 反复纠正的那个点）：

> `assignee: user` = **你**要做这件事；`needs_owner` 有值 = **Pi** 要你做决策。这是两种不同的"要你"，走不同的 UI 通道，详见 §6。

其余你偶尔会看到的字段（不日常改）：`energy` / `claimed_by` / `deferred_until` / `owner_response` / `interaction_round` / `activity_result` —— 这些都是系统自动写的，你看就行，不要手改。字段运行时效果看 `Pi/Self/pios-capabilities-overview.md` §六。

**verify 卡的标准姿势**（Pi 自己用）：`assignee: pi` + `blocked_on: verify-after:YYYY-MM-DD HH:MM` + `source: close-loop`。**禁止**加 `needs_owner` —— 那会把 Pi 自己的自检任务错误地弹给你（`Pi/Self/pios-capabilities-overview.md` §六 footnote）。

---

## §3 Agent —— 执行单元

PiOS 跑 7 种 agent。每个 agent 有一份 `SOUL.md`（人格）和若干 task（具体任务）。定义在 `Pi/Config/pios.yaml` 的 `agents` 段。

| Agent | 角色 | 主要 task | 部署机器 |
|---|---|---|---|
| **pi** | 大脑 + 小脑 + 自省 + 双手 | triage / work / sense-maker / reflect / curiosity / daily-briefing / evening-brief / weekly-wrap-up | laptop-host + worker-host |
| **pipeline** | 生活数据采集 | daily-ai-diary / daily-wechat-digest / daily-health / daily-photo-diary / daily-user-status / daily-diary-engine | laptop-host |
| **maintenance** | 系统合规管家 | maintenance / auth-health-check / memory-gather / token-daily-summary / vault-snapshot | laptop-host |
| **radar** | 情报雷达 | big-thing-daily-scan / radar-worker / claude-code-leak-monitor | laptop-host |
| **creator** | 内容创作 | daily-scripts（小红书口播稿） | laptop-host + worker-host |
| **hawkeye** | 电商监控 | hawkeye-worker | laptop-host |
| **life** | 健康/生活辅助 | reminders-refresh / weekly-health-review | laptop-host |

**pi agent 是主角**，其他 6 个是插件 agent（通过 `plugin.yaml` 注册，见 ARCHITECTURE §3 Layer 3）。

**权威**：`Pi/Self/pios-capabilities-overview.md` 一、二章。

---

## §4 Task —— 定时任务

每个 agent 下挂多个 task。每个 task 是一份 md（prompt + 配置），放在 `Pi/Agents/{agent}/tasks/` 下，并在 `Pi/Config/pios.yaml` 的 `tasks` 段注册调度。

**调度是 cron 驱动的**（ARCHITECTURE §4.2）：

| Task | 频率 | 做什么 |
|---|---|---|
| `triage` | `*/15 * * * *` | 扫 inbox、派发、搬 archive、升级 needs_owner |
| `work` | `*/5 * * * *` | 抢一张 ready_for_work 卡执行一步 |
| `sense-maker` | `0 */2 * * *` | 对账现实 ↔ 系统、更新 blocked_on / energy |
| `reflect` | `0 4 * * *` | Pi 每日自省，产反思卡、更新 mood |
| `daily-briefing` | `9 8 * * *` | 每日早报 |
| `evening-brief` | `0 22 * * *` | 晚间收工汇报 |
| `maintenance` | `30 2 * * *` | 系统巡检、清日志、auth 检查 |
| `vault-snapshot` | `0 3 * * *` | 增量备份 |

**任务执行记录**写入 `Pi/State/runs/*.json`，每个 task 一个 json。看最近跑了啥：`ls -lt ~/PiOS/Pi/State/runs/ | head`。

**权威**：`Pi/Config/pios.yaml`（你的 vault 里那份是你的实际调度）+ `Pi/Self/pios-capabilities-overview.md`。

---

## §5 Activity —— 一次执行

task 跑一次 = 一次 activity。

- **写入位置**：卡 frontmatter 的 `activity_result` 字段 + 正文末追加一段"工作记录"
- **日志**：`Pi/Log/worker-log-{hostname}.md`（每次 work tick 一行 bullet）
- **run 记录**：`Pi/State/runs/*.json`（adapter 写）

**worker 的硬规矩**（L2 v3.1 R1 铁律）：worker 不能直接写 `needs_owner`，只能在 `activity_result.proposed_needs_owner` 里提议升级。triage 下一轮读到 proposal 才决定要不要真的弹 Things Need You。

为什么：worker 是"执行脑"，triage 是"决策脑"，两者分离防止 worker 误判 / race condition。权威见 [`../components/card-system.md`](../components/card-system.md) 的 R1 铁律段。

---

## §6 Things Need You vs MyToDo —— 最关键的一对区分

这是 2026-04-22 owner 反复纠正的点。UI 的 Home 页面最上面两块就是这两个区：

| 维度 | MyToDo | Things Need You |
|---|---|---|
| frontmatter 字段 | `assignee: user` | `needs_owner: alert / respond / act / check` |
| 语义 | **你**要做 | **Pi** 要你决策 |
| Home 面板位置 | 中间 MyToDo 区 | 最顶部 Things Need You 条 |
| 触发源 | 你自己加 / 从 TNY 点"转入待办"过来 | Worker 提议 → triage 升级 |
| 处理方式 | 自己做完改 `status: done`（或 UI 点"标完成"） | 点 UI 9 种按钮之一（见权威表） |
| Pi 会调度吗 | 不，这是你自己的事 | 不，Pi 在等你 |
| 会自动催吗 | 不催 | 不催（但 aging 超 3 天 triage 会升级 needs_owner 级别） |

**最容易搞错的按钮**：Things Need You 上的 **"📋 转入待办"** 按钮 —— 意思是"**Pi 不管这事了，这事我（owner）自己接过去**"（改 `assignee: user`，卡从 TNY 区跳到 MyToDo 区）。**不是** "Pi 接过去做"。

权威 9 按钮 × 后端表：[`../components/things-need-you.md`](../components/things-need-you.md) 的"按钮 × 后端"段。踩坑溯源：`feedback_ui_button_read_handler.md`（Claude 自动记忆）。

---

## §7 Agent 节奏 —— Pi 的四种生物节拍

Pi agent 有 4 个核心节奏（SOUL.md 里叫"四节奏"）：

| 节奏 | 频率 | 心智状态 | 产物 |
|---|---|---|---|
| **triage** | 每 15 min | 分拣员 | 派发卡、搬归档、升级 needs_owner |
| **work** | 每 5 min | 执行者 | 抢卡干活、写 activity_result、出产物 |
| **sense-maker** | 每 2 h | 对账员 | 对账现实 ↔ 卡片状态、更新 blocked_on / energy |
| **reflect** | 每日 4:00 | 自省者 | `Pi/Log/reflection-log.md` + 更新 `pi-state-now.md` mood 向量 |

triage 和 work 是**卡流的心跳**：没有它们卡不动，Home 界面就会一直不更新。出问题时第一反应是看这俩跑没跑 —— 扫 `Pi/State/runs/` 和 `Pi/Log/worker-log-*.md`。

---

## §8 通知 5 级 —— 都走 notify.sh

PiOS 所有通知统一入口 `Pi/Tools/notify.sh <level> "消息"`，按 level 自动路由（`Pi/Config/notification-spec.md` 是权威）：

| level | 通道 | 用在什么场景 | 频率预期 |
|---|---|---|---|
| `critical` | 微信 + PiBrowser | 系统故障 / 死线必须回 / auth 失效 | 极少，响了就是大事 |
| `report` | 微信 | 日报 / 简报 / 任务完成异步汇报 | 每天 2-5 条 |
| `reminder` | PiBrowser 弹窗 + 语音 | 健康 / 运动 / 吃药 | 每天 5-10 条 |
| `info` | PiBrowser | 一般通知、低优先级 | 按需 |
| `silent` | 仅写日志 | 内部记账，不打扰 | 不限 |

**你需要理解的规矩**：
- 微信响了就是"值得看的" —— `notification-spec.md` 规定一天 `critical` + `report` 合计不超过 10 条
- `reminder` 只到 PiBrowser，**不发微信**。卡说"微信发 owner"时 Pi 必须用 `critical` 或 `report`（见 `feedback_notify_vs_wechat.md`，Claude 自动记忆）
- notify.sh 默认 5 min 去重 —— 同一事件短时间重复调不会重复发

PiBrowser 层的说话节律（chitchat / greet / quiet hours）详见 [`../pi-speak-behavior.md`](../pi-speak-behavior.md) 的三层门控。

---

## §9 Vault 目录结构

Vault 是 PiOS 的"硬盘"。默认在 `~/PiOS`（setup 时可改）。一图概览（权威见 ARCHITECTURE §7 File Ownership Model）：

```
~/PiOS/                          ← Vault 根
├── Cards/                       ← 卡片系统（Pi 自由读写）
│   ├── inbox/                   ← 新卡，triage 每 15 min 派
│   ├── active/                  ← 在做的
│   └── archive/                 ← 终态，不再碰
├── Pi/
│   ├── Config/                  ← 你的配置（pios.yaml / alignment.md / BOOT.md）
│   ├── Agents/                  ← agent SOUL.md + task prompts
│   ├── Plugins/                 ← 核心 + 插件（core / health / wechat / ...）
│   ├── Tools/                   ← engine 脚本（notify.sh / pios-tick.sh 等）
│   ├── State/                   ← runs + locks（运行时）
│   ├── Log/                     ← worker-log / sense-log / reflection-log
│   ├── Output/                  ← Pi 产出（intel 报告 / content 草稿 / infra 文档）
│   ├── Memory/                  ← Pi 持久记忆（feedback_*.md + worker-knowledge）
│   └── Self/                    ← Pi 自我认知（pi-state-now / diary / capabilities-overview）
├── {你的名字}/                   ← 你的个人数据（Pi 读写但属你）
│   ├── Personal/Daily/          ← 每日日记（diary-engine 生成）
│   ├── Profile/                 ← 9 份 md：owner ↔ AI 共享认知层
│   ├── Pipeline/                ← 采集的原始数据（health / wechat / photos / location）
│   └── Scratch/                 ← 草稿区
└── Projects/                    ← 你的项目（含 PiOS 产品 repo）
```

**五层归属**（谁能改）见 ARCHITECTURE §7 表 —— 简化版：

| 你能改 | Pi 能改 | 都别动 |
|---|---|---|
| `Pi/Config/*`（pios.yaml / alignment / BOOT）、插件配置 | `Cards/*`、`Pi/State/ Log/ Output/ Memory/ Self/*`、`{你}/*` | `Projects/pios/`（产品代码）、`Pi/Tools/*.sh`（engine）、`Pi/Agents/{pi,…}/tasks/*.md`（核心 prompt） |

---

## §10 下一步读啥

看你接下来想干什么：

| 我想 | 读 |
|---|---|
| 学每天怎么用 PiOS（早 / 中 / 晚 + 常用 UI 操作） | [`./daily-flow.md`](./daily-flow.md) |
| 开关插件 / 定制通知级别 / 多机部署 | [`./configure.md`](./configure.md) |
| 出问题了救急 | [`./troubleshoot.md`](./troubleshoot.md) |
| 看五层架构权威 | [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| 看 Pi 自己的操作手册（owner 原话 ⇄ 内部语义 ⇄ 步骤 15 场景） | `Pi/Config/pi-ops-handbook.md` |
| 看 Card frontmatter 所有字段 | `Pi/Config/card-spec.md` |
| 看所有 agent / task / pipeline 全景 | `Pi/Self/pios-capabilities-overview.md` |

---

## 相关权威源

- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) —— 五层架构 + 组件依赖图
- `Pi/Config/card-spec.md` —— Card frontmatter SSoT
- [`../components/things-need-you.md`](../components/things-need-you.md) —— TNY 9 按钮 × 后端权威表
- [`../components/card-system.md`](../components/card-system.md) —— Card 字段契约 + R1 铁律
- `Pi/Config/notification-spec.md` —— 通知 5 级规范
- `Pi/Self/pios-capabilities-overview.md` —— agent / task / pipeline / skill 全景
- `Pi/Config/pi-ops-handbook.md` —— Pi 自己读的原话翻译层
- `Pi/Memory/MEMORY.md` —— Pi 已内化的 50+ 条教训索引
