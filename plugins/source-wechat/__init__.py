"""source-wechat — extracts WeChat daily messages and produces a digest.

Ported from:
  - scripts/decrypt_backup.py  (AES-256-CBC SQLCipher decryption)
  - scripts/gen_wechat_md.py   (message extraction + formatting)

Pipeline:
  1. Optionally decrypt encrypted backup DBs (if encrypted_db_dir + keys_file configured)
  2. Read decrypted SQLite DBs to extract private-chat messages for target date
  3. Format into raw Markdown per contact
  4. Use LLM (if available) to generate a structured daily digest
"""

import hashlib
import hmac as hmac_mod
import json
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import tempfile
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree as ET

from pios.sdk import SourcePlugin, SourceData

# ── SQLCipher decryption constants ───────────────────────────────────────────
PAGE_SZ   = 4096
KEY_SZ    = 32
SALT_SZ   = 16
IV_SZ     = 16
HMAC_SZ   = 64
RESERVE_SZ = 80   # IV(16) + HMAC(64)
SQLITE_HDR = b"SQLite format 3\x00"

MSG_TYPES = {
    1: "text", 3: "image", 34: "voice", 42: "contact_card",
    43: "video", 47: "emoji", 48: "location", 49: "app_msg",
    50: "voip", 51: "wechat_init", 10000: "system", 10002: "revoke",
}

SYSTEM_ACCOUNTS = {
    "filehelper", "newsapp", "fmessage", "medianote", "floatbottle",
    "weixin", "notifymessage", "mphelper", "tmessage", "qqsafe",
    "officialaccounts", "blogapp", "weibo", "qqmail",
}


# ── Decryption ────────────────────────────────────────────────────────────────

def _derive_mac_key(enc_key: bytes, salt: bytes) -> bytes:
    mac_salt = bytes(b ^ 0x3A for b in salt)
    return hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)


def _aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    return dec.update(data) + dec.finalize()


def _decrypt_page(enc_key: bytes, page_data: bytes, pgno: int) -> bytes:
    iv = page_data[PAGE_SZ - RESERVE_SZ: PAGE_SZ - RESERVE_SZ + IV_SZ]
    if pgno == 1:
        encrypted = page_data[SALT_SZ: PAGE_SZ - RESERVE_SZ]
        decrypted = _aes_cbc_decrypt(enc_key, iv, encrypted)
        return bytes(SQLITE_HDR + decrypted + b"\x00" * RESERVE_SZ)
    encrypted = page_data[: PAGE_SZ - RESERVE_SZ]
    return _aes_cbc_decrypt(enc_key, iv, encrypted) + b"\x00" * RESERVE_SZ


def _decrypt_db(db_path: str, out_path: str, enc_key: bytes) -> bool:
    """Decrypt a single SQLCipher DB. Returns True on success."""
    try:
        file_size = os.path.getsize(db_path)
        total_pages = (file_size + PAGE_SZ - 1) // PAGE_SZ
        with open(db_path, "rb") as fh:
            page1 = fh.read(PAGE_SZ)
        if len(page1) < PAGE_SZ:
            return False
        salt = page1[:SALT_SZ]
        mac_key = _derive_mac_key(enc_key, salt)
        hmac_data = page1[SALT_SZ: PAGE_SZ - RESERVE_SZ + IV_SZ]
        stored = page1[PAGE_SZ - HMAC_SZ:]
        hm = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
        hm.update(struct.pack("<I", 1))
        if hm.digest() != stored:
            return False
        os.makedirs(os.path.dirname(out_path) if os.path.dirname(out_path) else ".", exist_ok=True)
        with open(db_path, "rb") as fin, open(out_path, "wb") as fout:
            for pgno in range(1, total_pages + 1):
                page = fin.read(PAGE_SZ)
                if not page:
                    break
                if len(page) < PAGE_SZ:
                    page = page + b"\x00" * (PAGE_SZ - len(page))
                fout.write(_decrypt_page(enc_key, page, pgno))
        # Verify
        conn = sqlite3.connect(out_path)
        conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        conn.close()
        return True
    except Exception:
        if os.path.exists(out_path):
            os.remove(out_path)
        return False


