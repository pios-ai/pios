# Pi 说话行为规范（speak-behavior）

> Pi 什么时候说话、在哪说、通过什么通道、留什么 trace。
> 这是 2026-04-20 闭环 queue→dispatcher→pi-main 后的权威版本。
> 改说话路径前必读；新增意识源要对齐这份表。

## 1. 说话的 7 个源

| 源 | 性质 | 触发 | 入口 |
|---|---|---|---|
| **pi-greet** | 反射 | presence absent→present 跳变（按 last_seen delta 选问候语） | `backend/pi-greet.js` → `pi-speak.fireReflex` |
| **pi-chitchat** | 意识 | 主进程 30min tick，双门控（present + energy≥0.6）+ 4 冷却门 | `backend/pi-chitchat.js` → `pi-speak.proposeIntent` |
| **triage self-report** | 意识 | `*/15 * * * *` cron，triage 自己要说 | `Agents/pi/tasks/triage.md` → `pi-speak.proposeIntent` |
| **sense-maker** | 意识 | `0 */2 * * *` cron | `Agents/pi/tasks/sense-maker.md` → `pi-speak.proposeIntent` |
| **evening-brief** | 反射 | `0 22 * * *` cron | `Agents/pi/tasks/evening-brief.md` → `notify.sh report "..."` |
| **reminders.yaml** | 反射 | `Pi/Tools/reminder.sh` 按 yaml 调度 | `notify.sh reminder "..."` |
| **业务代码** | 反射 | auth-check / sense-maker emergency 等 | `notify.sh critical\|warning\|info "..."` |

- **反射**：立即发。用 `pi-speak.fireReflex()` 或 `notify.sh critical/reminder/report`。
- **意识**：进队列，下个 triage tick（≤15min）按 Step 8 决策说不说/怎么说。用 `pi-speak.proposeIntent()` 或 `notify.sh warning/info`。

## 2. 三层门控（谁能过）

### chitchat 6 门（`pi-chitchat.js:159`）

1. `presence.status === 'present'` — 不在不闲聊
2. `pi-mood.json.energy >= 0.6` — 没劲不闲聊
3. `pi-social.quiet_until` 未到期 — owner 说过"别烦"就闭嘴
4. `pi-social.last_interaction_at` > 2h — 刚对话过不打断思路
5. `pi-social.last_greeting_at` > 30min — 刚问过好不话痨
6. 同日 ≤ 2 次 + 两次间隔 ≥ 2h — 频率硬顶

### greet 1 门（`pi-greet.js:118`）

- `_lastPresenceStatus !== 'present' && curr === 'present'` 才触发，present 维持时只刷 `last_seen_ts_ms`。
- delta < 10min 不问候（`DEFAULT_BANDS.no_greet`）。

### notify.sh 2 门（`Pi/Tools/notify.sh:29`）

- **Dedup**：消息前 60 字符做 key，5min TTL。跳过重复。
- **Level**：`silent` 只写 history log 不说话。

### triage Step 8（intent 队列决策器）

- 读 `pi-speak-intents.jsonl` + `recent_outgoing` + `quiet_until` + `last_interaction` + archetype。
- 每条 intent 输出 `speak | defer | merge | drop` 决策，写 `pi-speak-decisions.jsonl`。
- 决策通过的走 `pi-speak.executeDecision()` → `pi-route.send()`。

## 3. 通道选择（pi-route 4 档）

`backend/pi-route.js:117` `send({ text, level, source, audience })`：

### level === 'critical' 走多通道并发

- 本地 notify（macOS toast）
- NPC bubble（如有 mainWindow）
- WeChat（openclaw）
- 忽略 presence。

### level 其他 按 presence 分档

| 状态 | 行为 | routed |
|---|---|---|
| `present` | 本地 notify + NPC bubble；`report` 额外发 WeChat | `local-present` / `report-wechat-present` |
| `unknown` | `report` 发 WeChat；其他退化本地（info→silent 低打扰） | `report-wechat-unknown` / `local-unknown-fallback` |
| `away <30min` | 憋住进 `pi-pending-messages.jsonl` | `pending-short` |
| `away ≥30min` | Electron 内走 aggregator；后台 `report` 直接走 WeChat | `wechat-pending-aggregation` / `report-wechat-away-direct` |

- `audience: 'self'` 只写 log 不通知（`self-only`）。
- `flushPending(mainWindow)` 在 absent→present 跳变时被调，按 source 聚合补发。

## 4. 真声音的硬条件（bubble + TTS）

NPC 气泡 + TTS 能发出来需要三个同时满足：

1. **PiOS.app 正在跑**（Electron 主进程存活）
2. **bubbleWin alive**（启动时 main.js 创建的透明气泡窗）
3. **调用在主进程内**（`global._npcSpeak` 只在主进程可见）

### 2026-04-20 修复的两个硬伤

- **Bug A · 子进程 bubble 永远 null**：原来 `notify.sh → node -e fireReflex &` 起独立 node 子进程，拿不到 `global._npcSpeak` → bubble 返回 null。
- **Bug B · cron node 静默 fail**：cron 的 PATH 无 `/opt/homebrew/bin`，node 找不到，`>/dev/null 2>&1` 吞了 stderr → 17:00/18:30 reminder 连 pi-speak-log 都没 entry。

