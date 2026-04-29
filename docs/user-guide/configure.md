---
title: PiOS 定制与配置
audience: 装完 PiOS、想调整插件 / 通知 / 多机部署的终端用户
updated: 2026-04-22
---

# PiOS 定制与配置

> 面向已经跑起来的 PiOS，想开关插件、改通知级别、加多一台机器的用户。前提读过 [`./concepts.md`](./concepts.md)。
>
> 上游权威：
> - [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) —— 五层架构 + 文件归属模型（谁能改什么）
> - `Pi/Config/pios.yaml` —— 你自己的 vault 里那份就是权威
> - `Pi/Config/notification-spec.md` —— 通知 5 级
> - `Pi/Config/infra-topology.md` —— 多机拓扑

---

## §1 插件开关

### §1.1 查当前开了哪些

setup wizard 第 4 步你选过一轮，后续要看：

```bash
# 看 pios.yaml 的 plugins 段
grep -A 2 "^plugins:" ~/PiOS/Pi/Config/pios.yaml

# 或看 Pi/Plugins 目录里装了哪些
ls ~/PiOS/Pi/Plugins/
```

官方插件清单（ARCHITECTURE §3 Layer 3 Plugins）：`core`（必装）/ `health` / `wechat` / `photos` / `diary` / `ecommerce` / `content` / `intel` / `browser` / `location`。每个插件的 agent 和 task 见 `Pi/Self/pios-capabilities-overview.md` 一、二章。

### §1.2 开 / 关一个插件（不卸载）

改 `Pi/Config/pios.yaml` 对应 agent 或 task 的 `enabled` 字段：

```yaml
agents:
  hawkeye:
    enabled: false   # 关掉整个 agent（所有 task 一起停）

tasks:
  - id: daily-scripts
    enabled: false   # 只关一个 task，agent 其他 task 照跑
```

保存 → 下一分钟 `pios-tick.sh` 读新配置，已在跑的 task 跑完为止，不再 dispatch 新的。

**不要**直接删 `Pi/Plugins/{插件名}/` —— pios.yaml 还引用着，tick 会报错。要彻底卸载走 `pios-plugin.sh uninstall {插件名}`（Pi/Tools/ 里的脚本，ARCHITECTURE §3 Layer 1 Plugin Manager）。

### §1.3 加一个没装的插件

目前没有 UI 入口，手动走：

```bash
# 假设从 PiOS 官方分发装 health 插件
bash ~/.pios/tools/pios-plugin.sh install health
```

装完 tick 会自动识别 `Pi/Plugins/health/plugin.yaml` 里注册的 agent 和 task。每个插件对应的 agent 和 task 看 `Pi/Self/pios-capabilities-overview.md` 一、二章。

---

## §2 通知级别定制

### §2.1 5 级含义（快速回顾）

`Pi/Config/notification-spec.md` 是权威。5 级：

| level | 通道 | 用途 |
|---|---|---|
| `critical` | 微信 + PiBrowser | 系统故障、安全告警、死线 |
| `report` | 微信 | 日报、简报、任务完成 |
| `reminder` | PiBrowser 弹窗 + 语音 | 健康、运动、吃药 |
| `info` | PiBrowser | 一般通知 |
| `silent` | 仅写日志 | 不打扰 |

### §2.2 调整某个 task 的通知级别

task prompt（`Pi/Agents/{agent}/tasks/{task}.md`）里调 `notify.sh` 的 level 参数。举例：

```bash
# 原来
bash Pi/Tools/notify.sh report "intel-worker 完成"

# 不想微信收，改成只 PiBrowser
bash Pi/Tools/notify.sh info "intel-worker 完成"
```

**注意**：`Pi/Agents/pi/tasks/` 下的 4 个核心 task（triage / work / sense-maker / reflect）属于 Core Agents 层，改它们会影响 Home UI 行为（ARCHITECTURE §3 Layer 2 "Pi never modifies"）。其余 agent 的 task 可以自由调。

### §2.3 静默时段（Quiet Hours / Presence）

Pi 通过 ioreg 检测 Mac idle / active 状态（`docs/pi-speak-behavior.md` 三层门控）。晚上你睡了 Pi 不会打扰 —— chitchat / greet 都会被 presence 门挡住。

