# PiOS Plugin 系统 v5

> 2026-04-16 | 取代 v4（已归档至 `Pi/archive/plugins-v4-20260416/`）

## 目的

让新用户装 PiOS 时，按自己环境选能力。仅此一个目的。

owner 本人不使用 Plugin 系统（他的 Vault 已经有全部文件）。Plugin 只服务分发。

## 结构总览

```
Projects/pios/                          ← 产品 repo（source of truth）
├── app/                                ← PiOS.app Electron 代码
├── core/                               ← PiOS 必装部分（PiOS.app 自带）
│   ├── agents/                         ← pi, maintenance 两个核心 agent
│   ├── engine/                         ← tick, adapter, auth, notify 等脚本
│   └── specs/                          ← card-spec, execution-protocol 等
└── plugins/                            ← 可选 Plugin（各自独立可分发）
    ├── pipeline/
    ├── diary/
    ├── health/
    ├── wechat/
    ├── photos/
    ├── content/
    ├── ecommerce/
    ├── intel/
    └── browser/
```

**用户装完后的 Vault 不含 `Pi/Plugins/` 目录。** Plugin 是安装包，装完文件散布到 `Pi/Agents/`、`Pi/Tools/`、`Pi/Config/plugins/` 等位置，和 owner 的 Vault 布局完全一致。

## core 不是 Plugin

core（pi + maintenance + 引擎）打包进 PiOS.app。首次启动 installer 直接把它铺到 Vault，用户无需选择。

Plugin 只是"可选"的东西。必装的不走 Plugin 系统。

## Plugin 结构（v5 规范）

```
plugins/{name}/
├── plugin.yaml          ← 清单（必需）
├── agents/              ← 本 Plugin 提供的 agent（可选）
│   └── {agent}/
│       ├── SOUL.md      ← 参数化模板
│       └── tasks/
│           └── *.md     ← 参数化模板
├── scripts/             ← bash/python 脚本（可选）
├── mcp/                 ← MCP server 配置（可选）
├── config/              ← 用户可编辑的配置模板（可选，首次安装复制到 Pi/Config/plugins/{name}/）
├── services/            ← launchd/systemd service 模板（可选）
└── README.md            ← 给用户看：这个 Plugin 干嘛的、需要什么、怎么用
```

## plugin.yaml 格式

```yaml
name: health
version: 1.0.0
description: Apple Health 数据采集 + 健康管家
author: PiOS

# 安装前置条件
requires:
  platform: [darwin]              # 操作系统白名单
  binaries: [python3, bash]       # 必需命令
  plugins: [pipeline]             # 前置 Plugin（必须已装）
  vault_dirs:                     # 用户必须有的 Vault 目录（没有 installer 会创建）
    - "{owner}/Pipeline/Health"

# Agents（会装到 Pi/Agents/{id}/）
agents:
  life:
    source: agents/life             # plugins/health/agents/life/ 的内容
    runtime: claude-cli
    host: "{primary}"

# Tasks（会注册到 pios.yaml）
tasks:
  daily-health:
    agent: pipeline                 # 依附到 core 的 pipeline agent（如果 Plugin 带自己的 agent，用自己的）
    source: agents/life/tasks/daily-health.md
    cron: "40 0 * * *"

# Scripts（会装到 Pi/Tools/）
scripts:
  - scripts/health-probe.py
  - scripts/reminder.sh

# MCP（注册到 .claude.json）
mcp:
  health: mcp/health.yaml

# 用户配置模板（首次安装复制到 Pi/Config/plugins/health/）
config:
  - config/reminders.yaml.template    # 用户装完后编辑此文件

# Services（launchd plist 模板，装完 launchctl load）
services:
  health-probe-daemon:
    type: launchd
    script: scripts/health-probe.py
    interval: 3600
```

## Host schema（岗位派驻 + 任务派遣）

**Agent 声明可派驻的 Host 集合，Task 从中选一个（或声明首选+备选数组作为 failover）。**

```yaml
agents:
  intel:
    hosts: [laptop-host, worker-host]     # 这个岗位能派驻到哪些 host（必须，数组）
    tasks:
      intel-worker:
        host: worker-host            # 单 host task：大多数情况——host ∈ agent.hosts
      other-task:
        hosts: [worker-host, laptop-host] # 多 host task：hosts[0]=主，后续=fallback 备选
        # 调度时按顺序选第一个 healthy 的 host；备 host 只在主不可用时跑
```

**规则**：
- `agent.hosts` 必需（至少 1 个）。没声明视为 `['any']`
- `task.host`（单值）和 `task.hosts`（数组）二选一写，都不写则继承 `agent.hosts[0]`
- `task.host` 或 `task.hosts` 里每个 host 必须 ∈ `agent.hosts`
- 单 host task 写 `host: X` 比 `hosts: [X]` 更简洁
- 多 host task 用 `hosts: [主, 备…]`——failover 用例

