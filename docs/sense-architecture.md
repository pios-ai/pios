# Sense Architecture (v1)

**Status**: P1/P3A-G/P3A.3/P2 已落地 · P3D.2 未做 · P4 规划 ready 实施待下 session
**Date**: 2026-04-21
**Related**: [verify-scratch-pad-p1](../../../Cards/active/verify-scratch-pad-p1.md) · [verify-sense-layer-p3](../../../Cards/active/verify-sense-layer-p3.md)

## 实施状态

| Phase | 内容 | 状态 |
|---|---|---|
| **P1** | Scratch Pad（目录 + 后端 API + Home 独立 tab + markdown 预览 + ⌘N/⌘V） | ✅ 2026-04-21 |
| **P3A** | pios.yaml schema migration（agent.category · sense.pipelines · sense.radars） | ✅ 2026-04-21 |
| **P3B** | Home → Team/Sense sub-tab（Pipeline 6 / Radar 5 卡片展示） | ✅ 2026-04-21 |
| **P3C** | toggle enabled / edit config modal / view output modal | ✅ 2026-04-21 |
| **P3D.1** | marketplace 占位（5+5 条可安装，点击提示 P3D.2 待做） | ✅ 2026-04-21 |
| **P3D.2** | 真正的一键安装 pipeline/radar 模板（Notion/Gmail/RSS/...） | ⏳ 未做 |
| **P3E** | 用户自建 Radar 表单（名字/ID/问题/cron/project）→ 写 Pi/Radars/ + yaml 双写 | ✅ 2026-04-21 |
| **P3F** | Pi agent 归位（Team/Agents + Team/Tasks 过滤）· maintenance hidden；后部分回滚：**Tasks 恢复全显 · Agents 恢复全显** | ✅ 2026-04-21（含回滚） |
| **P3G** | **Pi-Plus 撤并入 Pi**；Pi sub-tab 两分区（是什么 A/B/C/D/E · 做什么 F 任务 / G Pipeline / H Radar）；Team 栏回 4 个 sub-tab | ✅ 2026-04-21 晚 |
| **P2** | diary-engine Step 1D 扩到 Scratch/ + --folder 参数 + pi_ingested 回写 | ✅ 2026-04-21（prompt 已改，下次 01:30 生效） |
| **P3A.2** | pios-tick.sh 切 sense.* 为事实源 | ❌ 不做（双写方案已 work，切换零收益） |
| **P3A.3** | scout/maintenance agent 真删除 · scout.tasks → intel · maintenance.tasks → pi · sense.radars.big-thing/claude-leak-monitor.task_ref → intel/* · pi 合并 maintenance capabilities | ✅ 2026-04-21 晚（Q3 决议：prompt 文件路径保留不迁，Pi/Agents/scout + maintenance workspace 目录保留） |
| **P4** | Profile 认知层 + .pending-updates.json 审批 UI | ⏳ 规划 ready（validator Rule 8+9 已预埋）· 实施待下 session |

---

## 0. TL;DR

PiOS 的核心是 Pi（kernel）。围绕 Pi 的四层本体论：

```
Direction   意图层    · 目标 / alignment
────────────────────────────────────
Kernel      pi (+ 原 maintenance)      必装
Execution   做事的 agents             少且稳
Sense       感知层                     多且动态 · 可安装
  ├ Pipeline   被动订阅（已知源 → 定时拉）
  └ Radar      主动扫描（开放问题 → 定时扫）
Cognition   Profile (P4)              认知沉淀
────────────────────────────────────
Infra       runtimes / plugins / services / infra-tasks
```

**Agent vs Pipeline/Radar 的分界线**：Agent 有 SOUL（人格）+ 独立权限。Pipeline/Radar 无 SOUL，借 runner agent 的身份执行。

---

## 1. 核心概念

### 1.1 Agent 分三类

| category | 示例 | 特征 | UI 归属 |
|---|---|---|---|
| `kernel` | pi | 必装，PiOS 的内核 | Overview 顶部常驻 |
| `execution` | life · creator · (未来 writer) | 有 SOUL，做具体事，有独立权限 | Team tab |
| `sense-runner` | pipeline · intel · hawkeye | 执行壳，为 Sense 提供身份/权限 | **不在 UI 显示**（yaml 内部） |

### 1.2 Sense 两种模式

| 维度 | Pipeline | Radar |
|---|---|---|
| 触发 | pull on schedule from known source | scan on schedule for signal on open question |
| 输入 | 已知数据源（文件夹/API/DB/MCP） | 开放问题（自然语言） |
| 产物 | 结构化采集产物 | 洞察报告 |
| 例子 | 微信 / 健康 / 照片 / 对话 | AI 趋势 / 大路径 / 电商选品 |
| 难度 | 复杂（每个源要特殊 collector/plugin） | 简单（多数 radar = question + web-search + AI） |
| 用户能自建？ | 简单的可以（文件夹/RSS/通用 API） | 几乎都可以 |

### 1.3 requires 机制

Pipeline/Radar 只管"元数据 + 合成 prompt"（轻）。采集重活由 **能力（plugin 或 MCP）** 承担。pios.yaml 已有两个能力源：
- `plugins:` 顶级 section — PiOS 级插件（wechat / health / photos / ecommerce / ...）
- `infra.mcp:` — MCP 工具（vault / web-search / browser / shell / ...）

```yaml
sense:
  pipelines:
    wechat-digest:
      requires: [wechat]         # plugin
    world-feed:
      requires: [web-search]     # MCP
```

安装流程：用户点"安装 pipeline" → 检查 `requires` → 缺的能力先装（若涉及认证走 auth-manager）→ pipeline 启用。

**校验规则**：`requires` 里的每一项必须在 `plugins ∪ infra.mcp` 里找到（两者有重叠，只要任一 section 命中即可）。

---

## 2. schema 设计

### 2.1 agent 加 category

```yaml
agents:
  pi:
    category: kernel
    required: true
    # 原 maintenance 的 tasks 合入：
    tasks:
      maintenance: { ... }
      token-daily-summary: { ... }
      # 原有 triage/work/sense-maker/reflect/...

  life:
    category: execution
  creator:
    category: execution

  pipeline:
    category: sense-runner
    hidden_from_team_ui: true    # UI 不显示为 Team 成员
  intel:
    category: sense-runner
    hidden_from_team_ui: true
  hawkeye:
    category: sense-runner
    hidden_from_team_ui: true
    project: ai-ecommerce

  # maintenance: 删除（合入 pi）
  # scout: 删除（两个 task 迁出）
```

### 2.2 新增 `sense:` 顶级 section

```yaml
sense:
  pipelines:
    wechat-digest:
      name: 微信
      icon: 📱
      category: messaging
      runner: pipeline
      requires: [wechat]
      source:
        type: database
        label: 微信加密 DB
        auth_required: true
      output:
        path: owner/Pipeline/AI_Wechat_Digest/
        schema: daily-md
      downstream: [diary-engine, sense-maker]
      schedule: 7 0 * * *
      prompt: Pi/Pipelines/wechat-digest/prompt.md    # 新位置
      installed: true
      enabled: true
      built_in: true

    # 其他 7 条（health / photo-diary / ai-diary / world-feed / user-status / diary-engine / leak-monitor）
    # leak-monitor 从 scout 迁来（它是扫外界信号，但方向反过来——从 Radar 降级为 Pipeline？）
    # ⚠ 待定：见审计 Q1

  radars:
    ai-trends:
      name: AI 趋势雷达
      icon: 🔍
      category: tech-trends
      runner: intel
      requires: [web-search]
      question: |
        2026 AI 趋势 + Claude 生态变化。
        重点关注：新模型发布 / 新能力 / 开源进展 / 定价变化。
      output: Pi/Output/intel/
      downstream: [sense-maker]
      schedule: 31 1 * * *
      prompt: Pi/Radars/ai-trends/prompt.md    # 新位置
      installed: true
      enabled: true
      built_in: true

    big-thing:
      name: 大路径扫描
      icon: 🧭
      runner: intel
      requires: [web-search]
      question_ref: Pi/Config/alignment.md
      output: Pi/Agents/scout/workspace/big-thing-daily-scan/
      schedule: 45 1 * * *
      prompt: Pi/Radars/big-thing/prompt.md
      built_in: true

    hawkeye-amazon:
      name: 亚马逊选品雷达
      icon: 🦅
      runner: hawkeye
      requires: [web-search, browser]
      project: ai-ecommerce              # ← project 绑定
      output: Cards/active/hawkeye-radar.md
      schedule: 0 9 * * 1,3,4,5
      prompt: Pi/Radars/hawkeye-amazon/prompt.md
      built_in: true
```

### 2.3 Scratch 的位置

**Scratch 是"0 号 pipeline"**（source=user typing, schedule=realtime）。但交互特殊（高频编辑、粘图），**UI 上保持独立最右 tab**。Sense tab 顶部放一行"Scratch · N 条待摄入 →"作为快速入口。

---

## 3. Home Tab 结构（P3G 重构后 · 2026-04-21 晚）

```
主 tab 栏：
  Overview | Direction | Team | Resources | Operation | ✎ Scratch

Team sub-tab 栏（工程视图 + 产品视图合并到 Pi 内部）：
  ✦ Pi | 👥 Agents | ⚙ Tasks | 🖥 Hosts

✦ Pi sub-tab（产品视图，两大分区）：
  ═══ Pi · 是什么 ═══     ← 认知
    A · 当下
    B · 身份
    C · 角色
    D · Owner 配置
    E · 对话历史 (pi-main)

  ═══ Pi · 做什么 ═══     ← 能力
    F · Pi 任务 (pi + maintenance · 10 条卡片)
    G · Pipeline (6 条 · 被动订阅)
    H · Radar (5 条 · 主动扫描 + 新建 Radar 按钮)

👥 Agents / ⚙ Tasks（工程视图，全显示）：
  所有 agent / 所有 task，不过滤 hidden_from_team_ui / category
```

**关键变化**：
- 原 Home 顶级 `Sense` tab 已撤 · Pipeline/Radar 归位到 Pi sub-tab 的"做什么"分区
- Pi kernel 的 tasks + Pipeline + Radar 都是 **Pi 能力**，同一层级展示（卡片）
- Pi 自身（身份/角色/Owner/对话）是 **Pi 认知**，用 section 折叠
- Agents/Tasks 是工程视图，全显示（调试/诊断用）
- 每张 Sense 卡片 4 按钮 `[● 启用] [▶ 手动] [📄 产物] [⚙ 配置]`，跨 iframe 调 parent pios-home 的 modal 函数

---

## 4. 迁移路径（P3A → P3E）

**不破坏现有调度**——pios-tick.sh 分阶段演进。

### P3A: schema migration（yaml 层）

1. pios.yaml 新增 `sense:` 顶级 section，填 7 条 pipeline + 4 条 radar 元数据（leak-monitor 归 radar）
2. 每个 agent 加 `category` 字段
3. `maintenance` agent 两个 task 搬进 `pi.tasks`，maintenance agent 删除
4. `scout` agent 两个 task 拆：`big-thing-daily-scan` → sense.radars.big-thing（runner=intel）；`claude-code-leak-monitor` → sense.pipelines.leak-monitor 或 sense.radars.leak-monitor（⚠ Q1 待定）。scout agent 删除
5. 原 `pipeline` agent 的 `tasks:` section **清空**（所有 task 搬进 sense.pipelines）
6. `hawkeye` agent 加 `hidden_from_team_ui: true` + `project: ai-ecommerce`，`hawkeye-worker` task 搬进 sense.radars

**pios-tick.sh 改动**：新增遍历 `sense.pipelines[]` 和 `sense.radars[]`，把它们当 task 跑（runner 字段决定用哪个 agent 的权限）。

### P3B: Home Sense tab（UI 层）

1. 主 tab 栏加 `Sense`（位置：Team 和 Resources 中间）
2. Sense 下 2 sub-tab：Pipeline / Radar
3. 每条 pipeline/radar 一张卡片（统一组件，只是 source vs question 字段展示不同）
4. Team tab 按 `category` 过滤，只显示 execution + kernel agent；sense-runner 隐藏

### P3C: 手动触发 + 开关 + 基础配置

- `[▶ 手动]` 复用现有 `/pios/task/run`（把 sense entry 包装成 task）
- `[enabled ●]` toggle 改 yaml `enabled` 字段，pios-tick.sh 读
- `[⚙ 配置]` 弹窗编辑 cron / prompt path / requires

### P3D: marketplace skeleton

Sense tab 顶部加"可安装"区（先 placeholder）：
```
[📝 Notion]  [✉ Gmail]  [🐦 X]  [🎙 播客]  [📰 RSS 订阅]
```
点击 → "即将支持" + 上报意愿。实际安装逻辑 P3D.2 做。

### P3E: 用户自建 Radar

`[+ 新建 Radar]` 按钮 → 表单：

```
名字 · 图标
问题（多行自然语言）
节律（cron 或 每天/每周/每小时）
产出路径（默认 Pi/Output/radar/<id>/）
关联 project（可选下拉：无/ai-ecommerce/...）
下游（勾 sense-maker / 勾进 daily briefing）

[ 安装并启用 ]
```

后端：
1. 写 `Pi/Radars/<id>/manifest.yaml` + `Pi/Radars/<id>/prompt.md`（prompt = 通用模板 + 用户的 question）
2. 在 `pios.yaml sense.radars` 加一条（atomic write）
3. 下一个 pios-tick 开始调度

---

## 5. 审计

### 5.1 对账表（方案 vs 现状）

| 方案概念 | 现状 | 性质 |
|---|---|---|
| `category: kernel/execution/sense-runner` | agent 无 category 字段 | [新增] schema 字段 |
| `pi` 吸收 maintenance | `pi.tasks` 有 6 个 task，`maintenance` 独立 agent 2 个 task | [合并] maintenance → pi |
| `sense:` 顶级 section | 无，所有 task 在 `agents[].tasks[]` 下 | [新增] yaml section |
| 7 条 pipeline 元数据 | pipeline agent 有 7 个 task | [改造] 7 条映射（task_ref 指向原 task） |
| 4 条 radar 元数据 | intel 1 + scout 2 + hawkeye 1 = 4 个 | [改造] 4 条映射到 sense.radars |
| 3 条 radar 元数据 | intel 1 task + scout `big-thing-daily-scan` + hawkeye 1 task = 3 个 | [改造] 3 条迁入 sense.radars |
| `runner` 字段 | 无此概念 | [新增] schema 字段 |
| `requires` 字段 | `plugins:` section 已有，但 task 不声明依赖 | [新增] schema 字段，引用现有 plugins |
| `project` 绑定 | agent 级有 `projects:[]`，task 级无 | [新增] task/sense-entry 级 project 字段 |
| `hidden_from_team_ui` | 无 | [新增] UI 过滤标记 |
| pios-tick.sh 遍历 sense.* | 只遍历 `agents[].tasks[]` | [改造] bash 脚本加 20-40 行 |
| Home Sense tab | 无 | [新增] UI |
| Home Team 按 category 过滤 | 显示所有 agents（8 个） | [改造] 加过滤条件 |
| 用户自建 Radar | 无 | [新增] 后端 API + UI 表单 |
| scout agent | 存在，2 个 task | [删除] 两个 task 迁走后删 agent |
| maintenance agent | 存在，2 个 task | [删除] 两个 task 并入 pi 后删 agent |
| Profile 写权限（P4） | 全局无人可写 | [P4 再说] |

### 5.2 10 项风险审计

**Q1 · leak-monitor 归 Pipeline 还是 Radar？** ⚠ 待你拍板
- 昨天我说 Pipeline（被动监听），后来改 Radar（扫信号）
- 重新看：它的行为是"用 web-search 扫'有人在哪里谈 Claude leak'"——**动作是主动 scan**
- 但"Claude leak" 是一个**固定主题**，不是开放问题
- **我的建议**：归 **Radar**（问题固定不影响，动作才是本质）。leak-monitor 就是一个"订阅了一个特定话题的 radar"。

**Q2 · 双跑风险** ⚠ 必须解
- P3A 期间，yaml 里若 `pipeline.tasks.daily-wechat-digest` 和 `sense.pipelines.wechat-digest` 同时存在，pios-tick.sh 会跑两遍
- **解法**：pios-tick.sh 改造时加 schema 校验——**一个 task prompt path 只能在一个地方注册**，重复报错
- 迁移脚本先验证、再写；失败回滚

**Q3 · prompt 路径迁移** ⚠
- 方案写 `Pi/Pipelines/<id>/prompt.md`（新位置），但现有 prompt 在 `Pi/Agents/pipeline/tasks/daily-wechat-digest.md`
- 迁文件成本：git mv + 更新 yaml 引用；diary-engine prompt 也有硬编码路径要跟
- **建议**：**prompt 路径暂不迁**，sense.pipelines 直接 reference 原位置 `Pi/Agents/pipeline/tasks/daily-wechat-digest.md`。等 P3E（用户自建）再用新位置 `Pi/Radars/<id>/`。这样迁移成本 = 0

**Q4 · pios-tick.sh 改造范围**
- 现有 634 行 bash（已扫过）。遍历 `agents[].tasks[]` 的代码集中在中段
- 加遍历 sense.* 估计 30-50 行（依赖/锁/gate/catch-up/failover 都能复用）
- ⚠ 必须保留 `try_acquire_lock` 和 `depends_on`
- 风险：bash yaml 解析（用 yq）能不能正确读嵌套 sense.*.* ——**需先写 dry-run 测试**

**Q5 · Syncthing 同步**
- 新增目录 `Pi/Radars/<id>/`（manifest + prompt）会走同步——OK
- 新增目录 `Pi/Pipelines/<id>/`（P3E 之后才真正用，P3A 不用）
- 用户自建 radar 写入时必须原子（tmp + rename），已是 `feedback_atomic_file_write.md` 红线
- ✅ 无新 .stignore 改动

**Q6 · requires 和现有 plugins section 的关系**
- 现状：agent 有 `plugins: [...]` 字段（声明依赖的 plugin）；task 无
- 方案：sense entry 加 `requires`
- 冲突：同一个 runner agent 的多条 pipeline 可能需要不同 plugin——agent 级声明是"我可能要用的"，entry 级声明是"这条必需"
- **解法**：entry 级 `requires` 是**硬要求**（缺一装不了）；agent 级 `plugins` 是**可能用到**。两者并存不冲突。

**Q7 · project 绑定**
- hawkeye 现在 agent 级有 `projects: ['ai-ecommerce']`，task 级没有
- 方案：sense entry 级加 `project: ai-ecommerce`
- UI：Radar 卡片上 badge 显示 `project:ai-ecommerce`，可按 project 过滤
- 执行时：runner 加载对应 project 的 DOMAIN.md / project-status.md 作为 context
- **新增机制**：pios-tick.sh 跑 task 时若 entry 有 project 字段，自动注入 `Projects/<project>/` 的 context——这个要小改 prompt 注入逻辑（10 行）

**Q8 · UI 层和现有 Tasks sub-tab 共存**
- Tasks sub-tab（Team 下）原本显示所有 task（含 pipeline/intel/...）
- 改造后：Tasks sub-tab 按 `agent.category` 过滤，只显示 execution + kernel 的 task（原 pipeline/intel/scout 的 task 不在这里显示，因为已搬到 sense.*）
- ⚠ 兼容：`category` 字段若缺省，默认 execution（保证旧 agent 不消失）
- Tasks sub-tab 的现有"按 agent 过滤"功能保留，但 agent 下拉不再包含 sense-runner

**Q9 · 回滚路径**
- P3A 写入 yaml 前，备份到 `Pi/State/pios.yaml.pre-sense-migration.backup`
- `vault-snapshot` 每日备份 yaml（已在 infra-tasks）
- 若 pios-tick.sh 报错 → auto-fallback 到上一版 yaml（现有机制：`.pios-yaml-last-valid`）
- UI 层回滚：主 tab 栏移除 Sense 按钮即可（不删数据）

**Q10 · Radar 的 runner 如何选**
- 用户自建 radar 时，默认 `runner: intel`（通用调研 agent）
- 若指定 project → `runner: hawkeye`（若 project=ai-ecommerce）
- 未来若新增 project → 新增对应 sense-runner agent
- ⚠ 发现：**"新装一个 project" 目前没有对应 sense-runner 机制**——owner 方案里"可安装"要真正落地还要一层"sense-runner 即创建"，这个是 P3D.2 的范畴

---

## 6. 实施工作量估计（粗）

| Phase | 工作量 | 依赖 |
|---|---|---|
| P3A schema migration | 中（写 yaml + dry-run 测 + 校验脚本） | - |
| P3A pios-tick.sh 改造 | 中（30-50 行 bash） | yaml dry-run 通过 |
| P3B Home Sense tab + 卡片 UI | 中（PiBrowser 前端 + 新 HTTP endpoints） | P3A 完成 |
| P3C 手动触发 / 开关 / 配置 | 小（复用现有 /pios/task/run） | P3B |
| P3D marketplace skeleton | 小（placeholder） | P3B |
| P3E 用户自建 Radar | 中（表单 + 写文件 + yaml 更新 + 原子） | P3C |

**不动的**：P1 Scratch（已完成）、P2 diary-engine 改造（未动）、P4 Profile（待 P4）。

---

## 7. 决议（2026-04-21 owner 拍板）

- **Q1 · leak-monitor = Radar** ✓（动作是主动 scan，问题固定不影响本质）
- **Q3 · prompt 路径不迁** ✓（sense entry 直接 reference `Pi/Agents/pipeline/tasks/*` 原位置；P3E 用户自建 radar 才用新 `Pi/Radars/<id>/`）
- **Q10 · project 和 runner 是两件事**：
  - `project` 用户可选；绑了会自动加载该 project 的 DOMAIN context + 产物进 project 目录
  - `runner` 后端自动（null → intel · ai-ecommerce → hawkeye · 未来 project → 对应 agent）
  - 用户表单里**没有 runner 字段**，只有 project
- **Output 路径规则**：

  | 类型 | 默认路径 | 说明 |
  |---|---|---|
  | radar + 无 project | `Pi/Output/radar/<id>/<YYYY-MM-DD>.md` | log 型 |
  | radar + project=`<p>` | `Projects/<p>/Radar/<id>/<YYYY-MM-DD>.md` | log 型 |
  | radar + dashboard 模式 | 用户/系统指定固定路径 | 每次跑更新同一文件（保留 hawkeye 现有 `Cards/active/hawkeye-radar.md`） |
  | pipeline | `owner/Pipeline/AI_*/` | 固定，不绑 project |

- **Schema 新增 `output.type`**：

  ```yaml
  output:
    type: log | dashboard
    path: auto | <absolute path>
  ```

**P3A 开工。**