- **触发门**：`presence.status === 'present'` + `pi-mood.json.energy >= 0.6` + 4 个冷却门
- **手动"别烦"**：PiBrowser 里说"别烦了" / "安静"，Pi 会设 `pi-social.quiet_until` 到明天
- **彻底关 chitchat**：`pios.yaml` 关 `pi-chitchat` task

reminder 类通知（健康提醒）有独立的静默时段，配在 `Pi/Config/reminders.yaml`。

### §2.4 微信通道的硬规矩

**卡说"微信发 owner"时必须用 `critical` 或 `report`，不能用 `reminder`**（`reminder` 只到 PiBrowser 本地 toast/bubble，不走微信）。

踩坑记录：`feedback_notify_vs_wechat.md`（Claude 自动记忆；2026-04-22 find-remaining-NYC 卡把 reminder 当微信发，owner 实际没收到，卡自验通过但结果是假的）。

微信通道的详细限制见 `notification-spec.md` §规则：一天 `critical` + `report` 合计不超过 10 条。

---

## §3 多机部署

### §3.1 拓扑全景

`Pi/Config/infra-topology.md` 是你自己的机器清单权威。典型布局：

| 机器 | 角色 | 跑什么 |
|---|---|---|
| **laptop-host** | 指挥台 + 主执行 | PiOS.app、全部插件、交互会话、browser、TTS |
| **worker-host** | 批量执行 | cron + tick、intel / scout 批处理、GPU 任务 |
| **storage-host** | 数据堡垒 | Immich、pipeline-api、存储（不跑 pios-tick） |
| **vpn-host** | 公网跳板 | VPN + DERP relay，无敏感数据 |

每台跑自己的 `pios-tick.sh`，task 的 `host` 字段决定在哪台跑。分布式锁通过 Vault 同步（ARCHITECTURE §5）防止同一 task 双跑。

### §3.2 加一台从机（worker-host 模式）

高层步骤：

1. **Syncthing 同步 Vault** —— 把 `~/PiOS` 加到 Syncthing 共享，新机器订阅同一个 folder（`Pi/Config/infra-topology.md` § Syncthing）
2. **装 claude CLI + 认证** —— 每台独立 `claude auth login`（不要 scp token，`feedback_auth_no_auto_sync.md` / Claude 自动记忆）
3. **跑 installer** —— `pios-installer.js` 注意选"加入已有 vault"而非新建
4. **加 cron** —— `crontab -l | grep pios-tick` 确认注册
5. **给 task 指派 host** —— 在 `pios.yaml` 对应 task 加 `host: worker-host`，或用 `runs_on: worker-host` 卡片级约束（`card-spec.md` § runs_on）

### §3.3 防火墙 —— 必须放行的端口

`Pi/Config/infra-topology.md` § 防火墙运维 是权威。关键一条：

- **UFW 8443/tcp** —— Tailscale DERP relay 回退通道，不开会偶发断连（`Pi/Memory/project_syncthing_conflict_fix.md`）

其他端口按需（Syncthing 22000 / SSH 22 等）。

### §3.4 远程机器运维禁忌

- **绝不**在远程机器上跑 `tailscale down` —— 跑了自己就没法 SSH 进去（`Pi/Memory/feedback_no_tailscale_down.md`）
- 多机集群里每台机器的 SSH 用户名可能跟本地用户名不一致——在 `~/.ssh/config` 显式 `User <remote-user>` 而不是依赖默认
- 排查 Syncthing 冲突**不要**用 `mv` / `rm` 用户数据 —— 先在 Syncthing 加 ignore 再操作（`Pi/Memory/feedback_no_destructive_debug.md`）

---

## §4 AI Runtime 切换（Claude ↔ Codex）

### §4.1 两种 runtime 的优劣

| Runtime | 优势 | 何时用 |
|---|---|---|
| **Claude Code CLI** | 1M context、交互感好、工具生态成熟 | 默认；需要读大量文件、对话式任务 |
| **Codex CLI** | 执行稳定、代码改动确定性高 | 纯代码 refactor、批处理 |

双 runtime 兼容见 `Pi/Memory/project_pios_v4_architecture.md` § 多 Runtime 兼容。

### §4.2 切换方式

