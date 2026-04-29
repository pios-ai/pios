---
title: PiOS 起步指南
audience: 刚装完 PiOS 的终端用户（macOS arm64）
updated: 2026-04-22
---

# PiOS 起步指南

> 面向刚在 macOS arm64 上装完 `PiOS.app` 的用户。开发者相关内容（构建、签名、维护）不在这份里 —— 读 [`../../INSTALL.md`](../../INSTALL.md) 的 "Maintainer Notes" 段落。
>
> 系统全景：[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)（五层架构权威）

---

## 1. 你装完 PiOS 看到什么

双击 `/Applications/PiOS.app` 第一次启动后，看到一个 **Setup Wizard 弹窗**。走完 wizard 会出现"Success"屏，点 "Start Using PiOS" 进入主界面 —— 顶部一行 Tab（Home / System 等），Home 页面三块内容（Things Need You / MyToDo / Recent Activity）。

同时在磁盘上产生这些东西（权威清单见 [`../../INSTALL.md`](../../INSTALL.md) §What PiOS Creates）：

- `~/.pios/config.json` —— 全局配置（owner_name + vault_root）
- `~/.pios/tools/` —— engine 脚本（包含 `pios-tick.sh`）
- Vault 根目录（默认 `~/PiOS`），包含：
  - `Cards/` —— 任务卡片（`inbox/` / `active/` / `archive/` 三个生命周期阶段）
  - `Pi/` —— 系统目录（`Config/` / `State/` / `Log/` / `Output/` / `Memory/` / `Agents/`）
  - `Projects/` —— 你的项目代码 / 产物
  - `{你的名字}/` —— 你的个人目录（`Profile/` / `Scratch/` 等）
- `Cards/inbox/welcome-to-pios.md` —— 一张欢迎卡，用来走通第一次 triage → work 流程

**设计哲学**：PiOS 所有状态都是文件，没数据库、没后端服务。agent 按 cron 定时跑，读写这些文件。跨机同步走 Syncthing。这意味着你关了 PiOS.app 系统还在跑（cron 驱动），也意味着所有"Pi 的记忆"都能在 Finder 里翻出来看（[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) §1 Design philosophy）。

---

## 2. 第一次开机：Setup Wizard 流程

Wizard 一共 4 步（权威流程见 [`../../INSTALL.md`](../../INSTALL.md) §Install Steps 第 6-9 步）：

**Step 1：Your name**
输入你自己的名字。这个名字会变成 `{owner}` 参数，一切 agent prompt、卡片 frontmatter 的 `assignee`、你的个人目录（`~/PiOS/{你的名字}/`）都拿它做路径。

**Step 2：Vault location**
默认 `~/PiOS`。留空即用默认；要自定义就填完整路径。

**Step 3：AI Runtime**
- `Claude Code CLI`：默认开，是 PiOS 的核心执行引擎
- `Codex CLI`：可选，需要单独装 codex 二进制

**Step 4：Plugins**
- 核心（必装）：`Vault` / `Shell` / `Web Search`
- 可选：`Browser` / `WeChat` / `Apple Health` / `Photos`

可选插件需要的前置条件（装不了就先不勾，之后再加）：
- `Browser` —— 已装 Chrome + Claude in Chrome 扩展
- `WeChat` —— OpenClaw binary 已装 + `~/.config/openclaw/auth-profiles.json` 有登录态
- `Apple Health` —— iOS 导出的 Health XML 路径
- `Photos` —— macOS Photos.app 已授权访问

点 "Install PiOS" → 等成功屏（显示 Vault 路径）→ 点 "Start Using PiOS" 进入主界面。

**如果 wizard 卡住或报错**：退出 app，删 `~/.pios/config.json` 后重开，重跑 wizard。删 `~/.pios/` 不会碰你的 vault 数据（vault 在另一个路径）。

---

## 3. 依赖让 PiOS 帮你装（Setup Wizard 第 0 页）

