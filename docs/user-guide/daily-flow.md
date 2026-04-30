---
title: PiOS 每日使用流
audience: 装完 PiOS、读过 concepts.md 的终端用户
updated: 2026-04-22
---

# PiOS 每日使用流

> 一份"早 / 中 / 晚 + 常用操作"的日常指南。前提你已经读过 [`./concepts.md`](./concepts.md)，知道 Card / Agent / Things Need You / MyToDo 的差别。
>
> 上游权威：
> - [`../components/things-need-you.md`](../components/things-need-you.md) —— 9 按钮 × 后端权威表
> - `Pi/Config/card-spec.md` —— Card frontmatter SSoT
> - `Pi/Config/pi-ops-handbook.md` —— Pi 原话翻译层

---

## §1 早上打开 PiOS —— 15 分钟走完三块

双击 `PiOS.app` → 默认停在 Home tab → 从上到下三块：**Things Need You / MyToDo / Recent Activity**。早上这 15 分钟重点在第一块。

### §1.1 Things Need You 积压处理（最重要）

这是 Pi 在等你决策的卡。顶部条显示 `N THINGS NEED YOU ›`，左右箭头翻 N 张。每张卡顶上是 queueType 图标 + `needs_owner_brief`（一句话说明要你干啥），下面是按钮组。

**按 aging 优先级扫**。aging 起点是卡的 `needs_owner_set_at`（不是 `created`），在 `Pi/Config/pi-ops-handbook.md` §2.2 有定义：

| aging | 意味着 | 怎么办 |
|---|---|---|
| 0-3 天 | 正常积压 | 今天看完 |
| 3-7 天 | triage 会把级别升一档（譬如 respond → alert） | 今早优先处理这些 |
| > 7 天 | Pi 会发 `notify.sh critical` 到微信强提醒 | 这条到了就必须断 —— 做 / 转入待办 / 不做了 |

**处理方式：点 UI 按钮**（不要去改 md，md 会被 engine 写）。9 个按钮的含义必须按 [`../components/things-need-you.md`](../components/things-need-you.md) 的权威表走 —— 不要从中文按钮名推断语义（`feedback_ui_button_read_handler.md`，Claude 自动记忆）。快速记忆：

| 按钮 | 出现在 | 意思 |
|---|---|---|
| **✓ 通过** | check 类型 | 验收通过，task 归档，project 留 active |
| **↵ 要修** | check 类型 | 返工，worker 下轮重做 |
| **✗ 驳回** | check 类型 | 否决，worker 下轮读 owner_response='reject' 处理 |
| **💬 回复** | respond 类型 | 你填文本/选项/日期，worker 下轮继续 |
| **✓ 已完成** | act 类型 | 你已经手动做完了（必填 comment），worker 下轮验证 |
| **⚡ 处理** | alert 类型 | 你已经处理了告警（走 respond 通道） |
| **📋 转入待办** | 全部 | **你接过去自己做**（改 `assignee: user`，卡跳到 MyToDo）。**不是** "Pi 接过去" |
| **⏸ 明天再说** | 全部 | 只改 `deferred_until=明天`，`assignee` 还是 Pi。24h 后回 TNY |
| **不做了** | 全部 | `status: dismissed`，必填 4+ 字原因，移 archive |

**右上角 📞 Call Pi**：懒得自己搞的兜底。点一下右边栏拉一条新会话（title 自动设成 `NYC:{卡名}`，归到 "Things Need You" 分组），Pi 读卡、能做的直接做、不能的一步步告诉你，做完再帮你按按钮收尾。不改卡 frontmatter，只发 prompt。

**常见的"不该出现在 TNY"的卡**：如果你看到一张 "Pi 自己应该做的设计 / 调研"被升到 needs_owner —— 那是 worker 误判（triage 没挡住）。目前 UI 没有"让 Pi 领走"按钮（`../components/things-need-you.md` 2026-04-20 条目 ⏳），临时处置：点 "⏸ 明天再说"，让 Pi 下轮自己修 frontmatter。

### §1.2 MyToDo 自己挑一条做

MyToDo 是 `Cards/active/` 里 `assignee: user` 的卡。**你自己的 todo，Pi 不调度不催**。

