#!/usr/bin/env python3
"""
Skeleton for a PiOS source plugin.

A source plugin ingests data from an external source and writes
Markdown documents to the vault. Copy this file and fill in the
three methods.

Usage:
    python3 source-plugin-skeleton.py
"""
import datetime
import json
from pathlib import Path


# === Configuration ===

PLUGIN_NAME = "source-example"
VAULT_PATH = Path.home() / "vault" / "Data" / "Example"
SCHEDULE = "0 6 * * *"  # cron: daily at 6:00 AM


# === Plugin ===

def fetch_data() -> dict:
    """
    Step 1: Fetch raw data from your source.

    Examples:
    - Read a JSON export file
    - Query a SQLite database
    - Call a REST API
    - Parse a local file
    """
    # TODO: Replace with your data source
    return {
        "metric_a": 42,
        "metric_b": "hello",
        "timestamp": datetime.datetime.now().isoformat(),
    }


def transform(raw: dict) -> str:
    """
    Step 2: Transform raw data into Markdown content.

    The output should be human-readable (you'll see it in Obsidian)
    and machine-parseable (agents will query it).
    """
    today = datetime.date.today().isoformat()

    return f"""---
title: "Example Report — {today}"
type: report
source: {PLUGIN_NAME}
date: {today}
created: {datetime.datetime.now().isoformat()}
tags: [example, auto-generated]
---

# Example Report — {today}

## Metrics
- Metric A: {raw['metric_a']}
- Metric B: {raw['metric_b']}

## Raw timestamp
{raw['timestamp']}
"""


def write_to_vault(content: str) -> Path:
    """
    Step 3: Write the document to the vault.
    """
    VAULT_PATH.mkdir(parents=True, exist_ok=True)
    today = datetime.date.today().isoformat()
    output = VAULT_PATH / f"{today}.md"
    output.write_text(content)
    return output


# === Main ===

if __name__ == "__main__":
    raw = fetch_data()
    content = transform(raw)
    path = write_to_vault(content)
    print(f"[{PLUGIN_NAME}] Wrote: {path}")