def decrypt_all(encrypted_db_dir: str, keys_file: str, out_dir: str) -> str:
    """Decrypt all DB files from encrypted_db_dir into out_dir. Returns out_dir."""
    with open(keys_file, encoding="utf-8") as f:
        keys = json.load(f)
    unique_keys = list({v["enc_key"] for v in keys.values()})
    os.makedirs(out_dir, exist_ok=True)

    for root, _, files in os.walk(encrypted_db_dir):
        for fname in files:
            if not fname.endswith(".db") or fname.endswith(("-wal", "-shm")):
                continue
            src = os.path.join(root, fname)
            rel = os.path.relpath(src, encrypted_db_dir)
            dst = os.path.join(out_dir, rel)
            if os.path.exists(dst):
                continue
            with open(src, "rb") as fh:
                hdr = fh.read(16)
            if hdr[:15] == b"SQLite format 3":
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                continue
            keys_to_try = []
            if rel in keys:
                keys_to_try.append(keys[rel]["enc_key"])
            for k in unique_keys:
                if k not in keys_to_try:
                    keys_to_try.append(k)
            for key_hex in keys_to_try:
                if _decrypt_db(src, dst, bytes.fromhex(key_hex)):
                    break
    return out_dir


# ── Message extraction ────────────────────────────────────────────────────────

def _decompress_zstd(data: bytes) -> str:
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zst") as f:
            f.write(data)
            tmp = f.name
        out = tmp + ".out"
        subprocess.run(["zstd", "-d", tmp, "-o", out, "--force", "-q"],
                       capture_output=True, timeout=5)
        with open(out, "rb") as f:
            result = f.read()
        os.unlink(tmp)
        os.unlink(out)
        return result.decode("utf-8", errors="replace")
    except Exception:
        return str(data)


def _parse_xml(text: str) -> Optional[ET.Element]:
    if not text:
        return None
    try:
        if ":\n" in text[:80] and not text.startswith("<"):
            text = text.split(":\n", 1)[1]
        return ET.fromstring(text)
    except Exception:
        return None


def _fmt_app_msg(content: str) -> str:
    root = _parse_xml(content)
    if root is None:
        return "[应用消息]"
    appmsg = root.find(".//appmsg")
    if appmsg is None:
        return "[应用消息]"
    t = appmsg.findtext("type", "")
    title = appmsg.findtext("title", "") or ""
    if t == "6":
        fname = (appmsg.find("appattach") or ET.Element("x")).findtext("attachfilename", "") or title
        return f"📎[文件: {fname}]"
    if t == "5":
        return f"🔗[链接: {title}]" if title else "🔗[链接]"
    if t in ("33", "36"):
        src = appmsg.findtext("sourcedisplayname", "")
        return f"🟢[小程序: {src or title}]"
    if t == "57":
        return title or "[引用消息]"
    if t == "2001":
        return "🧧[红包]"
    if t == "2000":
        return "💰[转账]"
    return f"[{title}]" if title else "[应用消息]"


def _fmt_location(content: str) -> str:
    root = _parse_xml(content)
    if root is not None:
        loc = root.find(".//location")
        if loc is not None:
            label = loc.get("poiname", "") or loc.get("label", "")
            if label:
                return f"📍[位置: {label}]"
    return "📍[位置]"


def _format_msg(local_type: int, content: str) -> Optional[str]:
    base = local_type & 0xFFFF
    mtype = MSG_TYPES.get(base, MSG_TYPES.get(local_type, f"unknown_{local_type}"))
    if mtype == "text":
        return content or ""
    if mtype == "wechat_init":
        return None
    if mtype == "image":
        return "📷[图片]"
    if mtype == "voice":
        return "🎙️[语音]"
    if mtype == "video":
        return "🎬[视频]"
    if mtype == "emoji":
        return "[表情]"
    if mtype == "voip":
        return "📞[通话]"
    if mtype == "location":
        return _fmt_location(content)
    if mtype == "app_msg":
        return _fmt_app_msg(content)
    if mtype == "contact_card":
        root = _parse_xml(content)
        if root is not None:
            msg = root.find(".//msg")
            if msg is not None and msg.get("nickname"):
                return f"👤[名片: {msg.get('nickname')}]"
        return "👤[名片]"
    if mtype == "system":
        text = re.sub(r"<[^>]+>", "", content or "").strip()
        return f"💬 {text}" if text and len(text) <= 200 else None
    if mtype == "revoke":
        text = re.sub(r"<[^>]+>", "", content or "").strip()
        return f"🔙 {text}" if text else "🔙 [撤回消息]"
    return f"[{mtype}]"


