#!/usr/bin/env python3
"""
WeChat V2 Image AES Key Scanner (macOS)

扫描微信进程内存，用严格的图片 header 验证找到真正的 AES-128 key。
比 find_image_key 二进制更可靠 — 验证 8+ 字节而非 3 字节。

用法: sudo python3 scan_image_key.py [dat_file]
  dat_file: 可选，指定一个 .dat 文件用于验证。不指定则自动找最新的。

需要: pip install pycryptodome
需要: sudo 权限（读取进程内存）
"""

import ctypes
import ctypes.util
import struct
import sys
import os
import glob
import json

from Crypto.Cipher import AES

# macOS Mach VM API
libc = ctypes.CDLL(ctypes.util.find_library('c'))

# mach_vm_read_overwrite
kern_return_t = ctypes.c_int
mach_port_t = ctypes.c_uint
mach_vm_address_t = ctypes.c_uint64
mach_vm_size_t = ctypes.c_uint64
vm_prot_t = ctypes.c_int
natural_t = ctypes.c_uint

class vm_region_basic_info_64(ctypes.Structure):
    _fields_ = [
        ('protection', vm_prot_t),
        ('max_protection', vm_prot_t),
        ('inheritance', ctypes.c_uint),
        ('shared', ctypes.c_uint),
        ('reserved', ctypes.c_uint),
        ('offset', ctypes.c_uint64),
        ('behavior', ctypes.c_int),
        ('user_wired_count', ctypes.c_ushort),
    ]

VM_REGION_BASIC_INFO_64 = 9
VM_REGION_BASIC_INFO_COUNT_64 = ctypes.sizeof(vm_region_basic_info_64) // ctypes.sizeof(natural_t)
VM_PROT_READ = 1

WECHAT_ATTACH = os.path.expanduser(
    "~/Library/Containers/com.tencent.xinWeChat/Data/Documents/"
    "xwechat_files/{YOUR_WXID}_XXXX/msg/attach"
)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(SCRIPT_DIR, "image_keys.json")

V2_MAGIC = b'\x07\x08V2\x08\x07'


def get_wechat_pid():
    """Find WeChat main process PID."""
    import subprocess
    result = subprocess.run(['pgrep', '-x', 'WeChat'], capture_output=True, text=True)
    pids = result.stdout.strip().split('\n')
    if pids and pids[0]:
        return int(pids[0])
    return None


def get_task_port(pid):
    """Get Mach task port for a process."""
    task = mach_port_t()
    kr = libc.task_for_pid(libc.mach_task_self(), pid, ctypes.byref(task))
    if kr != 0:
        print(f"ERROR: task_for_pid failed (kr={kr}). Need sudo + SIP disabled or re-signed WeChat.")
        sys.exit(1)
    return task


def read_memory(task, address, size):
    """Read process memory using mach_vm_read_overwrite."""
    buf = (ctypes.c_char * size)()
    out_size = mach_vm_size_t(0)
    kr = libc.mach_vm_read_overwrite(
        task, mach_vm_address_t(address), mach_vm_size_t(size),
        mach_vm_address_t(ctypes.addressof(buf)), ctypes.byref(out_size)
    )
    if kr != 0:
        return None
    return bytes(buf[:out_size.value])


def enumerate_regions(task):
    """Enumerate readable memory regions."""
    address = mach_vm_address_t(0)
    size = mach_vm_size_t(0)
    info = vm_region_basic_info_64()
    info_count = natural_t(VM_REGION_BASIC_INFO_COUNT_64)
    object_name = mach_port_t(0)

    regions = []
    while True:
        kr = libc.mach_vm_region(
            task, ctypes.byref(address), ctypes.byref(size),
            VM_REGION_BASIC_INFO_64, ctypes.byref(info),
            ctypes.byref(info_count), ctypes.byref(object_name)
        )
        if kr != 0:
            break
        if info.protection & VM_PROT_READ:
            regions.append((address.value, size.value))
        address.value += size.value
        info_count.value = VM_REGION_BASIC_INFO_COUNT_64

    return regions


def find_test_file(dat_path=None):
    """Find a V2 .dat file for key validation."""
    if dat_path and os.path.exists(dat_path):
        return dat_path
    # Auto-find newest full-size V2 dat
    dats = glob.glob(os.path.join(WECHAT_ATTACH, "**/Img/*.dat"), recursive=True)
    dats = [f for f in dats if not f.endswith('_t.dat') and not f.endswith('_h.dat')]
    for f in sorted(dats, key=os.path.getmtime, reverse=True):
        with open(f, 'rb') as fh:
            if fh.read(6) == V2_MAGIC:
                return f
    return None


def validate_jpeg_strict(data):
    """Strict JPEG header validation — checks marker structure, not just magic bytes."""
    if len(data) < 12:
        return False
    if data[0] != 0xFF or data[1] != 0xD8 or data[2] != 0xFF:
        return False
    marker = data[3]
    # Valid APP/SOF/DQT/DHT markers
    if marker not in (0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7,
                      0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEE, 0xEF,
                      0xDB, 0xC0, 0xC2, 0xC4, 0xFE):
        return False
    # Check marker segment length (must be reasonable)
    seg_len = struct.unpack('>H', data[4:6])[0]
    if seg_len < 2 or seg_len > 65535:
        return False
    # Extra checks for known markers
    if marker == 0xE0:  # JFIF
        return seg_len >= 14 and data[6:11] == b'JFIF\x00'
    if marker == 0xE1:  # EXIF
        return seg_len >= 8 and data[6:12] in (b'Exif\x00\x00', b'Exif\x00\x01')
    if marker == 0xDB:  # DQT — must be 67 (one table) or 132 (two tables)
        return seg_len in (0x43, 0x84)
    # For other markers, length check is sufficient
    return True


