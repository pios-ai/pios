#!/usr/bin/env python3
"""
每日微信消息提取器
从 live WeChat 加密数据库中提取昨天（或指定日期）的私聊消息。

用法:
    python3 daily_extract.py                # 提取昨天的消息
    python3 daily_extract.py 2026-03-23     # 提取指定日期
    python3 daily_extract.py --today        # 提取今天的消息

输出: YYYY-MM-DD_wechat_digest.md 到 OUT_DIR

需要: pip install cryptography
"""
import hashlib, struct, os, sys, json, shutil, sqlite3, tempfile, re
import hmac as hmac_mod
from datetime import datetime, timedelta
from collections import defaultdict
from xml.etree import ElementTree as ET

# ========== 路径配置（环境变量 > 默认值）==========
LIVE_DB_DIR = os.environ.get('WECHAT_LIVE_DB',
    os.path.expanduser('~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/{YOUR_WXID}_XXXX/db_storage'))
KEYS_FILE = os.environ.get('WECHAT_KEYS_FILE',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'all_keys_clean.json'))
OUT_DIR = os.environ.get('WECHAT_DIGEST_DIR',
    os.path.expanduser('{vault}/{owner}/Pipeline/AI_Wechat_Digest/daily_raw'))
MY_WXID = os.environ.get('WECHAT_MY_WXID', os.environ.get('WECHAT_MY_WXID', ''))
# WECHAT_DATA_DIR: parent of db_storage, contains msg/file/{YYYY-MM}/
WECHAT_DATA_DIR = os.environ.get('WECHAT_DATA_DIR',
    os.path.dirname(os.path.expanduser('~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/{YOUR_WXID}_XXXX/db_storage')))
# ==================================================

# SQLCipher 4 params
PAGE_SZ = 4096; KEY_SZ = 32; SALT_SZ = 16; IV_SZ = 16; HMAC_SZ = 64; RESERVE_SZ = 80
SQLITE_HDR = b'SQLite format 3\x00'

MSG_TYPES = {
    1: 'text', 3: 'image', 34: 'voice', 42: 'contact_card',
    43: 'video', 47: 'emoji', 48: 'location', 49: 'app_msg',
    50: 'voip', 10000: 'system', 10002: 'system',
}

def build_file_index(data_dir):
    """Build filename -> [abs_path, ...] index from msg/file/YYYY-MM/ dirs."""
    file_root = os.path.join(data_dir, 'msg', 'file')
    index = {}
    if not os.path.isdir(file_root):
        return index
    for month in sorted(os.listdir(file_root)):
        month_dir = os.path.join(file_root, month)
        if not os.path.isdir(month_dir):
            continue
        for fname in os.listdir(month_dir):
            abs_path = os.path.join(month_dir, fname)
            index.setdefault(fname, []).append(abs_path)
    return index

def resolve_file(fname, create_time, file_index):
    """Return absolute path of a WeChat file attachment, or None.
    Handles WeChat's dedup renaming: foo.csv → foo(1).csv → foo(2).csv etc.
    """
    if not fname or not file_index:
        return None

    def _pick(paths):
        if not paths:
            return None
        if len(paths) == 1:
            return paths[0]
        dt = datetime.fromtimestamp(create_time)
        target_month = dt.strftime('%Y-%m')
        for p in paths:
            if target_month in p:
                return p
        return paths[0]

    # Exact match first
    result = _pick(file_index.get(fname))
    if result:
        return result

    # WeChat dedup: foo.csv might be cached as foo(1).csv or foo (1).csv
    stem, ext = os.path.splitext(fname)
    for suffix in ['(1)', '(2)', '(3)', ' (1)', ' (2)']:
        candidate = f'{stem}{suffix}{ext}'
        result = _pick(file_index.get(candidate))
        if result:
            return result

    return None

def derive_mac_key(enc_key, salt):
    mac_salt = bytes(b ^ 0x3a for b in salt)
    return hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)

def decrypt_page(enc_key, page_data, pgno):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    iv = page_data[PAGE_SZ - RESERVE_SZ : PAGE_SZ - RESERVE_SZ + IV_SZ]
    if pgno == 1:
        encrypted = page_data[SALT_SZ : PAGE_SZ - RESERVE_SZ]
    else:
        encrypted = page_data[:PAGE_SZ - RESERVE_SZ]
    dec = Cipher(algorithms.AES(enc_key), modes.CBC(iv)).decryptor()
    decrypted = dec.update(encrypted) + dec.finalize()
    if pgno == 1:
        return bytes(bytearray(SQLITE_HDR + decrypted + b'\x00' * RESERVE_SZ))
    return decrypted + b'\x00' * RESERVE_SZ

