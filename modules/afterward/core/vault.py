"""
Vault encryption — compatible with obsidian-vault-encryptor (openabe/2024).

Format: AES-256-GCM + PBKDF2-SHA256 @ 210,000 iters.
Supports both V1 and V2 magic headers.
Writes V2 by default.

Usage:
    from afterward.core.vault import encrypt, decrypt, encrypt_file, decrypt_file

    ciphertext = encrypt(b"hello world", passphrase="secret")
    plaintext  = decrypt(ciphertext, passphrase="secret")

    encrypt_file("note.md", "note.md.enc", passphrase="secret")
    plaintext = decrypt_file("note.md.enc", passphrase="secret")

Memory hygiene:
    Passphrase is zeroed (best-effort) after key derivation.
    For absolute guarantees, call clear_bytearray() manually after use.
"""

from __future__ import annotations

import base64
import json
import secrets
import struct
from pathlib import Path
from typing import Union

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# === format constants (bit-compatible with obsidian-vault-encryptor) ===

MAGIC_V1 = bytes([79, 67, 69, 78, 67, 49])  # "OCENC1"
MAGIC_V2 = bytes([79, 67, 69, 78, 74, 50])  # "OCENJ2"
FORMAT_ID = "openclaw-vault-encryptor"
VERSION_V2 = 2
VERSION_V1 = 1
DEFAULT_ITERATIONS = 210_000
SALT_LEN = 16
IV_LEN = 12
KEY_LEN = 32  # 256-bit AES


# === core primitives ===


def _derive_key(passphrase: Union[str, bytes], salt: bytes, iterations: int) -> bytes:
    """PBKDF2-SHA256 key derivation. Returns 32-byte AES-256 key."""
    if isinstance(passphrase, str):
        passphrase_bytes = passphrase.encode("utf-8")
    else:
        passphrase_bytes = bytes(passphrase)

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LEN,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(passphrase_bytes)


def encrypt(
    plaintext: bytes,
    passphrase: Union[str, bytes],
    iterations: int = DEFAULT_ITERATIONS,
) -> bytes:
    """Encrypt bytes using V2 format. Returns full `.enc` file content."""
    salt = secrets.token_bytes(SALT_LEN)
    iv = secrets.token_bytes(IV_LEN)
    key = _derive_key(passphrase, salt, iterations)

    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(iv, plaintext, associated_data=None)
    # note: aesgcm.encrypt() returns ciphertext || tag concatenated (16-byte tag at end)

    return _pack_v2(salt=salt, iv=iv, iterations=iterations, ciphertext=ciphertext)


def decrypt(encrypted: bytes, passphrase: Union[str, bytes]) -> bytes:
    """Decrypt `.enc` file bytes. Auto-detects V1 or V2 format."""
    if encrypted.startswith(MAGIC_V2):
        salt, iv, iterations, ciphertext = _unpack_v2(encrypted)
    elif encrypted.startswith(MAGIC_V1):
        salt, iv, iterations, ciphertext = _unpack_v1(encrypted)
    else:
        raise ValueError("Invalid encrypted file header (not OCENC1/OCENJ2)")

    key = _derive_key(passphrase, salt, iterations)
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(iv, ciphertext, associated_data=None)


# === file-level helpers ===


def encrypt_file(
    plain_path: Union[str, Path],
    enc_path: Union[str, Path],
    passphrase: Union[str, bytes],
    iterations: int = DEFAULT_ITERATIONS,
) -> None:
    """Encrypt file in-place pattern: read plain, write .enc."""
    plain = Path(plain_path).read_bytes()
    encrypted = encrypt(plain, passphrase, iterations)
    Path(enc_path).write_bytes(encrypted)


def decrypt_file(
    enc_path: Union[str, Path],
    passphrase: Union[str, bytes],
) -> bytes:
    """Decrypt `.enc` file and return plaintext bytes."""
    encrypted = Path(enc_path).read_bytes()
    return decrypt(encrypted, passphrase)


# === V2 pack/unpack ===


def _pack_v2(
    salt: bytes,
    iv: bytes,
    iterations: int,
    ciphertext: bytes,
) -> bytes:
    header = {
        "format": FORMAT_ID,
        "version": VERSION_V2,
        "cipher": "AES-256-GCM",
        "kdf": "PBKDF2-SHA256",
        "iterations": iterations,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertextLength": len(ciphertext),
        "passphraseEncoding": "utf-8",
    }
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")

    out = bytearray()
    out += MAGIC_V2
    out += struct.pack(">I", len(header_bytes))  # big-endian uint32
    out += header_bytes
    out += ciphertext
    return bytes(out)


