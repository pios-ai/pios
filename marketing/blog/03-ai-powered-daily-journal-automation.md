---
title: "How to Build an AI-Powered Daily Journal with Claude Code and Obsidian"
slug: ai-powered-daily-journal-automation
target_keywords:
  - AI journal automation
  - AI powered daily journal
  - claude code journal
  - obsidian daily notes automation
  - automated journaling with AI
meta_description: "Build an automated daily journal that pulls data from health apps, messages, and photos, then uses AI to generate personalized daily summaries in Obsidian."
description: "Build an automated daily journal that pulls data from health apps, messages, and photos, then uses AI to generate personalized daily summaries in Obsidian."
date: 2026-04-07
created: 2026-04-07
word_count: ~2500
type: seo_article
category: tutorial
---

# How to Build an AI-Powered Daily Journal with Claude Code and Obsidian

Journaling is one of the highest-leverage habits for self-awareness and personal growth. But most people abandon it within weeks because it's too time-consuming.

What if your journal wrote itself?

Not a generic AI summary — a personalized daily entry that pulls from your actual health data, messages, photos, and activities. An entry that captures what happened, why it mattered, and what patterns are emerging — with minimal effort from you.

This guide shows you how to build exactly that using Claude Code, Obsidian, and a few Python scripts.

## What an AI-Powered Journal Looks Like

Here's a real example of an auto-generated daily entry:

```markdown
---
date: 2026-04-07
type: daily
mood_inferred: focused, slightly tired
---

# Monday, April 7, 2026

## Health Snapshot
- Sleep: 6h 48m (below your 7.5h target, 3rd short night this week)
- Steps: 9,234 (good — exceeded 8k goal)
- Resting HR: 62 bpm (normal range)
- Sunlight: 45 min (target: 60 min — consider a lunch walk)

## Day at a Glance
- Morning: Reviewed project proposals, responded to 3 client emails
- Afternoon: Deep work session on the dashboard redesign (2.5 hours)
- Evening: Dinner with M. — discussed apartment renovation plans

## Key Decisions & Thoughts
- Decided to postpone the API migration to next sprint (load testing
  showed current architecture handles projected traffic fine)
- M. wants to start renovation by May — need to finalize contractor
  by end of this week

## Patterns & Alerts
⚠️ Sleep has been below target 3 of the last 5 nights. Last time
this pattern occurred (March 20-25), you reported increased anxiety
and reduced focus. Consider your evening routine.

## Photos
![[photo-2026-04-07-lunch.jpg]]
Lunch at the new café on Zhongshan Road

## Tomorrow's Focus
1. Finalize contractor shortlist (renovation deadline)
2. Continue dashboard redesign (blocked on design review after this)
3. 30-min walk at lunch (sunlight deficit)
```

Notice what's happening: the journal combines **objective data** (health metrics, photos, messages) with **AI-generated insights** (pattern detection, recommendations). You didn't have to write any of this. You might add a paragraph of personal reflection — that's the only manual input.

## The Architecture

The system has three components:

1. **Data collectors** — Scripts that pull data from various sources
2. **Journal engine** — An AI agent that combines data into a coherent entry
3. **Scheduler** — Runs everything automatically on a daily schedule

```
6:00 AM  →  Collectors run (health, messages, photos, calendar)
6:30 AM  →  Journal engine reads collected data + last 7 days
6:35 AM  →  AI generates today's journal entry
6:36 AM  →  Entry saved to Obsidian vault
7:00 AM  →  You open Obsidian and read your briefing
```

## Building the Data Collectors

### Collector 1: Apple Health

Apple Health stores a wealth of data. The easiest way to access it programmatically is through the **Health Auto Export** app ($3.99, runs on your iPhone, exports to a local server or file).

```python
# collector_health.py
import json
from datetime import date
from pathlib import Path

EXPORT_DIR = Path.home() / "health-export"
OUTPUT_DIR = Path.home() / "vault" / "data" / "health"

def collect_today():
    today = date.today().isoformat()
    export_file = EXPORT_DIR / f"{today}.json"

    if not export_file.exists():
        return None

    data = json.loads(export_file.read_text())

    # Extract key metrics
    return {
        "date": today,
        "sleep_hours": round(data.get("sleep_duration_hours", 0), 1),
        "sleep_deep_pct": data.get("sleep_deep_percentage", 0),
        "steps": data.get("step_count", 0),
        "resting_hr": data.get("resting_heart_rate", 0),
        "active_energy_kcal": data.get("active_energy", 0),
        "sunlight_minutes": data.get("time_in_daylight", 0),
    }
```

### Collector 2: Messages

For chat apps with local databases (WeChat on macOS, iMessage), you can read the SQLite database directly. For others, use export tools.

```python
# collector_messages.py
import sqlite3
from datetime import date, datetime

def collect_imessage_today():
    """Read today's iMessage conversations."""
    db_path = Path.home() / "Library" / "Messages" / "chat.db"
    conn = sqlite3.connect(str(db_path))

    today_start = datetime.combine(date.today(), datetime.min.time())
    timestamp = int(today_start.timestamp() * 1e9) + 978307200 * 1e9

    rows = conn.execute("""
        SELECT h.id, m.text, m.is_from_me, m.date
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.date > ?
        ORDER BY m.date
    """, (timestamp,)).fetchall()

    # Group by contact
    conversations = {}
    for contact, text, is_from_me, msg_date in rows:
        if contact not in conversations:
            conversations[contact] = []
        sender = "Me" if is_from_me else contact
        conversations[contact].append(f"{sender}: {text}")

    return conversations
```

