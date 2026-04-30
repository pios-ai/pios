---
title: "Build an AI Task Management System That Actually Works (Developer Guide)"
slug: ai-task-management-system-tutorial
target_keywords:
  - AI task management system
  - automated task triage AI
  - personal AI project management
  - build AI todo system
meta_description: "Learn how to build an AI-powered task management system using Markdown cards, automated triage, and Claude. Includes real code examples and architecture decisions."
description: "Learn how to build an AI-powered task management system using Markdown cards, automated triage, and Claude. Includes real code examples and architecture decisions."
date: 2026-04-07
created: 2026-04-07
word_count: ~2400
type: seo_article
category: tutorial
---

# Build an AI Task Management System That Actually Works

Every productivity app promises to organize your life. Most end up as another inbox you ignore. The fundamental problem isn't the UI or the features — it's that these systems are passive. They store tasks but don't help you manage them.

What if your task system could:
- Automatically classify and prioritize new tasks based on your projects and goals
- Detect when a blocked task becomes unblocked
- Surface the right task at the right time based on your energy, schedule, and context
- Archive completed work and create follow-up tasks

This guide shows you how to build exactly that using AI agents, Markdown files, and a simple but powerful architecture.

## The Card-Based Architecture

Forget databases. We use plain Markdown files as "task cards" — one file per task, organized in directories that represent states.

```
Cards/
├── inbox/      # New items, not yet triaged
├── active/     # Currently being worked on
└── archive/    # Completed or abandoned
```

Each card has YAML frontmatter for metadata:

```markdown
---
type: task
status: active
priority: 2
parent: home-renovation
created: 2026-04-07
energy: 0.8
blocked_on:
---

# Research smart home platforms

Compare HomeKit, Home Assistant, and Google Home for a new apartment.

## Context
Moving to a new apartment in May. Need to decide on smart home platform
before electrician does the wiring (deadline: April 20).

## Acceptance Criteria
- [ ] Compare at least 3 platforms on: cost, device support, automation
- [ ] Assess compatibility with existing Philips Hue and Aqara devices
- [ ] Recommendation with reasoning
```

**Why Markdown files instead of a database?**

1. **Human-readable**: Open the folder in any text editor or Obsidian
2. **AI-friendly**: LLMs read Markdown natively — no serialization needed
3. **Git-trackable**: Full history of every change to every task
4. **Tool-agnostic**: No lock-in to any specific app or framework
5. **Grep-able**: `grep -r "blocked_on:" Cards/active/` instantly shows all blocked tasks

## The Frontmatter Schema

Every task card has these fields:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `task` or `project` | Projects contain tasks; tasks are executable |
| `status` | `inbox`, `active`, `done` | Current state |
| `priority` | 1, 2, or 3 | P1 = urgent, P2 = important, P3 = normal |
| `parent` | string | Filename of parent project (empty for top-level) |
| `created` | date | When this card was created |
| `energy` | 0.0–1.0 | Decay factor — stale tasks get deprioritized |
| `blocked_on` | string | What's preventing progress (empty = ready to work) |

The `blocked_on` field is the secret weapon. Instead of a binary "done/not done" state, tasks can be explicitly blocked:

```yaml
blocked_on: owner-action          # Waiting for human decision
blocked_on: contractor-quote    # Waiting for external party
blocked_on: api-key-needed      # Missing resource
blocked_on: verify-after: 2026-04-10 14:00  # Delayed verification
```

## Building the AI Triage Agent

The triage agent processes the inbox: classifies, prioritizes, and routes new cards.

```python
import anthropic
from pathlib import Path
import yaml

CARDS_DIR = Path.home() / "vault" / "Cards"
client = anthropic.Anthropic()

def triage_inbox():
    inbox = CARDS_DIR / "inbox"
    active = CARDS_DIR / "active"

    # Load existing projects for context
    projects = load_active_projects()

    for card_path in inbox.glob("*.md"):
        content = card_path.read_text()
        frontmatter, body = parse_card(content)

        # Ask AI to classify
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=500,
            messages=[{
                "role": "user",
                "content": f"""Classify this task card.

Active projects:
{format_projects(projects)}

New card:
{content}

Respond in YAML:
priority: 1|2|3
parent: <matching project filename or empty>
blocked_on: <if it needs human action or external dependency>
duplicate_of: <filename if this duplicates an existing card>
reasoning: <one line explaining your classification>"""
            }]
        )

        classification = yaml.safe_load(response.content[0].text)

        if classification.get("duplicate_of"):
            # Merge content into existing card, delete inbox card
            merge_into(classification["duplicate_of"], body)
            card_path.unlink()
            continue

        # Update frontmatter
        frontmatter["priority"] = classification["priority"]
        frontmatter["parent"] = classification.get("parent", "")
        frontmatter["blocked_on"] = classification.get("blocked_on", "")
        frontmatter["status"] = "active"
        frontmatter["energy"] = 1.0

        # Ensure acceptance criteria exist
        if "## Acceptance Criteria" not in body:
            body = add_acceptance_criteria(body, client)

        # Write updated card to active/
        write_card(active / card_path.name, frontmatter, body)
        card_path.unlink()
```