**调度行为（pios-tick.sh + pios-adapter.sh 嵌套两层 fallback）**：

```
遍历顺序：host 优先 × engine 次之

hosts=[A, B]  engines=[codex, claude]  →
  (A × codex)  ← 先试
  (A × claude)
  (B × codex)
  (B × claude)
```

- Host 层（tick.sh）：按 `hosts[]` 顺序选第一个心跳活 + 至少一个 engine 可用的 host
- Engine 层（adapter.sh）：在选中 host 上按 `engines[]` 顺序试，挂了切下一个
- 两次 fallback 都会写事件到 `Pi/Log/fallback-events.jsonl`：
  ```jsonl
  {"at":"...","kind":"host","task":"...","intended_host":"laptop-host","actual_host":"worker-host","reason":"primary-host-unhealthy"}
  {"at":"...","kind":"engine","task":"...","run_id":"...","host":"...","intended_engine":"codex-cli","actual_engine":"claude-cli","reason":"...","status":"degraded"}
  ```
- UI 订阅这个 jsonl 可显示 "今日 fallback 历史"

## Agent capabilities（权限声明）

`pios.yaml` 里每个 agent 都必须有 `capabilities:` 块，显式声明它能做什么、产出放哪。capabilities 是**权威**——未来的权限 runtime 会读这里裁剪 agent 的可见文件和可用工具。

```yaml
agents:
  hawkeye:
    capabilities:
      mcp: [vault, web-search]                    # 能连哪些 MCP server（岗位工具权限）
      skills: []                                  # 能"想起来用"哪些 Skill（白名单，待运行时裁剪）
      workspace: Pi/Agents/hawkeye/workspace/     # 自己的办公桌（全权读写）
      projects: [ai-ecommerce]                    # 参与的共享项目（Projects/ai-ecommerce/** 全权）
      public_read:  []                            # 公共区/他人工作区的只读白名单
      public_write: []                            # 公共区/他人工作区的可写白名单（含特许）
```

**三层路径模型**：

| 层 | 示例 | 权限 |
|---|---|---|
| **岗位自留地（workspace）** | `Pi/Agents/{agent}/workspace/` | 全权读写，一律允许 |
| **共享项目区（projects）** | `Projects/{name}/**` | 声明参与即获全权 |
| **公共区（public_read/write）** | `Cards/**`, `Pi/Log/**`, `Personal/Daily/**` | 按声明给，包括特许写 |

**特许写**的例子：pipeline 的 `public_write: ['{owner}/Personal/Daily/**']` ——它是 daily-diary-engine 的产出必需，但其它 agent 一律禁写 Personal。pi 的 `public_write: ['Cards/**']` 显式化了"派活权限"（改 Card 的 `ready_for_work` 就是给 worker 派活）。

**协作写**：scout 的 `public_write` 里包含 `Pi/Agents/intel/workspace/scan-state/**` ——scout 与 intel 协作，它产出的 IR state 写到 intel 工作台的这个子目录。这显式表达"两个岗位共享一张工作台"。

**legacy 兼容**：`agents.*.plugins: [...]` 字段保留向后兼容（Team Tab UI 读它），内容应与 `capabilities.mcp` 保持一致。后续 PR 会统一。

## 参数化（install / 运行时替换）

Plugin 源文件使用占位符。install 时从用户 `~/.pios/config.json` 读值替换；**task prompt 里的占位符由 `pios-adapter.sh` 在每次运行前从 `pios.yaml` 读取注入**（不是 install 时替换，因为 Vault 可以换 owner 但 plugin 不重装）。

**固定占位符**：

| 占位符 | 含义 | 例子 |
|-------|------|------|
| `{owner}` | 用户短名（ID） | `owner` |
| `{vault}` | Vault 根绝对路径 | `~/PiOS-Vault` |
| `{primary}` | 主力机器 hostname | `laptop-host` |
| `{secondary}` | 副机 hostname（可空） | `worker-host` |
| `{home}` | `$HOME` | `~` |

**display_names dict 派生占位符**（整串 per-user 显示名）：

`pios.yaml` 的 `display_names:` 每个 key 自动派生一个 `{<key>_name}` 占位符：

```yaml
# pios.yaml
owner: owner
display_names:
  wechat: <owner-display-name>         # → {wechat_name}
  english: owner          # → {english_name}   (future-proof 示例)
  family: 爸爸          # → {family_name}    (future-proof 示例)
```

⚠️ **铁律：禁止 `{owner}` + 字面量拼接**。Tony 不会叫 `Tony<surname>`，prompt 里 `{owner}<surname>` 这种写法等于硬编码 owner。所有 per-user 的整串显示名必须整体进 `display_names:`，prompt 里用 `{<key>_name}` 单一占位符。