def decrypt_database(db_path, out_path, enc_key_hex):
    enc_key = bytes.fromhex(enc_key_hex)
    file_size = os.path.getsize(db_path)
    total_pages = (file_size + PAGE_SZ - 1) // PAGE_SZ

    with open(db_path, 'rb') as fin:
        page1 = fin.read(PAGE_SZ)
    if len(page1) < PAGE_SZ:
        return False

    salt = page1[:SALT_SZ]
    mac_key = derive_mac_key(enc_key, salt)
    p1_hmac_data = page1[SALT_SZ : PAGE_SZ - RESERVE_SZ + IV_SZ]
    p1_stored_hmac = page1[PAGE_SZ - HMAC_SZ : PAGE_SZ]
    hm = hmac_mod.new(mac_key, p1_hmac_data, hashlib.sha512)
    hm.update(struct.pack('<I', 1))
    if hm.digest() != p1_stored_hmac:
        return False

    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    with open(db_path, 'rb') as fin, open(out_path, 'wb') as fout:
        for pgno in range(1, total_pages + 1):
            page = fin.read(PAGE_SZ)
            if len(page) < PAGE_SZ:
                page = page + b'\x00' * (PAGE_SZ - len(page)) if page else b''
                if not page: break
            fout.write(decrypt_page(enc_key, page, pgno))
    return True

