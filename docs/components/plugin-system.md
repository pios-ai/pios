# Plugin System Component

> Part of [PiOS Architecture](../../ARCHITECTURE.md) — Layer 3

## Overview

Plugins add domain-specific capabilities to PiOS. Each plugin can register agents, tasks, scripts, services, and MCP tools. The `core` plugin is required; all others are optional.

Users install plugins to get capabilities (health tracking, WeChat integration, e-commerce monitoring). Users configure plugins through config files, not by editing plugin prompts.

## Plugin Registry

| Plugin | Required | Platform | What It Adds |
|--------|----------|----------|--------------|
| `core` | YES | all | triage, work, sense-maker, reflect, maintenance, briefing |
| `health` | no | macOS | Apple Health data collection, weekly review, reminders |
| `wechat` | no | macOS | WeChat message extraction, daily digest |
| `photos` | no | all (needs Immich) | Photo diary from Immich |
| `diary` | no | all | Daily diary synthesis from all pipeline outputs |
| `ecommerce` | no | all | Amazon product monitoring (Hawkeye) |
| `content` | no | all | Short-form video scripts, XHS content |
| `intel` | no | all | Research tasks, intelligence scanning |
| `browser` | no | macOS | PiBrowser automation via MCP |
| `location` | no | macOS (needs iCloud) | Location tracking |
| `owner-private` | no | — | owner's private config (not distributable) |

## plugin.yaml Format

Each plugin has a `plugin.yaml` at its root:

```yaml
name: health
version: 0.1.0
description: Apple Health data collection and health management
platform: macos
requires:
  binaries: [python3]
  plugins: [core]     # dependencies on other plugins

# Agents this plugin provides (registered into pios.yaml on install)
agents:
  life:
    name: Life Manager
    soul: agents/life/SOUL.md
    plugins: [vault, health]
    runtime: claude-cli

# Tasks this plugin provides
tasks:
  daily-health:
    agent: pipeline      # attaches to existing agent
    prompt: tasks/daily-health.md
    trigger:
      cron: "40 0 * * *"
  weekly-health-review:
    agent: life
    prompt: tasks/weekly-health-review.md
    trigger:
      cron: "0 10 * * 0"
  reminders-refresh:
    agent: life
    prompt: tasks/reminders-refresh.md
    trigger:
      cron: "0 4 1,15 * *"

# Scripts (non-AI, bash/python)
scripts:
  health-probe:
    path: scripts/health-probe.py
    description: Extract metrics from Apple Health export

# MCP capabilities
mcp:
  health:
    description: Apple Health data
    host: laptop-host

# Services (daemons)
services: {}

# Hooks (Claude Code hooks)
hooks: {}
```

## Plugin Lifecycle

### Install

```bash
pios-plugin.sh install health
```

1. Copy plugin directory to `Pi/Plugins/health/`
2. Merge plugin's agents/tasks into `pios.yaml`
3. Copy agent SOUL.md and task prompts to appropriate locations
4. Register MCP capabilities
5. Start any services

### Uninstall

```bash
pios-plugin.sh uninstall health
```

1. Remove plugin's agents/tasks from `pios.yaml`
2. Remove agent/task files
3. Stop services
4. Remove plugin directory

### Update

Replace plugin files, re-merge into pios.yaml. User config (pios.yaml overrides) preserved.

## Plugin ↔ Core Agent Interaction (Hook Registration)

**Goal**: triage / sense-maker / reflect (core agents) treat all plugins
uniformly via a registry. Plugins self-describe what they provide and which
core hooks they participate in. **No plugin-specific logic in core
agent prompts.**

**Status**:

- Phase 3a (2026-04-28): infra layer in place — `plugin.yaml` schema
  extension, `backend/lib/plugin-registry.js`, wechat plugin pilot. Core
  agents still hardcode wechat path; new infra is dormant.
- Phase 3b (2026-04-28): switch core triage to read from registry; remove wechat
  hardcoding. `pi-triage-pregate.sh` now calls `plugin-registry-cli.js gate-all`.
  `core/tasks/triage.md` 动作 1 is now dispatch-only. Verified: disable/enable
  smoke, test-plugin auto-discovery, wechat hardcoding fully removed.
- Phase 3c (design 2026-04-28, impl ongoing): migrate remaining plugins
  (health → ecommerce → intel → photos → diary → browser → location → content)
  one session per 1-2 plugins. After all migrated, triage 大瘦身 extracts
  social-state and speech-decision sections to shrink triage.md toward ≤300 lines.
  See "Phase 3c Migration Plan" section below.
- Phase 3c data plugin hooks (2026-04-29): backend plugin hook coverage now
  exists for health, ecommerce, intel, photos, diary, content, browser, and
  location. `browser` reads PiBrowser session metadata only; `location` fires
  only when a location digest file exists.