硬编码特定 URL 如 Immich API → 在 `config/` 目录给模板，让用户装完编辑。

## install 流程

`pios-plugin.sh install {name}` 做：

1. 读 `plugins/{name}/plugin.yaml` 检查 `requires`
   - 平台不匹配 → abort
   - 缺 binary → abort
   - 前置 plugin 未装 → 提示先装
2. 读 `~/.pios/config.json` 取得所有占位符的值
3. 对每个文件读→替换占位符→写入目标位置
4. 在 `pios.yaml` 里注册 agents 和 tasks
5. 在 `.claude.json` 里注册 MCP
6. 在 `Pi/Config/plugins/{name}/` 下放用户配置模板
7. 渲染 launchd plist → `~/Library/LaunchAgents/` → `launchctl load`
8. 追加记录到 `~/.pios/installed-plugins.json`（装了哪些文件，uninstall 时照此清理）

## uninstall 流程

`pios-plugin.sh uninstall {name}` 做：

1. 读 `~/.pios/installed-plugins.json` 找到这个 plugin 装了哪些文件
2. 逐个删除（agent SOUL、task prompt、script、MCP 配置、service）
3. 从 `pios.yaml` 移除 agents/tasks
4. 从 `.claude.json` 移除 MCP 条目
5. `launchctl unload` + 删 plist
6. **不删** `Pi/Config/plugins/{name}/`（用户配置，保留）

## Plugin 清单（v5 初版）

| Plugin | Agent | Tasks | 平台限制 | 依赖 Plugin |
|--------|-------|-------|--------|-----------|
| `pipeline` | pipeline | daily-ai-diary | — | — |
| `diary` | — | daily-user-status, daily-diary-engine | — | pipeline |
| `health` | life | daily-health, weekly-health-review, reminders-refresh | darwin | pipeline |
| `wechat` | — | daily-wechat-digest | darwin | — |
| `photos` | — | daily-photo-diary | — | —（运行时需 Immich 地址） |
| `content` | creator | daily-scripts | — | — |
| `ecommerce` | hawkeye | hawkeye-worker | — | — |
| `intel` | intel, scout | intel-worker, big-thing-daily-scan, claude-code-leak-monitor | — | — |
| `browser` | — | —（只注册 MCP） | — | — |

## 打包流程（从 owner 当前 Vault 抽取）

一次性脚本，不需要重复跑：

1. **扫源文件**：按上表找到每个 Plugin 的 agent/task/script
2. **参数化替换**：
   - 真实 owner name → `{owner}`（保留如 `{owner}_Profile.md` 等文件名变量，让用户自己填）
   - 真实 vault 绝对路径 → `{vault}`
   - 多机集群里的具体 hostname → `{primary}` / `{secondary}` 等通用 alias
   - `<owner-display-name>`（整串微信名） → `{wechat_name}`（对应 `display_names.wechat: "<owner-display-name>"`）；**不要**拆成 `{owner}<surname>`，Tony 不会叫 Tony<surname>
   - `<owner-real-fullname>`（英文名/护照名/其他整串 per-user 字符串） → 新增 `display_names.<key>` 条目 + `{<key>_name}` 占位符
   - 具体 URL → 留硬编码但在 `config/` 给模板（用户装完编辑）
3. **写入** `Projects/pios/plugins/{name}/`
4. **生成** 每个 plugin 的 `plugin.yaml` 和 README.md
5. **校验**：从 `plugin.yaml` 反查，所有声明的文件都存在

## 和 owner 现有 Vault 的关系

- owner 的 `Pi/Agents/`、`Pi/Tools/` **不动**
- Plugin 打包只**读** owner 的文件，不修改
- Plugin 是产品 repo 的东西，放 `Projects/pios/plugins/`
- 分发给新用户时：PiOS.app 装完，用户自己 `pios-plugin.sh install health` 选装

## 为什么 owner 也该用 Plugin（未来）

不做。owner 保持现状。

理由：Plugin 是"从模板生成用户文件"的机制。owner 就是模板的来源，他不需要再从自己那里生成一遍。任何改进他先直接改 `Pi/Agents/` 验证，验证 OK 再同步回 `Projects/pios/plugins/` 给新用户。

---

## 实现工作量

1. **打包脚本**（`Projects/pios/scripts/build-plugins.sh`）— 新写 ~200 行 Python
2. **新 pios-plugin.sh**（取代 v4）— 重写 ~300 行
3. **plugin.yaml 规范** + 9 个 Plugin 的 plugin.yaml — 30 分钟
4. **跑打包** — 生成 `Projects/pios/plugins/*/`
5. **测试**：fresh Vault 跑 install 链路

估计全职 2 天。
