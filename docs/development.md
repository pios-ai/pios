# PiOS Development Guide

> Before making any change, read [ARCHITECTURE.md](../ARCHITECTURE.md) first.

## Golden Rule

**Every change has a blast radius. Know it before you touch anything.**

This guide tells you: for each type of change, what to read, what to check, and what might break.

---

## Change Impact Matrix

### Changing Engine Code

| File | What Might Break | Must Check |
|------|-----------------|------------|
| `pios-tick.sh` | All task scheduling, catch-up, locking | Every mechanism (lock, catch-up, pre_gate, depends_on, auth-pause) |
| `pios-adapter.sh` | All task execution, run records, bullet logging | Run record format, worker-log format, signal handling |
| `notify.sh` | All notifications | Notification levels, WeChat delivery, PiBrowser IPC |
| `auth-manager.sh` | All AI task execution (if auth breaks, nothing runs) | Token refresh, account switching, auth-pause |

**Test**: `PIOS_DRY_RUN=1 bash pios-tick.sh` — logs what would run without actually running.

### Changing PiOS.app Code

| Area | What Might Break | Must Check |
|------|-----------------|------------|
| Home rendering (pios-home.html) | Decision display, task status | Card fields it reads (see [card-system.md](components/card-system.md)) |
| SessionBus / adapters | All conversation + task monitoring | ClaudeInteractiveAdapter, RunSessionAdapter, GPTDirectAdapter |
| pios-engine.js | Agent/Card display | pios.yaml parsing, Card frontmatter parsing |
| HTTP API (:17891) | Browser MCP automation | All `/api/` endpoints |
| Notification watcher | Desktop notifications, TTS | pi_notify.json format |
| NPC / 派大星 (bubble.html + pi-pulse.js + main.js NPC BEGIN/END) | 气泡窗口显示、pose 动画、toast/speak 气泡、点击收气泡、TTS 打断 | 读 [pi-npc.md](pi-npc.md)；renderer 改动警惕 TDZ（`const` 声明必须在引用之前，否则整个 script block throw，IPC handler 全部失效） |
| NPC 音质 4 层栈 (tts-sanitize.js + qwen-voice app.py + qwen-tts.js + voice-filter.js) | 所有 NPC 声音口吃/吞字/没磁性/乱读符号；Pi Tab 磁性下拉失效 | 读 [npc-voice-sop.md](npc-voice-sop.md)；改前必跑 `bash scripts/npc-voice-health.sh`（6 项健康检查 + 防回退闸门），改完再跑一次 |

**Test**: `npm run dev` (Electron dev mode), then check Home, chat, task monitoring. NPC 改动 rebuild 后用 `bash Pi/Tools/notify.sh {info|warning|critical} "<text>"` 触发不同级别，看 4 项：颜色稳定、critical 边跳边说、长文滚动条、点派大星收气泡打断 TTS。

### Changing Core Agent Prompts

| Prompt | What Might Break | Must Check |
|--------|-----------------|------------|
| triage.md | Card flow (inbox→active→archive), dispatch, Decision display on Home | All 7 actions, Card field writes, PiOS.app Home sections |
| work.md | Task execution, Decision creation | needs_owner/decision_brief format, claimed_by lifecycle |
| sense-maker.md | State reconciliation, project opening | Card status updates, domain processing |
| reflect.md | Daily review (low impact if broken) | Reflection log format |

**DANGER**: Changing Card field names or formats in core prompts breaks PiOS.app Home. Always check [card-system.md](components/card-system.md) contracts first.

### Changing Card Spec

| Change | What Might Break | Must Check |
|--------|-----------------|------------|
| Add field | Nothing (additive) | — |
| Rename field | Everything that reads the old name | PiOS.app Home, triage, work, sense-maker, pios-engine.js |
| Remove field | Everything that reads it | Same as rename |
| Change field semantics | Subtle bugs everywhere | Every consumer of the field |

### Changing Plugin Prompts

| Change | What Might Break | Must Check |
|--------|-----------------|------------|
| Plugin task prompt | Only that plugin's task execution | Task's own acceptance criteria |
| Plugin SOUL.md | That plugin's agent behavior | All tasks under that agent |
| Plugin config format | Tasks that read the config | All tasks in the plugin |

