"""
Shamir Secret Sharing for arbitrary-length secrets (passphrases).

Wraps pycryptodome's 16-byte Shamir with automatic chunking + PKCS7 padding.

Threshold scheme: K-of-N. Default 3-of-5 (抗 2 个 trustee 失联).

Share format (per trustee):
    base64( magic(2) | trustee_idx(1) | chunk_count(1) | chunks(chunk_count * 16) | crc16(2) )

Usage:
    from afterward.core.shamir import split, combine

    # owner sets up:
    shares = split("my-vault-master-passphrase", threshold=3, num_shares=5)
    # shares = [(1, "base64..."), (2, "base64..."), ...]
    # Give each (idx, share) to one trustee

    # Later, to reconstruct:
    passphrase = combine([(1, share1), (3, share3), (5, share5)])
    # passphrase = "my-vault-master-passphrase"

Memory hygiene:
    Caller is responsible for clearing recovered secret after use.
    Shares themselves are not sensitive (any K-1 reveal nothing).
"""

from __future__ import annotations

import base64
import struct
from typing import List, Tuple, Union

from Crypto.Protocol.SecretSharing import Shamir

SHARE_MAGIC = bytes([0xAF, 0x01])  # "AF" for Afterward, 01 = schema version
CHUNK_SIZE = 16  # Shamir library only handles 16-byte secrets


# === PKCS7 padding (arbitrary length → multiple of 16) ===


def _pad(data: bytes, block_size: int = CHUNK_SIZE) -> bytes:
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len] * pad_len)


def _unpad(data: bytes) -> bytes:
    if not data:
        raise ValueError("Cannot unpad empty data")
    pad_len = data[-1]
    if pad_len == 0 or pad_len > CHUNK_SIZE:
        raise ValueError(f"Invalid padding byte: {pad_len}")
    if data[-pad_len:] != bytes([pad_len] * pad_len):
        raise ValueError("Invalid PKCS7 padding")
    return data[:-pad_len]


# === CRC16 for integrity check (detect transcription errors) ===


