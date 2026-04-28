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

## Plugin ↔ Core Agent Interaction (Current Gap)

**Current state**: triage.md hardcodes plugin-specific logic (WeChat ingest, specific data paths).

**Target state**: Plugins register data sources and triage hooks via plugin.yaml:

```yaml
# Proposed extension to plugin.yaml
triage_hooks:
  ingest:
    - name: wechat-messages
      description: Ingest WeChat messages from daily digest
      check: "test -f {vault}/{owner}/Pipeline/AI_Wechat_Digest/daily_raw/$(date +%Y-%m-%d).md"
      action: "Read and parse {owner} messages, create Cards for explicit instructions"
  notify:
    - name: health-alert
      condition: "health metrics contain anomaly"
      level: critical
```

triage.md would then iterate over registered hooks instead of hardcoding each plugin's logic. This is not yet implemented.

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
