#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate daily WeChat chat summaries from raw files."""

import os
import re
from datetime import datetime
from pathlib import Path

# Configuration — set AI_WECHAT_DIGEST_DIR to the parent directory containing
# `daily_raw` and `daily_summary`; defaults to the current working directory.
BASE_DIR = Path(os.environ.get("AI_WECHAT_DIGEST_DIR", "."))
RAW_DIR = BASE_DIR / "daily_raw"
OUTPUT_DIR = BASE_DIR / "daily_summary"
DATES = [
    "2020-11-19", "2020-11-18", "2020-11-17", "2020-11-16", "2020-11-15",
    "2020-11-14", "2020-11-13", "2020-11-12", "2020-11-11", "2020-11-10"
]

def extract_contacts_and_messages(raw_file_path):
    """Extract contacts and their main messages from raw file."""
    contacts_info = {}
    current_contact = None

    with open(raw_file_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    for line in lines:
        line = line.rstrip()

        # Skip header and empty lines
        if line.startswith('---') or line.startswith('date:') or line.startswith('type:') or \
           line.startswith('total_') or not line.strip():
            continue

        # New contact section
        if line.startswith('## '):
            current_contact = line[3:].strip()
            contacts_info[current_contact] = []
        elif current_contact and line.startswith('- ') and '：' in line:
            # Extract message content
            parts = line.split('：', 1)
            if len(parts) == 2:
                msg_content = parts[1].strip()
                # Skip image/video/file/location messages
                if not msg_content.startswith('📷') and not msg_content.startswith('🎬') and \
                   not msg_content.startswith('📎') and not msg_content.startswith('📍') and \
                   not msg_content.startswith('🔗') and not msg_content.startswith('💬') and \
                   not msg_content.startswith('🎙️') and msg_content:
                    contacts_info[current_contact].append(msg_content)

    return contacts_info

def generate_summary_for_date(date_str):
    """Generate summary for a specific date."""
    raw_file = RAW_DIR / f"{date_str}.md"

    if not raw_file.exists():
        print(f"Warning: {raw_file} not found")
        return None

    # Extract contacts and messages
    contacts_info = extract_contacts_and_messages(raw_file)

    # Identify key topics and contacts
    key_items = []
    memorable_items = []
    contact_summaries = []

    # Process each contact
    for contact_name, messages in contacts_info.items():
        if not messages:
            continue

        # Get a one-sentence summary from the messages
        contact_summary = messages[0][:50] if messages else ""
        if contact_summary:
            contact_summaries.append((contact_name, contact_summary))

            # NOTE: prior versions of this script hardcoded a specific owner's
            # life events as keyword extraction rules (purchases / family
            # health / housing / startup events). That tied wechat summary
            # quality to one user's vocabulary and leaked private context.
            # Generic version: rely on the LLM downstream to read raw messages
            # and extract its own key/memorable items; this script only
            # collects per-contact one-line summaries and lets the synthesis
            # step (daily-wechat-digest task prompt) do classification.
            pass

    # Generic placeholder; downstream LLM rewrites this from raw content.
    overall_summary = "今日微信对话摘要待 AI 合成"

    # Build summary file content
    summary_lines = [
        f"# 微信聊天日记 {date_str}",
        "",
        f"## 今日微信聊天一句话总结",
        f"{overall_summary} ^wechat-daily-summary",
        "",
        "## 今日要事"
    ]

    # Add key items
    if key_items:
        for item in list(dict.fromkeys(key_items))[:3]:  # Max 3 items, remove duplicates
            summary_lines.append(f"- {item}")
    else:
        summary_lines.append("- 多个项目和事务进行中")

    summary_lines.extend([
        "",
        "## 值得记住"
    ])

    # Add memorable items
    if memorable_items:
        for item in list(dict.fromkeys(memorable_items))[:3]:  # Max 3 items, remove duplicates
            summary_lines.append(f"- {item}")
    else:
        summary_lines.append("- 日常工作和生活事务")

    summary_lines.extend([
        "",
        "## 按联系人摘要"
    ])

    # Add contact summaries (top 5)
    for contact, summary in contact_summaries[:5]:
        clean_summary = summary.replace('📷[图片]', '').replace('🎙️[语音]', '').strip()
        if clean_summary and len(clean_summary) > 5:
            summary_lines.append(f"- **{contact}**: {clean_summary}")

    return "\n".join(summary_lines)

# Create output directory if needed
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Generate summaries for each date
for date_str in DATES:
    print(f"Processing {date_str}...")
    summary = generate_summary_for_date(date_str)

    if summary:
        output_file = OUTPUT_DIR / f"{date_str}.md"
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(summary)
        print(f"  ✓ Created {output_file}")
    else:
        print(f"  ✗ Failed to generate summary for {date_str}")

print("\nDone!")
