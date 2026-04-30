---
title: PiOS 故障排查
audience: 装完 PiOS 遇到问题的终端用户
updated: 2026-04-22
---

# PiOS 故障排查

> 每条按"症状 → 原因 → 解决"三段式。做任何"删文件 / 关服务 / 重登 auth"前先读对应章节的禁忌，2026 年以来踩过的坑都在 `Pi/Memory/` 里沉淀成 feedback。
>
> 入口也看 [`./getting-started.md`](./getting-started.md)。安装本身的问题先看 [`../../INSTALL.md`](../../INSTALL.md) §Troubleshooting。

---

## 1. PiOS.app 打不开 / macOS 阻止

**症状**：双击 `PiOS.app` 弹 "无法打开" / "已损坏" / 啥反应都没有。

**原因**：
- DMG 里直接双击 app（没拖到 `/Applications`）
- macOS Gatekeeper 的 quarantine flag 拦住未签名 app
- PiOS v0.7.2 **未签名、未公证**（已知限制，见 [`../../INSTALL.md`](../../INSTALL.md) §Known Limitations）

**解决**：
1. 从 DMG 把 `PiOS.app` 拖到 `/Applications`，从 `/Applications` 里打开，不要从 DMG 里直接打开。
2. 第一次被 Gatekeeper 拦：去 `System Settings → Privacy & Security`，在最下方找到 "PiOS was blocked"，点 `Open Anyway`。
3. 还不行就去掉 quarantine flag：
   ```bash
   xattr -dr com.apple.quarantine /Applications/PiOS.app
   ```
4. 仍然不打开 → 查 Console.app 看是否是 Node/Electron crash，再升级问题。

---

## 2. 装完了但没看到 agent 在跑

**症状**：setup wizard 点完 "Start Using PiOS"，welcome 卡一直在 `Cards/inbox/`，15 分钟后也不动。

**原因**：engine 链路里某一环断了 —— config / welcome 卡 / Claude CLI / cron 四者任何一个缺位都会卡住。

**按这 4 条逐项查**（也见 [`./getting-started.md`](./getting-started.md) §4 的验证 checklist）：

```bash
# ① config.json 存在且非空
cat ~/.pios/config.json

# ② welcome 卡在位（替换成你的 vault 路径）
ls ~/PiOS/Cards/inbox/welcome-to-pios.md

# ③ Claude Code CLI 可用
which claude && claude --version

# ④ cron 注册了
crontab -l | grep pios-tick
```

**解决**：
- ① 缺 → 重跑 setup wizard
- ② 缺 → 到 `~/PiOS/Cards/inbox/` 手动创建一张 starter 卡，或重装
- ③ 缺 → `npm install -g @anthropic-ai/claude-code && claude auth login`
- ④ 缺 → 退 PiOS.app 重开；engine installer 会补 cron

**再确认一次 engine 跑过了**：
```bash
ls -lt ~/PiOS/Pi/State/runs/ | head -5
```
如果 `Pi/State/runs/` 没有 `.json` 文件或时间都是几小时以前的，说明 tick 根本没跑；如果有新文件但 `status: failed`，读 json 里的 `error` 字段。

---

## 3. Auth 失效（401 / token expired）

**症状**：worker log 里出现 `401` / `Failed to authenticate` / `Invalid API key`；卡里 `activity_result` 有 auth error；多台机器同时全红。

**原因**：OAuth access_token 过期（寿命 4-6 小时，refresh_token 几周）。正常 case 下 CLI 原生认证会自动刷新 —— 手动同步 token 到其他文件会打断这个链路。

**解决**：

Claude CLI：
```bash
claude auth login
```

Codex CLI（如果装了）：
```bash
codex auth login
```

OpenClaw（微信通道；只有你启了 WeChat 插件才相关）：如果 401 是 `refresh_token_reused` 但 access_token JWT 还活，改 `~/.config/openclaw/auth-profiles.json` 的 `expires` 字段跳过刷新，不要强刷新。详见 `Pi/Memory/` 的 `feedback_openclaw_expires_trick`。