**PiOS 首次启动会自动检查 5 项依赖并帮你装**：Xcode CLT → Homebrew → Node.js 18+ → Python 3.12（NPC 语音用）→ Claude CLI。每项前面打 ✓ 或 ✗，缺的点「装」按钮。

用户这边要做三件事：
- Xcode Command Line Tools 第一次会弹 macOS "软件要求" 对话框，点「安装」等 5-15 min 下载
- Homebrew 装的时候会弹 macOS 原生密码框（请求管理员权限）
- Claude CLI 装完后，去 Terminal 跑一次 `claude auth login`（浏览器 OAuth），回到 PiOS 点「重新检查」

全 5 项 ✓ 后，"Install PiOS" 按钮才 enable。

**如果你想自己先装**（老用户 / CI 机），手动命令：
```bash
xcode-select --install                              # Xcode CLT（系统对话框）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node python@3.12
npm install -g @anthropic-ai/claude-code && claude auth login
```

**不要手动同步 token**。PiOS 的 auth 由 Claude CLI 原生管（Keychain + refresh token）。手动往 `~/.claude/.credentials.json` 塞东西 / 写环境变量 / 跨机 scp token 都会把认证写坏。2026-04-16 全局 401 事故就是这么来的 —— 需要重登只走 `claude auth login`（见 `Pi/Memory/MEMORY.md` 索引里的 `feedback_auth_no_auto_sync`）。

---

## 4. 装完了，验证什么

开一个终端，按这份 checklist 逐条跑（把 `~/PiOS` 换成你自己选的 vault 路径）：

```bash
# 1. 全局配置存在且含两个关键字段
cat ~/.pios/config.json | grep -E 'owner_name|vault_root'

# 2. Vault 目录存在
ls ~/PiOS

# 3. Welcome 卡在 inbox
ls ~/PiOS/Cards/inbox/welcome-to-pios.md

# 4. Engine 脚本在位
ls ~/.pios/tools/pios-tick.sh

# 5. cron 注册了（每分钟跑一次）
crontab -l | grep pios-tick
```

5 条全部通过，装机就成功了。任何一条不通 → 直接跳 [`./troubleshoot.md`](./troubleshoot.md) §2 "装完了但没看到 agent 在跑"。

---

## 5. 第一张卡发生了什么（用 welcome card 走一遍）

`Cards/inbox/welcome-to-pios.md` 是 starter 卡，用它看完整生命周期（权威 lifecycle 描述见 [`../../docs/components/card-system.md`](../components/card-system.md)）：

| 时间 | 发生什么 | 你看到什么 |
|------|---------|-----------|
| T+0 | cron 每分钟跑 `pios-tick.sh`，扫 `pios.yaml` 里注册的 agent | 无可见变化 |
| T+≤15min | `triage` agent 扫 `Cards/inbox/`，给 welcome 卡判 `type` + `priority`，搬到 `Cards/active/` | 卡从 `inbox/` 消失，出现在 `active/` |
| T+≤20min | `work` agent（每 5 分钟）选中这张卡，执行里面的任务 | 卡 frontmatter 多出 `activity_result`，正文末追加工作记录 |
| 执行过程中 | 如果 worker 判断需要你决策 → 提议升级 | triage 下一轮把 `needs_owner` 写上，Home "Things Need You" 顶部条出现这张卡 |
| 你点按钮响应 | engine 把 `owner_response` 写回卡 frontmatter，清 `needs_owner` | 卡从 Things Need You 消失 |
| 任务结束 | work 判 `status: done` → 下一轮 triage 搬 `Cards/archive/` | Home "Recent Activity" 出现完成记录 |

**关键纪律**（影响你看到的行为）：
- Worker 不能直接升级 `needs_owner`，只能在 `activity_result.proposed_needs_owner` 里提议，升级权归 triage 独占（L2 v3.1 R1 铁律，见 [`../components/card-system.md`](../components/card-system.md)）。这意味着"卡跳到 Things Need You"最慢要等一轮 triage（≤15min）。
- 卡归档不手动 `mv` —— triage 是唯一搬运工（`Pi/Config/done-protocol.md`）。