- 扫一眼有几条，挑一条先做
- 做完点卡详情里的"标完成" → `status: done`，搬 archive
- 不做了就点"不做了" → `status: dismissed`
- 有些卡带 `auto_check`（shell 命令），sense-maker 每 2h 跑一次，退出码 0 自动标完成（见 `card-spec.md` § auto_check）

**MyToDo 的来源**两种：
- 你自己加（见 §2.2）
- 从 Things Need You 点 "📋 转入待办"过来（原本 Pi 问你的事，你接过去自己做）

### §1.3 Recent Activity 扫一眼

最下面一块，列 Pi 最近的 worker 活动和卡状态变化。扫一眼今天 Pi 都跑了什么 —— 不用细看，有异常（比如 error / failed）再点进去。

想深看就切 `System` tab：有每个 agent 的最近 runs、健康报告、token 用量。

---

## §2 白天加新任务 —— 两条路分清楚

### §2.1 让 Pi 调研 / 执行（走 inbox）

**场景**：你想让 Pi 帮你调研、找资料、写代码、做内容。这种事 Pi 做，不是你做。

**操作**：在 `Cards/inbox/` 新建一张 md（或通过 UI 的"新建卡片"入口）。必要 frontmatter：

```yaml
---
type: task            # 或 project（预期挂子卡）
status: inbox
priority: 2           # 1 最高，5 最低；不确定写 2
created: 2026-04-22
source: owner_request
---
```

**正文写三要素**（`card-spec.md` § Task 卡片三要素硬要求，缺任一不得创建）：
1. `## 目标` —— 一句话说清做什么
2. `## 用途` —— 产出给谁用、用来做什么决策/动作（决定验收标尺）
3. `## 验收标准` —— 要达到"能用"层次，不是"文件存在"层次

**别写** `assignee` —— triage 会派；**别写** `needs_owner` —— worker 判断要不要升级。

**什么时候出结果**：triage 每 15 min 扫 inbox，把卡搬到 active；work 每 5 min 抢一张跑一步。复杂任务会跑多轮，卡在 active 累积 `activity_result`。

**批量建卡的规矩**：别一次建 10 张。先建 1 张 parent project，让 triage 或 Pi 后续拆子卡（`pi-ops-handbook.md` §2.4）。

**快捷入口**：如果你在 PiBrowser Pi 会话里直接说"帮我调研 xxx" / "立个项目做 xxx"，Pi 会触发 `task-create` skill 自动建卡，不用你手写 frontmatter。

### §2.2 给自己加 todo（走 active，不走 triage）

**场景**：你要自己做这事，不是让 Pi 做。

**操作**：**直接**在 `Cards/active/` 新建 md（跳过 inbox，因为不需要 triage 判优先级）：

```yaml
---
type: task
status: active
assignee: user       # 关键：标记是你做的
priority: 2
created: 2026-04-22
---
```

正文写 1-2 句话说清楚要做什么即可（三要素是给 Pi 的任务用的，`assignee: user` 的卡豁免）。

**禁写** `needs_owner` / `response_type` / `decision_brief` —— 这些会误触发 Things Need You 弹卡（`pi-ops-handbook.md` §2.1）。

**通过 UI 加**：Home 上的"新建 todo"输入框直接写一行，engine 会帮你填 `assignee: user` + `status: active`。

---

## §3 晚上看 evening-brief

**产出**：每日 22:00 自动跑（`pi/tasks/evening-brief.md`），产物发到：
- 微信（通过 `notify.sh report`，简报摘要）
- `Pi/Output/daily-briefing/YYYY-MM-DD-evening.md`（完整版）

**内容大纲**：
- 今天完成：done 的卡列表（扫 archive 新增）
- 今天积压：Things Need You 当前数量 + aging 分布
- 明天计划：按 priority / due 排的候选
- Pi 状态：`pi-state-now.md` mood 向量变化

不想被打扰就在 `pios.yaml` 把 `evening-brief` enabled 改 false，或调 `notify.sh` level（见 [`./configure.md`](./configure.md) § 通知级别定制）。

---

## §4 常用 UI 操作

### §4.1 开 / 关 PiOS