def _is_private_chat(wxid: str) -> bool:
    if "@chatroom" in wxid or wxid.startswith("gh_") or "@openim" in wxid:
        return False
    return wxid not in SYSTEM_ACCOUNTS


def _load_contacts(decrypted_dir: str) -> Dict[str, str]:
    """Returns {wxid: display_name}."""
    contacts: Dict[str, str] = {}
    db_path = os.path.join(decrypted_dir, "contact", "contact.db")
    if not os.path.exists(db_path):
        return contacts
    try:
        conn = sqlite3.connect(db_path)
        rows = conn.execute(
            "SELECT username, nick_name, remark, alias FROM contact"
        ).fetchall()
        conn.close()
        for username, nick, remark, alias in rows:
            contacts[username] = remark or nick or alias or username
    except Exception:
        pass
    return contacts


def _extract_messages(decrypted_dir: str, my_wxid: str, target_date: str) -> Dict[str, List[Dict]]:
    """Extract all private-chat messages for target_date. Returns {contact_display: [messages]}."""
    contacts = _load_contacts(decrypted_dir)
    msg_dir = os.path.join(decrypted_dir, "message")
    all_chats: Dict[str, List[Dict]] = defaultdict(list)

    if not os.path.isdir(msg_dir):
        return {}

    for fname in sorted(os.listdir(msg_dir)):
        if not (fname.startswith("message_") or fname.startswith("biz_message_")):
            continue
        if not fname.endswith(".db") or "fts" in fname or "resource" in fname:
            continue
        db_path = os.path.join(msg_dir, fname)
        try:
            conn = sqlite3.connect(db_path)
            sender_map: Dict[int, str] = {}
            try:
                for rowid, uname in conn.execute("SELECT rowid, user_name FROM Name2Id").fetchall():
                    sender_map[rowid] = uname
            except Exception:
                pass

            hash_to_user: Dict[str, str] = {}
            for (uname,) in conn.execute("SELECT user_name FROM Name2Id").fetchall():
                h = hashlib.md5(uname.encode()).hexdigest()
                hash_to_user[h] = uname

            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
            ).fetchall()

            for (table_name,) in tables:
                table_hash = table_name.replace("Msg_", "")
                chat_user = hash_to_user.get(table_hash, table_hash)
                if not _is_private_chat(chat_user):
                    continue

                try:
                    rows = conn.execute(
                        f'SELECT local_type, real_sender_id, create_time, '
                        f'message_content, WCDB_CT_message_content '
                        f'FROM "{table_name}" ORDER BY create_time ASC'
                    ).fetchall()
                except Exception:
                    continue

                for local_type, sender_id, create_time, content, ct_type in rows:
                    if not create_time:
                        continue
                    dt = datetime.fromtimestamp(create_time)
                    if dt.strftime("%Y-%m-%d") != target_date:
                        continue

                    if ct_type == 4 and isinstance(content, bytes):
                        content = _decompress_zstd(content)
                    elif isinstance(content, bytes):
                        content = content.decode("utf-8", errors="replace")

                    sender_wxid = sender_map.get(sender_id, str(sender_id))
                    is_me = sender_wxid == my_wxid
                    display = _format_msg(local_type, content or "")
                    if display is None:
                        continue

                    contact_display = contacts.get(chat_user, chat_user)
                    sender_label = "我" if is_me else contact_display
                    all_chats[contact_display].append({
                        "time": dt.strftime("%H:%M"),
                        "sender": sender_label,
                        "content": display,
                    })

            conn.close()
        except Exception:
            continue

    return dict(all_chats)


def _build_raw_md(target_date: str, chats: Dict[str, List[Dict]]) -> str:
    """Build a raw Markdown listing of all messages, sorted by contact activity."""
    dt = datetime.strptime(target_date, "%Y-%m-%d")
    total = sum(len(v) for v in chats.values())
    lines = [
        "---",
        f"date: {target_date}",
        "type: wechat_daily",
        f"total_messages: {total}",
        f"total_contacts: {len(chats)}",
        "---",
        "",
    ]
    for contact, messages in sorted(chats.items(), key=lambda x: -len(x[1])):
        lines.append(f"## {contact}")
        lines.append("")
        for msg in messages:
            first_line = msg["content"].split("\n")[0]
            lines.append(f"- {msg['time']} {msg['sender']}：{first_line}")
        lines.append("")
    return "\n".join(lines)


