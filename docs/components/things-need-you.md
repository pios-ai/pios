# Things Need You（Owner Queue）

> Part of [PiOS Architecture](../../ARCHITECTURE.md) — Home UI 的第一板块，Owner ↔ Pi 的唯一正式交接入口。
>
> 持续追踪问题与改进：发现新问题 → 先来这里记录 → 再考虑是不是要起新卡。

## 一句话

Cards 中 `needs_owner` 非空的那些，按 4 种 queueType（alert / respond / act / check）分流到 Home 顶部条，提供对应控件让 owner 一次给出回复，写回 `owner_response`，然后 worker 下一轮 pickup。

## 契约字段（card frontmatter）

| 字段 | 写入方 | 清除方 | 作用 |
|---|---|---|---|
| `needs_owner` | worker（triage / work / sense-maker） | engine（owner 点按钮后） | 4 合 1 队列入口：`alert` / `respond` / `act` / `check` |
| `needs_owner_brief` | worker | 同上 | 卡片一句话"要 owner 干什么"——**owner 看到的是这个**，不是 title |
| `response_type` | worker | — | 决定控件：`pick-one` / `pick-many` / `confirm` / `date` / `text` |
| `response_options` | worker | — | pick-one/many 的选项数组 |
| `interaction_round` | engine | — | 第几轮交互（每被 owner 回复一次 +1） |
| `owner_response` | engine | worker（下一轮 triage 消费后） | owner 的实际回复内容 |
| `owner_response_at` | engine | 同上 | 回复时间戳 |
| `_owner_response_prev` | engine | 同上 | 上一轮的 needs_owner 状态快照，用于 undo |

详见 [card-system.md](card-system.md) 和 `Pi/Config/card-spec.md`。

## 4 种 queueType

| queueType | 图标 | 含义 | 典型场景 |
|---|---|---|---|
| `alert` | 🔴 | 系统告警 | owner 需要意识到并处理（系统故障、auth 失效、关键信号） |
| `respond` | 💬 | 需要回复 | owner 填文本/选项，worker 下一轮读 `owner_response` 继续推进 |
| `act` | ✋ | 需要物理操作 | 改文件 / 买东西 / 听播报 / npm build；owner 手动完成后回 UI 点"已完成"写备注 |
| `check` | ✅ | 需要验收 | owner 审方案 / 验 output，通过后卡归档（task）或保持 active（project/never_archive） |

> 代码源：`backend/pios-engine.js:774-790`（`getOwnerQueue` 的 `nextStepMap` 字段仅用于 UI 文案，不是强制语义——实际语义看按钮调哪个后端，见下表）。

## 按钮 × 后端（权威表，改 UI 前必读）

> 任何 UI 行为都来自这张表里某个后端 action。看按钮 `onclick` → 对应函数 → 看下表语义。

