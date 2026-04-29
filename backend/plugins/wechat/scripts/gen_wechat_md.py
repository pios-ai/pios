#!/usr/bin/env python3
"""Generate wechat_daily/*.md and wechat_friend/*.md from decrypted WeChat databases.
   With media attachment linking.

   Paths via environment variables (or use defaults):
     WECHAT_DB_DIR    — decrypted DB directory
     WECHAT_OUT_DIR   — vault output directory
     WECHAT_MEDIA_DIR — media files directory (for file:// links)
     WECHAT_MY_WXID   — your wxid

   Example:
     export WECHAT_MEDIA_DIR=/Volumes/NewDisk/微信媒体
     python3 gen_wechat_md.py
"""

import sqlite3
import hashlib
import json
import os
import re
import subprocess
import tempfile
import datetime
from collections import defaultdict
from xml.etree import ElementTree as ET

# ========== PATHS (env var > default) ==========
BASE = os.environ.get('WECHAT_DB_DIR', '{vault}/L0_raw/Backup-Messages/02-微信聊天_已解密')
OUT_BASE = os.environ.get('WECHAT_OUT_DIR', '{vault}/ai_pipeline/Wechat')
MEDIA_ROOT = os.environ.get('WECHAT_MEDIA_DIR', '{vault}/L0_raw/Backup-Messages/02-微信聊天')
MY_WXID = os.environ.get('WECHAT_MY_WXID', os.environ.get('WECHAT_MY_WXID', ''))
# ================================================

DAILY_DIR = os.path.join(OUT_BASE, 'wechat_daily')
FRIEND_DIR = os.path.join(OUT_BASE, 'wechat_friend')

MSG_TYPES = {
    1: 'text', 3: 'image', 34: 'voice', 42: 'contact_card',
    43: 'video', 47: 'emoji', 48: 'location', 49: 'app_msg',
    50: 'voip', 51: 'wechat_init', 10000: 'system', 10002: 'revoke',
}

def build_file_index(media_root):
    file_root = os.path.join(media_root, 'msg', 'file')
    index = {}
    if not os.path.isdir(file_root):
        return index
    for month in sorted(os.listdir(file_root)):
        month_dir = os.path.join(file_root, month)
        if not os.path.isdir(month_dir):
            continue
        for f in os.listdir(month_dir):
            rel = f'msg/file/{month}/{f}'
            index.setdefault(f, []).append(rel)
    return index

def build_video_index(media_root):
    video_root = os.path.join(media_root, 'msg', 'video')
    size_index = {}
    thumb_index = {}
    if not os.path.isdir(video_root):
        return size_index, thumb_index
    for month in sorted(os.listdir(video_root)):
        month_dir = os.path.join(video_root, month)
        if not os.path.isdir(month_dir):
            continue
        for f in os.listdir(month_dir):
            if f.endswith('.mp4'):
                fpath = os.path.join(month_dir, f)
                try:
                    size = os.path.getsize(fpath)
                except:
                    continue
                key = (month, size)
                if key not in size_index:
                    size_index[key] = f'msg/video/{month}/{f}'
            elif f.endswith('_thumb.jpg'):
                base = f.replace('_thumb.jpg', '')
                thumb_index[(month, base)] = f'msg/video/{month}/{f}'
    return size_index, thumb_index

class MediaLinker:
    def __init__(self, media_root):
        self.media_root = media_root
        print('  Building file index...')
        self.file_index = build_file_index(media_root)
        print(f'    {len(self.file_index)} unique filenames')
        print('  Building video index...')
        self.video_size_index, self.video_thumb_index = build_video_index(media_root)
        print(f'    {len(self.video_size_index)} video size entries')

    def resolve_file(self, title, create_time):
        if not title:
            return None
        if title in self.file_index:
            paths = self.file_index[title]
            if len(paths) == 1:
                return paths[0]
            dt = datetime.datetime.fromtimestamp(create_time)
            target_month = dt.strftime('%Y-%m')
            for p in paths:
                if target_month in p:
                    return p
            return paths[0]
        return None

    def resolve_video(self, xml_length, create_time):
        if not xml_length:
            return None, None
        dt = datetime.datetime.fromtimestamp(create_time)
        month = dt.strftime('%Y-%m')
        size = int(xml_length)
        key = (month, size)
        mp4_path = self.video_size_index.get(key)
        thumb_path = None
        if mp4_path:
            mp4_name = os.path.basename(mp4_path).replace('.mp4', '')
            thumb_path = self.video_thumb_index.get((month, mp4_name))
        return mp4_path, thumb_path