def _llm_summary(raw_md: str, target_date: str, llm: Any) -> str:
    """Generate a structured daily digest via LLM."""
    prompt = f"""你是用户的私人助理，负责整理他的微信聊天日记。
以下是 {target_date} 的全部微信私聊记录（按联系人分组）：

{raw_md}

请生成一份结构化的日记，格式如下（用中文，内容尽量精炼）：

# 微信聊天日记 {target_date}

## 今日微信聊天一句话总结
<一句话总结今天所有微信聊天的核心内容> ^wechat-daily-summary

## 今日要事
- <事项1>
- <事项2>
（最重要的 3-6 件事，按重要程度排列）

## 待办/跟进
- [ ] <需要跟进的事项>
（只列真正需要行动的事项）

## 值得记住
- <有趣/重要/值得铭记的内容>
（可以是情感、洞见、有意思的对话片段等）

## 按联系人摘要
- **联系人名**: <简短摘要>
（每个有实质对话的联系人一行）

只生成内容，不要解释你的思考过程。"""

    try:
        messages = [{"role": "user", "content": prompt}]
        return llm.complete(messages, temperature=0.3, max_tokens=2000)
    except Exception as e:
        return f"（LLM 摘要生成失败: {e}）\n\n{raw_md}"


class Plugin(SourcePlugin):
    """WeChat daily digest source plugin."""

    def fetch(self) -> List[SourceData]:
        decrypted_dir = self.context.get_config("decrypted_db_dir", "")
        encrypted_dir = self.context.get_config("encrypted_db_dir", "")
        keys_file = self.context.get_config("keys_file", "")
        my_wxid = self.context.get_config("my_wxid", "")
        if not my_wxid:
            self.logger.warning("source-wechat: my_wxid not configured — skipping")
            return []
        days_back = int(self.context.get_config("days_back", 1))

        # Resolve decrypted DB path
        if not decrypted_dir and encrypted_dir and keys_file:
            self.logger.info("Decrypting WeChat backup DBs...")
            tmp_out = os.path.join(
                str(Path(encrypted_dir).parent), "02-微信聊天_已解密_pios"
            )
            try:
                decrypted_dir = decrypt_all(
                    str(Path(encrypted_dir).expanduser()),
                    str(Path(keys_file).expanduser()),
                    tmp_out,
                )
                self.logger.info(f"Decryption complete → {decrypted_dir}")
            except Exception as e:
                self.logger.error(f"Decryption failed: {e}")
                return []

        if not decrypted_dir:
            self.logger.warning(
                "source-wechat: set decrypted_db_dir (or encrypted_db_dir + keys_file) in config"
            )
            return []

        decrypted_dir = str(Path(decrypted_dir).expanduser())
        if not os.path.isdir(decrypted_dir):
            self.logger.warning(f"Decrypted DB dir not found: {decrypted_dir}")
            return []

        results: List[SourceData] = []
        today = date.today()

        for i in range(1, days_back + 1):
            target = (today - timedelta(days=i)).isoformat()

            if self.context.database:
                existing = self.context.database.get_documents(
                    source="source-wechat", date_from=target, date_to=target
                )
                if existing:
                    self.logger.info(f"Skipping {target} — already in vault")
                    continue

            self.logger.info(f"Extracting WeChat messages for {target}...")
            chats = _extract_messages(decrypted_dir, my_wxid, target)

            if not chats:
                self.logger.info(f"No private-chat messages found for {target}")
                continue

            self.logger.info(
                f"Found messages from {len(chats)} contacts on {target}"
            )
            results.append(SourceData(
                source="source-wechat",
                data_type="wechat-daily",
                content={"date": target, "chats": chats},
                title=f"微信聊天日记 {target}",
                date=target,
                tags=["wechat", "daily"],
            ))

        return results

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        target_date = data.content["date"]
        chats = data.content["chats"]
        raw_md = _build_raw_md(target_date, chats)

        llm = self.context.llm
        if llm and llm.is_available():
            self.logger.info(f"Generating LLM summary for {target_date}...")
            summary = _llm_summary(raw_md, target_date, llm)
        else:
            self.logger.info("LLM not available — saving raw messages")
            summary = raw_md

        return {"text": summary}