| 按钮 | 显示条件 | 前端函数 | 后端 endpoint | 后端函数 | frontmatter 变化 | 卡状态/位置 |
|---|---|---|---|---|---|---|
| **✓ 通过** | check/review | `handleOwnerAction('approve')` | `/pios/approve-review` | `approveReview` | 清 `needs_owner` / `needs_owner_brief` / `response_type` / `response_options` / `blocked_on` / `deferred_until`；追加 `## Owner 审批` 段 | task: `status=done` + 移 archive；project / `never_archive:true`: 保持 active |
| **↩ 要修** | check/review | `handleOwnerAction('rework')` | `/pios/rework-review` | `reworkReview` | `status=active`，清 needs_owner + blocked_on，追加 `## Owner 反馈` 段 | 留 active，worker 下轮重做 |
| **✕ 驳回** | check/review | `handleOwnerAction('reject')` | `/pios/respond-to-owner` | `respondToOwner('reject')` | 写 `owner_response='reject'` + `owner_response_at`，清 needs_owner，存 `_owner_response_prev` | 留 active，worker 下轮读 owner_response 处理 |
| **✓ 已完成** | act | `doCompleteAction(fn)` | `/pios/respond-to-owner` | `respondToOwner('completed')` | 同上，`owner_response='completed'` + comment 存到正文 | 留 active，worker 下轮验证 |
| **💬 回复** | respond | `handleOwnerAction('respond')` | `/pios/respond-to-owner` | `respondToOwner(payload)` | 写 owner_response（文本/选项/日期/confirm），清 needs_owner | 留 active，worker 下轮处理 |
| **⚡ 处理** | alert | 同上（走 respond） | 同上 | 同上 | 同上 | 同上 |
| **📋 转入待办** | **全部** | `todoAddOrReschedule(fn, {advanceDecision:true})` | `/pios/acknowledge-action` + `/pios/update-card` | `acknowledgeAction` → 改 `assignee=user` + `deferred_until` | **`assignee=user`**（Pi 不再管），设 deferred_until，清 needs_owner | 卡变 **My ToDos**（owner 自己接过去做） |
| **不做了** | **全部** | `promptDismissWithReason(fn)` | `/pios/dismiss-card` | `dismissCard` | `status=dismissed`，清 needs_owner + deferred_until，追加 `## 取消` 段（必填 4+ 字原因） | 移 archive |
| **⏸ 明天再说** | **全部** | `deferTomorrow(fn)` | `/pios/defer-card` | `deferCard(filename, tomorrow)` | **只写 `deferred_until=明天`**，其他不变 | **assignee 保持 Pi**，24h 后卡重新出现在 Things Need You |
| **📞 Call Pi** | Home 顶部条右上角（全部 queueType） | `callPiOnCurrentDecision()` → `callPiOnCard(fn)` | `/pios/call-pi` | `pios:call-pi` → renderer `createSession` + setTitle `NYC:{filename}` + `sessionSetGroup("Things Need You")` + `expandSidebar` + sidebarInput.sendMessage | 无（不改卡，只把 title/brief/queueType 拼进 prompt 发给 Pi） | **Home 留在原位**（BrowserView 不移除），**拉出右边栏**起一条新会话（title = `NYC:{filename}`，归到 "Things Need You" 分组，**不进 pi-main**），Pi 在右边栏读卡、驱动后续、最后帮 owner 按其他按钮收尾 |

### 关键区别（容易搞错）

- **⏸ 明天再说**：assignee 保持 Pi，明天 Pi 继续盯着。
- **📋 转入待办**：assignee=user，变成 **owner 自己的 My ToDos**。"take it over" 的方向是 **owner 接手**，不是 Pi 接手。
- UI 里**没有**"让 Pi 自己领走做方案"的按钮。如果一张卡本就该是 Pi 自己做（worker 误升级成 needs_owner），正确路径是 worker/triage 下轮修 frontmatter，不是 owner 点按钮。这是个已知缺口（见下）。

## 5 种交互控件（response_type）

| response_type | 控件 | 示例 |
|---|---|---|
| `pick-one` | 单选按钮列表 | "选一条路径" |
| `pick-many` | 多选 checkbox | "勾选你认可的几条观点" |
| `confirm` | 大字 brief + 两个按钮（批准 / 驳回） | "要不要在 pios.yaml 加这条 allow 规则？" |
| `date` | 日期 picker | "几号之前需要决定？" |
| `text`（或空）| textarea | 开放文本回复 |

> 代码源：`pios-home.html:6410-6700`。

## UI 布局（Home Overview Tab 顶部条）

```
┌─────────────────────────────────────────────┐
│  N THINGS NEED YOU  ›           [📞 Call Pi] │
│                                             │
│  [需要验收] [P2]                             │
│  卡片标题                                     │
│  needs_owner_brief（一句话）                  │
│                                             │
│  [✓ 通过] [↵ 要修] [✗ 驳回] [转入待办]       │
│  [不做了] [⏸ 明天再说]                       │
│          [◀] [▶]  ← 左右翻 N 张              │
└─────────────────────────────────────────────┘
```

> 右上角的 **📞 Call Pi** 是"我懒得自己搞"的兜底入口：点了**拉出右边栏 + 新起一条会话**（Home 留在原位、BrowserView 不移除；title = `NYC:{filename}`，归到 "Things Need You" 分组，**不进 pi-main**，避免污染主线），Pi 读卡、能做的直接做、不能的一步步告诉 owner，做完再帮 owner 按上面的按钮收尾。不改卡 frontmatter，只发 prompt。卡处理完这条会话就归档/删掉。
>
> 注：`sendMessage` 首条消息会用消息首行自动命名 session，所以 call-pi 把 title 显式设成 `NYC:{filename}` 后会被守卫（只在 title 是默认 `新对话` 时才自动覆盖，见 renderer/app.js `sendMessage`）。