setup wizard 第 3 步选过一次。后补改 `Pi/Config/pios.yaml`：

```yaml
infra:
  runtimes:
    claude:
      enabled: true
      primary: true        # 默认用这个
    codex:
      enabled: true
      primary: false       # fallback
```

task 级指定：task 的 yaml 里加 `engine: codex` 强制走 Codex。

### §4.3 Auth 踩坑

- **Claude 在 cron 里跑失败** —— 不是"cron 读不到 Keychain"，是 `claude auth logout+login` 写坏 ACL。兜底方案：env var 文件。见 `feedback_claude_cron_env_var.md`（Claude 自动记忆）
- **Codex 401 refresh_token_reused** —— 如果 JWT 还没过期，改 `~/.config/openclaw/auth-profiles.json` 的 `expires` 跳过刷新。见 `feedback_openclaw_expires_trick.md`（Claude 自动记忆）
- **通用红线**：不要自动同步 token，只能手动 re-login。2026-04-16 全局 401 就是自动同步干的（`feedback_auth_no_auto_sync.md`，Claude 自动记忆）

---

## §5 Owner Profile 填充（你的画像）

`{你的名字}/Profile/` 下有 9 份 md（`Pi/Self/pios-capabilities-overview.md` §五）：`Profile` / `Beliefs` / `Timeline` / `People` / `Patterns` / `Health` / `Knowledge_Map` / `Status_Archive` / `README`。

**这 9 份 md 是 Owner ↔ AI 共享认知层**。Pi 读它来理解你是谁、你在乎什么、你家人是谁、你的健康状态。你自己改它、Pi 在你明确要求时改它。

**不要**用 yaml 重做这层认知 —— 有人尝试过，失败了（`feedback_scan_owner_profile_layer.md`，Claude 自动记忆）。md 格式对 Pi 读效率和你自己修改都更友好。

**什么时候更新**：
- 重大生活变化（换工作 / 家人状态变动 / 健康诊断）
- Pi 反问你某个画像字段时，顺手同步
- weekly-wrap-up 或 monthly-reflection 时 Pi 会提醒你检视过时字段

---

## §6 alignment.md —— 价值对齐

`Pi/Config/alignment.md` 定义你和 Pi 的价值 / 优先级对齐。例子：

- 健康 > 工作 > 其他
- 遇到冲突先问你，不自作主张做重大决策
- 微信通道保持安静

Pi 每次启动读 BOOT.md 时连 alignment 一起读（`Pi/BOOT.md` 启动协议）。改了立即生效（下一个 task 开 session 时读到）。

---

## §7 不要动的文件

五层架构归属表见 ARCHITECTURE §7。快速版：

| 绝对别动 | 原因 |
|---|---|
| `Projects/pios/` 下的代码 | Engine + App，产品代码，升级会覆盖 |
| `Pi/Tools/*.sh` | Engine 脚本 |
| `Pi/Agents/pi/tasks/{triage,work,sense-maker,reflect}.md` | Core Agents prompt，Home UI 依赖 |
| `Pi/Config/card-spec.md` `execution-protocol.md` `done-protocol.md` `notification-spec.md` | 协议 SSoT，改了连锁反应 |
| `Pi/Plugins/core/` | Core plugin |

| 可以改，但要有理由 | 改了怎么生效 |
|---|---|
| `Pi/Config/pios.yaml` | 下一分钟 tick 读新配置 |
| `Pi/Config/alignment.md` | 下一次 agent session 开始时读 |
| `Pi/BOOT.md` | 同上 |
| `Pi/Config/infra-topology.md` | 手改，只给 Pi 读不改逻辑 |
| `{你}/Profile/*.md` | Pi 下次读你画像时生效 |

---

## 相关权威源

- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) —— 五层架构 + 文件归属
- `Pi/Config/pios.yaml` —— 你的实际调度配置
- `Pi/Config/notification-spec.md` —— 通知 5 级规范
- `Pi/Config/infra-topology.md` —— 多机拓扑 + 防火墙
- [`../pi-speak-behavior.md`](../pi-speak-behavior.md) —— Pi 说话三层门控
- `Pi/Self/pios-capabilities-overview.md` —— agent / task / plugin 全景
- `Pi/Memory/MEMORY.md` —— Pi 已内化的教训索引
