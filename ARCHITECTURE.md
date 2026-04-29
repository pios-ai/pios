# PiOS Architecture

> Version: 0.1 | Date: 2026-04-16 | Status: Draft
>
> This is the authoritative architecture document for PiOS.
> All design decisions, component boundaries, and interface contracts are defined here.
> Before changing any PiOS component, read the relevant section first.

---

## 1. What PiOS Is

PiOS is an AI-native personal operating system. It runs AI agents on a schedule to manage your tasks, collect your data, and surface decisions that need your attention. You interact with it through PiOS.app (a desktop application) and through Cards (markdown files that represent tasks and projects).

**Core experience**: You drop tasks into Cards. PiOS triages, prioritizes, executes, and reports back. You make decisions. PiOS handles everything else.

**Design philosophy**: All state is files. No database. No backend server dependency. Files sync across machines via Syncthing. AI agents read and write these files on a schedule.

---

## 2. System Overview

```
User
 │
 ├─ PiOS.app ──── interactive conversation, task monitoring, notifications
 │
 └─ Cards ──────── drop tasks, receive results, make decisions
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│                         PiOS                                  │
│                                                               │
│  ┌─────────┐   ┌──────────┐   ┌────────────┐   ┌─────────┐ │
│  │ Engine  │──▶│Core Agents│──▶│   Cards    │◀──│  Plugins │ │
│  │         │   │           │   │            │   │          │ │
│  │ tick.sh │   │ triage    │   │ inbox      │   │ health   │ │
│  │ adapter │   │ work      │   │ active     │   │ wechat   │ │
│  │         │   │ sense     │   │ archive    │   │ photos   │ │
│  │         │   │ reflect   │   │            │   │ ecommerce│ │
│  └────┬────┘   └──────────┘   └─────┬──────┘   │ content  │ │
│       │                              │          │ intel    │ │
│       │         ┌────────────────────┘          │ diary    │ │
│       │         ▼                               └─────────┘ │
│  ┌────▼─────────────────┐                                    │
│  │       Vault          │                                    │
│  │  (file system)       │                                    │
│  │                      │                                    │
│  │  Pi/Config/          │  ← system config                   │
│  │  Pi/State/           │  ← runtime state (runs, locks)     │
│  │  Pi/Log/             │  ← logs                            │
│  │  Pi/Output/          │  ← agent outputs                   │
│  │  Pi/Memory/          │  ← persistent memory               │
│  │  {User}/             │  ← user personal data              │
│  │                      │                                    │
│  │  ← Syncthing sync →  │                                    │
│  └──────────────────────┘                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Five Layers

PiOS has five layers. Each layer has a clear owner and modification rules.

### Layer 1: Engine (product code)

**Owner**: PiOS developer. **Pi never modifies. User never modifies.**

The scheduling and execution infrastructure. Pure code, no user-specific content.

| Component | File(s) | Role |
|-----------|---------|------|
| Scheduler | `pios-tick.sh` | Every minute: read pios.yaml, match cron, check gates, acquire lock, spawn adapter |
| Adapter | `pios-adapter.sh` | Start AI CLI session with agent prompt, write run record |
| App | `main.js` + `backend/` + `renderer/` | Desktop UI, interactive conversation, task monitoring |
| Installer | `pios-installer.js` | First-time setup: create Vault, copy defaults, register cron |
| Plugin Manager | `pios-plugin.sh` | Install/uninstall plugins |
| Auth Manager | `auth-manager.sh` | Token lifecycle, refresh, account switching |
| Notifier | `notify.sh` | Route notifications by severity level |
| Tools | `audit-hook.sh`, `backup-checker.sh`, `anomaly-scanner.sh`, `vault-snapshot.sh` | Security, backup, monitoring |

**Update policy**: Replaced entirely on PiOS version upgrade. No user customization.

### Layer 2: Core Agents (product logic)

**Owner**: PiOS developer. **Pi executes but never modifies. User generally does not modify.**

The four core agents that make Card flow work. They ship with the `core` plugin. PiOS.app's Home UI depends on their behavior.

| Agent | Prompt | Schedule | Role |
|-------|--------|----------|------|
| triage | `triage.md` | */15 min | Ingest data, triage inbox, archive done, unblock, dispatch, notify |
| work | `work.md` | */5 min | Pick one ready Card, execute it, close or create follow-up |
| sense-maker | `sense-maker.md` | */2 hours | Reconcile reality with system state, update Cards, manage domains |
| reflect | `reflect.md` | daily 4:00 | Review system performance, diagnose issues, create improvement Cards |

Supporting core tasks (also in `core` plugin):

| Task | Schedule | Role |
|------|----------|------|
| daily-briefing | daily 8:09 | Generate daily summary for user |
| maintenance | daily 2:30 | System health check, log cleanup |
| token-daily-summary | daily 3:02 | Token usage report |
| vault-snapshot | daily 3:00 | Incremental backup |
| auth-health-check | hourly | Token refresh, account health |

**Update policy**: Updated on PiOS version upgrade. Prompts are parameterized with `{owner}` and `{vault}` — no hardcoded user content. Power users may customize at their own risk.

**Critical dependency**: PiOS.app Home reads Card fields (`needs_owner`, `ready_for_work`, `status`, `decision_brief`) that core agents write. Changing core agent behavior can break the UI. See [Card System Contracts](docs/components/card-system.md).

### Layer 3: Plugins (installable capabilities)

**Owner**: Plugin developer (may be PiOS team or third-party). **User installs/uninstalls and configures.**

Each plugin adds domain-specific agents, tasks, data sources, and notification rules. Plugins register with the system through `plugin.yaml`.

| Plugin | Agents | Key Tasks | Data Sources |
|--------|--------|-----------|--------------|
| `health` | life | daily-health, weekly-health-review, reminders-refresh | Apple Health export |
| `wechat` | — | daily-wechat-digest | WeChat local DB |
| `photos` | — | daily-photo-diary | Immich API |
| `diary` | — | daily-user-status, daily-diary-engine | Aggregates all pipeline outputs |
| `ecommerce` | hawkeye | hawkeye-worker | Amazon product pages |
| `content` | creator | daily-scripts | User daily data + style guides |
| `intel` | intel, scout | intel-worker, big-thing-daily-scan | Web search |
| `browser` | — | — | PiBrowser automation |
| `location` | — | — | iCloud location |

**Update policy**: Updated independently per plugin. Plugin prompts may contain user-specific configuration (ASINs, health goals, etc.) which should be read from plugin config files, not hardcoded.

**Current gap**: Plugin prompts currently hardcode user-specific content. Target: parameterize all prompts, move user-specific values to plugin config.

### Layer 4: User Configuration

**Owner**: User. **Pi modifies only when user explicitly asks.**

| File | Purpose | Who Writes |
|------|---------|------------|
| `Pi/Config/pios.yaml` | Which agents, schedules, machines, plugins, infrastructure | User (via installer or manual) |
| `Pi/Config/alignment.md` | Values and priorities | User |
| `Pi/BOOT.md` | User profile + startup protocol | Installer (template), user (customizes) |
| `Pi/Config/infra-topology.md` | Machine hardware, network, security details | User |
| Plugin configs | Domain-specific parameters (ASINs, health goals, etc.) | User |

**Update policy**: Never overwritten by PiOS upgrades. Migrations may add new fields with defaults.

### Layer 5: Runtime Data

**Owner**: Pi (the AI). **Pi freely reads and writes.**

| Directory | Content | Written By |
|-----------|---------|------------|
| `Cards/inbox/` | New tasks awaiting triage | User or agents |
| `Cards/active/` | Current tasks and projects | triage, work, sense-maker |
| `Cards/archive/` | Completed tasks | triage |
| `Pi/State/runs/` | Run records (one JSON per task execution) | adapter |
| `Pi/State/locks/` | Distributed locks (JSON, 10min TTL) | tick |
| `Pi/Log/` | Worker logs, sense logs, cron logs, cleanup logs | agents, tick |
| `Pi/Output/` | Agent outputs (intel reports, content, infra docs) | agents |
| `Pi/Memory/` | Persistent cross-session memory | Pi |
| `{User}/Personal/Daily/` | Daily diary | pipeline |
| `{User}/Pipeline/` | Raw data from plugins (health, wechat, photos) | pipeline tasks |

**Update policy**: Ephemeral. Not part of PiOS product. Not synced to product repo.

---

## 4. Key Data Flows

### 4.1 Card Lifecycle

```
User creates Card          Plugin task creates Card
(or drops into inbox/)     (e.g., scout finds opportunity)
        │                           │
        ▼                           ▼
   Cards/inbox/                Cards/inbox/
        │                           │
        └───────────┬───────────────┘
                    ▼
            triage (*/15 min)
            · set priority
            · match parent project
            · dedup check
            · move to active/
                    │
                    ▼
            Cards/active/
            (status: active, waiting for dispatch)
                    │
            triage dispatches:
            · calculate target backlog
            · pick candidates by priority/energy
            · write ready_for_work: true
                    │
                    ▼
            work (*/5 min)
            · pick one ready_for_work Card
            · read context, execute task
            · update Card status
            · set status: done or needs_owner
                    │
              ┌─────┴──────┐
              ▼             ▼
        status: done   needs_owner: ...
              │             │
              │             ▼
              │        PiOS.app Home
              │        shows Decision
              │             │
              │        User responds
              │             │
              │        triage clears
              │        needs_owner
              │             │
              ▼             ▼
        triage archives  back to active
        → Cards/archive/   (next work cycle)