### Collector 3: Photos

If you use Immich (self-hosted photo management) or have photos syncing to a local directory:

```python
# collector_photos.py
from PIL import Image
from PIL.ExifTags import TAGS
from pathlib import Path
from datetime import date

PHOTO_DIR = Path.home() / "Photos" / "Imports"

def collect_today_photos():
    """Find photos taken today with EXIF data."""
    today = date.today()
    photos = []

    for img_path in PHOTO_DIR.glob("*.{jpg,jpeg,heic,png}"):
        if img_path.stat().st_mtime >= today_start_timestamp:
            exif = extract_exif(img_path)
            photos.append({
                "path": str(img_path),
                "time": exif.get("DateTime", ""),
                "location": exif.get("GPSInfo", ""),
            })

    return sorted(photos, key=lambda p: p["time"])
```

## Building the Journal Engine

The journal engine is the AI agent that combines all collected data into a coherent entry.

```python
# journal_engine.py
import anthropic
from datetime import date, timedelta
from pathlib import Path

VAULT = Path.home() / "vault"
client = anthropic.Anthropic()

def generate_journal():
    today = date.today()

    # 1. Gather today's data
    health = load_json(VAULT / "data" / "health" / f"{today}.json")
    messages = load_json(VAULT / "data" / "messages" / f"{today}.json")
    photos = load_json(VAULT / "data" / "photos" / f"{today}.json")
    calendar = load_json(VAULT / "data" / "calendar" / f"{today}.json")

    # 2. Load recent context (last 7 days of journals)
    recent_journals = []
    for i in range(1, 8):
        d = today - timedelta(days=i)
        journal_path = VAULT / "01-Daily" / f"{d}.md"
        if journal_path.exists():
            recent_journals.append(journal_path.read_text())

    # 3. Build the prompt
    prompt = f"""Generate today's journal entry based on this data.

## Today's Health Data
{format_health(health)}

## Today's Conversations (summarized)
{format_messages(messages)}

## Today's Photos
{format_photos(photos)}

## Calendar Events
{format_calendar(calendar)}

## Recent Journal Entries (for pattern detection)
{chr(10).join(recent_journals[-3:])}

## Instructions
- Start with a health snapshot (compare to goals and recent trends)
- Summarize the day's activities chronologically
- Extract key decisions and thoughts from conversations
- Detect patterns across the last 7 days (sleep, mood, productivity)
- Flag any health alerts (3+ days below sleep target, unusual HR, etc.)
- Suggest 3 focus items for tomorrow based on active projects and today's context
- Infer mood from the data (don't ask me, just infer)
- Keep the tone personal but not overly cheerful
- Use Obsidian wiki-links for references to other notes
"""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )

    entry = response.content[0].text

    # 4. Add frontmatter and save
    output = f"""---
date: {today}
type: daily
auto_generated: true
---

{entry}
"""

    output_path = VAULT / "01-Daily" / f"{today}.md"
    output_path.write_text(output)
    return output_path
```

## Scheduling with launchd (macOS)

Create a launch agent that runs the full pipeline every morning:

```xml
<!-- ~/Library/LaunchAgents/com.pios.daily-journal.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pios.daily-journal</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/you/scripts/run-daily-journal.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
</dict>
</plist>
```

The shell script runs collectors first, then the engine:

```bash
#!/bin/bash
# run-daily-journal.sh
cd ~/scripts
python3 collector_health.py
python3 collector_messages.py
python3 collector_photos.py
python3 journal_engine.py
```

## Making It Interactive with Claude Code

The real power emerges when you combine automated journaling with interactive AI sessions:

```bash
cd ~/vault
claude "Read my journal from the last week. What patterns do you see
in my sleep and productivity? Any concerns?"
```

Because Claude Code can read your vault directly, it has access to weeks or months of structured data. It can spot trends that you'd never notice by reading individual entries.

## Tips for Long-Term Success

1. **Don't skip the reflection section** — Auto-generated data is useful, but your own thoughts make the journal valuable. Even one sentence of reflection per day compounds over months.

2. **Review weekly** — Set a recurring reminder to read your week's journals. The AI catches patterns, but you need to decide what to do about them.

3. **Start simple** — Even without any data collectors, you can use Claude Code to generate a journal template each morning. Add automation gradually.

4. **Keep raw data** — Store the raw JSON exports alongside the generated Markdown. You'll want to re-process old data when you improve your journal engine.

5. **Version control** — Put your vault in git. Track every change. You'll thank yourself when you want to see how your system (and your life) evolved over time.

## Resources

- **PiOS** — Open-source implementation with a full daily journal engine: [github.com/pios-ai/pios](https://github.com/pios-ai/pios)
- **Obsidian** — [obsidian.md](https://obsidian.md)
- **Health Auto Export** — iOS app for Apple Health data export
- **Immich** — Self-hosted photo management: [immich.app](https://immich.app)

---

*Part of the PiOS documentation series. PiOS is an open-source Personal Intelligence Operating System for building AI systems that understand your life.*