**想亲眼看每一步**：
```bash
# triage 运行记录（每 15min 一条）
ls -lt ~/PiOS/Pi/State/runs/triage-*.json | head -3

# worker 执行日志（每台机器分片）
tail -30 ~/PiOS/Pi/Log/worker-log-*.md

# 卡当前 frontmatter
head -30 ~/PiOS/Cards/active/welcome-to-pios.md 2>/dev/null || \
head -30 ~/PiOS/Cards/inbox/welcome-to-pios.md
```

---

## 6. Home 界面三块

PiOS.app 打开默认在 Home tab。从上到下三块：

### 6.1 Things Need You（Pi 要你决策的）

`Cards/active/` 里 `needs_owner` 非空的卡都在这里，按 4 种 queueType 分流 + 9 种按钮响应。**权威表**（按钮显示条件、前端函数、后端 endpoint、frontmatter 变化）：[`../components/things-need-you.md`](../components/things-need-you.md)。

4 种 queueType 简表：

| queueType | 含义 | 典型场景 |
|-----------|------|---------|
| `alert` | 系统告警 | Auth 失效、服务宕机、安全异常 |
| `respond` | 需要回复 | Pi 问了一个选择题 / 填空题 |
| `act` | 需要物理操作 | 改个文件 / 买个东西 / 运行个命令 |
| `check` | 需要验收 | Pi 交了方案给你审 |

**两个最容易误解的按钮**（按 [`../components/things-need-you.md`](../components/things-need-you.md) + `Pi/Memory/` 里的 `feedback_ui_button_read_handler`）：
- **📋 转入待办** —— 意思是"Pi 不管了，这事我自己接"（`assignee: user`，移到 MyToDo）。**不是** "Pi 接过去做"。
- **⏸ 明天再说** —— 只改 `deferred_until`，`assignee` 保持 Pi；24 小时后卡自动重回 Things Need You。

### 6.2 MyToDo（你自己要做的）

`Cards/active/` 里 `assignee: user` 的卡。这是你自己 todo，和 Things Need You 无关。

**MyToDo vs Things Need You 区分**（2026-04-22 加进 `Pi/Config/pi-ops-handbook.md` §3.1 的对照）：

| 区别 | MyToDo | Things Need You |
|------|--------|-----------------|
| 字段 | `assignee: user` | `needs_owner: alert/respond/act/check` |
| 语义 | 你要做的事 | Pi 等你决策 |
| 来源 | 你自己加 / 从 TNY 点"转入待办"过来 | Triage 升级（worker 只能提议） |

### 6.3 Recent Activity（Pi 最近做了啥）

拉最近的 worker 活动 + 卡片状态变化。看今天一天 Pi 都跑了什么任务。

这一块读的是两个源：
- `Pi/Log/worker-log-{hostname}.md` —— 每个 work tick 的 bullet（多机分片，`-laptop-host.md` / `-worker-host.md` 各一份防 Syncthing 冲突）
- `Pi/State/runs/*.json` —— 每次 agent 执行的结构化记录

所以 Pi 的"记忆"是文件，随时能在 Finder 翻出来自己读（不需要 app 开着）。

---

## 7. 不会出错的操作

装完能跑起来的状态下，日常就用 UI，不碰命令行也行。真要看内部状态：

- **看整体状态**：PiOS.app 顶部切到 `System` tab
- **重启**：退出 PiOS.app 再开。Scheduler 是 cron 驱动的，和 app 开不开无关 —— `PiOS.app` 关了 triage/work 也继续每 1/5/15 分钟跑
- **暂停 agent**：把 `Pi/Config/pios.yaml` 里对应 agent 的 `enabled` 改成 `false`；下一分钟 tick 不再 dispatch
- **加一张卡**：直接在 `Cards/inbox/` 新建 `.md`，填 `type: task` / `status: inbox` / `created: YYYY-MM-DD`，triage 下一轮接手（≤15min）
- **让 Pi 发通知**：命令行里 `bash ~/PiOS/Pi/Tools/notify.sh info "消息"`。5 级分别走不同通道（critical/report 走微信，reminder/info 走 PiBrowser，silent 只写日志）。完整规范：`Pi/Config/notification-spec.md`