**禁忌**（2026-04-16 全局 401 事故教训，已写进 `CLAUDE.md` + memory index）：
- 禁止手动往 `~/.claude/.credentials.json` 塞 token
- 禁止写 `CLAUDE_CODE_OAUTH_TOKEN` 环境变量（`pios-adapter.sh` 故意不设，让 CLI 走原生认证）
- 禁止 scp `.credentials.json` 跨机 —— 每台机器 `claude auth login` 各自登
- cron 里跑 claude-cli 如果失败，通常不是"cron 读不到 Keychain"而是 logout+login 写坏 ACL（见 `feedback_claude_cron_env_var`）

PiOS auth 架构权威：`Pi/Memory/project_auth_system.md`。

---

## 4. Syncthing 冲突（多机用户）

**症状**：`*.sync-conflict-*.md` 文件在 `Cards/active/` 或 `Pi/Log/` 出现；两台机器看到的卡内容不一致。

**原因**：多台机器写同一个文件（比如都往同一份 worker log 追加），Syncthing 没法合并就产 conflict 副本。或 DERP 中继断了，Tailscale 走不通 → Syncthing 重连爆冲突。

**诊断**：
```bash
# 找所有 conflict 文件
find ~/PiOS -name '*.sync-conflict-*' 2>/dev/null | head -20

# 查 Syncthing 实时状态（如果装了）
curl -s localhost:8384/rest/db/status 2>/dev/null | head

# 健康报告（Pi maintenance 每日巡检产出）
head -30 ~/PiOS/Pi/healthcheck-report.md
```

**解决**（按 `Pi/Memory/project_syncthing_conflict_fix.md` 权威方案）：
1. **单写者原则**：每份文件只允许一个 writer。日志加 `{HOST}` 后缀分片（`worker-log-laptop-host.md` / `worker-log-worker-host.md`）；任务在 `pios.yaml` 里用 `hosts:` 字段指定跑哪台。
2. **`.stignore` 规则**：`Pi/State/locks/` 必须加（锁不同步）；`.stignore` 自己也要加进去（防止多机互相覆盖 —— 内容不同）。
3. **DERP 断连**：如果在远程 Linux 节点（worker-host 类），UFW `default deny outgoing` 会挡 Tailscale 的 DERP 中继端口。补放行：
   ```bash
   sudo ufw allow out to any port 8443 proto tcp
   ```
4. **清冲突文件**：人工比对 `.sync-conflict-*.md` 和主文件，保留正确版本后手动删副本（**不要** 无脑全删 —— conflict 里可能有只在另一台写进去的新内容）。

**禁忌**：远程机器绝不跑 `tailscale down`（见 `feedback_no_tailscale_down` —— 跑了自己就 SSH 不进去）。

---

## 5. 通知不响

**症状**：Pi 明显完成了任务（卡 status 变了 / Recent Activity 有记录），但 Mac 没弹窗、没声音、微信也没消息。

**原因优先级**（2026-04-10 花了 1 小时查代码才发现是系统静音的教训，`feedback_system_mute_debug`）：

**第一步永远先查系统音量 + DND**：
```bash
osascript -e "get volume settings"
# 看 output volume 和 muted，都非 0 且 muted:false 再往下查
```

macOS DND / 专注模式也会吞通知 —— 检查控制中心的勿扰开关。

**第二步查 notify 日志**：
```bash
tail ~/PiOS/Pi/Log/notify-history.jsonl
```
这份是唯一的通知历史。如果空 → 根本没调 notify；如果有记录但你没收到 → 系统层（DND / 音量 / 微信登录态）的问题。

**第三步自测通道**：
```bash
bash ~/PiOS/Pi/Tools/notify.sh info "test notification"
```
info 级走 PiBrowser 本地弹窗。如果本地能响，问题在微信通道（见 §6）；本地也不响，重启 PiOS.app。

