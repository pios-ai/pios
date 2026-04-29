# Card System Component

> Part of [PiOS Architecture](../../ARCHITECTURE.md) — Layer 5 (data) with Layer 2 contracts

## Overview

Cards are the universal work unit in PiOS. Every task, project, research item, and decision is a Card — a markdown file with YAML frontmatter. Cards live in three directories representing their lifecycle stage.

## Lifecycle

```
Cards/inbox/     ──triage──▶  Cards/active/  ──triage──▶  Cards/archive/
(new, untriaged)              (in progress)               (completed)
```

## Directory Semantics

| Directory | Meaning | Who Writes | Who Reads |
|-----------|---------|------------|-----------|
| `Cards/inbox/` | New tasks awaiting triage | User, agents, plugins | triage |
| `Cards/active/` | Currently active tasks and projects | triage, work, sense-maker | triage, work, sense-maker, PiOS.app |
| `Cards/archive/` | Completed/dismissed tasks | triage | PiOS.app (history), reflect |

## Frontmatter Fields

### Required Fields

| Field | Type | Set By | Description |
|-------|------|--------|-------------|
| `type` | `task` / `project` | Creator | task = single deliverable, project = container with sub-cards |
| `status` | `inbox` / `active` / `pending` / `in_review` / `blocked` / `done` / `dismissed` / `escalated` | triage, work (done), watchdog (escalated) | Lifecycle state (见 §State Machine) |
| `priority` | 1-5 | triage | 1 = highest |
| `created` | YYYY-MM-DD | Creator | Creation date |

### Dispatch Fields (core agent contract)

These fields are the contract between core agents and PiOS.app Home UI. **Breaking these breaks the product.**

| Field | Type | Set By | Cleared By | PiOS.app Reads? | Description |
|-------|------|--------|------------|-----------------|-------------|
| `ready_for_work` | `true` | triage (dispatch) | work (claim) | YES — "Ready" section | Card is dispatched and waiting for work to pick up |
| `claimed_by` | `work-{timestamp}` | work | work (on complete) | YES — "Running" indicator | work is currently executing this Card |
| `needs_owner` | `alert` / `respond` / `act` / `check` / `null` | **triage only** (L2 v3.1 R1) | triage (after user responds) | **YES — "Decisions" section** | Card needs user decision/review/clarification. Worker writes `activity_result.proposed_needs_owner` instead |
| `decision_brief` | string | **triage only** (L2 v3.1 R1) | triage (after user responds) | **YES — Decision detail** | Human-readable summary of what needs deciding |
| `blocked_on` | string | work, sense-maker | triage (time-based), sense-maker | YES — "Blocked" section | What's blocking: `verify-after: {date}`, card filename, `external-person(...)` |
| `deferred_until` | YYYY-MM-DD | user, sense-maker | triage | — | Don't process until this date |
| `energy` | 0.0-1.0 | sense-maker, triage | — | — | Remaining work estimate (1.0 = fresh, 0.0 = done) |
| `assignee` | agent-name / `user` | triage, user | — | — | `user` = owner's manual task, Pi won't touch |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `parent` | filename | Parent project card. A `type: task` parents to a project. A `type: project` can also parent to another project (**sub-project**); child inherits parent's `goal` unless it sets its own. The Direction Tab renders sub-projects recursively under their parent; stats (inbox/active/blocked/done chips) roll up through the whole subtree. |
| `source` | `worker` / `user` / plugin name | Who created this card |
| `runs_on` | hostname | Only execute on this machine |
| `cron` | cron expression | For recurring scan/track cards |
| `owner_response` | string | User's response to needs_owner |
| `goal` | goal-id | **Project cards only.** Declares which `pios.yaml direction.goals.{id}` this project rolls up to. Reverse-declaration: Goals don't list projects; projects claim their goal. sense-maker 第四层 aggregates progress into `Pi/Log/goal-progress.md`. Omit to mark the project as `_unaligned` (shown separately in Home Direction Tab). |

