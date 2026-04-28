# Engine Component

> Part of [PiOS Architecture](../../ARCHITECTURE.md) — Layer 1

## Overview

The Engine is PiOS's scheduling and execution infrastructure. It reads `pios.yaml`, matches tasks to cron schedules, and spawns AI sessions to execute them. It is pure bash + python3 (for YAML parsing), consumes zero AI tokens itself, and runs on every machine that has PiOS installed.

## Components

### pios-tick.sh (~650 lines bash)

**Location**: `Pi/Tools/pios-tick.sh` (current) → `engine/pios-tick.sh` (target)

**Trigger**: `* * * * *` via cron (every minute) or PiOS.app internal timer.

**Environment**: `PIOS_VAULT` must point to the Vault root. `PIOS_HOST` can override hostname detection.

**Execution flow** (each tick):

```
1. Host detection (hostname → laptop-host/worker-host/storage-host)
2. Scheduler mode check (pios.yaml scheduler: pios-tick | openclaw)
3. YAML schema validation + fallback to last-valid backup
4. Expired lock cleanup (Pi/State/locks/, 10min TTL)
5. Stale run reaping (same-host running > 60min → mark failed)
6. Reminder execution (laptop-host only, bash-only, zero AI)
7. Auth-pause check (Pi/State/auth-pause.json)
8. Catch-up computation (missed fires within 12h, proven-healthy gate)
9. Main loop — for each task:
   a. enabled + agent active?
   b. host match?
   c. auth-paused? (skip AI tasks)
   d. engine status ok? (check pios.yaml infra.runtimes, failover)
   e. cron match? (or catch-up candidate, max 2 per tick)
   f. depends_on satisfied? (run records today/yesterday)
   g. pre_gate passes? (bash expr, zero AI cost)
   h. acquire lock?
   i. spawn adapter (background)
```

**Key mechanisms**:

| Mechanism | How | Files |
|-----------|-----|-------|
| Distributed lock | JSON file with host/pid/expires_at, 10min TTL | `Pi/State/locks/{task}.lock.json` |
| Catch-up | Scan runs/, find proven-healthy tasks that missed a fire within 12h window | `Pi/State/runs/` |
| Engine failover | Task declares `engines: [claude-cli, codex-cli]`, tick tries alternatives when primary is down | `pios.yaml` task definition |
| Pre-gate | Bash expression evaluated before starting AI session; returns 0 = has work, 1 = skip | `pios.yaml` task `pre_gate` field |
| Schema fallback | Validates YAML on every tick; invalid → restore last-valid backup + notify critical | `Pi/State/.pios-yaml-last-valid` |
| Auth-pause | `all_exhausted: true` in auth-pause.json → skip all AI tasks | `Pi/State/auth-pause.json` |

**Logging**: `Pi/Log/cron/pios-tick-{host}-{date}.log` — one line per event (START, SKIP, GATE-SKIP, ENGINE-DOWN, CATCHUP, etc.)

### pios-adapter.sh

**Location**: `Pi/Tools/pios-adapter.sh` (current) → `engine/pios-adapter.sh` (target)

**Called by**: pios-tick.sh (as background subprocess)

**Role**: Construct the full prompt (SOUL.md + task prompt), start the appropriate AI CLI (claude-cli, codex-cli, local bash), capture output, write run record.

**Run record**: Written to `Pi/State/runs/{task}-{YYYYMMDD}-{HHMMSS}.json`

```json
{
  "run_id": "triage-20260416-093000",
  "agent": "pi",
  "task": "triage",
  "host": "laptop-host",
  "runtime": "claude-cli",
  "session_id": "uuid-from-claude-cli",
  "started_at": "2026-04-16T09:30:00+08:00",
  "finished_at": "2026-04-16T09:31:42+08:00",
  "status": "completed",
  "exit_code": 0,
  "token_input": 12000,
  "token_output": 3500,
  "cost_usd": 0.12,
  "bullets": ["triage: 2 inbox 处理", "派发: 1 张 ready_for_work"]
}
```

**Bullet extraction**: Adapter parses lines starting with `- ` from AI output → saves as `bullets` array in run record, and appends to `Pi/Log/worker-log-{host}.md`.

**Signal handling**: Traps SIGTERM/SIGINT → writes finish record before exit. SIGKILL/OOM → tick's stale reaper cleans up next tick.

### Other Engine Tools

| Tool | Role |
|------|------|
| `auth-manager.sh` | `login` / `status` / `switch` / `check` for Claude/Codex OAuth tokens |
| `auth-check.sh` | Hourly health check (called as infra-task) |
| `notify.sh` | Route notifications: critical → WeChat+PiBrowser, report → WeChat, reminder → PiBrowser TTS, info → PiBrowser, silent → log only |
| `notify-wechat.sh` | Low-level WeChat push (called by notify.sh) |
| `reminder.sh` | Read `reminders.yaml`, match current time, execute via `say` (macOS TTS) |
| `vault-snapshot.sh` | Daily incremental backup with hardlinks, 30-day retention |
| `backup-checker.sh` | Monitor Syncthing + Time Machine health |
| `anomaly-scanner.sh` | Scan audit logs for suspicious operations |
| `audit-hook.sh` | Claude Code postToolUse hook → append to audit.log |
| `pios-install.sh` | CLI installer (alternative to PiOS.app installer) |
| `pios-plugin.sh` | Plugin install/uninstall/list |
| `pios-register-cron.sh` | Register pios-tick in crontab |

## Interfaces

### Input: pios.yaml

Engine reads `agents.{id}.tasks.{id}` entries. Required fields per task:

```yaml
task_id:
  enabled: true/false
  prompt: relative path to .md prompt file
  trigger:
    cron: "*/15 * * * *"
  # Optional:
  host: laptop-host          # which machine runs this
  runtime: claude-cli   # which AI engine
  engines: [claude-cli, codex-cli]  # failover list
  depends_on: [other-task-id]       # wait for these
  pre_gate: "bash expression"       # zero-cost skip check
  catch_up: true                    # allow missed-fire recovery
  catch_up_window_minutes: 720      # how far back to check
```

### Output: Run Records

Written to `Pi/State/runs/{task}-{YYYYMMDD}-{HHMMSS}.json`. See format above.

Consumers:
- PiOS.app (task history display, running task detection)
- tick (depends_on check, catch-up computation, stale reaper)
- sense-maker (reads recent runs for system health assessment)

### Output: Locks

Written to `Pi/State/locks/{task}.lock.json`. Format:

```json
{"host": "laptop-host", "pid": 12345, "task": "triage", "started_at": "...", "expires_at": "..."}
```

Consumers: tick on all machines (mutual exclusion via Syncthing file sync).

### Output: Worker Log

Appended to `Pi/Log/worker-log-{host}.md`. Format: bullet lines extracted from AI output.

Consumers: triage (reads recent bullets for dispatch decisions), reflect (reads for performance review).
