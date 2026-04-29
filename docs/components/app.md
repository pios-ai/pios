# PiOS.app Component

> Part of [PiOS Architecture](../../ARCHITECTURE.md) — Layer 1

## Overview

PiOS.app is the desktop application (Electron) that provides the user interface for PiOS. It serves two roles:

1. **Interactive runtime**: Real-time conversation with Pi, task monitoring, notifications
2. **Vault viewer**: Display Cards, agent status, run history

**Current codebase**: `Projects/pios/` (target: `Projects/pios/app/`)

**Build**: `npm run build` → `dist/mac-arm64/PiOS.app`

**Key files**:
- `main.js` (5283 lines) — Electron main process, all backend logic
- `pios-home.html` (6539 lines) — Main UI (Home, Cards, chat, settings)
- `backend/` — Modular backend services
- `renderer/` — Frontend JavaScript

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  main.js (Electron main process)                     │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ SessionBus   │  │ PiOS Engine  │  │ HTTP API  │ │
│  │              │  │              │  │ :17891    │ │
│  │ 4 adapters:  │  │ reads:       │  │           │ │
│  │ · claude     │  │ · pios.yaml  │  │ browser   │ │
│  │ · gpt        │  │ · Cards/     │  │ control   │ │
│  │ · codex      │  │ · runs/      │  │ for MCP   │ │
│  │ · run        │  │              │  │           │ │
│  └──────┬───────┘  └──────────────┘  └───────────┘ │
│         │                                            │
│  ┌──────▼───────┐  ┌──────────────┐                 │
│  │ Notifications│  │ TTS/ASR      │                 │
│  │              │  │              │                 │
│  │ watches      │  │ qwen-voice   │                 │
│  │ pi_notify    │  │ subprocess   │                 │
│  │ .json        │  │ :7860        │                 │
│  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────┘
         │ IPC
         ▼
┌─────────────────────────────────────────────────────┐
│  pios-home.html (Electron renderer)                  │
│                                                      │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐ │
│  │  Home  │ │  Chat  │ │ Tasks  │ │   Settings   │ │
│  │        │ │        │ │        │ │              │ │
│  │Decision│ │ Pi     │ │ Card   │ │ Agents       │ │
│  │ Cards  │ │ convo  │ │ list   │ │ Plugins      │ │
│  │ Status │ │ stream │ │ detail │ │ Auth         │ │
│  └────────┘ └────────┘ └────────┘ └──────────────┘ │
└─────────────────────────────────────────────────────┘
```

## SessionBus (conversation system)

The SessionBus manages all AI conversation sessions. Each session has an engine adapter that handles the actual AI interaction.

### Four Engine Adapters

| Engine Key | Adapter | Purpose |
|------------|---------|---------|
| `claude` | `ClaudeInteractiveAdapter` | User ↔ Pi real-time chat. Spawns `claude -p` subprocess, parses stream-json, extracts `<say>` voice tags |
| `gpt` | `GPTDirectAdapter` | ChatGPT direct API via Codex OAuth |
| `codex` | `CodexInteractiveAdapter` | Codex CLI interactive sessions |
| `run` | `RunSessionAdapter` | **Watch + takeover background tasks**. Tail jsonl file, SIGINT to interrupt, `claude --resume` to interject |

### RunSessionAdapter (task observation + takeover)

This is the bridge between PiOS.app and the Engine:

1. **Watching**: Engine runs a task → adapter tail's the session jsonl → events stream to UI in real-time
2. **Interjecting**: User sends message → adapter SIGINTs the adapter process → spawns `claude --resume <sid>` → continues same session
3. **Replay**: Task finished → adapter reads jsonl once, displays history

```
Engine spawns adapter → AI writes jsonl → RunSessionAdapter tails jsonl → UI shows events
                                                    │
                                          User clicks "takeover"
                                                    │
                                          SIGINT adapter process
                                                    │
                                          spawn claude --resume
                                                    │
                                          same jsonl, same session
```

## Home UI Dependencies

The Home screen reads Card files and displays them in sections. It depends on specific Card fields written by core agents.

| Home Section | Card Field Read | Written By |
|---|---|---|
| Decisions | `needs_owner` has value | work (when task needs user decision) |
| Decisions | `decision_brief` | work (summary of what needs deciding) |
| Ready Tasks | `ready_for_work: true` | triage (dispatch step) |
| Active Tasks | `status: active` | triage (inbox → active move) |
| Blocked Tasks | `blocked_on` has value | work, sense-maker |
| In Review | `status: in_review` | work (after completing task) |

**Contract**: If any core agent stops writing these fields correctly, Home breaks. See [Card System](card-system.md) for the full field contract.

## Vault Integration

PiOS.app finds the Vault via `backend/vault-root.js`:

```
Priority:
1. PIOS_VAULT environment variable
2. ~/.pios/config.json → vault_root
3. ~/PiOS (default fallback)
```

All Vault reads are direct file system access. No API, no cache layer.

## Bundled Resources

PiOS.app bundle (`app.asar`) includes:

```
app.asar/
├── main.js, preload.js, browser-preload.js
├── pios-home.html, auth-dialog.html, quick-input.html
├── backend/
│   ├── tools/
│   │   ├── pios-tick.sh      ← bundled copy of scheduler
│   │   ├── pios-adapter.sh   ← bundled copy of adapter
│   │   ├── reminder.sh
│   │   └── cron-runner.sh
│   ├── claude-client.js, codex-client.js, ...
│   ├── pios-engine.js, pios-installer.js, ...
│   └── adapters/, tools/
├── renderer/
└── node_modules/
```

**Distribution rule**: `pios-tick.sh` 以产品 repo `backend/tools/` 为唯一源码，build 时进 app bundle，install 时复制到 `~/.pios/tools/`。Vault `Pi/Tools/` 不再作为安装来源。

## Scheduler

PiOS.app 在启动时会每 60 秒 spawn 一次 `pios-tick.sh`，并在启动后立即先跑一次。因此安装流程不再注册外部 cron，避免 app 内置 scheduler 和系统 cron 双跑。