**修法**：`notify.sh` 先通过 `Projects/pios/backend/pi-speak-dispatch.js` 在后台进程直接调用 `pi-speak.fireReflex()` / `proposeIntent()`，不再依赖 Electron 主进程存活；direct dispatch 失败时才 append 一行 JSON 到 `Pi/Inbox/pi-speak-queue.jsonl`，供 PiOS 主进程 watcher 兜底处理。

⚠️ **警告**：Pi 主动说话**不能**走 `mainWindow.webContents.send('pios:talk', text)`。那是**用户输入通道**——renderer 会把 text 当 user turn 塞 pi-main session → Claude 真的回复 → 自问自答。参考 `Pi/Memory/feedback_pi_speaks_not_pios_talk.md`。

## 5. 留痕（三处日志 + pi-main session）

每次说话留 4 条 trace：

| 文件 | 作用 | 写入点 |
|---|---|---|
| `Pi/Log/pi-speak-log.jsonl` | pi-speak 统一日志（P7 权威） | `pi-speak.fireReflex / executeDecision` |
| `Pi/Log/pi-route-log.jsonl` | 路由日志（含 routed 分档 + result） | `pi-route.send` |
| `Pi/Log/notify-history.jsonl` | 兼容老 Operation Notifications 面板 schema | `pi-speak._appendNotifyHistory` |
| `sessions.json` pi-main.messages | Talk to Pi 看到 Pi 主动说过什么（2026-04-20 裂缝修） | `global._appendPiMainProactive` |

**pi-main 回写规则**（`pi-speak.js:_appendToMainSession`）：
- `routed ∈ {local-present, local-unknown-fallback, report-wechat-present, report-wechat-unknown, report-wechat-away-direct, wechat-long-away, wechat-pending-aggregation, critical-multichannel}` 才回写。
- `pending-*` / `self-only` / 未 routed 跳过。
- 回写 role = `assistant`，带 `meta: { kind: 'proactive', source }`。

## 6. 三个场景走一遍

### 场景 1：owner 在 Mac 前，16:30 reminders.yaml 触发"该喝水"

```
reminder.sh → notify.sh reminder "该喝水"
  → dedup 通过 → pi-speak-dispatch.js → fireReflex({level:reminder, text:"该喝水"})
  → pi-route.send({level:"reminder", audience:"owner"})
  → presence === "present" → routed="local-present"
     ├── sendLocalNotify("reminder", ...) → macOS toast
     └── Electron 不在 direct dispatch 路径时 bubble=null；PiOS 运行时 queue fallback 仍可走 bubble
  → pi-speak-log 记一条 {type:reflex, routed:local-present}
  → pi-route-log 同步一条
  → notify-history 同步一条
  → _appendToMainSession → sessions.json pi-main.messages +1 {role:assistant, meta:{kind:proactive, source:notify.sh-reminder}}
```

### 场景 2：owner 离开 Mac 2 小时，chitchat 想说 "我在想..."

```
30min tick → pi-chitchat.maybeChat
  → presence !== "present"
  → skip（门控 1 fail）
```

或 presence present 但 energy 低：skip 门控 2。

### 场景 3：owner 离开 6 小时，evening-brief 22:00 触发

```
cron → evening-brief → notify.sh report "晚上好，今天..."
  → pi-speak-dispatch.js → fireReflex → pi-route.send({level:"report"})
  → report 按通知规范走 WeChat；present/unknown 也会发微信，后台 away≥30min 直接发微信
  → pi-speak-log / pi-route-log / notify-history / pi-main 四处留痕
```

## 7. 什么情况"天然不说"（by-design silent）

- notify.sh `silent` 级别
- audience=`self`
- chitchat 任一门控失败
- greet delta < 10min
- triage Step 8 决策 `defer` / `drop`
- presence away<30min（憋到回来）
- level=`info` 且 presence=`unknown`（退化 silent）
- dedup 命中
- bubbleWin destroyed（降级到只 notify）

## 8. 改这块代码前的 checklist

- [ ] 新增说话源？标明反射 vs 意识，走 `fireReflex` 还是 `proposeIntent`。
- [ ] 新加通道？扩 `pi-route.send`，不要绕过它直接 exec。
- [ ] 新加门控？加在 `pi-chitchat` / `pi-greet` 或 triage Step 8，不要散落业务代码里。
- [ ] 运行在子进程？**不能**依赖 `global._npcSpeak`——写 queue，让主进程 dispatch。
- [ ] Pi 主动发的话？**不能**写 `pios:talk` 通道——用 `fireReflex` 或 `_npcSpeak`。
- [ ] 跑 `test/p6-smoke-test.js` 15 项全绿再提交。

## 参考

- 架构：`Projects/pios/backend/{pi-speak,pi-route,pi-chitchat,pi-greet}.js`
- 队列：`Pi/Inbox/pi-speak-queue.jsonl`（notify.sh → 主进程）
- 意图：`Pi/State/pi-speak-{intents,decisions}.jsonl`（triage Step 8）
- 日志：`Pi/Log/{pi-speak-log,pi-route-log,notify-history}.jsonl`
- 会话：`~/Library/Application Support/PiOS/sessions.json` pi-main
- 规范：`Pi/Config/notification-spec.md`（notify.sh 级别定义）
- 教训：`Pi/Memory/feedback_pi_speaks_not_pios_talk.md`
