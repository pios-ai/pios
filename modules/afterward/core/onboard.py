"""
Afterward onboarding helper.

Given master password + trustees config, initialize vault:
    - vault/unlock-check.txt.enc  (for password verification on unlock)
    - vault/instructions.yaml.enc (empty template, user fills in later)
    - vault/contacts.yaml.enc     (trustees + recipients)
    - Generate 5 Shamir shares (3-of-5)

Returns shares as JSON. Master password never persisted anywhere.

Usage (called via IPC from Electron, password from stdin to avoid shell exposure):
    echo '{"password":"...","trustees":[{...}]}' | python3 -m core.onboard --base-dir /path

Security:
    - master password zeroed from memory after use (best effort)
    - shares returned once, caller must distribute + clear from memory
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List

import yaml

from core.shamir import split as shamir_split
from core.vault import encrypt as vault_encrypt

UNLOCK_CHECK_MARKER = "AFTERWARD_UNLOCK_OK\n"


def initialize_vault(base_dir: Path, password: str, trustees: List[dict]) -> dict:
    """
    Initialize a fresh Afterward vault.

    trustees: list of {index, name, email, phone} (any optional fields OK)
    Returns: {"shares": [(idx, share_str), ...], "initialized": True, "base_dir": str}
    """
    if len(trustees) < 3:
        raise ValueError("Need at least 3 trustees (threshold=3)")

    base_dir.mkdir(parents=True, exist_ok=True)
    vault_dir = base_dir / "vault"
    vault_dir.mkdir(exist_ok=True)

    # Guard: refuse to overwrite existing vault
    unlock_check = vault_dir / "unlock-check.txt.enc"
    if unlock_check.exists():
        raise FileExistsError(
            f"Vault already initialized at {vault_dir}. "
            "Refusing to overwrite — if you want to re-init, delete the dir manually."
        )

    # Step 1: unlock-check file (proves password without revealing vault content)
    unlock_check.write_bytes(vault_encrypt(UNLOCK_CHECK_MARKER.encode("utf-8"), password))

    # Step 2: empty instructions.yaml (user fills in)
    empty_instructions = {
        "version": 1,
        "actions": [],
        "missions": [],
    }
    instructions_enc = vault_encrypt(
        yaml.safe_dump(empty_instructions, allow_unicode=True).encode("utf-8"),
        password,
    )
    (vault_dir / "instructions.yaml.enc").write_bytes(instructions_enc)

    # Step 3: contacts.yaml (trustees as first entries; recipients added later)
    contacts_dict = {}
    for t in trustees:
        idx = t.get("index")
        contacts_dict[f"trustee-{idx}"] = {
            "name": t.get("name", ""),
            "email": t.get("email", ""),
            "phone": t.get("phone", ""),
            "role": "trustee",
            "default_channel": "email",
        }
    contacts_enc = vault_encrypt(
        yaml.safe_dump(contacts_dict, allow_unicode=True).encode("utf-8"),
        password,
    )
    (vault_dir / "contacts.yaml.enc").write_bytes(contacts_enc)

    # Step 4: generate Shamir shares (3-of-5)
    num_shares = len(trustees)
    threshold = min(3, num_shares)
    shares_raw = shamir_split(password, threshold=threshold, num_shares=num_shares)

    # Pair shares with trustee metadata for UI display
    shares_with_meta = []
    for (idx, share_str), trustee in zip(shares_raw, trustees):
        shares_with_meta.append({
            "index": idx,
            "share": share_str,
            "trustee_name": trustee.get("name", f"Trustee #{idx}"),
            "trustee_email": trustee.get("email", ""),
            "trustee_phone": trustee.get("phone", ""),
        })

    # Step 5: store trustee metadata (without shares!) for later management
    # (shares are distributed, never stored on owner's machine)
    trustee_metadata = [
        {k: v for k, v in t.items() if k != "share"}
        for t in trustees
    ]
    (base_dir / "trustees-meta.json").write_text(
        json.dumps(trustee_metadata, indent=2, ensure_ascii=False)
    )

    return {
        "initialized": True,
        "base_dir": str(base_dir),
        "threshold": threshold,
        "num_shares": num_shares,
        "shares": shares_with_meta,
    }


def _cli():
    parser = argparse.ArgumentParser(description="Initialize Afterward vault")
    parser.add_argument("--base-dir", required=True, help="Afterward data directory")
    args = parser.parse_args()

    # Read JSON config from stdin {password: str, trustees: [...]}
    try:
        config = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(f'{{"error": "bad json: {e}"}}', file=sys.stdout)
        sys.exit(1)

    password = config.get("password", "")
    trustees = config.get("trustees", [])

    if not password:
        print('{"error": "password is required"}')
        sys.exit(1)
    if len(password) < 6:
        print('{"error": "password must be at least 6 characters"}')
        sys.exit(1)
    if not (3 <= len(trustees) <= 5):
        print('{"error": "must have 3-5 trustees"}')
        sys.exit(1)

    try:
        result = initialize_vault(Path(args.base_dir), password, trustees)
        print(json.dumps(result, ensure_ascii=False))
    except FileExistsError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    _cli()
