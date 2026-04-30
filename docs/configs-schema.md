# agent.configs — Per-Runtime Permission Schema

**Date**: 2026-04-18
**Replaces**: `agent.capabilities.{public_read,public_write,allowed_tools,permission,mcp,skills}`

## Why

PiOS 原 `capabilities` 是一套统一 schema，adapter 试图 transpile 到三家 runtime（claude-cli / codex-cli / openclaw）各自的权限机制。实测下来：
- 三家权限模型 85% 相似但 15% 差异会造成歧义（path 粒度 / tool 语法 / 权限档位）
- 任何 transpile 都必然有损
- UI 被迫在字段旁边堆补丁文字（"仅 claude-cli 支持"）遮丑

**新设计**：权限跟 runtime 走，不跟 agent 走。每个 runtime 用**自己的原生 schema** 独立配置，100% 无损。

## 数据结构

```yaml
agents:
  pi:
    hosts: [laptop-host]
    runtimes: [claude-cli, codex-cli]     # ← agent 声明可跑的 runtime
    workspace: Pi/Agents/pi/workspace/    # ← 岗位物理概念，跟 runtime 无关
    projects: []                          # ← 参与的共享项目
    description: "..."

    configs:                              # ← 新字段，per-runtime 独立
      claude-cli:                         # 键名 = runtime id
        # 完全镜像 .claude/settings.json 原生 schema
        permissions:
          allow:
            - "Read(Cards/**)"
            - "Write(Pi/Inbox/**)"
            - "Edit(Pi/Log/gate-state-*.json)"
            - "Bash(git status)"
            - Glob
            - Grep
          deny: []
        permission_mode: default          # default | acceptEdits | plan | bypassPermissions
        # 将来可扩展: hooks, mcp, skills

      codex-cli:
        # 完全镜像 ~/.codex/config.toml 相关段
        sandbox_mode: workspace-write     # read-only | workspace-write | danger-full-access
        approval_policy: on-request       # untrusted | on-failure | on-request | never
        network_access: true              # 允许 DNS/HTTP（workspace-write 默认拦 DNS，必开以避免 EAI_NONAME）
        add_dirs:                         # 额外可写目录（--add-dir）
          - Cards/
          - Pi/Inbox/

      # openclaw 未在 runtimes 里声明 → 不出现
```

## Fallback 策略

- `pios.yaml` 同时保留**老 `capabilities`（legacy）+ 新 `configs`**
- adapter 读取优先级：`configs.{runtime}` 优先；缺失时回退旧 `capabilities` transpile 逻辑
- env flag `PIOS_ENFORCE_MODE=configs|legacy` 强制切换
- 所有 UI 写入走 `configs`，老 `capabilities` 字段只读、只作兜底

## 迁移规则（legacy → configs.claude-cli）

自动转换规则（`Pi/Tools/migrate-configs.py`）：

| 老字段 | 新 configs.claude-cli 字段 |
|---|---|
| `public_read: [glob]` | `permissions.allow: ["Read(glob)"]` |
| `public_write: [glob]` | `permissions.allow: ["Read(glob)", "Write(glob)", "Edit(glob)"]` |
| `workspace: dir` | `permissions.allow: ["Read(dir/**)", "Write(dir/**)", "Edit(dir/**)"]` |
| `allowed_tools: [Bash/Glob/Grep/...]` | `permissions.allow: [直接加]` |
| `permission: default` | `permission_mode: default` |

## 迁移规则（legacy → configs.codex-cli，保守模板）

codex-cli 不支持 glob 级 path 白名单，只能目录级。迁移策略：

- `sandbox_mode: workspace-write`（默认允许 cwd 可写）
- `approval_policy: on-request`（要求人工批准）
- `network_access: true`（默认开启，否则 workspace-write 默认拦 DNS → 联网任务 EAI_NONAME）
- `add_dirs`: 从 `public_write` 抽取**唯一父目录**（去重）
- **没有 read_only_access 字段** —— codex workspace-write 语义是"cwd + /tmp + $TMPDIR + add_dirs 可写，其他自动 RO"，不支持"额外限制 RO 子目录"。老 capabilities.public_read 的"读白名单"在 codex 语义下等于 noop（workspace-write 模式下 AI 反正都能读）。如需硬限制读取请改 `sandbox_mode: read-only`
- Glob 精度损失 → UI 在 codex-cli tab 上说明"目录级，不支持 glob"

## 迁移规则（legacy → configs.openclaw，占位）

openclaw 能力最弱，迁移时**不主动生成**，保持 `configs.openclaw` 为空：
- 如果 agent 在 `runtimes` 里声明了 openclaw 却没 `configs.openclaw`，UI tab 标"⚠ 未配置，默认 auto-approve"（客观事实，让用户手动填）

## adapter emit 逻辑

spawn runtime 时，adapter 根据当前 runtime 生成临时 config 文件：

### claude-cli
```
$TMPDIR/pios-run-{uuid}/.claude/settings.json
```
内容 = `configs.claude-cli` 原样 JSON.stringify。启动时用 `HOME=$TMPDIR/pios-run-{uuid}` 或 `--settings` flag 指定。

### codex-cli
```
codex exec -c sandbox_mode=workspace-write \
           -c 'sandbox_workspace_write.writable_roots=["Cards/","Pi/Inbox/"]' \
           -c 'approval_policy="on-request"' \
           ... (从 configs.codex-cli 展开)
```
用 `-c key=value` 覆盖 `~/.codex/config.toml` 默认值。

### openclaw
待定（openclaw 配置方式文档不全，V2 处理）。

## 时间线

1. ✅ 设计本文档
2. 写迁移脚本 `Pi/Tools/migrate-configs.py`，跑一次生成所有 8 agent 的 `configs` 块（不删老 `capabilities`）
3. adapter 加读 `configs` 优先逻辑 + emit 临时 config 文件
4. UI Configuration section 改 runtime tab 组件
5. 端到端验证
6. 老 `capabilities` 保留 1 个月观察期，稳定后再删
