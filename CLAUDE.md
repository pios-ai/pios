# PiOS

> PiOS 代码在这个目录。改之前读 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 目录结构

```
Projects/pios/              ← PiOS.app 源码 + 架构文档
├── main.js                 ← Electron 主进程 entry（497 行 thin shell）
├── main/                   ← 26 个职责单一模块（≤800 each；2026-04-29 拆分）
│   ├── README.md           ← 模块导航 + 加新 IPC handler 5 步流程
│   └── ipc-handlers/       ← 薄一层 IPC 注册子目录
├── pios-home.html          ← 主界面
├── backend/                ← 后端模块
├── renderer/               ← 前端 JS
├── package.json            ← npm/electron-builder 配置
├── ARCHITECTURE.md         ← 五层架构文档（必读）
└── docs/                   ← 组件文档 + 开发指南
    ├── development.md      ← 变更影响矩阵
    └── components/         ← engine / app / core-agents / plugin-system / card-system / things-need-you
```

PiOS 的其他代码在 Vault 里：
- `Pi/Tools/` — engine 脚本（pios-tick.sh, adapter, auth, notify）
- `Pi/Plugins/` — 插件（core + 功能插件）
- `Pi/Agents/` — agent SOUL + task prompts
- `Pi/Config/` — 系统配置和规范

## 规则

1. 改代码前查 [docs/development.md](docs/development.md) 的变更影响矩阵
2. 改完必须 `npm run build:dir && bash scripts/install-app.sh`（dev 模式偷工减料 = 把 daily driver 跑成 Electron 默认外观，禁止）
3. Core agent prompts 用 `{owner}` `{vault}` 参数化，不硬编码
4. 加新 IPC handler 看 [main/README.md](main/README.md) 5 步流程（`node --check` 不抓 missing import，必须 endpoint smoke test）

## 快速索引

| 问题 | 读这个 |
|------|--------|
| 整体架构 | ARCHITECTURE.md |
| 改什么会坏什么 | docs/development.md |
| Card 字段契约 | docs/components/card-system.md |
| Things Need You 交互 + 问题追踪 | docs/components/things-need-you.md |
| triage/work/sense-maker 职责 | docs/components/core-agents.md |
| 插件怎么加 | docs/components/plugin-system.md |