### Workflow Fields (L2 v3.1 — activity_result + multi-turn HITL)

> 规范来源：[pios-l2-workflow-activity-spec-v3.1.md](../../../../Pi/Output/infra/pios-l2-workflow-activity-spec-v3.1.md)
>
> **R1 铁律**：`needs_owner` / `decision_brief` 只有 triage 能写。Worker 改成写 `activity_result.proposed_needs_owner`（提议）。

| Field | Type | Set By | Description |
|-------|------|--------|-------------|
| `activity_result` | object | work / sense-maker / reflect | Worker 的 needs_owner **提议**（不生效），triage 消费后清空 |
| `activity_result.proposed_needs_owner` | `alert` / `respond` / `act` / `check` / `null` | Worker | 想让 triage 考虑设成这个值 |
| `activity_result.proposed_brief` | string | Worker | 一句话给 Owner 看 |
| `activity_result.proposed_by` | `work-{host}-{pid}` / `sense-maker-...` | Worker | 谁提的 |
| `activity_result.proposed_at` | ISO8601 | Worker | 什么时候提的 |
| `needs_owner_set_by` | `triage-{host}-{pid}` | triage | 审计：谁设的 needs_owner |
| `needs_owner_set_at` | ISO8601 | triage | 审计：什么时候设的；watchdog 用此字段算 timeout |
| `interaction_round` | int | triage / Worker | 返工轮次，每次 +1 |
| `interaction_ceiling` | int (default `5`) | 卡片创建者 / triage | 超过则 `status: escalated`；缺省 = 5 |
| `owner_timeout_hours` | int (default `48`) | 卡片创建者 / triage | `needs_owner` 挂超过 N 小时则 `status: escalated`；缺省 = 48 |
| `history_summary` | string | card-compact infra-task | 工作记录压缩产物（超 40KB 或 10 轮触发） |
| `escalation_reason` | `timeout` / `ceiling` / `reopen_limit` / `owner_explicit` | triage / watchdog | 为什么升级到 escalated |
| `_version` | int | adapter (P6 后) | 单调递增 CAS 计数器；当前阶段可选，P6 启用后强制 |
| `owner_response_consumed_at` | ISO8601 | Worker | claim-before-act 锁：消费 owner_response 的时间戳 |
| `owner_response_consumed_by` | `work-{host}-{pid}` | Worker | 哪个 Worker 实例消费了 |
| `_owner_response_prev` | object | Worker | owner_response 消费前的快照（sense-maker 回滚用） |

**Migration**：所有 Workflow Fields 可选。缺失字段 = legacy 行为：
- 无 `activity_result` → triage 读老卡的 `needs_owner` 字段（legacy path）
- 无 `owner_timeout_hours` → watchdog 按 48h
- 无 `interaction_ceiling` → watchdog 按 5

## Card Body Sections

| Section | Written By | Purpose |
|---------|------------|---------|
| `## Goal` / `## Description` | Creator | What this Card is about |
| `## Acceptance Criteria` | Creator | Required for type: task. Defines "done" |
| `## Work History` | work, sense-maker | Chronological log of work done |
| `## Triage Dispatch Notes` | triage | Instructions for work (written at dispatch time) |
| `## Decision` | work | What needs user decision + options |

## PiOS.app Home Rendering Logic

```
Home page sections:

1. Decisions
   └─ Cards where: needs_owner is not empty
      Display: Card title + decision_brief
      Action: User responds → written to owner_response

2. In Progress
   └─ Cards where: claimed_by starts with "work-"
      Display: Card title + current status

3. Ready
   └─ Cards where: ready_for_work: true AND no claimed_by
      Display: Card title + priority

4. Active
   └─ Cards where: status = active AND no ready_for_work AND no claimed_by AND no needs_owner
      Display: Card title + priority + energy

5. Blocked
   └─ Cards where: blocked_on is not empty
      Display: Card title + what's blocking
```