**不要做的事**（装完 1 小时内最常翻车）：

- 不要改 `Pi/BOOT.md` / `AGENTS.md` 或任何 `Pi/Agents/*/tasks/*.md`（这些是 agent 人格 + prompt，改了会让 agent 行为漂移）
- 不要手动 `mv` 卡片（让 triage 搬 —— `Pi/Config/done-protocol.md` 明确 triage 独占搬运权）
- 不要自己塞 `~/.claude/.credentials.json`（见 §3 "不要手动同步 token"）
- 不要在远程 Linux 节点跑 `tailscale down`（`Pi/Memory/` 有 `feedback_no_tailscale_down` —— 跑了自己就 SSH 不回去）
- 不要未经确认删任何文件 —— `Pi/` 下很多目录是 Pi 的长期记忆

---

## 8. 三个心智模型（习惯的思维切换）

从 Things / Todoist / Notion 过来的用户，前三天最容易在这三件事上翻车：

**① 不是你分派任务给 agent，是 triage 分派**

Todoist 里你自己拖卡、定优先级、标项目。PiOS 不是这样：你把卡扔 `Cards/inbox/`，triage 每 15 分钟扫一次，它来判 priority / 派 agent / 处理去重和 parent 关联。你手动塞进 `Cards/active/` 也能跑，但**会跳过 triage 的去重和关联**，同一件事可能被起多张卡。正常路径就是 inbox → triage 派。

**② "通知"不是事件日志，是 owner 专用的打扰**

后台每跑一个 task 都不发通知。默认留档到 `Pi/Log/worker-log-{host}.md` 和 `Pi/State/runs/*.json`，你主动开 app 才看到。只有 agent 显式调 `notify.sh` 才出声 —— 意思是值得打断你（`Pi/Config/notification-spec.md` §规则 2）。所以 PiOS.app 一整天安安静静不代表啥都没做，看 Recent Activity / run records 才知道实际量。

**③ Pi 自己的状态也在文件里**

Pi 当下的关注点、mood、对最近事件的态度，都写在 `Pi/Self/` 下的 md 里（reflect agent 每日 4 点更新）。你可以直接在 Obsidian / Finder 里读，和 Pi 对话也能问"你最近在想什么"让它读给你听。这不是装饰，是 Pi 运行时真的拿这些文件决策（优先级、要不要主动开口）。

---

## 9. 下一步读啥

看你接下来想干什么：

| 我想 | 读 |
|------|----|
| 理解 Card / Agent / Task / needs_owner 到底是什么 | `./concepts.md`（TODO: 需查，本次未建） |
| 学每天怎么用 PiOS | `./daily-flow.md`（TODO: 需查，本次未建） |
| 出问题了怎么救 | [`./troubleshoot.md`](./troubleshoot.md) |
| 看五层架构 | [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| 想改 PiOS 代码 | [`../../CLAUDE.md`](../../CLAUDE.md) + [`../development.md`](../development.md) |
| 看 Pi 操作手册（owner 原话 ⇄ PiOS 内部语义 ⇄ 步骤，15 场景） | `Pi/Config/pi-ops-handbook.md` |

---

## 相关权威源

- `Projects/pios/ARCHITECTURE.md` —— 五层架构
- `Projects/pios/INSTALL.md` —— 安装流程 + 已知限制
- `Projects/pios/docs/components/things-need-you.md` —— TNY 9 按钮 × 后端权威表
- `Pi/Config/card-spec.md` —— Card frontmatter SSoT
- `Pi/Config/notification-spec.md` —— 通知 5 级规范
- `Pi/Config/infra-topology.md` —— 5 台机器拓扑（多机用户必读）
- `Pi/Memory/MEMORY.md` —— Pi 已内化的 50+ 条教训索引