- Phase 3c-final (2026-04-29): core triage prompt was slimmed from 963 lines to
  274 lines in both the product source and runtime copy. The prompt keeps
  dispatch/card-flow contracts inline and points speech/social details to
  `docs/pi-speak-behavior.md`; plugin-specific data paths remain behind
  registry hooks.

### `plugin.yaml` Hook Schema (Phase 3a)

```yaml
# What this plugin contributes that core agents need to know about
provides:
  # Card source tags — when this plugin creates a card, frontmatter
  # `source:` should be one of these. Lets sense-maker / reflect
  # attribute cards back to their originating plugin without grepping.
  card_sources: [wechat-pipeline]

  # Resolved-on-demand data paths. core agents access them via the
  # registry, not by hardcoding. Tokens like {owner} / {vault} / {date}
  # are substituted at call time.
  data_paths:
    today_raw: "{owner}/Pipeline/AI_Wechat_Digest/daily_raw/{date}.md"

# Hooks core agents call into during their tick.
triage_hooks:
  # Gate hook: cheap probe answering "do you have new data this tick?"
  # core triage runs ALL plugins' on_gate hooks at start of tick;
  # any plugin returning fire=true contributes to triage's wake-up reason.
  on_gate:
    script: scripts/triage-gate.sh
    timeout_sec: 5
    description: Cheap mtime/state check; no decryption, no AI.

  # Ingest hook: only run when on_gate said fire=true.
  # Heavier: may decrypt / parse / call out to network.
  # Returns structured events for core triage to act on (create cards,
  # update Owner_Status, etc.).
  on_ingest:
    script: scripts/triage-ingest.sh
    timeout_sec: 60
    description: Run only when gate fires; emit events JSON.
```

### Hook Contract

#### `on_gate`

Environment variables:

| Var | Meaning |
|---|---|
| `PIOS_VAULT` | absolute path to vault root |
| `PIOS_HOST` | resolved canonical host id |
| `PIOS_OWNER` | owner key (`{owner}` substitution source) |
| `PIOS_PLUGIN_LAST_STATE_JSON` | absolute path to JSON file holding the plugin's prior `since_state` (may not exist on first run) |

stdout: a single line of JSON:

```json
{
  "fire": true,
  "kind": "new-daily-raw",
  "payload": {
    "raw_path": "/Users/.../daily_raw/2026-04-28.md",
    "mtime": 1714291200
  },
  "since_state": {
    "wechat_mtime": 1714291200
  }
}
```

- `fire` (required, bool) — was there new data?
- `kind` (optional, string) — plugin-defined event type, opaque to core
- `payload` (optional, object) — passed to `on_ingest` if fire is true
- `since_state` (optional, object) — registry merges into the plugin's
  state file so next tick's `on_gate` can compare

If `fire=false`, the rest are ignored. Exit code 0 means success
regardless of fire/skip; non-zero is treated as an error and logged.

#### `on_ingest`

Environment variables: same as `on_gate`, plus:

| Var | Meaning |
|---|---|
| `PIOS_PLUGIN_GATE_PAYLOAD` | JSON string of the `payload` from `on_gate` |

stdout: a single line of JSON:

```json
{
  "events": [
    {
      "kind": "owner-instruction",
      "summary": "Owner asked to investigate X",
      "raw_path": "/Users/.../daily_raw/2026-04-28.md#L42",
      "card_proposal": {
        "type": "task",
        "title": "调研 X",
        "body_excerpt": "..."
      }
    }
  ],
  "summary_for_triage": "wechat: 3 owner instructions, 2 status updates"
}
```

- `events` (required, array) — zero or more structured events for triage
  to act on. core triage may turn `card_proposal` into actual cards.
- `summary_for_triage` (optional, string) — one-liner for triage's log

### Why hooks are scripts, not LLM prompt

- **Deterministic**: same input → same output. LLM prompt-based
  "ingest hint" forces every triage tick to spend tokens re-deriving
  what amounts to a deterministic file probe.
- **Testable**: `bash scripts/triage-gate.sh` can be unit-tested
  outside any LLM context.
- **Cheap**: gate hook is ~milliseconds (mtime + JSON write) vs ~seconds
  of LLM thinking.
- **Composable**: registry can run all plugins' gates in parallel. LLM
  has to read each prompt segment serially.

LLM judgement enters at the `on_ingest → events → core triage's reaction`
boundary, not at the gate level.

### Registry API (`backend/lib/plugin-registry.js`)

Loaders:

```js
const registry = require('./lib/plugin-registry');
await registry.load();  // reads all backend/plugins/*/plugin.yaml
```

Query:

