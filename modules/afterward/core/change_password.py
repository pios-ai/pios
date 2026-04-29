"""
Change master password — re-encrypt all vault files + regenerate Shamir shares.

Usage (via Electron IPC):
    echo '{"old":"...","new":"..."}' | python3 -m core.change_password --base-dir /path

Flow:
  1. Verify old password (decrypt unlock-check.txt.enc)
  2. Decrypt all `vault/*.enc` files with old password
  3. Re-encrypt each with new password
  4. Update unlock-check.txt.enc with new password
  5. Regenerate Shamir shares (K-of-N, using trustees-meta.json for count)
  6. Return new shares for re-distribution

Returns JSON {ok, shares: [...]} or {error}.

Safety:
    - Writes to temp files first, renames atomically per file
    - If any file fails to decrypt with old password, aborts (partial re-encrypt would corrupt vault)
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import List, Tuple

from core.shamir import split as shamir_split
from core.vault import decrypt as vault_decrypt, encrypt as vault_encrypt

UNLOCK_CHECK_MARKER = "AFTERWARD_UNLOCK_OK\n"


def change_password(base_dir: Path, old_password: str, new_password: str) -> dict:
    vault_dir = base_dir / "vault"
    if not vault_dir.exists():
        return {"error": "vault dir not found"}

    # Step 1: verify old password
    unlock_check = vault_dir / "unlock-check.txt.enc"
    if not unlock_check.exists():
        return {"error": "unlock-check missing (not initialized?)"}
    try:
        marker = vault_decrypt(unlock_check.read_bytes(), old_password).decode("utf-8")
        if not marker.startswith("AFTERWARD_UNLOCK_OK"):
            return {"error": "unlock-check decrypted to wrong marker"}
    except Exception:
        return {"error": "old password wrong"}

    # Step 2: find all .enc files + decrypt-then-re-encrypt atomically
    all_enc = sorted(vault_dir.rglob("*.enc"))

    # Dry-run: decrypt everything first (verify old password works on all files)
    decrypted: List[Tuple[Path, bytes]] = []
    for enc_path in all_enc:
        try:
            plain = vault_decrypt(enc_path.read_bytes(), old_password)
            decrypted.append((enc_path, plain))
        except Exception as e:
            return {"error": f"failed to decrypt {enc_path.name}: {e}"}

    # All decrypts succeeded — re-encrypt with new password
    # Write to .new then atomic rename, so partial failure doesn't corrupt
    for enc_path, plain in decrypted:
        new_bytes = vault_encrypt(plain, new_password)
        tmp_path = enc_path.with_suffix(enc_path.suffix + ".new")
        tmp_path.write_bytes(new_bytes)
        tmp_path.replace(enc_path)

    # Step 3: regenerate Shamir shares based on existing trustees
    meta_file = base_dir / "trustees-meta.json"
    if not meta_file.exists():
        return {"error": "trustees-meta.json missing"}
    trustees = json.loads(meta_file.read_text())
    num_shares = len(trustees)
    threshold = min(3, num_shares)
    shares_raw = shamir_split(new_password, threshold=threshold, num_shares=num_shares)

    shares_with_meta = []
    for (idx, share_str), trustee in zip(shares_raw, trustees):
        shares_with_meta.append({
            "index": idx,
            "share": share_str,
            "trustee_name": trustee.get("name", f"Trustee #{idx}"),
            "trustee_email": trustee.get("email", ""),
        })

    return {
        "ok": True,
        "threshold": threshold,
        "num_shares": num_shares,
        "re_encrypted_files": len(decrypted),
        "shares": shares_with_meta,
    }


def _cli():
    parser = argparse.ArgumentParser(description="Change Afterward vault master password")
    parser.add_argument("--base-dir", required=True)
    args = parser.parse_args()

    try:
        config = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"bad json: {e}"}))
        sys.exit(1)

    old_pwd = config.get("old", "")
    new_pwd = config.get("new", "")
    if not old_pwd or not new_pwd:
        print(json.dumps({"error": "old and new password required"}))
        sys.exit(1)
    if len(new_pwd) < 6:
        print(json.dumps({"error": "new password must be at least 6 characters"}))
        sys.exit(1)
    if old_pwd == new_pwd:
        print(json.dumps({"error": "new password must differ from old"}))
        sys.exit(1)

    try:
        result = change_password(Path(args.base_dir), old_pwd, new_pwd)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result.get("ok") else 1)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    _cli()