## The Task Selection Algorithm

When you (or an AI worker) want to pick the next task, the selection algorithm considers multiple factors:

```python
def select_next_task():
    candidates = []

    for card_path in (CARDS_DIR / "active").glob("*.md"):
        fm, body = parse_card(card_path.read_text())

        if fm.get("type") != "task":
            continue
        if fm.get("blocked_on"):
            # Check if verify-after time has passed
            if is_verify_expired(fm["blocked_on"]):
                clear_block(card_path)
            else:
                continue  # Skip blocked tasks

        score = calculate_score(fm)
        candidates.append((score, card_path, fm))

    # Sort by score (highest first)
    candidates.sort(key=lambda x: x[0], reverse=True)

    return candidates[0] if candidates else None

def calculate_score(fm):
    """Score = priority weight × energy × recency bonus."""
    priority_weight = {1: 10, 2: 5, 3: 2}
    score = priority_weight.get(fm.get("priority", 3), 2)
    score *= fm.get("energy", 1.0)

    # Recency bonus: newer tasks get a small boost
    age_days = (date.today() - parse_date(fm["created"])).days
    if age_days < 3:
        score *= 1.2

    return score
```

## Energy Decay: Keeping the System Fresh

Tasks that sit unworked lose energy over time. This prevents your active list from becoming an ever-growing graveyard of abandoned tasks.

```python
def apply_energy_decay():
    """Run daily. Reduce energy of stale tasks."""
    for card_path in (CARDS_DIR / "active").glob("*.md"):
        fm, body = parse_card(card_path.read_text())

        if fm.get("type") != "task":
            continue
        if fm.get("blocked_on"):
            continue  # Don't decay blocked tasks

        age = (date.today() - parse_date(fm["created"])).days
        current_energy = fm.get("energy", 1.0)

        # Decay: lose 5% per day after day 3
        if age > 3:
            new_energy = max(0.1, current_energy * 0.95)
            fm["energy"] = round(new_energy, 2)
            write_card(card_path, fm, body)

        # Alert if energy drops below threshold
        if new_energy < 0.3:
            create_review_alert(card_path, fm)
```

When energy drops below 0.3, the task is effectively de-prioritized. A weekly review agent can flag these for human decision: re-energize (you still want to do it) or archive (let it go).

## Blocked Task Resolution

One of the most powerful features: an agent that periodically checks if blocked tasks can be unblocked.

```python
def check_blocked_tasks():
    """Run every 30 minutes. Check if any blocks can be resolved."""
    for card_path in (CARDS_DIR / "active").glob("*.md"):
        fm, body = parse_card(card_path.read_text())

        block = fm.get("blocked_on", "")
        if not block:
            continue

        # Check verify-after deadlines
        if block.startswith("verify-after:"):
            deadline = parse_datetime(block.split(":", 1)[1].strip())
            if datetime.now() >= deadline:
                fm["blocked_on"] = ""
                write_card(card_path, fm, body)
                notify(f"Task unblocked: {card_path.stem}")

        # Check dependency completion
        if block.startswith("depends:"):
            dep_name = block.split(":", 1)[1].strip()
            dep_path = CARDS_DIR / "archive" / f"{dep_name}.md"
            if dep_path.exists():  # Dependency moved to archive = done
                fm["blocked_on"] = ""
                write_card(card_path, fm, body)
```

## Acceptance Criteria: The Quality Gate

Every task must have acceptance criteria — specific, verifiable conditions that define "done." This prevents scope creep and enables AI verification.

```markdown
## Acceptance Criteria
- [ ] Compared 3+ smart home platforms with feature matrix
- [ ] Tested compatibility with Philips Hue Bridge v2
- [ ] Written recommendation document in Output/intel/
- [ ] Created follow-up task for purchasing decisions
```

The AI triage agent enforces this: if a new task doesn't have acceptance criteria, the agent generates them based on the task description. If it can't generate meaningful criteria, the task is blocked as "needs clarification."

## Putting It All Together

Schedule the agents:

```bash
# Every 5 minutes: triage inbox + check blocked tasks
*/5 * * * * python3 ~/scripts/agent-triage.py && python3 ~/scripts/agent-check-blocked.py

# Daily at midnight: energy decay + archive done tasks
0 0 * * * python3 ~/scripts/energy-decay.py && python3 ~/scripts/archive-done.py

# Weekly: review low-energy tasks
0 9 * * 1 python3 ~/scripts/weekly-review.py
```

## Why This Works Better Than Traditional To-Do Apps

1. **AI triage** means new tasks get classified and prioritized without your effort
2. **Blocked tracking** makes invisible bottlenecks visible
3. **Energy decay** naturally surfaces stale tasks for review
4. **Acceptance criteria** define done clearly before you start
5. **Markdown files** mean your data is portable, searchable, and git-trackable
6. **Parent-child hierarchy** connects tasks to projects without complex project management

The system scales from 10 tasks to 1,000+ without losing usability, because AI handles the cognitive overhead of classification, prioritization, and status tracking.

---

*Part of the PiOS documentation series. PiOS is an open-source Personal Intelligence Operating System for building AI systems that understand your life.*