- **开**：双击 `/Applications/PiOS.app`
- **关**：右上角退出或 `Cmd+Q`

**重要**：scheduler 是 cron 驱动的，**不是** PiOS.app 驱动。关掉 app 不影响 triage / work / sense-maker / reflect —— cron 每分钟仍然跑 `pios-tick.sh`（`~/.pios/tools/pios-tick.sh`）。app 只是 UI 窗口。

### §4.2 切 Vault

setup 时选过 vault 根（默认 `~/PiOS`）。后补改：编辑 `~/.pios/config.json`，改 `vault_root` 字段，重启 PiOS.app + 重装 cron（`crontab -l | grep pios-tick` 看是否更新）。

**不要**把旧 vault 的东西手动 mv 过去 —— Syncthing / 软链接 / 备份都会踩坑。要迁移先走 `vault-snapshot.sh` 备份，再在新 vault 做 install。

### §4.3 看 cron 日志

```bash
# 当前用户的 crontab
crontab -l | grep pios-tick

# tick 自己的日志
tail -f ~/PiOS/Pi/Log/pios-tick.log

# 最近的 run 记录（每次 task 跑一次产生一个 json）
ls -lt ~/PiOS/Pi/State/runs/ | head -20

# worker 日志（每次 work tick 追加一行 bullet）
tail -50 ~/PiOS/Pi/Log/worker-log-*.md

# 锁状态
ls ~/PiOS/Pi/State/locks/
```

### §4.4 暂停一个 agent

改 `Pi/Config/pios.yaml` 里对应 agent 或 task 的 `enabled: false` —— 下一分钟 tick 不再 dispatch，已在跑的跑完为止。

### §4.5 查一张卡的来龙去脉

- Obsidian 打开 vault 根目录 → 定位 `Cards/active/{卡名}.md`
- 看 frontmatter + 正文的"工作记录" / `activity_result`
- Pi 相关决策在 `Pi/Log/worker-log-*.md` 搜卡名

---

## §5 一周节奏

### §5.1 周一 weekly-wrap-up

Pi 每周一早上自动跑 `weekly-wrap-up` task，产周报：
- 上周完成 vs 遗留
- `owner/Profile/` 相关字段是否需要更新
- 下周候选

产物在 `Pi/Output/weekly/YYYY-Www.md`，走 `notify.sh report` 推微信。

### §5.2 每月 monthly-reflection

月初 Pi 跑 `monthly-reflection` task，做一次深度反思：
- 过去一个月 mood 向量走势
- 大方向卡（`Cards/active/` 长期项目）的推进状态
- 产出 1-3 张 `Cards/inbox/reflect-*.md` 候选改进项

---

## §6 异常时先看这些

| 症状 | 先看 | 权威 |
|---|---|---|
| Home 啥都不刷新 | `crontab -l` 是否有 pios-tick；`tail ~/PiOS/Pi/Log/pios-tick.log` | [`./troubleshoot.md`](./troubleshoot.md) |
| TNY 一张卡点"已完成"后又冒出来 | 卡 frontmatter `interaction_round` 是否 > 1（worker 有后续问题） | `pi-ops-handbook.md` §2.5 |
| 卡卡在 active 不动 | `blocked_on` 字段有没有值 | `card-spec.md` § blocked_on |
| 微信收不到通知 | openclaw 登录态：`cat ~/.config/openclaw/auth-profiles.json` | `feedback_openclaw_binary_not_auth.md` |
| claude auth 401 | 手动 `claude auth login`；**不要**手动同步 token | `feedback_auth_no_auto_sync.md` |

---

## 相关权威源

- [`./concepts.md`](./concepts.md) —— 概念字典
- [`./configure.md`](./configure.md) —— 定制开关
- [`./troubleshoot.md`](./troubleshoot.md) —— 故障救急
- [`../components/things-need-you.md`](../components/things-need-you.md) —— TNY 9 按钮权威表
- `Pi/Config/card-spec.md` —— Card 字段 + Task 三要素
- `Pi/Config/pi-ops-handbook.md` —— Pi 原话翻译层
- `Pi/Config/notification-spec.md` —— 通知 5 级
