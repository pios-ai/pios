"""
WeChat 4.0 backup database decryptor
Uses cryptography library (instead of pycryptodome) for AES-CBC.
SQLCipher 4 params: AES-256-CBC, HMAC-SHA512, reserve=80, page_size=4096
"""
import hashlib, struct, os, sys, json
import hmac as hmac_mod
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
IV_SZ = 16
HMAC_SZ = 64
RESERVE_SZ = 80  # IV(16) + HMAC(64)
SQLITE_HDR = b'SQLite format 3\x00'


def derive_mac_key(enc_key, salt):
    mac_salt = bytes(b ^ 0x3a for b in salt)
    return hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)


def aes_cbc_decrypt(key, iv, data):
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    return decryptor.update(data) + decryptor.finalize()


def decrypt_page(enc_key, page_data, pgno):
    iv = page_data[PAGE_SZ - RESERVE_SZ : PAGE_SZ - RESERVE_SZ + IV_SZ]
    if pgno == 1:
        encrypted = page_data[SALT_SZ : PAGE_SZ - RESERVE_SZ]
        decrypted = aes_cbc_decrypt(enc_key, iv, encrypted)
        return bytes(bytearray(SQLITE_HDR + decrypted + b'\x00' * RESERVE_SZ))
    else:
        encrypted = page_data[:PAGE_SZ - RESERVE_SZ]
        decrypted = aes_cbc_decrypt(enc_key, iv, encrypted)
        return decrypted + b'\x00' * RESERVE_SZ


def decrypt_database(db_path, out_path, enc_key):
    file_size = os.path.getsize(db_path)
    total_pages = file_size // PAGE_SZ
    if file_size % PAGE_SZ != 0:
        total_pages += 1

    with open(db_path, 'rb') as fin:
        page1 = fin.read(PAGE_SZ)

    if len(page1) < PAGE_SZ:
        print(f"  [ERROR] File too small")
        return False

    # Verify page 1 HMAC
    salt = page1[:SALT_SZ]
    mac_key = derive_mac_key(enc_key, salt)
    p1_hmac_data = page1[SALT_SZ : PAGE_SZ - RESERVE_SZ + IV_SZ]
    p1_stored_hmac = page1[PAGE_SZ - HMAC_SZ : PAGE_SZ]
    hm = hmac_mod.new(mac_key, p1_hmac_data, hashlib.sha512)
    hm.update(struct.pack('<I', 1))
    if hm.digest() != p1_stored_hmac:
        return False

    print(f"  HMAC OK, {total_pages} pages", end="", flush=True)

    os.makedirs(os.path.dirname(out_path) if os.path.dirname(out_path) else '.', exist_ok=True)
    with open(db_path, 'rb') as fin, open(out_path, 'wb') as fout:
        for pgno in range(1, total_pages + 1):
            page = fin.read(PAGE_SZ)
            if len(page) < PAGE_SZ:
                if len(page) > 0:
                    page = page + b'\x00' * (PAGE_SZ - len(page))
                else:
                    break
            decrypted = decrypt_page(enc_key, page, pgno)
            fout.write(decrypted)

    return True


def main():
    keys_file = sys.argv[1] if len(sys.argv) > 1 else "all_keys.json"
    db_dir = sys.argv[2] if len(sys.argv) > 2 else None
    out_dir = sys.argv[3] if len(sys.argv) > 3 else None

    if not db_dir or not out_dir:
        print("Usage: python3 decrypt_backup.py <keys.json> <db_dir> <out_dir>")
        sys.exit(1)

    with open(keys_file, encoding="utf-8") as f:
        keys = json.load(f)

    print(f"Loaded {len(keys)} DB key mappings")
    print(f"DB dir: {db_dir}")
    print(f"Output dir: {out_dir}")
    os.makedirs(out_dir, exist_ok=True)

    # Collect all DB files
    db_files = []
    for root, dirs, files in os.walk(db_dir):
        for f in files:
            if f.endswith('.db') and not f.endswith('-wal') and not f.endswith('-shm'):
                path = os.path.join(root, f)
                rel = os.path.relpath(path, db_dir)
                sz = os.path.getsize(path)
                db_files.append((rel, path, sz))

    db_files.sort(key=lambda x: x[2])
    print(f"Found {len(db_files)} DB files\n")

    success = 0
    failed = 0
    skipped = 0
    total_bytes = 0

    # Collect all unique enc_keys to try
    unique_keys = list(set(v["enc_key"] for v in keys.values()))
    print(f"Unique encryption keys to try: {len(unique_keys)}\n")

    for rel, path, sz in db_files:
        # Check if plaintext
        with open(path, 'rb') as fh:
            header = fh.read(16)
        if header[:15] == b'SQLite format 3':
            # Just copy plaintext DBs
            out_path = os.path.join(out_dir, rel)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            import shutil
            shutil.copy2(path, out_path)
            print(f"COPY (plain): {rel}")
            success += 1
            continue

        out_path = os.path.join(out_dir, rel)

        # Try the mapped key first, then all unique keys
        keys_to_try = []
        if rel in keys:
            keys_to_try.append(keys[rel]["enc_key"])
        for k in unique_keys:
            if k not in keys_to_try:
                keys_to_try.append(k)

        print(f"Decrypt: {rel} ({sz/1024/1024:.1f}MB) ...", end=" ", flush=True)

        decrypted = False
        for key_hex in keys_to_try:
            enc_key = bytes.fromhex(key_hex)
            ok = decrypt_database(path, out_path, enc_key)
            if ok:
                # Verify SQLite
                try:
                    import sqlite3
                    conn = sqlite3.connect(out_path)
                    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                    conn.close()
                    table_names = [t[0] for t in tables]
                    print(f" -> OK! Tables: {', '.join(table_names[:5])}", end="")
                    if len(table_names) > 5:
                        print(f" ...{len(table_names)} total", end="")
                    print(flush=True)
                    success += 1
                    total_bytes += sz
                    decrypted = True
                    break
                except Exception as e:
                    print(f" -> SQLite verify failed: {e}", flush=True)
                    continue

        if not decrypted:
            print(f" -> FAILED (no key worked)", flush=True)
            failed += 1
            # Clean up failed output
            if os.path.exists(out_path):
                os.remove(out_path)

    print(f"\n{'='*60}")
    print(f"Results: {success} success, {failed} failed, {len(db_files)} total")
    print(f"Decrypted: {total_bytes/1024/1024:.1f}MB")
    print(f"Output: {out_dir}")


if __name__ == '__main__':
    main()