## State Machine (L2 v3.1)

```
            ┌──────────────────────────────────────────────┐
            │                                              │
            ▼                                              │
   ┌─────────────┐   Worker 写 activity_result   ┌─────────┴────────┐
   │   active    │ ─────────────────────────────▶│  (triage tick)   │
   └─────────────┘                                └─────────┬────────┘
            ▲  owner_response                               │
            │  consumed by Worker                           │ triage 设 needs_owner
            │                                               ▼
            │                                       ┌──────────────┐
            └────────────────────────────────────── │  in_review   │
                                                    └──────────────┘
   ┌─────────────┐                                 ┌──────────────┐
   │    done     │ ◀── Worker 收尾                  │   blocked    │  ← 外部依赖暂停
   └─────────────┘                                 └──────────────┘

             ┌──── interaction_round > ceiling / owner_timeout 超时 / reopen ≥ 2 / Owner 显式 ────┐
             │                                                                                    ▼
             │                                                                           ┌──────────────┐
   任何状态 ─┘                                                                            │  escalated   │
                                                                                         └──────┬───────┘
                                       Owner 在 Things Need You 处理后，triage 判定        │
                                                                                         ▼
                                                                            active | done

in_review / blocked / escalated / done / dismissed / active / inbox / pending
```

**转移权限**：

| 转移 | 写字段 | 谁可以写 |
|---|---|---|
| `active → in_review` | `needs_owner` | **triage only** |
| `in_review → active` | 清 `needs_owner` + 标 `owner_response_consumed_*` | Worker |
| `active → done` | `status: done` | Worker（R1 例外） |
| `active ↔ blocked` | `status: blocked` | 任何 agent |
| `* → escalated` | `status: escalated` + `escalation_reason` | **triage** 或 **card-watchdog** (infra-task) |
| `escalated → active / done` | `status` | **triage only**（Owner 处理后） |

## Invariants

These must always be true. If violated, the system is in an inconsistent state.

1. A Card cannot be in both `ready_for_work: true` and `claimed_by` at the same time
2. A Card with `needs_owner` must have `decision_brief`
3. A Card in `Cards/archive/` must have `status: done` or `status: dismissed`
4. A Card with `status: done` in `Cards/active/` will be moved to archive by next triage tick
5. `type: task` Cards must have `## Acceptance Criteria` to be dispatched
6. `type: project` Cards must have `## Work History` to be dispatched (sense-maker writes the first entry)
7. Only one `claimed_by: work-*` Card per host at any time (work picks one, finishes, then picks next)
8. **R1 (L2 v3.1)**: Only **triage** can write `needs_owner` / `decision_brief` / `needs_owner_set_*`. Workers write `activity_result.proposed_needs_owner` instead.
9. **R1-crash-safe (L2 v3.1)**: triage 消费 activity_result 时必须**先**写 `needs_owner` **后**清空 `activity_result`（反过来挂掉会丢提议）.
10. **Status-escalated-writer (L2 v3.1)**: Only **triage** or **card-watchdog** can set `status: escalated`.

## Change Impact Guide

| If you change... | Check these... |
|---|---|
| Add/rename a frontmatter field | PiOS.app Home rendering, triage dispatch logic, work claim logic |
| Change status values | PiOS.app section filtering, triage archive logic, pios-engine.js, `pi-owner-attention-guard.py` TERMINAL_STATUSES |
| Change needs_owner format | PiOS.app Decision rendering, triage IPC clearing, `pi-owner-attention-guard.py:30` VALID_NEEDS_OWNER_TYPES |
| Change dispatch fields | PiOS.app Ready section, work pickup logic |
| Change Card body sections | work reading logic, sense-maker reading logic |
| Change `activity_result` schema | work.md / sense-maker.md / reflect.md prompts, triage.md consumption logic |
| Change `status: escalated` triggers | card-watchdog.sh, triage.md §5.5 escalation checks |
| Change `history_summary` format | card-compact.sh compaction logic |