```

### 4.2 Scheduling Flow

```
cron (every minute)
  │
  ▼
pios-tick.sh
  │
  ├─ validate pios.yaml (schema check, fallback to last-valid)
  ├─ cleanup expired locks
  ├─ reap stale runs (same-host only)
  ├─ run reminders (laptop-host only, zero AI)
  ├─ check auth-pause
  ├─ compute catch-up candidates
  │
  └─ for each task in pios.yaml:
       ├─ enabled? agent active?
       ├─ host matches this machine?
       ├─ engine status ok? (failover to alt engine if down)
       ├─ cron matches now? (or catch-up candidate?)
       ├─ depends_on satisfied? (run records exist)
       ├─ pre_gate passes? (bash expression, zero AI)
       ├─ acquire distributed lock?
       │
       └─ YES → spawn pios-adapter.sh (background)
                  │
                  ├─ construct prompt: SOUL.md + task prompt
                  ├─ start AI CLI session (claude/codex)
                  ├─ write run record to Pi/State/runs/
                  ├─ extract bullet log → worker-log
                  ├─ update gate-state
                  └─ release lock
```

### 4.3 PiOS.app ↔ Engine Interaction

```
PiOS.app                              Engine (pios-tick + adapter)
   │                                        │
   │  reads Pi/State/runs/*.json ◀──────── writes run records
   │  tail ~/.claude/...jsonl    ◀──────── AI session writes jsonl
   │                                        │
   │  SIGINT adapter process    ──────────▶ adapter receives signal
   │  claude --resume <sid>     ──────────▶ resume same session
   │                                        │
   │  reads Pi/Config/pios.yaml ◀──────── tick reads same file
   │  reads Cards/*             ◀──────── agents write Cards
   │                                        │
   │  watches pi_notify.json    ◀──────── notify.sh writes
   │  shows desktop notification            │
   │  plays TTS                             │
```

**They never call each other directly. All communication is through Vault files.**

---

## 5. Machine Topology

PiOS runs across multiple machines. Each machine runs its own pios-tick.sh (via cron or PiOS.app). Tasks are assigned to machines via the `host` field in pios.yaml.

```
┌─────────────────┐     Syncthing      ┌─────────────────┐
│   laptop-host        │ ◀═══════════════▶  │   worker-host     │
│   (primary)     │     (Vault sync)   │   (secondary)   │
│                 │                     │                 │
│  PiOS.app       │                     │  cron + tick    │
│  cron + tick    │                     │  batch tasks    │
│  interactive    │                     │                 │
│  browser, TTS   │                     │                 │
│  all plugins    │                     │  intel, scout   │
└────────┬────────┘                     └────────┬────────┘
         │            Syncthing                   │
         └──────────▶ storage-host ◀───────────────────┘
                      (storage)
                      Immich, pipeline-api
```

**Distributed lock** prevents the same task from running on multiple machines simultaneously. Lock files in `Pi/State/locks/` sync via Syncthing.

---

## 6. Component Dependency Map

```
PiOS.app Home UI
    │
    │ reads: needs_owner, ready_for_work, status, decision_brief
    │
    ▼
Card Fields (defined in card-spec.md)
    ▲                    ▲                    ▲
    │                    │                    │
  triage              work              sense-maker
  (writes status,     (writes status,   (writes status,
   ready_for_work,     needs_owner,      blocked_on,
   dispatches)         decision_brief)   energy)
    │                    │                    │
    │  reads             │  reads             │  reads
    ▼                    ▼                    ▼
pios.yaml          Card content         Owner data
plugin configs     Pi/Output/           Pi/Log/
Pi/State/runs/     SOUL.md              {User}/Daily/
gate-state.json                         wechat digest
    ▲
    │ written by
    │
  Engine (tick + adapter)
    ▲
    │ triggered by
    │
  cron / PiOS.app timer
```

**Key dependencies to remember when making changes:**
- Change Card fields → check PiOS.app Home code + triage + work + sense-maker
- Change triage dispatch logic → check PiOS.app Home (what it expects to display)
- Change pios.yaml schema → check tick (parser), app (pios-engine.js), installer
- Change run record format → check app (run discovery), tick (stale reaper), adapter
- Change plugin.yaml format → check plugin manager, installer, pios-engine.js

---

## 7. File Ownership Model

Every file in the Vault belongs to exactly one of the five layers. This determines who can modify it.

### Quick Reference

| Path Pattern | Layer | Pi Can Modify? |
|---|---|---|
| `Projects/pios/` (this repo) | Engine | Never |
| `Projects/pios/` | Engine | Never |
| `Pi/Tools/*.sh` | Engine | Never |
| `Pi/Plugins/core/` | Core Agents | Never |
| Core agent prompts (`triage.md`, `work.md`, `sense-maker.md`, `reflect.md`) | Core Agents | Never |
| `Pi/Config/card-spec.md`, `execution-protocol.md`, `done-protocol.md`, `notification-spec.md` | Core Agents | Never |
| `Pi/Plugins/{non-core}/` | Plugins | Never (plugin developer maintains) |
| Plugin agent prompts | Plugins | Never |
| `Pi/Config/pios.yaml` | User Config | Only when user asks |
| `Pi/Config/alignment.md` | User Config | Only when user asks |
| `Pi/BOOT.md` | User Config | Only when user asks |
| `Pi/Config/infra-topology.md` | User Config | Only when user asks |
| `Cards/*` | Runtime Data | Freely |
| `Pi/Log/*`, `Pi/Output/*`, `Pi/Memory/*`, `Pi/State/*` | Runtime Data | Freely |
| `{User}/*` | Runtime Data | Freely |

---

## 8. Product Repo Structure (Target)

```
Projects/pios/                    ← product repo (this directory)
│
├── ARCHITECTURE.md               ← this file
├── docs/
│   └── components/               ← per-component documentation
│
├── app/                          ← PiOS.app (Electron) — currently Projects/pios/
│   ├── main.js
│   ├── pios-home.html
│   ├── backend/
│   ├── renderer/
│   └── package.json
│
├── engine/                       ← scheduling + execution scripts
│   ├── pios-tick.sh
│   ├── pios-adapter.sh
│   ├── pios-install.sh
│   └── ...other tools
│
├── core/                         ← core plugin (triage/work/sense-maker/reflect)
│   ├── plugin.yaml
│   ├── agents/
│   │   ├── pi/SOUL.md
│   │   ├── pi/tasks/triage.md
│   │   ├── pi/tasks/work.md
│   │   ├── pi/tasks/sense-maker.md
│   │   ├── pi/tasks/reflect.md
│   │   ├── maintenance/SOUL.md
│   │   └── maintenance/tasks/...
│   └── specs/
│       ├── card-spec.md
│       ├── execution-protocol.md
│       ├── done-protocol.md
│       └── notification-spec.md
│
└── plugins/                      ← official plugins (each could be its own repo)
    ├── health/
    ├── wechat/
    ├── photos/
    ├── diary/
    ├── ecommerce/
    ├── content/
    ├── intel/
    └── browser/
```

**Current state → target mapping:**

| Current Location | Target Location |
|---|---|
| `Projects/pios/` | `Projects/pios/app/` |
| `backend/tools/pios-tick.sh` (repo source) + bundle/vault copies | `Projects/pios/engine/` (single source) |
| `Pi/Plugins/core/` | `Projects/pios/core/` |
| `Pi/Plugins/{other}/` | `Projects/pios/plugins/{other}/` |
| `Pi/Config/card-spec.md` etc. | `Projects/pios/core/specs/` |

For the current 3-location pios-tick.sh runtime layout (repo / app bundle /
vault) and the drift-control rule that .app form only reads bundle, see
[docs/components/engine.md](docs/components/engine.md#pios-ticksh-650-lines-bash).
| `Pi/Agents/pi/tasks/triage.md` etc. | `Projects/pios/core/agents/pi/tasks/` |

**User Vault (after split) retains:**

```
~/PiOS/                           ← user Vault
├── Pi/Config/pios.yaml           ← user config
├── Pi/Config/alignment.md
├── Pi/BOOT.md
├── Pi/Config/infra-topology.md
├── Cards/
├── Pi/Log/ Output/ Memory/ State/
├── {User}/
└── Projects/                     ← user's own projects (not PiOS product code)
```

---

## 9. Known Gaps (Current → Target)

Tracked gaps for v0.7.12. Resolved items are listed below the table.

| # | Gap | Impact | Priority |
|---|-----|--------|----------|
| 1 | Naming inconsistency: pios / pi-browser / PiOS / PiBrowser | Four names for overlapping things across UI / docs / packages | Low |
| 2 | main.js is 7465 lines single file | All app logic in one file; hard to maintain, change risk leaks across concerns | Low |
| 3 | Thin test coverage: P6 smoke (15 cases, pre-commit hook) + 2 owner-queue tests | No CI, no unit test suite — large refactors lack a safety net | Medium |
| 4 | DMG is not code-signed / notarized | macOS Gatekeeper blocks first launch; user has to manually approve | High (for distribution) |
| 5 | Setup wizard requires Claude Code CLI to be pre-installed | Not truly one-click; user must run `npm i -g @anthropic-ai/claude-code && claude auth login` first | Medium |

### Resolved (v0.7.0 → v0.7.12)

- ✅ **PiOS.app now embeds the scheduler**: `main.js` runs an internal `setInterval` every 60s that spawns `pios-tick.sh`, with a `powerMonitor.resume` hook to recover from laptop sleep. External cron is no longer required.
- ✅ **Core agent prompts are parameterized**: SOUL.md, characters.yaml, and all task prompts use `{owner}` placeholders; runtime values come from `~/.pios/config.json`.
- ✅ **Plugin prompts are sanitized**: v0.7.9 moved all owner-specific configuration to plugin config files; prompts no longer hardcode any concrete values.
- ✅ **Hostname normalization is centralised**: `backend/lib/host-resolve.js` replaces 6 copies of the same regex block. Multi-machine users configure aliases in `~/.pios/config.json`.
- ✅ **pios-tick.sh single SSoT (2026-04-29 plan c)**: Vault `Pi/Tools/` is the canonical runtime; `Projects/pios/backend/tools/` is now build-input-only (auto-synced from Vault via `npm run prebuild:*`); bundle is bootstrap-source-only. `install-app.sh` no longer reverse-syncs bundle → vault. Resolves "3 copies divergence" by removing two of them as canonical sources. See `verify-pios-tools-regression-fix-2026-04-29` for the regression event that prompted this.
- ✅ **Plugin self-registration (Phase 3c, v0.7.10)**: `plugin-registry` routes `triage_hooks` (`on_gate` / `on_ingest`) instead of hardcoded plugin paths. health, ecommerce, browser, content, diary, intel, location, photos plugins ship `triage-gate` + `triage-ingest` hook scripts via `plugin.yaml`. New plugins now extend triage by adding hooks rather than editing the core prompt.
- ✅ **Sanitize-lint chain (v0.7.10)**: `scripts/sanitize-lint.sh` refactored into a generic pattern engine + extra-patterns; runs as both pre-commit hook (staged additions) and pre-push hook (full history + tag messages + author/committer emails) when pushing to `pios-ai*` remotes.
- ✅ **Multi-host deploy script (v0.7.10)**: `scripts/deploy.sh` orchestrates build → install → vault sync → peer daemon restart → verify. Driven by `~/.pios/config.json` `deploy` section (peer SSH target, peer vault path, daemon list); auto-skips peer steps for single-host users.
- ✅ **Atomic-write helper (v0.7.10)**: `backend/lib/atomic-write.js` centralises the temp-file + rename pattern; 11 call sites migrated, removing copy-pasted error-prone implementations.
- ✅ **Three system agents fully shipped (v0.7.11)**: bundle now ships SOUL for `pi`, `pipeline`, and `radar` (the 3 system agents per `pios.yaml` manifest). Installer no longer creates the vestigial empty `Pi/Agents/maintenance/` and `Pi/Agents/sense-maker/` dirs (those are tasks under `pi`, not standalone agents). `maintenance` task is enabled by default in seeded manifest.
- ✅ **Voice plugin (v0.7.11)**: `backend/plugins/voice/` packages qwen-voice (NPC clone-voice TTS + local ASR) as a plugin. Resources tab surfaces an activation button; clicking spawns a PiBrowser sidebar conversation where Pi guides the user through installing the local MLX stack (mlx-audio / mlx-whisper / mlx-lm) on their own machine. `Lite` build still ships voiceless; the Full build path remains via `~/qwen-voice/` as before.
- ✅ **Plugin self-heal in pios-tick (v0.7.11)**: when `~/.pios/config.json` lists a plugin ID but `vault/Pi/Plugins/<id>/` is missing (dev-built vault, sync drift, or partial install), each tick now copies the plugin from the bundle into the vault using `cp -rn` (never overwrites user edits). The Resources tab activation button stops vanishing on state drift.
- ✅ **Pipeline tasks disabled by default (v0.7.12)**: all 7 seeded pipeline tasks (daily-ai-diary, daily-diary-engine, daily-health, daily-photo-diary, daily-user-status, daily-wechat-digest, daily-world-feed) are `enabled: false` on a fresh install. Users opt in from the Resources / Team panel after deciding which pipelines they want and configuring credentials. (issue #4)
- ✅ **`mainWindow` getter pattern (v0.7.12)**: `main/installer-bridge.js` no longer captures `mainWindow` by value at register time (when the `BrowserWindow` is still `null` because module-level wiring runs before `app.whenReady`). `main.js` now passes `getMainWindow: () => mainWindow` and the IPC handler resolves the window at call time, fixing "PiOS 主窗口未就绪" errors when activating the WeChat / voice plugins. (issue #3)
- ✅ **`pios.yaml` validation diagnostics (v0.7.12)**: when YAML parsing or schema check fails, the python traceback is written to `~/.pios/logs/config-validation.log` (rolling 500-line buffer), the notification message includes the log path plus line/column hint when available, and the bubble status is `warn` if rollback succeeds vs `critical` if there is no usable backup. (issue #2)

---

## 10. Design Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-16 | triage/work/sense-maker/reflect are product code, not user config | PiOS.app Home depends on their Card field writes. Breaking them breaks the product. |
| 2026-04-16 | All state is files, no database | Simplicity, Syncthing portability, human-readable, git-friendly |
| 2026-04-16 | Distributed locks via Vault files | Syncthing provides cross-machine consistency; no need for coordination server |
| 2026-04-16 | Plugins register capabilities; core agents consume them | triage should not hardcode plugin-specific logic |
| 2026-04-16 | PiOS.app should embed scheduler (spawn pios-tick.sh) | Standalone app experience; no manual cron setup for new users |
