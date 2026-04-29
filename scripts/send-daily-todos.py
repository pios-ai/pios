#!/usr/bin/env python3
"""
send-daily-todos.py — 每天 00:00 发送当日 owner 待办到微信
用法: python3 send-daily-todos.py [--dry-run]
"""

import os
import sys
import subprocess
import re
from datetime import date, datetime

def _read_pios_config():
    """读 ~/.pios/config.json，失败返回空 dict。"""
    try:
        import json as _json
        cfg_path = os.path.join(os.path.expanduser('~'), '.pios', 'config.json')
        with open(cfg_path, 'r') as f:
            return _json.load(f) or {}
    except Exception:
        return {}

_PIOS_CFG = _read_pios_config()
# 优先级：env > config.json > default
VAULT = (os.environ.get('PIOS_VAULT')
         or _PIOS_CFG.get('vault_root')
         or os.path.join(os.path.expanduser('~'), 'PiOS'))
CARDS_DIR = os.path.join(VAULT, 'Cards', 'active')
WECHAT_TARGET = (os.environ.get('PIOS_OPENCLAW_TARGET')
                 or _PIOS_CFG.get('openclaw_target')
                 or '')
MAX_MSG_LEN = 1800  # WeChat single message safe limit (~2000 chars); split if longer

DRY_RUN = '--dry-run' in sys.argv


def parse_frontmatter(path):
    """Extract YAML frontmatter from a markdown file."""
    try:
        import yaml
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        m = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
        if not m:
            return None, content
        fm = yaml.safe_load(m.group(1)) or {}
        return fm, content[m.end():]
    except Exception:
        return None, ''


def extract_title(body):
    """Get first H1 heading from body."""
    m = re.search(r'^#\s+(.+)', body, re.MULTILINE)
    return m.group(1).strip() if m else ''


def parse_date(val):
    """Parse a date value (str or date) to date."""
    if val is None:
        return None
    if isinstance(val, date):
        return val
    if isinstance(val, datetime):
        return val.date()
    try:
        return date.fromisoformat(str(val).strip().strip("'\""))
    except Exception:
        return None


def collect_todos(today):
    """Return sorted list of (sort_key, title, card_id, due) for owner's active items."""
    results = []
    try:
        card_files = [f for f in os.listdir(CARDS_DIR) if f.endswith('.md')]
    except Exception:
        return results

    for fname in card_files:
        path = os.path.join(CARDS_DIR, fname)
        fm, body = parse_frontmatter(path)
        if not fm:
            continue

        # Skip non-active or non-user cards
        status = fm.get('status', 'active')
        if status in ('done', 'archived', 'blocked'):
            continue
        assignee = fm.get('assignee', '')
        if assignee != 'user':
            continue

        # Date filters: skip if deferred to a future date
        deferred = parse_date(fm.get('deferred_until'))
        if deferred and deferred > today:
            continue

        due = parse_date(fm.get('due'))

        # Priority for sorting (lower = higher priority)
        priority = fm.get('priority', 5)
        try:
            priority = float(priority)
        except Exception:
            priority = 5.0

        # Boost overdue/today-due items to top
        urgency_boost = 0.0
        if due and due <= today:
            urgency_boost = -10.0

        title = extract_title(body) or fname.replace('.md', '')
        results.append((priority + urgency_boost, title, fname.replace('.md', ''), due))

    results.sort(key=lambda x: x[0])
    return results


def format_messages(todos, today):
    """Build a list of WeChat messages showing ALL todos, splitting into multiple
    messages if the total exceeds MAX_MSG_LEN chars. No truncation."""
    date_str = today.strftime('%m-%d')

    if not todos:
        return [f"📋 {date_str} 待办\n今日暂无明确待办 ✓"]

    # Build all item lines
    all_lines = []
    for _, title, card_id, due in todos:
        due_tag = f"｜{due.strftime('%Y-%m-%d')}" if due else ''
        all_lines.append(f"• {title}{due_tag}")

    # Split into pages so each message stays under MAX_MSG_LEN
    messages = []
    total = len(todos)
    page = 1
    current_items = []

    def flush(items, is_last):
        if not items:
            return
        if len(messages) == 0:
            # First message gets the header
            header = f"📋 {date_str} 待办（共 {total} 项）\n"
        else:
            idx_start = sum(len(m.split('• ')) - 1 for m in messages) + 1
            header = f"📋 {date_str} 待办（续）\n"
        msg = header + '\n'.join(items)
        messages.append(msg)

    for line in all_lines:
        # Check if adding this line would exceed the limit
        test_header = f"📋 {date_str} 待办（共 {total} 项）\n" if not messages else f"📋 {date_str} 待办（续）\n"
        test_msg = test_header + '\n'.join(current_items + [line])
        if current_items and len(test_msg) > MAX_MSG_LEN:
            flush(current_items, False)
            current_items = [line]
        else:
            current_items.append(line)

    flush(current_items, True)
    return messages


def format_message(todos, today):
    """Kept for backward compatibility — returns first message only."""
    return format_messages(todos, today)[0]


def send_wechat(message):
    """Send message via openclaw CLI."""
    if not WECHAT_TARGET:
        return False, '', 'PIOS_OPENCLAW_TARGET not set'
    env = os.environ.copy()
    env['PATH'] = os.path.expanduser('~/.npm-global/bin') + ':/opt/homebrew/bin:' + env.get('PATH', '')
    env['HTTP_PROXY'] = os.environ.get('OPENCLAW_HTTP_PROXY', 'http://127.0.0.1:8080')

    cmd = [
        'openclaw', 'message', 'send',
        '--channel', 'openclaw-weixin',
        '--target', WECHAT_TARGET,
        '--message', message,
        '--json',
    ]
    try:
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
        return result.returncode == 0, result.stdout.strip(), result.stderr.strip()
    except Exception as e:
        return False, '', str(e)


def main():
    today = date.today()
    todos = collect_todos(today)
    msgs = format_messages(todos, today)

    ts = datetime.now().isoformat(timespec='seconds')
    print(f"[send-daily-todos] {ts} date={today} todos={len(todos)} messages={len(msgs)}")
    for i, msg in enumerate(msgs):
        print(f"[send-daily-todos] message[{i+1}/{len(msgs)}] ({len(msg)} chars):\n{msg}")

    if DRY_RUN:
        print("[send-daily-todos] --dry-run, skipping send")
        return

    for i, msg in enumerate(msgs):
        ok, stdout, stderr = send_wechat(msg)
        if ok:
            print(f"[send-daily-todos] sent [{i+1}/{len(msgs)}] OK: {stdout}")
        else:
            print(f"[send-daily-todos] FAILED [{i+1}/{len(msgs)}] stderr={stderr}", file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()