```js
registry.listEnabled();              // [{id, provides, triage_hooks}, ...]
registry.findBySource('wechat-pipeline');  // → {id: 'wechat', ...} | null
registry.resolvePath('wechat', 'today_raw');  // → '/Users/.../daily_raw/2026-04-28.md'
```

Hook execution:

```js
const result = await registry.runGate('wechat');
// → { fire: true, kind: '...', payload: {...}, since_state: {...} }

const ingestResult = await registry.runIngest('wechat', result.payload);
// → { events: [...], summary_for_triage: '...' }
```

Scheduler integration (Phase 3b): `pi-triage-pregate.sh` (or pios-tick.sh
inline) calls `registry.runAllGates()` before triage launches; result
written to `Pi/State/plugin-triage-state-{host}.json` for triage prompt
to read.

## File Structure Per Plugin

```
Pi/Plugins/{name}/
├── plugin.yaml          ← registration manifest
├── agents/
│   └── {agent}/
│       ├── SOUL.md      ← agent identity and rules
│       └── tasks/
│           └── *.md     ← task prompts
├── scripts/             ← non-AI scripts (bash/python)
├── config/              ← plugin-specific configuration
└── README.md            ← plugin documentation
```

## User Configuration

Plugin-specific user settings should live in plugin config files, NOT in prompts:

```
Pi/Plugins/ecommerce/config/
├── tracked-products.yaml    ← ASINs, categories, alert thresholds
└── schedule.yaml            ← custom schedule overrides

Pi/Plugins/health/config/
├── conditions.yaml          ← user's health conditions, medications
├── goals.yaml               ← sleep target, activity goals
└── reminders.yaml           ← reminder schedule and messages
```

Prompts read these config files at runtime. This way, users customize behavior without editing prompts.

## Phase 3c Migration Plan (2026-04-28 design)

### Context

After Phase 3b (wechat migrated, triage dispatch-only), `core/tasks/triage.md` is
963 lines. The remaining data plugins (health / ecommerce / intel / photos / diary /
browser / location / content) need gate+ingest hooks. Adding a new plugin does NOT
require changing `triage.md` — the dispatch loop in 動作 1 is already generic.

Separately, `triage.md` 大瘦身 must extract the large non-plugin core sections
(動作 7.5 social-state ~150 ln, 動作 8 speech-decision ~135 ln) to reach the ≤300
line target. This is tracked as a follow-up sub-task once all data plugins are done.

---

### Migration Order (priority order, one session per 1-2 plugins)

#### Session 3c-1: health plugin

**Why first**: cleanest data path, no decrypt, purely additive (no triage.md removals).
Validates the pattern for pipeline-data plugins.

| Hook | Script | Logic |
|------|--------|-------|
| gate | `scripts/triage-gate.sh` | compare `{owner}/Pipeline/AI_Health_Digest/daily_health/{today}.md` mtime to `plugin-health-state-{host}.json` |
| ingest | `scripts/triage-ingest.sh` | read daily_health + supplement/rhythm/eye-care, emit events: `health-summary-available`, flag anomalies if any |

```yaml
# backend/plugins/health/plugin.yaml — expected additions
provides:
  card_sources: [health-pipeline]
  data_paths:
    daily_health: "{owner}/Pipeline/AI_Health_Digest/daily_health/{date}.md"
    supplement: "{owner}/Pipeline/AI_Health_Digest/supplement-tracking/{date}.md"
    rhythm: "{owner}/Pipeline/AI_Health_Digest/rhythm-tracking/{date}.md"
    eye_care: "{owner}/Pipeline/AI_Health_Digest/eye-care-tracking/{date}.md"
triage_hooks:
  on_gate:
    script: scripts/triage-gate.sh
    timeout_sec: 5
  on_ingest:
    script: scripts/triage-ingest.sh
    timeout_sec: 15
```

**Note**: `backend/plugins/health/` does not exist yet (health is currently a pios.yaml
plugin flag enabling MCP access). This session creates the `backend/plugins/health/`
directory and hook scripts. The existing `life` agent and `daily-health` task are NOT
moved — they stay as pios.yaml agents.

Verify: `pios.yaml plugins.health.enabled: false` → listEnabled() excludes health →
pregate skips health hook.

---

#### Session 3c-2: ecommerce plugin (wraps hawkeye agent)

**Why second**: survival-priority domain. Hawkeye agent has an independent workspace;
the plugin hook gives triage visibility into new scan results without replacing the agent.

| Hook | Script | Logic |
|------|--------|-------|
| gate | `scripts/triage-gate.sh` | check newest file mtime in `Pi/Agents/hawkeye/workspace/` vs state |
| ingest | `scripts/triage-ingest.sh` | read latest scan file, emit `ecommerce-scan-available` events; also expose `domain_context_path` for triage card enrichment |