**通知 5 级权威对照表**：[`Pi/Config/notification-spec.md`](../../../Pi/Config/notification-spec.md) —— critical / report 走微信，reminder / info 走 PiBrowser，silent 只写日志。

**禁忌**：
- 禁止绕开 `notify.sh` 直接写 IPC 文件或直接调 `notify-wechat.sh`。统一入口只有 `notify.sh`
- `notify-history.jsonl` 唯一写入者是 `pi-speak.js`；notify.sh 的 `FROM_ROUTE=1` 分支不写（见 `feedback_notify_history_single_writer`）

---

## 6. Things Need You 积压不清

**症状**：Home "Things Need You" 顶部条一直显示一堆卡；点按钮没反应 / 按完卡不消失。

**原因**：UI 按钮 onclick 报错 / 后端 endpoint 挂 / 按钮语义理解错了按错按钮。

**诊断**：
1. 在 PiOS.app 窗口里右键 → `Inspect Element` → `Console` tab，看按钮点击有无 JS 报错
2. 查 PiOS.app 后台日志（Electron main 进程），看 `/pios/*` endpoint 是否返回 200

**按钮语义别靠文案猜**（见 `feedback_ui_button_read_handler`）。权威对照表（9 按钮 × 后端函数 × frontmatter 变化 × 卡状态）：[`../components/things-need-you.md`](../components/things-need-you.md) "按钮 × 后端（权威表）"章节。

最常被误读的按钮：
- **📋 转入待办** = 把 Pi 问询转到你的 MyToDo（`assignee: user`），**不是** "Pi 接过去做"
- **⏸ 明天再说** = 只改 `deferred_until`，`assignee` 不变，24h 后卡回来
- **✕ 驳回** = 写 `owner_response='reject'`，卡留 active，worker 下轮再读

**发现一张卡本就该 Pi 自己做（误升级）**：UI 里目前**没有**"让 Pi 领走"按钮（已知产品缺口，见 [`../components/things-need-you.md`](../components/things-need-you.md) 历史问题 2026-04-20）。临时手工改 frontmatter：删 `needs_owner` + 加 `ready_for_work: true`，下轮 work 就会接。

---

## 7. 卡在 inbox 不派

**症状**：你新加了一张卡到 `Cards/inbox/*.md`，15 分钟后还在 inbox。

**原因**：triage 没跑 / 卡 frontmatter 不对 / triage 判卡重复了跳过了。

**诊断**：
```bash
# triage 最近是不是跑过（每 15min）
ls -lt ~/PiOS/Pi/State/runs/triage-*.json 2>/dev/null | head -5

# 看 triage run 的 status
head ~/PiOS/Pi/State/runs/$(ls -t ~/PiOS/Pi/State/runs/triage-*.json | head -1)

# 卡片 frontmatter 基本字段
head -20 ~/PiOS/Cards/inbox/你的卡.md
```

卡 frontmatter 最少要有（完整契约：[`Pi/Config/card-spec.md`](../../../Pi/Config/card-spec.md)）：
```yaml
type: task     # 或 project
status: inbox
created: YYYY-MM-DD
```

**engine 是否在线**：
```bash
head -30 ~/PiOS/Pi/healthcheck-report.md
```

**解决路径**：
- triage run 都 failed → 看 `Pi/Log/worker-log-*.md` 最近条目找错因
- 卡 frontmatter 不完整 → 补字段
- triage 判重了 → 看 inbox 卡 `activity_result` 的 `reason`，可能和 active 某张旧卡同名

---

## 8. PiBrowser / PiOS.app 改完代码没效果

**症状**：改了 `Projects/pios/` 下的 JS/HTML，重启 app 看不到变化。

**原因**：PiOS.app 跑的是 asar 打包产物，不是源码实时加载（见 `feedback_pibrowser_must_build`）。

