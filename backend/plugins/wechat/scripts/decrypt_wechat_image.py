#!/usr/bin/env python3
"""
Pi 微信图片解密工具

用法:
  python3 decrypt_wechat_image.py <dat_file> [output_dir]
  python3 decrypt_wechat_image.py --contact <contact_hash> [output_dir]
  python3 decrypt_wechat_image.py --all [output_dir]

Key 来源: image_keys.json（由 find_image_key 持续收集）
格式: {"ciphertext_hex": "key_hex", ...}
"""

import os
import sys
import json
import struct
import glob

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(SCRIPT_DIR, "image_keys.json")
WECHAT_ATTACH = os.path.expanduser(
    "~/Library/Containers/com.tencent.xinWeChat/Data/Documents/"
    "xwechat_files/{YOUR_WXID}_XXXX/msg/attach"
)

V2_MAGIC = b'\x07\x08V2\x08\x07'
V1_MAGIC = b'\x07\x08V1\x08\x07'


def load_keys():
    """Load {ciphertext_hex: key_bytes} from image_keys.json"""
    if not os.path.exists(KEYS_FILE):
        print(f"ERROR: {KEYS_FILE} not found. Run find_image_key first.")
        sys.exit(1)
    with open(KEYS_FILE) as f:
        data = json.load(f)
    # Convert hex strings to bytes
    keys = {}
    for ct_hex, key_hex in data.items():
        keys[ct_hex.lower()] = bytes.fromhex(key_hex)
    return keys


def get_pattern(dat_path):
    """Extract the ciphertext pattern (first 16 encrypted bytes) from a .dat file."""
    with open(dat_path, 'rb') as f:
        header = f.read(31)
    if len(header) < 31 or header[:6] not in (V2_MAGIC, V1_MAGIC):
        return None
    # Ciphertext starts at offset 15
    return header[15:31].hex()


def decrypt_v2(data, aes_key, xor_key=0x88):
    """Decrypt V2 data. Returns (decrypted_bytes, format) or (None, None)."""
    from Crypto.Cipher import AES

    if len(data) < 15 or data[:6] not in (V2_MAGIC, V1_MAGIC):
        return None, None

    key = aes_key
    if data[:6] == V1_MAGIC:
        key = b'cfcd208495d565ef'[:16]

    aes_size, xor_size = struct.unpack_from('<LL', data, 6)

    # AES alignment (PKCS7 adds 1-16 bytes)
    remainder = aes_size % 16
    aligned_aes_size = aes_size + (16 - remainder) if remainder else aes_size + 16

    offset = 15
    if offset + aligned_aes_size > len(data):
        return None, None

    aes_data = data[offset:offset + aligned_aes_size]
    cipher = AES.new(key[:16], AES.MODE_ECB)
    dec_raw = cipher.decrypt(aes_data)

    # Try PKCS7 unpad first
    pad_len = dec_raw[-1]
    if 1 <= pad_len <= 16 and all(b == pad_len for b in dec_raw[-pad_len:]):
        dec_aes = dec_raw[:-pad_len]
    else:
        # Fallback: truncate to declared aes_size
        dec_aes = dec_raw[:aes_size]

    if not _is_image_header(dec_aes[:16]):
        return None, None

    offset += aligned_aes_size
    raw_end = len(data) - xor_size
    raw_data = data[offset:raw_end] if offset < raw_end else b''
    xor_data = data[raw_end:]
    dec_xor = bytes(b ^ xor_key for b in xor_data)

    result = dec_aes + raw_data + dec_xor
    fmt = _detect_format(result[:16])
    return result, fmt


def _is_image_header(h):
    return (h[:3] == b'\xFF\xD8\xFF' or
            h[:4] == b'\x89PNG' or
            h[:4] == b'RIFF' or
            h[:4] == b'wxgf' or
            h[:3] == b'GIF')


def _detect_format(h):
    if h[:3] == b'\xFF\xD8\xFF': return 'jpg'
    if h[:4] == b'\x89PNG': return 'png'
    if h[:4] == b'RIFF': return 'webp'
    if h[:4] == b'wxgf': return 'hevc'
    if h[:3] == b'GIF': return 'gif'
    return 'bin'


def decrypt_file(dat_path, output_dir=None, keys=None):
    """Decrypt a single .dat file using pattern-matched key."""
    if keys is None:
        keys = load_keys()
    if output_dir is None:
        output_dir = os.path.join(SCRIPT_DIR, "decoded")
    os.makedirs(output_dir, exist_ok=True)

    pattern = get_pattern(dat_path)
    if pattern is None:
        # Try XOR decryption (old format)
        print(f"SKIP: {os.path.basename(dat_path)} - not V2 format")
        return None

    key = keys.get(pattern)
    if key is None:
        # Pattern not found - try all keys (slower but handles edge cases)
        with open(dat_path, 'rb') as f:
            data = f.read()
        for ct_hex, k in keys.items():
            result, fmt = decrypt_v2(data, k)
            if result and fmt != 'bin':
                return _save_result(dat_path, result, fmt, output_dir, ct_hex[:16])
        print(f"FAIL: {os.path.basename(dat_path)} - no matching key")
        return None

    with open(dat_path, 'rb') as f:
        data = f.read()
    result, fmt = decrypt_v2(data, key)
    if result and fmt != 'bin':
        return _save_result(dat_path, result, fmt, output_dir, pattern[:16])
    print(f"FAIL: {os.path.basename(dat_path)} - decryption error")
    return None


def _save_result(dat_path, result, fmt, output_dir, key_hint):
    basename = os.path.splitext(os.path.basename(dat_path))[0]
    for suffix in ('_t', '_h'):
        if basename.endswith(suffix):
            basename = basename[:-len(suffix)]
            break
    out_path = os.path.join(output_dir, f"{basename}.{fmt}")
    with open(out_path, 'wb') as f:
        f.write(result)
    print(f"OK: {os.path.basename(dat_path)} -> {fmt} ({len(result):,}B) key={key_hint}...")
    return out_path


def decrypt_contact(contact_hash, output_dir=None, keys=None):
    """Decrypt all full-size images for a contact."""
    if keys is None:
        keys = load_keys()
    contact_dir = os.path.join(WECHAT_ATTACH, contact_hash)
    if not os.path.isdir(contact_dir):
        print(f"ERROR: Contact dir not found: {contact_dir}")
        return []
    dat_files = glob.glob(os.path.join(contact_dir, "**/Img/*.dat"), recursive=True)
    dat_files = [f for f in dat_files if not f.endswith('_t.dat') and not f.endswith('_h.dat')]
    print(f"Found {len(dat_files)} full-size images for contact {contact_hash[:12]}...")
    results = []
    for f in sorted(dat_files):
        r = decrypt_file(f, output_dir, keys)
        if r:
            results.append(r)
    print(f"\nDecrypted {len(results)}/{len(dat_files)}")
    return results


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    if sys.argv[1] == '--contact':
        decrypt_contact(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif sys.argv[1] == '--all':
        keys = load_keys()
        out = sys.argv[2] if len(sys.argv) > 2 else None
        contacts = [d for d in os.listdir(WECHAT_ATTACH)
                    if os.path.isdir(os.path.join(WECHAT_ATTACH, d))]
        for c in contacts:
            decrypt_contact(c, out, keys)
    else:
        decrypt_file(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
