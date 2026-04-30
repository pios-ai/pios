# Core Agents Component

> Part of [PiOS Architecture](../../ARCHITECTURE.md) — Layer 2

## Overview

The four core agents are PiOS's operating system logic. They make the Card system work: triaging new tasks, dispatching work, executing tasks, reconciling state, and reflecting on performance.

They ship with the `core` plugin. PiOS.app's Home UI depends on the Card fields they write. **Changing core agent behavior can break the product.**

## The Four Agents

### triage — The Cerebellum (*/15 min)

**Prompt**: `Pi/Agents/pi/tasks/triage.md` (276 lines)

**Role**: Event response + state governance + intelligent dispatch. Does NOT execute tasks, does NOT make strategic decisions.

**Seven actions per tick**:

| # | Action | Reads | Writes |
|---|--------|-------|--------|
| 0 | Gate check | `gate-state-{host}.json`, Cards/inbox, Cards/active | Skip if nothing to do |
| 1 | Message ingest | Plugin data sources (e.g., WeChat digest) | Cards/inbox (new tasks from messages) |
| 2 | Triage inbox | Cards/inbox/*.md | Move to Cards/active/ (set priority, match parent, dedup) |
| 3 | Archive done | Cards/active/ where status=done | Move to Cards/archive/ |
| 4 | IPC | Pi/Inbox/clarification_response.md | Clear blocked_on on Cards |
| 5 | Unblock | Cards/active/ where blocked_on has expired time | Clear blocked_on/deferred_until |
| 6 | Dispatch | Cards/active/ (candidate selection + scoring) | Write `ready_for_work: true` on selected Cards |
| 7 | Notify | Signal assessment | notify.sh (critical/report/silent) |

**Dispatch algorithm (action 6)**:
1. Estimate avg work time per Card (from worker-log last 10 runs)
2. Calculate target backlog: `ceil(15 / avg_minutes_per_card)`
3. Count current backlog (ready_for_work) + inflight (claimed_by)
4. Need = max(0, target - backlog - inflight)
5. Pick candidates: active, not blocked, not claimed, has acceptance criteria, energy >= 0.3
6. Sort: ongoing projects first → priority asc → energy desc → oldest first
7. Write `ready_for_work: true` + dispatch notes on top N

**Card fields written**:
- `status`: inbox → active (action 2)
- `priority`: set during triage (action 2)
- `ready_for_work: true`: dispatch signal (action 6)
- `blocked_on`: cleared when conditions met (action 5)
- `deferred_until`: cleared when date passed (action 5)

**Budget**: < 20K tokens per tick.

### work — The Hands (*/5 min)

**Prompt**: `Pi/Agents/pi/tasks/work.md`

**Role**: Pick one Card with `ready_for_work: true`, execute it, update status.

**Flow**:
1. Scan Cards/active/ for `ready_for_work: true`
2. Pick the first one (triage already sorted)
3. Write `claimed_by: work-{timestamp}`, clear `ready_for_work`
4. Read Card context (acceptance criteria, work history, related Output)
5. Execute the task (read files, write code, call tools, web search)
6. Update Card:
   - Task complete → `status: done`
   - Needs user decision → `needs_owner: decision(...)` + `decision_brief: ...`
   - Needs verification → create verify Card with `blocked_on: verify-after: {date}`
   - Partially done → append to `## Work History`, clear `claimed_by`

**Card fields written**:
- `claimed_by`: work-{timestamp} (during execution)
- `status`: done / in_review
- `needs_owner`: decision(...) / review(...) / clarify(...)
- `decision_brief`: human-readable summary of what needs deciding
- `ready_for_work`: cleared after claiming

**Critical**: `needs_owner` + `decision_brief` are what PiOS.app Home displays as "Decisions". If work doesn't write these correctly, users don't see pending decisions.

### sense-maker — The Brain (*/2 hours)

**Prompt**: `Pi/Agents/pi/tasks/sense-maker.md`

**Role**: Reconcile reality with system state. Read external signals (diary, WeChat, worker logs), update Cards accordingly, manage domain lifecycles.

**What it does**:
- Read today's diary, WeChat digest, worker logs
- Compare against Cards/active/ — find discrepancies
- Update Card statuses based on real-world signals
- Open new projects (write first `## Work History` entry)
- Detect focus opportunities and create Cards
- Manage domain-specific processing (DOMAIN.md)

**Card fields written**:
- `status`: updated based on real-world signals
- `blocked_on`: set/cleared based on external dependencies
- `energy`: adjusted based on context
- `## Work History`: first entry on new projects

### reflect — The Mirror (daily 4:00)

**Prompt**: `Pi/Agents/pi/tasks/reflect.md`

**Role**: Daily performance review. Diagnose what's working, what's not, create improvement Cards.

**What it does**:
- Read recent worker logs, run records, Cards completed/blocked
- Calculate metrics (Cards throughput, avg execution time, error rate)
- Diagnose: keep doing / stop doing / start doing
- Write reflection to `Pi/Log/reflection-log.md`
- Create decision Cards for boundary-crossing improvements

## Supporting Core Tasks

| Task | Agent | Schedule | Role |
|------|-------|----------|------|
| daily-briefing | pi | 8:09 daily | Generate daily summary for user |
| maintenance | maintenance | 2:30 daily | System health check, log cleanup, orphan Card detection |
| token-daily-summary | maintenance | 3:02 daily | Token usage report |

## Agent Boundaries

| Responsibility | triage | work | sense-maker | reflect |
|---|---|---|---|---|
| Inbox triage | YES | - | - | - |
| Archive done Cards | YES | - | - | - |
| Dispatch (ready_for_work) | YES | - | - | - |
| Execute Card tasks | - | YES | - | - |
| Write needs_owner/decision_brief | - | YES | - | - |
| Code validation / closure checks | - | YES | - | - |
| Read diary / WeChat full text | - | - | YES | - |
| Open new projects (first work history) | - | - | YES | - |
| Domain lifecycle management | - | - | YES | - |
| Performance diagnosis | - | - | - | YES |
| Create improvement Cards | - | - | - | YES |

**Hard rule**: triage never executes tasks. work never triages. sense-maker never dispatches. These boundaries prevent feedback loops and keep token budgets predictable.

## Parameterization (Current Gap)

Core agent prompts currently use `{owner}` and `{vault}` placeholders, but some still have hardcoded content:

| Prompt | Hardcoded Content | Should Be |
|--------|-------------------|-----------|
| triage.md | `{owner}<surname>` (WeChat name) | Read from plugin config or pios.yaml |
| triage.md | `daily_extract.py` path | Registered by wechat plugin |
| triage.md | WeChat DB path | Registered by wechat plugin |
| sense-maker.md | Domain-specific DOMAIN.md references | Read from pios.yaml direction.domains |

**Target**: Core prompts contain zero user-specific content. All customization comes from pios.yaml, card-spec.md, and plugin registrations.