def try_decompress(data):
    """Try zstd decompression for WCDB compressed content."""
    if not isinstance(data, bytes):
        return data
    try:
        import subprocess, tempfile as _tf
        with _tf.NamedTemporaryFile(delete=False, suffix='.zst') as f:
            f.write(data)
            tmp = f.name
        out = tmp + '.out'
        zstd_bin = '/opt/homebrew/bin/zstd' if os.path.exists('/opt/homebrew/bin/zstd') else 'zstd'
        subprocess.run([zstd_bin, '-d', tmp, '-o', out, '--force', '-q'],
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

def get_content(row):
    """Extract message content, handling WCDB compression."""
    content = row['message_content'] or ''
    ct_type = row.get('WCDB_CT_message_content', 0)
    if ct_type == 4 and isinstance(content, bytes):
        content = try_decompress(content)
    elif isinstance(content, bytes):
        content = content.decode('utf-8', errors='replace')
    return content or ''

def format_message(content, local_type, is_me, create_time=0, file_index=None):
    """Format a single message for display. Returns (text, file_path_or_None)."""
    base_type = local_type & 0xFFFF
    msg_type = MSG_TYPES.get(base_type, f'type_{base_type}')

    if msg_type == 'text':
        return content, None
    elif msg_type == 'image':
        return '📷[图片]', None
    elif msg_type == 'voice':
        return '🎤[语音]', None
    elif msg_type == 'video':
        return '🎬[视频]', None
    elif msg_type == 'emoji':
        return '[表情]', None
    elif msg_type == 'location':
        return '📍[位置]', None
    elif msg_type == 'voip':
        return '📞[通话]', None
    elif msg_type == 'contact_card':
        return '👤[名片]', None
    elif msg_type == 'system':
        if '撤回' in content:
            try:
                root = ET.fromstring(content)
                who = root.findtext('.//replacemsg', '').replace('"', '').strip()
                return (f'💬 {who}' if who else '💬[撤回消息]'), None
            except:
                pass
        return '💬[系统消息]', None
    elif msg_type == 'app_msg':
        try:
            root = ET.fromstring(content)
            title = root.findtext('.//title', '')
            app_type = root.findtext('.//type', '')
            if app_type == '6':
                # Extract actual filename from appattach
                appattach = root.find('.//appattach')
                fname = title
                if appattach is not None:
                    fname = appattach.findtext('attachfilename', '') or title
                file_path = resolve_file(fname, create_time, file_index)
                if file_path:
                    return f'📎[文件: {fname}] → {file_path}', file_path
                return f'📎[文件: {fname}]', None
            elif app_type == '57':
                return f'↩️ {title}', None
            elif title:
                return f'🔗{title}', None
        except:
            pass
        return '📎[应用消息]', None
    return f'[{msg_type}]', None

def load_contacts(db_dir, keys):
    """Load contact names from contact.db"""
    contacts = {}
    db_name = 'contact/contact.db'
    key_info = keys.get(db_name)
    if not key_info:
        return contacts

    src = os.path.join(db_dir, db_name)
    if not os.path.exists(src):
        return contacts

    tmp = tempfile.mktemp(suffix='.db')
    try:
        shutil.copy2(src, tmp + '.enc')
        if decrypt_database(tmp + '.enc', tmp, key_info['enc_key']):
            conn = sqlite3.connect(tmp)
            try:
                rows = conn.execute(
                    'SELECT username, nick_name, remark, alias FROM contact'
                ).fetchall()
                for username, nick, remark, alias in rows:
                    display = remark or nick or alias or username
                    contacts[username] = display
            except Exception as e:
                pass
            conn.close()
    finally:
        for f in [tmp, tmp + '.enc']:
            if os.path.exists(f): os.remove(f)
    return contacts

def extract_day(db_dir, keys, target_date, contacts, file_index=None):
    """Extract all private chat messages for target_date."""
    ts_start = int(datetime.strptime(target_date, '%Y-%m-%d').timestamp())
    ts_end = ts_start + 86400

    all_messages = []

    for i in range(12):
        db_name = f'message/message_{i}.db'
        key_info = keys.get(db_name)
        if not key_info:
            continue

        src = os.path.join(db_dir, db_name)
        if not os.path.exists(src):
            continue

        tmp = tempfile.mktemp(suffix='.db')
        try:
            shutil.copy2(src, tmp + '.enc')
            if not decrypt_database(tmp + '.enc', tmp, key_info['enc_key']):
                # Try all unique keys
                decrypted = False
                for kn, ki in keys.items():
                    if kn == db_name:
                        continue
                    if decrypt_database(tmp + '.enc', tmp, ki['enc_key']):
                        decrypted = True
                        break
                if not decrypted:
                    continue

            conn = sqlite3.connect(tmp)
            conn.row_factory = sqlite3.Row

            # Build sender map from Name2Id table
            sender_map = {}
            try:
                rows_n2i = conn.execute('SELECT rowid, user_name FROM Name2Id').fetchall()
                for rowid, uname in rows_n2i:
                    sender_map[rowid] = uname
            except:
                pass

            # Build hash->username mapping
            hash_to_user = {}
            try:
                n2i = conn.execute('SELECT user_name FROM Name2Id').fetchall()
                for (uname,) in n2i:
                    h = hashlib.md5(uname.encode()).hexdigest()
                    hash_to_user[h] = uname
            except:
                pass

            # Find all Msg_ tables
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
            ).fetchall()]

            for table in tables:
                if '_fts' in table or '_config' in table:
                    continue

                try:
                    chat_hash = table.replace('Msg_', '')
                    chat_user = hash_to_user.get(chat_hash, chat_hash)

                    # Skip group chats and system accounts
                    if '@chatroom' in chat_user or chat_user.startswith('gh_'):
                        continue
                    system_accounts = {'filehelper', 'newsapp', 'fmessage', 'medianote',
                                       'floatbottle', 'weixin', 'notifymessage', 'mphelper',
                                       'tmessage', 'qqsafe', 'officialaccounts', 'blogapp',
                                       'weibo', 'qqmail'}
                    if chat_user in system_accounts or '@openim' in chat_user:
                        continue

                    rows = conn.execute(f'''
                        SELECT local_type, real_sender_id, create_time,
                               message_content, WCDB_CT_message_content
                        FROM "{table}"
                        WHERE create_time >= ? AND create_time < ?
                        ORDER BY create_time
                    ''', (ts_start, ts_end)).fetchall()

                    if not rows:
                        continue

                    for row in rows:
                        row_dict = dict(row)
                        content = get_content(row_dict)
                        create_time = row_dict['create_time']
                        local_type = row_dict['local_type']
                        sender_id = row_dict['real_sender_id']

                        sender_wxid = sender_map.get(sender_id, str(sender_id))
                        is_me = (sender_wxid == MY_WXID)

                        formatted, file_path = format_message(
                            content, local_type, is_me,
                            create_time=create_time, file_index=file_index)
                        time_str = datetime.fromtimestamp(create_time).strftime('%H:%M')

                        all_messages.append({
                            'chat_hash': chat_hash,
                            'chat_user': chat_user,
                            'time': time_str,
                            'timestamp': create_time,
                            'is_me': is_me,
                            'content': formatted,
                            'local_type': local_type,
                            'file_path': file_path,
                        })
                except Exception as e:
                    continue

            conn.close()
        finally:
            for f in [tmp, tmp + '.enc']:
                if os.path.exists(f): os.remove(f)

    return all_messages

def group_by_chat(messages, contacts):
    """Group messages by chat and add contact names."""
    chats = defaultdict(list)
    for msg in messages:
        chats[msg['chat_hash']].append(msg)

    # Sort each chat by timestamp
    for h in chats:
        chats[h].sort(key=lambda m: m['timestamp'])

    return chats