def decompress_zstd(data):
    if not isinstance(data, bytes):
        return data
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix='.zst') as f:
            f.write(data)
            tmp = f.name
        out = tmp + '.out'
        subprocess.run(['zstd', '-d', tmp, '-o', out, '--force', '-q'],
                      capture_output=True, timeout=5)
        with open(out, 'rb') as f:
            result = f.read()
        os.unlink(tmp)
        os.unlink(out)
        return result.decode('utf-8', errors='replace')
    except Exception:
        try: os.unlink(tmp)
        except: pass
        try: os.unlink(out)
        except: pass
        return str(data)

def parse_xml_safe(text):
    if not text:
        return None
    try:
        if ':\n' in text[:80] and not text.startswith('<'):
            text = text.split(':\n', 1)[1]
        return ET.fromstring(text)
    except:
        return None

def format_image(content, media_linker, chat_hash, create_time):
    return '📷[图片]', None

def format_video(content, media_linker, chat_hash, create_time):
    root = parse_xml_safe(content)
    if root is not None:
        vid = root.find('.//videomsg')
        if vid is not None:
            duration = vid.get('playlength', '')
            xml_length = vid.get('length', '')
            dur_str = f' {duration}s' if duration else ''
            mp4_path, _ = media_linker.resolve_video(xml_length, create_time)
            if mp4_path:
                return f'🎬[视频{dur_str}]', mp4_path
            return f'🎬[视频{dur_str}]', None
    return '🎬[视频]', None

def format_voice(content, ml, ch, ct):
    return '🎙️[语音]', None

def format_emoji(content, ml, ch, ct):
    return '[表情]', None

def format_location(content, ml, ch, ct):
    root = parse_xml_safe(content)
    if root is not None:
        loc = root.find('.//location')
        if loc is not None:
            label = loc.get('poiname', '') or loc.get('label', '')
            if label:
                return f'📍[位置: {label}]', None
    return '📍[位置]', None

def format_contact_card(content, ml, ch, ct):
    root = parse_xml_safe(content)
    if root is not None:
        msg = root.find('.//msg')
        if msg is not None:
            nickname = msg.get('nickname', '')
            if nickname:
                return f'👤[名片: {nickname}]', None
    return '👤[名片]', None

def format_app_msg(content, media_linker, chat_hash, create_time):
    root = parse_xml_safe(content)
    if root is not None:
        appmsg = root.find('.//appmsg')
        if appmsg is not None:
            msg_type = appmsg.findtext('type', '')
            title = appmsg.findtext('title', '') or ''
            if msg_type == '6':
                appattach = appmsg.find('appattach')
                fname = title
                if appattach is not None:
                    fname = appattach.findtext('attachfilename', '') or title
                file_path = media_linker.resolve_file(fname, create_time)
                if file_path:
                    return f'📎[文件: {fname}]', file_path
                return f'📎[文件: {fname or title}]', None
            if msg_type == '5':
                if title:
                    return f'🔗[链接: {title}]', None
                return f'🔗[链接]', None
            if msg_type in ('33', '36'):
                sourcedisplayname = appmsg.findtext('sourcedisplayname', '')
                return f'🟢[小程序: {sourcedisplayname or title}]', None
            if msg_type == '57':
                ref_content = appmsg.findtext('title', '')
                return (f'{ref_content}' if ref_content else '[引用消息]'), None
            if msg_type == '2001':
                return '🧧[红包]', None
            if msg_type == '2000':
                return '💰[转账]', None
            if title:
                return f'[{title}]', None
    return '[应用消息]', None

def format_voip(content, ml, ch, ct):
    return '📞[通话]', None

def format_system(content, ml, ch, ct):
    if not content:
        return None, None
    text = re.sub(r'<[^>]+>', '', content).strip()
    if not text or len(text) > 200:
        return None, None
    return f'💬 {text}', None

def format_revoke(content, ml, ch, ct):
    text = re.sub(r'<[^>]+>', '', content or '').strip()
    return (f'🔙 {text}' if text else '🔙 [撤回消息]'), None

FORMAT_MAP = {
    'image': format_image, 'video': format_video, 'voice': format_voice,
    'emoji': format_emoji, 'location': format_location, 'contact_card': format_contact_card,
    'app_msg': format_app_msg, 'voip': format_voip, 'system': format_system, 'revoke': format_revoke,
}