**Lower risk than core changes** — plugin failures don't break Card flow or Home UI.

### Changing pios.yaml

| Change | What Might Break | Must Check |
|--------|-----------------|------------|
| Add/remove agent | Agent appears/disappears in PiOS.app | pios-engine.js agent listing |
| Change task cron | Task runs at different time | depends_on chains (downstream tasks may break) |
| Change task host | Task runs on different machine | Machine has required tools, MCP, data |
| Change runtime status | Tasks skip or failover | Engine status check in tick, failover logic |
| Change infra.instances | Machine topology | SSH, Syncthing, Tailscale connectivity |

---

## Development Workflow

### Before Making a Change

1. **Identify the layer** (Engine / Core Agent / Plugin / User Config / Runtime Data)
2. **Read the component doc** in `docs/components/`
3. **Check the dependency map** in ARCHITECTURE.md Section 6
4. **Identify blast radius** using the matrix above

### Making the Change

1. **One thing at a time** — don't bundle unrelated changes
2. **Test locally** — dry-run for engine, dev mode for app, manual verify for prompts
3. **Check contracts** — if you changed Card fields, verify Home still renders correctly

### After Making a Change

1. **Verify** — check that the thing you changed works
2. **Check side effects** — did anything downstream break?
3. **Update docs** — if you changed behavior, update the component doc
4. **Build** (if PiOS.app change) — `cd Projects/pios && npm run build`

---

## Common Tasks

### "Fix a bug in Card display on Home"

```
Read: docs/components/card-system.md (field contracts)
Read: docs/components/app.md (Home rendering logic)
Check: pios-home.html (renderer) + main.js (IPC handlers)
Test: npm run dev, verify Home sections
```

### "Add a new Card field"

```
Read: docs/components/card-system.md (existing fields)
Add: field to card-spec.md
Update: core agent prompts that should write the field
Update: PiOS.app if Home should display it
Update: card-system.md documentation
```

### "Change triage dispatch logic"

```
Read: docs/components/core-agents.md (triage section)
Read: docs/components/card-system.md (dispatch fields contract)
Edit: triage.md (dispatch algorithm in action 6)
Verify: Cards still get ready_for_work: true
Verify: PiOS.app Home still shows Ready section
```

### "Add a new plugin"

```
Read: docs/components/plugin-system.md (plugin.yaml format)
Create: Pi/Plugins/{name}/plugin.yaml
Create: agent SOUL.md + task prompts
Install: pios-plugin.sh install {name}
Verify: task appears in pios.yaml, agent shows in PiOS.app
```

### "Fix a scheduling issue"

```
Read: docs/components/engine.md (tick flow)
Check: Pi/Log/cron/pios-tick-{host}-{date}.log (what tick decided)
Check: Pi/State/runs/ (did the task run? what status?)
Check: Pi/State/locks/ (is it locked?)
Check: pios.yaml (is it enabled? host match? cron correct?)
```

### "PiOS.app shows wrong data"

```
Read: docs/components/app.md (vault integration)
Read: docs/components/card-system.md (field contracts)
Check: Cards/active/*.md frontmatter (is the data correct in files?)
  If yes → bug is in PiOS.app rendering (pios-home.html or pios-engine.js)
  If no → bug is in the agent that writes the field (check core-agents.md)
```

---

## File Locations Reference

| What | Current Location | Target Location (after repo split) |
|------|-----------------|-----------------------------------|
| Architecture docs | `Projects/pios/` | `Projects/pios/` |
| PiOS.app source | `Projects/pios/` | `Projects/pios/app/` |
| Engine scripts | `Pi/Tools/` | `Projects/pios/engine/` |
| Core plugin | `Pi/Plugins/core/` | `Projects/pios/core/` |
| Core agent prompts | `Pi/Agents/pi/tasks/` | `Projects/pios/core/agents/pi/tasks/` |
| Other plugins | `Pi/Plugins/{name}/` | `Projects/pios/plugins/{name}/` |
| Product specs | `Pi/Config/card-spec.md` etc. | `Projects/pios/core/specs/` |
| User config | `Pi/Config/pios.yaml` etc. | Stays in Vault |
| Runtime data | `Cards/`, `Pi/Log/`, `Pi/State/` | Stays in Vault |
