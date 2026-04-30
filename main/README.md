# Projects/pios/main/ — 模块导航

`main.js` 已从 7469 行单文件拆成 26 个 ≤800 行的模块（2026-04-29，从 78% 起拆到 81%+ reduction）。
本文件是新人入门索引。每个模块有 `register()` / `create()` / `setup()` / `start()` / `attach()` 入口，main.js 顶部 require + app.whenReady 里 call。

## 入口约定

```
register(ipcMain[, ctx])   纯 IPC 注册类
create(state[, deps])      返回 service object（含状态）
setup(deps)                返回模块 API（含状态）
start(deps)                启动后台子系统（不返回值）
attach(deps)               绑定生命周期事件（不返回值）
```

## 模块清单（按职责分组）

### 引擎层
- [`session-helpers.js`](session-helpers.js) — Claude session backup/compact + JSONL 路径解析（`_parseContextMarkdown` / `_compactSession` / `_findClaudeJsonl`）
- [`session-manager.js`](session-manager.js) — 多 session 管理 + sessions:* / conversation:* IPC（`loadSessions` / `saveSessions` / `_flushSessionsToDisk`）
- [`task-run.js`](task-run.js) — Task run 发现层：`Pi/State/runs/` 解析 + materialize 为 sessionObj
- [`sessionbus-setup.js`](sessionbus-setup.js) — SessionBus v2 + 4 engine adapter（claude/gpt/codex/run）+ ContextInjector
- [`scheduler.js`](scheduler.js) — 内置 pios-tick.sh 调度 + powerMonitor 睡眠唤醒
- [`chat-prompts.js`](chat-prompts.js) — voice prompts (CODEX/GPT) + `prepareGPTRequest` / `prepareCodexRequest` + short-followup gate
- [`agent-mode.js`](agent-mode.js) — Agent Mode AI 自主浏览（`agent-mode:*` IPC）
- [`voice-runtime.js`](voice-runtime.js) — qwen-voice 子进程生命周期 + `pios:qwen-*` IPC
- [`installer-bridge.js`](installer-bridge.js) — `pios:is-installed` / install / setup-done + deps:check/install + plugin-list/activate

### Tab/Window 层
- [`tab-manager.js`](tab-manager.js) — Window + tab CRUD 工厂（`createWindow` / `createTab` / `switchToTab` / `closeTab`）
- [`tab-manager-ipc.js`](tab-manager-ipc.js) — 配套 IPC（browser:* / tab:* / sidebar:* / panel:*）
- [`window-lifecycle.js`](window-lifecycle.js) — mainWindow 生命周期事件（close/activate/hide/resize/move + before-quit）
- [`app-menu.js`](app-menu.js) — App Menu + Cmd+Shift+J quick window
- [`bubble-npc-tray.js`](bubble-npc-tray.js) — 浮动语音气泡 + NPC 化身系统 + Tray menu

### HTTP API 层（Browser Control）
- [`browser-control-api.js`](browser-control-api.js) — HTTP server shell + 路由 dispatcher（149 行；本身只做 shell 层）
- [`browser-control-api-auth.js`](browser-control-api-auth.js) — Auth login / recheck endpoint（claude-cli / codex-cli OAuth 流）
- [`bca-get-1.js`](bca-get-1.js) — `/pios/*` dashboard GET：overview / owner-queue / cards / decisions / agents / runs / SSE events / activity / outputs(GET)...
- [`bca-get-2.js`](bca-get-2.js) — outputs / tasks / users / manifest / profile / sense / vault-file / characters / pi-tab / scratch GET
- [`bca-post-1.js`](bca-post-1.js) — afterward / profile / sense / scratch POST / fork-session / identity/character/skin / users / open-tab / run-terminal
- [`bca-post-2.js`](bca-post-2.js) — manifest / notify / agent CRUD / PiOS actions / outputs / task management / open-session / talk / call-pi
- [`bca-browser-cmds.js`](bca-browser-cmds.js) — MCP 浏览器命令 switch（/navigate /new_tab /click /fill /screenshot /tabs ...）

### 通知 + 后台子系统
- [`notification.js`](notification.js) — `sendNotification` 5 路（osascript + Electron Notification + TTS + Home toast）+ `handlePiEvent`（后台事件静默写主会话）
- [`pi-inbox-watchers.js`](pi-inbox-watchers.js) — 3 个 file watcher（pi_notify / pi-speak-queue / pi-main-proactive-queue）+ `global._appendPiMainProactive`
- [`lifecycle-timers.js`](lifecycle-timers.js) — pi-chitchat 30min / presence-watch 60s / wechat-aggregator 5min（含 powerMonitor resume kick）

### 工具
- [`file-processing.js`](file-processing.js) — drop/paste 文件解析（XLSX / PDF / Word / image / text）

### `ipc-handlers/` 子目录（薄薄一层 IPC 注册）
- [`ipc-handlers/pios-engine.js`](ipc-handlers/pios-engine.js) — pios:agents/cards/projects/runtimes/spawn-agent + 9 张 card ops
- [`ipc-handlers/voice.js`](ipc-handlers/voice.js) — voice:tts / voice:asr / debug:trace + TTS/Whisper 预热
- [`ipc-handlers/bookmarks.js`](ipc-handlers/bookmarks.js) — bookmarks:list/add/remove
- [`ipc-handlers/browser-data.js`](ipc-handlers/browser-data.js) — history:* + memories:* + privacy:*
- [`ipc-handlers/session-bus.js`](ipc-handlers/session-bus.js) — SessionBus IPC 桥

## 加新 IPC handler 流程

1. 选已有的合适模块（按职责分组找）；不要轻易开新文件
2. 在该模块的 `register()` / `setup()` 函数体内 `ipcMain.handle('foo:bar', ...)` 加一行
3. 跑 `node --check Projects/pios/main/<file>.js` 验语法
4. **强制**：跑一次 `node -e "require('./Projects/pios/main/<file>')"` 验 require 链不崩
5. 重 build + install + curl/IPC 真触发新 handler 一次（`node --check` 不抓 missing import）
6. 改完任何此目录文件，**必须 `npm run build:dir && bash scripts/install-app.sh`**——dev 模式蒙混不算（详见 `feedback_no_dev_mode_shortcut.md`（owner Claude memory））

## 拆分后铁律

- main.js 入口 ≤ 500 行（当前 497）
- 每个 main/* 模块 ≤ 800 行（最大 798）
- 任一模块涨过 800 行 → 立即按子职责再拆，不要等
- 共享 mainWindow 等 mutable state 一律走 getter 而非闭包捕获 null（getter 模式见 main.js _browserCtrlState / _tabMgrState / notification.create({get mainWindow})）

## 历史

- 2026-04-29 上午 09:48~12:51：Pi worker 跨 3 tick 完成 7469→6803（前 3 tick 慢，因 triage 一次只派 1 张）
- 2026-04-29 中午 12:51：改 triage prompt 派满 3 张后，单 tick 6803→2026
- 2026-04-29 14:40~16:00：Claude 接手收口，2026→497；本目录 26 个模块全部 ≤800