def _crc16(data: bytes) -> int:
    """CRC-16/CCITT-FALSE. Just for integrity check, not security."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = (crc << 1) ^ 0x1021
            else:
                crc <<= 1
            crc &= 0xFFFF
    return crc


# === split / combine ===


def split(
    secret: Union[str, bytes],
    threshold: int = 3,
    num_shares: int = 5,
) -> List[Tuple[int, str]]:
    """
    Split secret into `num_shares` shares; any `threshold` can reconstruct.

    Returns list of (trustee_index, share_string) tuples.
    trustee_index is 1..num_shares.
    share_string is base64-encoded, safe to print / QR-code / email.
    """
    if isinstance(secret, str):
        secret_bytes = secret.encode("utf-8")
    else:
        secret_bytes = bytes(secret)

    if threshold < 2 or threshold > num_shares:
        raise ValueError(f"Invalid threshold {threshold} for {num_shares} shares")
    if num_shares > 255:
        raise ValueError("num_shares must be <= 255")

    padded = _pad(secret_bytes)
    num_chunks = len(padded) // CHUNK_SIZE
    if num_chunks > 255:
        raise ValueError(f"Secret too long ({num_chunks} chunks > 255)")

    # Split each chunk; collect by trustee index
    trustee_chunks: dict[int, List[bytes]] = {i: [] for i in range(1, num_shares + 1)}
    for chunk_i in range(num_chunks):
        chunk = padded[chunk_i * CHUNK_SIZE : (chunk_i + 1) * CHUNK_SIZE]
        sub_shares = Shamir.split(threshold, num_shares, chunk)
        # sub_shares: [(idx, share_bytes), ...]
        for idx, sub in sub_shares:
            trustee_chunks[idx].append(sub)

    # Assemble each trustee's share: magic|idx|chunk_count|chunks|crc16
    result: List[Tuple[int, str]] = []
    for idx in range(1, num_shares + 1):
        chunks_concat = b"".join(trustee_chunks[idx])
        body = (
            SHARE_MAGIC
            + bytes([idx])
            + bytes([num_chunks])
            + chunks_concat
        )
        crc = _crc16(body)
        payload = body + struct.pack(">H", crc)
        share_b64 = base64.b64encode(payload).decode("ascii")
        result.append((idx, share_b64))

    return result


def combine(shares: List[Tuple[int, str]]) -> bytes:
    """
    Reconstruct secret from at least `threshold` shares.

    shares: list of (trustee_index, share_string) tuples.
    Returns the original secret as bytes (decode UTF-8 for passphrase).

    Raises ValueError on insufficient/corrupt shares.
    """
    if len(shares) < 2:
        raise ValueError("Need at least 2 shares")

    parsed: List[Tuple[int, List[bytes]]] = []
    num_chunks_seen = None

    for idx_claimed, share_str in shares:
        payload = base64.b64decode(share_str)
        if len(payload) < len(SHARE_MAGIC) + 1 + 1 + CHUNK_SIZE + 2:
            raise ValueError(f"Share for trustee {idx_claimed} too short")
        if payload[: len(SHARE_MAGIC)] != SHARE_MAGIC:
            raise ValueError(f"Share for trustee {idx_claimed}: invalid magic")

        body = payload[:-2]
        (crc_stored,) = struct.unpack(">H", payload[-2:])
        if _crc16(body) != crc_stored:
            raise ValueError(f"Share for trustee {idx_claimed}: CRC mismatch (corrupted?)")

        offset = len(SHARE_MAGIC)
        idx_actual = payload[offset]
        offset += 1
        if idx_actual != idx_claimed:
            raise ValueError(
                f"Share trustee mismatch: claimed {idx_claimed}, share says {idx_actual}"
            )

        num_chunks = payload[offset]
        offset += 1
        if num_chunks_seen is None:
            num_chunks_seen = num_chunks
        elif num_chunks != num_chunks_seen:
            raise ValueError("Shares have inconsistent chunk counts (from different secrets?)")

        chunks = []
        for chunk_i in range(num_chunks):
            chunk_start = offset + chunk_i * CHUNK_SIZE
            chunk_end = chunk_start + CHUNK_SIZE
            chunks.append(payload[chunk_start:chunk_end])

        parsed.append((idx_actual, chunks))

    # Combine per chunk
    recovered_chunks: List[bytes] = []
    for chunk_i in range(num_chunks_seen or 0):
        sub_shares = [(idx, chunks[chunk_i]) for idx, chunks in parsed]
        recovered = Shamir.combine(sub_shares)
        recovered_chunks.append(recovered)

    padded = b"".join(recovered_chunks)
    return _unpad(padded)


# === CLI for manual testing / generating real shares ===


def _cli():
    import argparse
    import getpass
    import sys

    parser = argparse.ArgumentParser(
        description="Afterward Shamir Secret Sharing (K-of-N threshold)"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("split", help="Split a secret into N shares")
    sp.add_argument("--threshold", "-k", type=int, default=3, help="Threshold (default 3)")
    sp.add_argument("--num-shares", "-n", type=int, default=5, help="Num shares (default 5)")

    cb = sub.add_parser("combine", help="Combine shares to reconstruct secret")
    cb.add_argument(
        "--share",
        "-s",
        action="append",
        required=True,
        help='Share in format "idx:base64", repeat -s for each (need at least threshold)',
    )

    args = parser.parse_args()

    if args.cmd == "split":
        secret = getpass.getpass("Secret / passphrase: ")
        confirm = getpass.getpass("Confirm: ")
        if secret != confirm:
            print("ERROR: secrets do not match", file=sys.stderr)
            sys.exit(1)

        shares = split(secret, threshold=args.threshold, num_shares=args.num_shares)
        print(f"\nGenerated {len(shares)} shares (threshold={args.threshold}):\n")
        for idx, share in shares:
            print(f"  trustee #{idx}:")
            print(f"    {share}")
            print()
        print("Give each trustee exactly ONE share. They must keep it private.")
        print(f"Any {args.threshold} trustees can reconstruct the secret.")

    elif args.cmd == "combine":
        parsed_shares = []
        for s in args.share:
            if ":" not in s:
                print(f"ERROR: share must be 'idx:base64' format", file=sys.stderr)
                sys.exit(1)
            idx_str, share_str = s.split(":", 1)
            parsed_shares.append((int(idx_str), share_str))

        try:
            secret = combine(parsed_shares)
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

        print(f"✓ reconstructed secret ({len(secret)} bytes)")
        # For safety don't print to stdout by default; write to stderr for visibility
        sys.stderr.write(secret.decode("utf-8", errors="replace") + "\n")


if __name__ == "__main__":
    _cli()