def generate_digest(target_date, chats, contacts):
    """Generate markdown digest."""
    lines = []
    # Sort chats by message count (most active first)
    sorted_chats = sorted(chats.items(), key=lambda x: len(x[1]), reverse=True)

    total_msgs = sum(len(msgs) for _, msgs in sorted_chats)
    total_contacts = len(sorted_chats)

    # Collect all attachments across all chats
    all_attachments = []
    for _, msgs in sorted_chats:
        for msg in msgs:
            if msg.get('file_path'):
                all_attachments.append({
                    'path': msg['file_path'],
                    'name': os.path.basename(msg['file_path']),
                })

    lines.append(f'---')
    lines.append(f'date: {target_date}')
    lines.append(f'type: wechat_daily')
    lines.append(f'total_messages: {total_msgs}')
    lines.append(f'total_contacts: {total_contacts}')
    lines.append(f'total_attachments: {len(all_attachments)}')
    lines.append(f'---')
    lines.append(f'')

    # Attachments summary at the top for easy access
    if all_attachments:
        lines.append(f'## 📎 附件列表 ({len(all_attachments)} 个)')
        lines.append(f'')
        for att in all_attachments:
            lines.append(f'- [{att["name"]}]({att["path"]})')
        lines.append(f'')

    for chat_hash, msgs in sorted_chats:
        # Get contact display name
        chat_user = msgs[0].get('chat_user', chat_hash)
        contact_name = contacts.get(chat_user, chat_user)

        lines.append(f'## {contact_name}')
        lines.append(f'')
        for msg in msgs:
            sender = '我' if msg['is_me'] else contact_name
            content_lines = msg['content'].split('\n')
            first_line = content_lines[0]
            lines.append(f'- {msg["time"]} {sender}：{first_line}')
            for extra in content_lines[1:]:
                if extra.strip():
                    lines.append(f'  {extra}')
        lines.append(f'')

    return '\n'.join(lines)

def main():
    # Determine target date
    # Supports: no args (yesterday), --today, YYYY-MM-DD, --date YYYY-MM-DD
    args = sys.argv[1:]
    if not args:
        target_date = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
    elif args[0] == '--today':
        target_date = datetime.now().strftime('%Y-%m-%d')
    elif args[0] == '--date' and len(args) > 1:
        target_date = args[1]
    else:
        target_date = args[0]

    print(f'提取日期: {target_date}')
    print(f'数据库目录: {LIVE_DB_DIR}')
    print(f'数据根目录: {WECHAT_DATA_DIR}')
    print(f'密钥文件: {KEYS_FILE}')
    print(f'输出目录: {OUT_DIR}')

    # Load keys
    with open(KEYS_FILE, 'r') as f:
        keys = json.load(f)
    print(f'已加载 {len(keys)} 个密钥')

    # Load contacts
    print('加载联系人...')
    contacts = load_contacts(LIVE_DB_DIR, keys)
    print(f'  {len(contacts)} 个联系人')

    # Build file index
    print('建立附件索引...')
    file_index = build_file_index(WECHAT_DATA_DIR)
    print(f'  {len(file_index)} 个文件名索引')

    # Extract messages
    print(f'提取 {target_date} 的消息...')
    messages = extract_day(LIVE_DB_DIR, keys, target_date, contacts, file_index=file_index)
    print(f'  共 {len(messages)} 条消息')

    if not messages:
        print('没有找到消息')
        # Still write empty file
        os.makedirs(OUT_DIR, exist_ok=True)
        out_file = os.path.join(OUT_DIR, f'{target_date}.md')
        with open(out_file, 'w') as f:
            f.write(f'---\ndate: {target_date}\ntype: wechat_daily\ntotal_messages: 0\ntotal_contacts: 0\n---\n\n')
        print(f'已保存空文件到: {out_file}')
        return

    # Group by chat
    chats = group_by_chat(messages, contacts)

    # Generate digest
    digest = generate_digest(target_date, chats, contacts)

    # Save
    os.makedirs(OUT_DIR, exist_ok=True)
    out_file = os.path.join(OUT_DIR, f'{target_date}.md')
    with open(out_file, 'w') as f:
        f.write(digest)

    attachment_count = sum(1 for m in messages if m.get('file_path'))
    print(f'\n已保存到: {out_file}')
    print(f'对话数: {len(chats)}, 消息数: {len(messages)}, 附件: {attachment_count}')

if __name__ == '__main__':
    main()