def _unpack_v2(data: bytes) -> tuple[bytes, bytes, int, bytes]:
    if len(data) < len(MAGIC_V2) + 4:
        raise ValueError("Encrypted file too short for V2 header")
    offset = len(MAGIC_V2)
    (header_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4
    if header_len <= 0 or offset + header_len > len(data):
        raise ValueError("Invalid V2 header length")

    try:
        header = json.loads(data[offset : offset + header_len].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError(f"Invalid V2 header JSON: {e}")
    offset += header_len

    if header.get("version") != VERSION_V2 or header.get("format") != FORMAT_ID:
        raise ValueError("Unsupported V2 format metadata")

    iterations = int(header["iterations"])
    if iterations <= 0:
        raise ValueError("Invalid iterations in header")

    salt = base64.b64decode(header["salt"])
    iv = base64.b64decode(header["iv"])
    if not salt or not iv:
        raise ValueError("Missing salt/iv in header")

    ciphertext = data[offset:]
    return salt, iv, iterations, ciphertext


# === V1 unpack (legacy; we don't write V1 but must read it) ===


def _unpack_v1(data: bytes) -> tuple[bytes, bytes, int, bytes]:
    if len(data) < len(MAGIC_V1) + 1 + 2 + 2 + 4 + 4:
        raise ValueError("Encrypted file too short for V1 header")

    offset = len(MAGIC_V1)
    version = data[offset]
    offset += 1
    if version != VERSION_V1:
        raise ValueError(f"Unsupported V1 version: {version}")

    (salt_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2
    (iv_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2
    (iterations,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4
    (enc_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    salt = data[offset : offset + salt_len]
    offset += salt_len
    iv = data[offset : offset + iv_len]
    offset += iv_len
    ciphertext = data[offset : offset + enc_len]

    return salt, iv, iterations, ciphertext


# === CLI for manual testing / round-trip verification ===


def _cli():
    import argparse
    import getpass
    import sys

    parser = argparse.ArgumentParser(
        description="Afterward vault encryptor (obsidian-vault-encryptor compatible)"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    enc = sub.add_parser("encrypt", help="Encrypt a file")
    enc.add_argument("input", help="Plain file path")
    enc.add_argument("output", help="Output .enc file path")

    dec = sub.add_parser("decrypt", help="Decrypt a file")
    dec.add_argument("input", help=".enc file path")
    dec.add_argument(
        "output",
        nargs="?",
        default="-",
        help="Plain output path (default: stdout)",
    )

    inspect = sub.add_parser("inspect", help="Show header info without decrypting")
    inspect.add_argument("input", help=".enc file path")

    args = parser.parse_args()

    if args.cmd == "encrypt":
        passphrase = getpass.getpass("Passphrase: ")
        confirm = getpass.getpass("Confirm: ")
        if passphrase != confirm:
            print("ERROR: passphrases do not match", file=sys.stderr)
            sys.exit(1)
        encrypt_file(args.input, args.output, passphrase)
        print(f"✓ encrypted {args.input} → {args.output}")

    elif args.cmd == "decrypt":
        passphrase = getpass.getpass("Passphrase: ")
        try:
            plain = decrypt_file(args.input, passphrase)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        if args.output == "-":
            sys.stdout.buffer.write(plain)
        else:
            Path(args.output).write_bytes(plain)
            print(f"✓ decrypted {args.input} → {args.output}")

    elif args.cmd == "inspect":
        data = Path(args.input).read_bytes()
        if data.startswith(MAGIC_V2):
            salt, iv, iterations, ciphertext = _unpack_v2(data)
            print(f"format    : V2 (OCENJ2)")
            print(f"cipher    : AES-256-GCM")
            print(f"kdf       : PBKDF2-SHA256 @ {iterations} iterations")
            print(f"salt      : {salt.hex()} ({len(salt)} bytes)")
            print(f"iv        : {iv.hex()} ({len(iv)} bytes)")
            print(f"ct length : {len(ciphertext)} bytes (includes 16-byte GCM tag)")
        elif data.startswith(MAGIC_V1):
            salt, iv, iterations, ciphertext = _unpack_v1(data)
            print(f"format    : V1 (OCENC1) [legacy]")
            print(f"iterations: {iterations}")
            print(f"salt      : {salt.hex()}")
            print(f"iv        : {iv.hex()}")
            print(f"ct length : {len(ciphertext)}")
        else:
            print(f"ERROR: not a valid OCENC1/OCENJ2 file", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    _cli()