def validate_png_strict(data):
    """Strict PNG header validation."""
    return len(data) >= 16 and data[:8] == b'\x89PNG\r\n\x1a\n'


def validate_webp_strict(data):
    """Strict WebP header validation."""
    return len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP'


def validate_image(data):
    """Validate decrypted data as a real image. Returns format or None."""
    if validate_jpeg_strict(data):
        return 'jpg'
    if validate_png_strict(data):
        return 'png'
    if validate_webp_strict(data):
        return 'webp'
    if data[:3] == b'GIF' and data[3:6] in (b'89a', b'87a'):
        return 'gif'
    return None


def scan_for_key(task, test_dat_path, max_regions=0):
    """Scan memory for the AES key using a known V2 dat file."""
    with open(test_dat_path, 'rb') as f:
        data = f.read()

    if data[:6] != V2_MAGIC:
        print(f"ERROR: {test_dat_path} is not V2 format")
        return None

    aes_size, xor_size = struct.unpack_from('<LL', data, 6)
    remainder = aes_size % 16
    aligned = aes_size + (16 - remainder) if remainder else aes_size + 16
    ct_block = data[15:15 + aligned]
    first_ct = ct_block[:16]

    print(f"Test file: {os.path.basename(test_dat_path)}")
    print(f"AES size: {aes_size}, XOR size: {xor_size}, aligned: {aligned}")
    print(f"First ciphertext block: {first_ct.hex()}")

    regions = enumerate_regions(task)
    print(f"Found {len(regions)} readable memory regions")

    # Filter to reasonable-sized regions (skip huge mappings)
    regions = [(addr, sz) for addr, sz in regions if 4096 <= sz <= 100 * 1024 * 1024]
    print(f"Scanning {len(regions)} regions (4KB-100MB)...")

    total_bytes = sum(sz for _, sz in regions)
    scanned = 0
    candidates = 0
    found_key = None

    for region_idx, (addr, sz) in enumerate(regions):
        mem = read_memory(task, addr, min(sz, 100 * 1024 * 1024))
        if not mem:
            continue
        scanned += len(mem)

        # Scan EVERY byte offset (not just 16-byte aligned)
        for off in range(0, len(mem) - 15):
            key_candidate = mem[off:off + 16]
            # Skip all-zero or all-same-byte keys
            if len(set(key_candidate)) <= 2:
                continue

            try:
                cipher = AES.new(key_candidate, AES.MODE_ECB)
                pt_first = cipher.decrypt(first_ct)

                # Quick reject: first 3 bytes must be image magic
                if not (pt_first[:3] == b'\xFF\xD8\xFF' or
                        pt_first[:4] == b'\x89PNG' or
                        pt_first[:4] == b'RIFF' or
                        pt_first[:3] == b'GIF'):
                    continue

                candidates += 1

                # Decrypt more blocks for thorough validation
                blocks_to_decrypt = min(256, len(ct_block))  # up to 4KB
                blocks_to_decrypt = (blocks_to_decrypt // 16) * 16
                pt_full = cipher.decrypt(ct_block[:blocks_to_decrypt])
                fmt = validate_image(pt_full)

                if fmt:
                    print(f"\n*** FOUND VALID KEY ***")
                    print(f"  Key: {key_candidate.hex()}")
                    print(f"  Format: {fmt}")
                    print(f"  Region: 0x{addr:x} + 0x{off:x} ({'aligned' if off % 16 == 0 else 'UNALIGNED'})")
                    print(f"  First 32 bytes decrypted: {pt_full[:32].hex()}")
                    found_key = key_candidate
                    # Don't stop — keep scanning to find all matches
                else:
                    if candidates <= 20:
                        print(f"  weak candidate #{candidates} at 0x{addr+off:x}: {pt_first[:8].hex()} (rejected)")

            except Exception:
                continue

        if (region_idx + 1) % 50 == 0:
            pct = scanned * 100 / total_bytes if total_bytes else 0
            print(f"  Progress: {region_idx+1}/{len(regions)} regions, {scanned//1024//1024}MB scanned, {candidates} weak, {pct:.0f}%")

    print(f"\nScan complete: {scanned//1024//1024}MB scanned, {candidates} candidates tested")
    return found_key


def save_key(key_bytes, test_dat_path):
    """Save the found key to image_keys.json, mapped to the test file's ciphertext pattern."""
    with open(test_dat_path, 'rb') as f:
        data = f.read()
    pattern = data[15:31].hex()

    keys = {}
    if os.path.exists(KEYS_FILE):
        with open(KEYS_FILE) as f:
            keys = json.load(f)

    keys[pattern] = key_bytes.hex()
    with open(KEYS_FILE, 'w') as f:
        json.dump(keys, f, indent=4)
    print(f"Saved key to {KEYS_FILE}: {pattern} -> {key_bytes.hex()}")


def main():
    dat_path = sys.argv[1] if len(sys.argv) > 1 else None

    pid = get_wechat_pid()
    if not pid:
        print("ERROR: WeChat is not running")
        sys.exit(1)
    print(f"WeChat PID: {pid}")

    test_file = find_test_file(dat_path)
    if not test_file:
        print("ERROR: No V2 .dat file found for testing")
        sys.exit(1)

    task = get_task_port(pid)
    key = scan_for_key(task, test_file)

    if key:
        save_key(key, test_file)
        print(f"\nKey found! Now run:")
        print(f"  python3 decrypt_wechat_image.py --all ~/Desktop/wechat-images/")
    else:
        print("\nNo valid key found. Try:")
        print("  1. Open WeChat and view some images first (loads key into memory)")
        print("  2. Re-run this script immediately")
        print("  3. Ensure SIP is disabled or WeChat is re-signed")


if __name__ == '__main__':
    main()