按钮因 queueType 而异（`pios-home.html:6351-6390` 根据 `qt` 生成 `btns` HTML）：
- `check` / `review` → ✓通过 ↵要修 ✗驳回
- `respond` → 填写回复
- `act` → ✓已完成（必填 comment）
- `alert` → 标为已处理

详情点进去会用 `openCardDetail({fromOwnerQueue: true})` 路由到同一份 markdown 渲染，顶部加 brief 横幅（`pios-home.html:8965`）。

## 历史问题 + 改进时间线

新增条目时往最上面插，保持倒序。

---

### 2026-04-20 · 错分类：功能需求被当成 `check`，且 UI 无"Pi 领走"按钮 ⏳

**触发**：`Cards/active/things-need-you-permission-quick-approve.md` 带 `needs_owner: check` 出现在队列。

**根因**：Pi triage 把 owner 的"功能需求反馈原话"当成了 `needs_owner` 入口，没区分：
- **owner 是输入方**（提需求）→ 应 `ready_for_work: true`，Pi 自己领走做方案
- **owner 是验收方**（审 Pi 的产出）→ 才是 `needs_owner: check`

**双重影响**：
1. 卡被错升级，owner 在 Things Need You 看到一条"Pi 自己该做的设计"
2. **UI 里没有"让 Pi 领走"的按钮**——现有 6 个按钮里最接近的是 ⏸ 明天再说（只改 deferred_until，不改分类）；📋 转入待办反而是 owner 自己接，方向错；✕ 驳回写的是 `owner_response='reject'` 语义含糊

**处置**：
1. 本条卡需手动在 Obsidian 改 frontmatter（删 `needs_owner` + `needs_owner_brief`，加 `ready_for_work: true`），或让 triage 下轮修
2. triage 规则需补：建 needs_owner 卡前判断"owner 是输入方还是验收方"
3. **产品缺口**：是否该加"📤 让 Pi 自己做"按钮（写 `ready_for_work=true` + 清 needs_owner，卡留 active 进 Ready 队列）？待设计

---

### 2026-04-20 · 权限类 act 缺一键批准 + 自动写 pios.yaml ⏳

**触发**：`Cards/archive/reflect-2026-04-20-goal-progress-allow-rule.md` owner 回复：
> "这一类的权限的东西，能不能在Things need you里直接批了，有个明确的确认按钮，然后就行了，不要让我去手动添加。"

**问题**：当 reflect 产出"建议在 pios.yaml 的 X agent allow 加 `Write(Y)`"类卡片时，owner 目前流程是：
1. 在 Things Need You 看到这张 `needs_owner: act` 卡
2. 手动打开 `Pi/Config/pios.yaml` 找到对应位置
3. 复制粘贴那行 allow 规则
4. 回 UI 点"已完成" + 写备注

**目标**：提供"✓ 批准并自动写入"按钮 → engine 直接改 pios.yaml 加规则 → 卡片归档。

**设计约束**：
- Pi 红线不允许 pi agent 自己改 pios.yaml（这是 owner 明示纪律）
- 但 engine（Electron main 进程）可以——它是 owner 拥有的 UI 行为，不是 Pi 越权
- pios.yaml 原子写入已有模式（`feedback_atomic_file_write`）
- 需要结构化字段表达"要加哪条 allow 规则"——不能靠 NLP parse `decision_brief`

**拟用字段**（待 Pi 设计确认）：
```yaml
# frontmatter
needs_owner: act
response_type: confirm
owner_action: permission-allow-rule
owner_action_payload:
  agent: sense-maker
  rule: "Write(Pi/Log/goal-progress.md)"
```

**跟进卡**：`Cards/active/things-need-you-permission-quick-approve.md`（Pi 做方案）

---

### 2026-04-17 · 点【已完成】直接消失、缺 comment ✅

**owner 反馈原话**（在 `things-need-you-improvement` 卡）：
> 垃圾。我点这个【Things Need you还是特别糟糕】的已完成，直接就给我跳没了！完成也要给comment，忘记了吗？

**修复**：`pios-home.html` `doCompleteAction()` 改成先弹完成说明框，必填备注才能提交；`backend/pios-engine.js` `respondToOwner()` 把说明追加到 `### Owner 回复` section（card archive `things-need-you-improvement.md` tick 2）。

---

### 2026-04-16 · UI 粗糙、重复渲染、交互不分类 ✅