```yaml
# backend/plugins/ecommerce/plugin.yaml
provides:
  card_sources: [ecommerce-scan, hawkeye-pipeline]
  data_paths:
    workspace: "Pi/Agents/hawkeye/workspace/"
    domain_context: "Projects/pios/backend/plugins/ecommerce/config/DOMAIN.md"
triage_hooks:
  on_gate:
    script: scripts/triage-gate.sh
    timeout_sec: 5
  on_ingest:
    script: scripts/triage-ingest.sh
    timeout_sec: 20
```

**Removes from triage.md**: line ~540 `ai-ecommerce DOMAIN.md` hardcoded reference.
After migration, triage reads `domain_context` via `registry.resolvePath('ecommerce', 'domain_context')`.

**Boundary note**: hawkeye agent (`Pi/Agents/hawkeye/`) stays in pios.yaml.agents — it is
an agent, not being moved into `backend/plugins/`. The `ecommerce` plugin provides only
triage hooks that surface agent outputs.

---

#### Session 3c-3: intel plugin (surfaces workspace reports)

**Why third**: intel workspace already exists; gate/ingest can reuse the scan-state pattern.

| Hook | Script | Logic |
|------|--------|-------|
| gate | `scripts/triage-gate.sh` | check newest `.md` mtime in `Pi/Agents/intel/workspace/` vs state |
| ingest | `scripts/triage-ingest.sh` | read new reports (files newer than since_state), emit `intel-report-available` events with titles/paths |

```yaml
provides:
  card_sources: [intel-pipeline]
  data_paths:
    workspace: "Pi/Agents/intel/workspace/"
    dedup_index: "Pi/Agents/intel/workspace/"   # dedup-check.py uses this
triage_hooks:
  on_gate:
    script: scripts/triage-gate.sh
    timeout_sec: 5
  on_ingest:
    script: scripts/triage-ingest.sh
    timeout_sec: 10
```

**Removes from triage.md**: line ~137 hardcoded intel workspace path in dedup-check.
After migration, triage gets path via `registry.resolvePath('intel', 'workspace')`.

---

#### Session 3c-4+: photos, diary, browser, location, content

Follow the same gate/ingest pattern. Lower urgency. Defer until 3c-1/2/3 validated.

| Plugin | Gate signal | Ingest output |
|--------|-------------|---------------|
| photos | `{owner}/Pipeline/AI_Photo_Digest/daily_photo/{date}.md` mtime | `photos-daily-available` events |
| diary | `{owner}/Personal/Daily/{date}.md` mtime | `diary-available` events |
| browser | PiBrowser process running + new session | browser-session events |
| location | iCloud location file mtime | location-update events |
| content | `Pi/Agents/creator/workspace/` newest md/txt mtime | `content-ready` events |

#### Session 3c-6: content plugin

**Why now**: final triage slimming is blocked on extracting large non-plugin core
sections, while content has a clean pios.yaml plugin flag and an existing creator
workspace. This keeps Phase 3c moving without touching core triage prompt logic.

| Hook | Script | Logic |
|------|--------|-------|
| gate | `scripts/triage-gate.sh` | check newest `.md`/`.txt` mtime in `Pi/Agents/creator/workspace/` vs state |
| ingest | `scripts/triage-ingest.sh` | read the changed draft, emit a `content-ready` event with title, line count, and first excerpt |

```yaml
provides:
  card_sources: [content-pipeline, creator-output]
  data_paths:
    workspace: "Pi/Agents/creator/workspace/"
    output_dir: "Pi/Output/content/"
triage_hooks:
  on_gate:
    script: scripts/triage-gate.sh
    timeout_sec: 5
  on_ingest:
    script: scripts/triage-ingest.sh
    timeout_sec: 15
```

---

### triage.md 大瘦身 (after all data plugins done)

Current: 963 lines. Target: ≤300 lines.

The data plugin migrations above are **additive** — they do NOT shrink triage.md because the
wechat hardcoding (removed in 3b) was the only plugin-specific data path in triage.

To hit ≤300, the following large sections must be extracted as separate task prompts:

| Section | Lines | Extraction target |
|---------|-------|-------------------|
| 動作 7.5 social-state + tone detection | ~150 | `core/tasks/triage-social.md` invoked by `pios.yaml` as a chained task or inline |
| 動作 8 speech decision | ~135 | `core/tasks/triage-speech.md` |
| 動作 5–5.7 blocked/escalation handling | ~185 | Could inline-compress to ~40 lines of rules |

**Prerequisite**: PiOS task system must support multi-file prompt include or chained tasks.
Check `pios.yaml infra-tasks` and `engine adapter` before attempting extraction.
If not supported, the ≤300 target may need to be revised to ~500 (after social/speech split).

This is a **separate session** (3c-final), not part of plugin migration.