def load_contacts():
    contacts = {}
    db = os.path.join(BASE, 'contact', 'contact.db')
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute('SELECT username, nick_name, remark, alias FROM contact').fetchall()
        for username, nick, remark, alias in rows:
            display = remark or nick or alias or username
            contacts[username] = {'nick_name': nick or '', 'remark': remark or '', 'alias': alias or '', 'display': display, 'wxid': username}
    except Exception as e:
        print(f'Warning: {e}')
    conn.close()
    return contacts

def is_private_chat(username):
    if '@chatroom' in username:
        return False
    if username.startswith('gh_'):
        return False
    system_accounts = {'filehelper', 'newsapp', 'fmessage', 'medianote', 'floatbottle', 'weixin', 'notifymessage', 'mphelper', 'tmessage', 'qqsafe', 'officialaccounts', 'blogapp', 'weibo', 'qqmail'}
    if username in system_accounts:
        return False
    if '@openim' in username:
        return False
    return True

def process_message_db(db_path, contacts, all_chats, media_linker):
    conn = sqlite3.connect(db_path)
    sender_map = {}
    try:
        rows = conn.execute('SELECT rowid, user_name FROM Name2Id').fetchall()
        for rowid, uname in rows:
            sender_map[rowid] = uname
    except:
        pass

    n2i = conn.execute('SELECT user_name FROM Name2Id').fetchall()
    hash_to_user = {}
    for (uname,) in n2i:
        h = hashlib.md5(uname.encode()).hexdigest()
        hash_to_user[h] = uname

    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").fetchall()

    for (table_name,) in tables:
        table_hash = table_name.replace('Msg_', '')
        chat_user = hash_to_user.get(table_hash, table_hash)
        if not is_private_chat(chat_user):
            continue

        try:
            rows = conn.execute(f'SELECT local_type, real_sender_id, create_time, message_content, WCDB_CT_message_content FROM "{table_name}" ORDER BY create_time ASC').fetchall()
        except Exception as e:
            print(f'  Warning: {table_name}: {e}')
            continue

        for local_type, sender_id, create_time, content, ct_type in rows:
            if not create_time:
                continue
            if ct_type == 4 and isinstance(content, bytes):
                content = decompress_zstd(content)
            elif isinstance(content, bytes):
                content = content.decode('utf-8', errors='replace')

            sender_wxid = sender_map.get(sender_id, str(sender_id))
            is_me = (sender_wxid == MY_WXID)
            base_type = local_type & 0xFFFF
            msg_type = MSG_TYPES.get(base_type, MSG_TYPES.get(local_type, f'unknown_{local_type}'))

            media_path = None
            if msg_type == 'text':
                display_content = content or ''
            elif msg_type == 'wechat_init':
                continue
            elif msg_type in FORMAT_MAP:
                display_content, media_path = FORMAT_MAP[msg_type](content, media_linker, table_hash, create_time)
                if display_content is None:
                    continue
            else:
                display_content = f'[{msg_type}]'

            dt = datetime.datetime.fromtimestamp(create_time)
            date_str = dt.strftime('%Y-%m-%d')
            time_str = dt.strftime('%H:%M')
            contact_display = contacts.get(chat_user, {}).get('display', chat_user)
            sender_display = '我' if is_me else contact_display

            msg = {'time': time_str, 'sender': sender_display, 'content': display_content, 'type': msg_type, 'media_path': media_path}

            key = (chat_user, date_str)
            if key not in all_chats:
                all_chats[key] = {'chat_user': chat_user, 'contact_display': contact_display, 'date': date_str, 'messages': []}
            all_chats[key]['messages'].append(msg)

    conn.close()

def format_media_link(media_path, msg_type):
    """Format a media link via media/ symlink (relative path)."""
    if not media_path:
        return ''
    obsidian_path = f'media/{media_path}'
    if msg_type == 'video':
        return f' [▶️ 播放](../{obsidian_path})'
    elif msg_type == 'app_msg':
        fname = os.path.basename(media_path)
        return f' [📥 {fname}](../{obsidian_path})'
    return ''