**owner 反馈原话**（`Cards/archive/things-need-you-improvement.md`）：
> Things Need you还是特别糟糕。比如点击【通过】，出来的东西极度粗糙，而且多点两次还会出现重复内容。在ThingsNeedYou里，我希望看到的是，单选、多选、填空，根据具体情况而出现，不是简单粗暴的把内容里的所有[]都列出来，这他妈简直是傻逼！我也希望里面如果附带报告，我可以直接点击查看报告。排版要精美，不要给我垃圾。【稍后提醒】现在要让我选日期，这个可以。但是增加一个【等明天】，直接defer到明天不用选日期。

**修复要点**（`things-need-you-improvement.md` tick 1）：
- 区分 5 种交互类型（`response_type`）
- 审批面板统一清理 transient UI + 单次提交 guard（`pios-home.html:6351+` overlay 不再累加）
- 从正文 `Pi/Output/...` 链接提取 output shortcut 按钮
- "稍后提醒" 加【等明天】快捷

---

## 已知待办（不一定有卡，先在这里 queue）

- [ ] 权限类 act 的一键批准 + 自动写 pios.yaml（见上 2026-04-20）
- [ ] triage 建 needs_owner 卡前区分"owner 是输入方还是验收方"
- [ ] UI 是否加 **📤 让 Pi 自己做** 按钮（当 owner 发现一张 `needs_owner` 卡是误升级、应是 Pi 自己的任务时，一键清 needs_owner + 写 ready_for_work=true）
- [ ] 是否应该把 `_owner_response_prev` 做成按钮级 undo（目前只有 frontmatter 记录，UI 无 undo 入口）
- [ ] queueType 是否该合并 `respond` 和 `act`？边界在实践中经常含糊（例：ai-sdr 的"买域名"是 act，但"告诉我你买完了"既像 act 又像 respond）

## 不变量

1. 卡有 `needs_owner` 必须有 `needs_owner_brief`（参考 [card-system.md](card-system.md) 不变量 #2）
2. owner 在 UI 点批准/驳回/完成 → engine 必须清掉 `needs_owner` + `needs_owner_brief`，写 `owner_response` + `owner_response_at`，记 `_owner_response_prev`
3. 同一张卡在 Things Need You 和 Review Queue 看到的 brief 必须一致（都读 `needs_owner_brief`）
4. UI 动作禁用"Pi 自己越权做的事"——pios.yaml 写入必须 engine 做，不是 Pi agent

## 相关文件索引

| 关注 | 读这个 |
|---|---|
| 队列聚合 | `backend/pios-engine.js:750-841`（`getOwnerQueue`） |
| 回复写入 | `backend/pios-engine.js:987-1060`（respondToOwner/approveReview 等） |
| UI 主条 | `pios-home.html:2479-2512`（Home Overview） |
| UI 按钮生成 | `pios-home.html:6351-6390`（6 个按钮按 queueType 分派） |
| Call Pi（右上角） | `pios-home.html` `callPiOnCurrentDecision` / `callPiOnCard`（showDecision 下方） |
| UI 交互控件 | `pios-home.html:6410-6700` |
| `doCompleteAction`（✓ 已完成） | `pios-home.html:8826` |
| `todoAddOrReschedule`（📋 转入待办） | `pios-home.html:8707-8774`（→ acknowledge-action + update-card，assignee=user） |
| `deferTomorrow`（⏸ 明天再说） | `pios-home.html:6716-6734`（只改 deferred_until，assignee 不变） |
| `promptDismissWithReason`（不做了） | `pios-home.html:3650-3690` |
| 详情 + brief 横幅 | `pios-home.html:8960-8972` |
| 卡 frontmatter 契约 | `Pi/Config/card-spec.md` + [card-system.md](card-system.md) |

## 变更影响

改 Things Need You 相关的东西，先过这张表：

| 若改... | 检查... |
|---|---|
| needs_owner 枚举值 | `pios-engine.js:774-790` + `pios-home.html:8265-8271` 图标 + 6351-6390 按钮 |
| response_type 枚举 | `pios-home.html:6410-6700` 每种控件 |
| 加新字段（如 owner_action） | card-spec.md + `respondToOwner` 写入路径 + UI 按钮 handler |
| queueType 排序规则 | `pios-engine.js:832-838`（priority ASC / staleDays DESC） |