**解决**：
```bash
cd ~/PiOS/Projects/pios
npm run build
open dist/mac-arm64/PiOS.app
```

**禁忌**：
- 不要只改源码不 `npm run build` 就声称修好了（多次犯过）
- 不要用 `npx electron .` 验证后就以为 `.app` 里也修好了 —— 用户日常用的是打包版
- 如果 `npm run build` 报 `hdiutil` 错，用 `npm run build:dir` 替代（见 [`../../INSTALL.md`](../../INSTALL.md) §Maintainer Notes）

---

## 9. Chrome MCP 反复 not connected（只对用 Browser 插件的人相关）

**症状**：调用 `mcp__Claude_in_Chrome__*` 工具反复报 "not connected"，即使 Chrome 开着、扩展装着。

**原因**（`feedback_chrome_mcp_not_connecting`）：多 Chrome Profile 同时登录，扩展只在某个 profile 激活，或 WebSocket 路由混乱。

**解决**：
1. Chrome 只保留**一个** profile 窗口开着（建议用你的主 Google 账号）
2. 关掉其他 profile 的 Chrome 窗口
3. MCP 连续 3 次失败 → 停下来，不要再 retry；用 `curl` 直接调本地 API 绕开，或手动操作浏览器后把结果粘回来

---

## 诊断命令清单（copy-paste 即可）

把 `~/PiOS` 换成你的 vault 路径。

```bash
# PiOS 整体健康
head -30 ~/PiOS/Pi/healthcheck-report.md

# 最近 10 条 run 记录
ls -lt ~/PiOS/Pi/State/runs/ | head -10

# 最近 worker 活动（多机要读每台的分片）
tail -30 ~/PiOS/Pi/Log/worker-log-*.md

# Things Need You 积压数
grep -l "needs_owner:" ~/PiOS/Cards/active/*.md | wc -l

# Inbox 积压数
ls ~/PiOS/Cards/inbox/*.md 2>/dev/null | wc -l

# Syncthing 冲突文件
find ~/PiOS -name '*.sync-conflict-*' 2>/dev/null | head -20

# 系统音量（通知无声第一步）
osascript -e "get volume settings"

# cron 注册情况
crontab -l | grep pios-tick

# Claude CLI 可用性
which claude && claude --version
```

---

## 什么时候升级到"问作者 / 开 issue"

以下情况别自己动，先停下来沉淀上下文再升级：

- 准备跑 `tailscale down`、`rm -rf`、`ufw reset` 一类破坏性命令
- 准备删 `Pi/` 下任何目录或 `Cards/archive/` 的历史
- 准备改 `Pi/BOOT.md` / `AGENTS.md` / `Pi/Agents/*/tasks/*.md`（Pi 的人格 + prompt）
- 连续 3 次补丁没修好同一个问题（`feedback_patch_tick_limit` 规则：第 3 次补丁 = 停下来审视架构）
- auth 失效试过 `claude auth login` 还不行

---

## 更深的资源

| 想看什么 | 读这个 |
|----------|-------|
| 我已经内化的 50+ 条教训索引 | `Pi/Memory/MEMORY.md` |
| 五台机器拓扑 + 防火墙 + Syncthing 全景 | `Pi/Config/infra-topology.md` |
| PiOS 五层架构权威 | [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| TNY 9 按钮 × 后端权威表 | [`../components/things-need-you.md`](../components/things-need-you.md) |
| Card frontmatter 契约 SSoT | `Pi/Config/card-spec.md` |
| 通知 5 级 + 每级通知点 | `Pi/Config/notification-spec.md` |
| Pi 操作手册（owner 原话 ⇄ 内部语义 ⇄ 步骤，15 场景） | `Pi/Config/pi-ops-handbook.md` |
| 变更影响矩阵（改 X 会坏 Y） | [`../development.md`](../development.md) |