def generate_daily_files(all_chats):
    os.makedirs(DAILY_DIR, exist_ok=True)
    by_date = defaultdict(list)
    for (chat_user, date_str), chat_data in all_chats.items():
        by_date[date_str].append(chat_data)

    print(f'Generating {len(by_date)} daily files...')
    media_linked = 0
    for date_str in sorted(by_date.keys()):
        chats = by_date[date_str]
        chats.sort(key=lambda c: -len(c['messages']))
        total_msgs = sum(len(c['messages']) for c in chats)
        total_contacts = len(chats)

        lines = ['---', f'date: {date_str}', 'type: wechat_daily', f'total_messages: {total_msgs}', f'total_contacts: {total_contacts}', '---', '']
        for chat_data in chats:
            display = chat_data['contact_display']
            lines.append(f'## {display}')
            lines.append('')
            for msg in chat_data['messages']:
                content = msg['content']
                media_path = msg.get('media_path')
                content_lines = content.split('\n')
                first_line = content_lines[0]
                line = f"- {msg['time']} {msg['sender']}：{first_line}"
                if media_path:
                    media_link = format_media_link(media_path, msg['type'])
                    if media_link:
                        line += media_link
                        media_linked += 1
                lines.append(line)
                for extra in content_lines[1:]:
                    if extra.strip():
                        lines.append(f'  {extra}')
            lines.append('')

        fpath = os.path.join(DAILY_DIR, f'{date_str}.md')
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))

    print(f'  Media links added: {media_linked}')
    return by_date

def generate_friend_files(all_chats, contacts):
    os.makedirs(FRIEND_DIR, exist_ok=True)
    friend_data = defaultdict(lambda: {'dates': set(), 'total_messages': 0, 'chat_user': '', 'contact_display': ''})
    for (chat_user, date_str), chat_data in all_chats.items():
        fd = friend_data[chat_user]
        fd['dates'].add(date_str)
        fd['total_messages'] += len(chat_data['messages'])
        fd['chat_user'] = chat_user
        fd['contact_display'] = chat_data['contact_display']

    print(f'Generating {len(friend_data)} friend files...')
    for chat_user, fd in friend_data.items():
        display = fd['contact_display']
        dates = sorted(fd['dates'])
        contact_info = contacts.get(chat_user, {})
        safe_name = re.sub(r'[<>:"/\\|?*]', '_', display)
        if not safe_name.strip() or safe_name.strip('.') == '':
            safe_name = chat_user

        lines = ['---', 'type: wechat_friend', f'wxid: {chat_user}', f'alias: "{contact_info.get("alias", "")}"',
                 f'nick_name: "{contact_info.get("nick_name", "")}"', f'remark: "{contact_info.get("remark", "")}"',
                 f'total_messages: {fd["total_messages"]}', f'first_chat: {dates[0]}', f'last_chat: {dates[-1]}',
                 '---', '', f'# {display}', '']
        for d in dates:
            lines.append(f'**{d}**')
            lines.append(f'![[wechat_daily/{d}#{display}]]')
            lines.append('')

        fpath = os.path.join(FRIEND_DIR, f'{safe_name}.md')
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))

def main():
    print('Loading contacts...')
    contacts = load_contacts()
    print(f'  {len(contacts)} contacts')
    print('Building media indexes...')
    media_linker = MediaLinker(MEDIA_ROOT)

    all_chats = {}
    msg_dir = os.path.join(BASE, 'message')
    if os.path.isdir(msg_dir):
        for fname in sorted(os.listdir(msg_dir)):
            if fname.startswith('message_') and fname.endswith('.db') and 'fts' not in fname and 'resource' not in fname:
                print(f'Processing {fname}...')
                process_message_db(os.path.join(msg_dir, fname), contacts, all_chats, media_linker)
            elif fname.startswith('biz_message_') and fname.endswith('.db'):
                print(f'Processing {fname}...')
                process_message_db(os.path.join(msg_dir, fname), contacts, all_chats, media_linker)

    print(f'\nTotal chat-day pairs: {len(all_chats)}')
    friends = set(k[0] for k in all_chats.keys())
    print(f'Unique private chat contacts: {len(friends)}')

    by_date = generate_daily_files(all_chats)
    generate_friend_files(all_chats, contacts)

    total_msgs = sum(len(v['messages']) for v in all_chats.values())
    print(f'\n=== Done ===')
    print(f'Total messages (private only): {total_msgs}')
    print(f'Daily files: {len(by_date)}')
    print(f'Friend files: {len(friends)}')
    print(f'Output: {DAILY_DIR}')
    print(f'         {FRIEND_DIR}')

if __name__ == '__main__':
    main()
