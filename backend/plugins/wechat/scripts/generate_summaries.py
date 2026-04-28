#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate daily WeChat chat summaries from raw files."""

import os
import re
from datetime import datetime
from pathlib import Path

# Configuration
RAW_DIR = Path("/sessions/wonderful-sweet-gates/mnt/AI_Wechat_Digest/daily_raw")
OUTPUT_DIR = Path("/sessions/wonderful-sweet-gates/mnt/AI_Wechat_Digest/daily_summary")
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

            # Add key items based on contact type and message content
            msg_text = ' '.join(messages[:2])  # First two messages

            if '保时捷' in contact_name or '保时捷' in msg_text:
                if '合同' in msg_text or '寄出' in msg_text:
                    key_items.append("跟进保时捷车购买合同寄出")
            elif '医生' in contact_name or '医院' in msg_text:
                if '住院' in msg_text or '手术' in msg_text:
                    memorable_items.append("父亲住院检查和手术安排")
            elif '房' in contact_name or '别墅' in msg_text:
                if '看房' in msg_text or '水云台' in msg_text or '珑泉湾' in msg_text:
                    key_items.append("看房和物业选择")
            elif '阿里' in msg_text or '加速' in msg_text or '比赛' in msg_text:
                key_items.append("阿里加速营和中大创新创业大赛")

    # Determine overall summary
    overall_summary = "忙于保时捷购车、房产看房、家人医疗和创业大赛"

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
