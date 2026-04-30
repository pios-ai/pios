#!/usr/bin/env python3
"""
WeChat Message DB Key Scanner (macOS)

扫描微信进程内存，用 HMAC-SHA512 验证找到消息数据库的 AES-256 加密密钥。
基于 scan_image_key.py（图片密钥扫描器）改写。

用法: sudo python3 extract_msg_keys.py [--db-dir DIR]
  --db-dir: 加密数据库目录，默认 ~/L0_data/wechat-db

输出: msg_keys.json（同目录下）
"""

import ctypes
import ctypes.util
import hashlib
import hmac as hmac_mod
import json
import os
import struct
import subprocess
import sys
import time

# ===== SQLCipher 4 参数 =====
PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
IV_SZ = 16
HMAC_SZ = 64
RESERVE_SZ = 80  # IV(16) + HMAC(64)

# ===== macOS Mach VM API =====
libc = ctypes.CDLL(ctypes.util.find_library('c'))

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

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(SCRIPT_DIR, "msg_keys.json")

DEFAULT_DB_DIR = os.path.expanduser("~/L0_data/wechat-db")


def get_wechat_pid():
    result = subprocess.run(['pgrep', '-x', 'WeChat'], capture_output=True, text=True)
    pids = result.stdout.strip().split('\n')
    if pids and pids[0]:
        return int(pids[0])
    return None


def get_task_port(pid):
    task = mach_port_t()
    kr = libc.task_for_pid(libc.mach_task_self(), pid, ctypes.byref(task))
    if kr != 0:
        print(f"ERROR: task_for_pid failed (kr={kr}).")
        print("需要: sudo + WeChat 已 adhoc 签名")
        print("  sudo codesign --force --deep --sign - /Applications/WeChat.app")
        print("  然后重启 WeChat，再重新运行本脚本")
        sys.exit(1)
    return task


def read_memory(task, address, size):
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


def load_db_page1(db_path):
    """读取 DB 文件的 page 1，返回验证所需的数据。"""
    with open(db_path, 'rb') as f:
        page1 = f.read(PAGE_SZ)
    if len(page1) < PAGE_SZ:
        return None
    # 检查是否已经是明文 SQLite
    if page1[:15] == b'SQLite format 3':
        return None  # 不需要解密
    salt = page1[:SALT_SZ]
    hmac_data = page1[SALT_SZ: PAGE_SZ - RESERVE_SZ + IV_SZ]
    stored_hmac = page1[PAGE_SZ - HMAC_SZ: PAGE_SZ]
    return {
        'path': db_path,
        'salt': salt,
        'hmac_data': hmac_data,
        'stored_hmac': stored_hmac,
    }


def verify_key(enc_key_bytes, db_info):
    """用 HMAC-SHA512 验证密钥是否匹配。"""
    mac_salt = bytes(b ^ 0x3a for b in db_info['salt'])
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key_bytes, mac_salt, 2, dklen=KEY_SZ)
    hm = hmac_mod.new(mac_key, db_info['hmac_data'], hashlib.sha512)
    hm.update(struct.pack('<I', 1))
    return hm.digest() == db_info['stored_hmac']


def collect_db_infos(db_dir):
    """收集所有需要解密的 DB 文件的 page 1 信息。"""
    infos = []
    for root, dirs, files in os.walk(db_dir):
        for f in files:
            if f.endswith('.db') and not f.endswith(('-shm', '-wal', '-first.material', '-last.material', '-incremental.material')):
                path = os.path.join(root, f)
                info = load_db_page1(path)
                if info:
                    infos.append(info)
    return infos


def scan_for_keys(task, db_infos):
    """扫描内存寻找匹配的密钥。"""
    regions = enumerate_regions(task)
    # 只扫描合理大小的 region（跳过超大映射）
    regions = [(addr, sz) for addr, sz in regions if 4096 <= sz <= 200 * 1024 * 1024]
    total_bytes = sum(sz for _, sz in regions)
    print(f"内存区域: {len(regions)} 个，总计 {total_bytes // 1024 // 1024}MB")

    found_keys = {}  # db_path -> key_hex
    remaining_infos = list(db_infos)
    scanned = 0
    tested = 0
    t0 = time.time()

    for region_idx, (addr, sz) in enumerate(regions):
        if not remaining_infos:
            break  # 所有 DB 都找到密钥了

        mem = read_memory(task, addr, min(sz, 200 * 1024 * 1024))
        if not mem:
            continue
        scanned += len(mem)

        # 每 8 字节对齐扫描（AES key 通常在堆上对齐存储）
        for off in range(0, len(mem) - KEY_SZ + 1, 8):
            candidate = mem[off:off + KEY_SZ]

            # 快速过滤：字节多样性 < 8 的跳过（真正的密钥熵很高）
            if len(set(candidate)) < 8:
                continue

            tested += 1

            # 对每个未匹配的 DB 验证
            still_remaining = []
            for db_info in remaining_infos:
                if db_info['path'] in found_keys:
                    continue
                if verify_key(candidate, db_info):
                    rel = os.path.relpath(db_info['path'], DEFAULT_DB_DIR)
                    found_keys[db_info['path']] = candidate.hex()
                    print(f"  FOUND: {rel} -> {candidate.hex()[:16]}...")
                else:
                    still_remaining.append(db_info)
            remaining_infos = still_remaining

        if (region_idx + 1) % 100 == 0 or (time.time() - t0) > 5:
            elapsed = time.time() - t0
            pct = scanned * 100 / total_bytes if total_bytes else 0
            print(f"  进度: {pct:.0f}% ({scanned // 1024 // 1024}MB), 测试 {tested} 候选, 已找到 {len(found_keys)} 个密钥, {elapsed:.0f}s")
            t0 = time.time()

    return found_keys


def main():
    db_dir = DEFAULT_DB_DIR
    for i, arg in enumerate(sys.argv[1:]):
        if arg == '--db-dir' and i + 2 <= len(sys.argv[1:]):
            db_dir = sys.argv[i + 2]

    db_dir = os.path.expanduser(db_dir)
    if not os.path.isdir(db_dir):
        print(f"ERROR: DB 目录不存在: {db_dir}")
        sys.exit(1)

    pid = get_wechat_pid()
    if not pid:
        print("ERROR: WeChat 未运行")
        sys.exit(1)
    print(f"WeChat PID: {pid}")

    print(f"DB 目录: {db_dir}")
    db_infos = collect_db_infos(db_dir)
    print(f"需解密的 DB: {len(db_infos)} 个")

    if not db_infos:
        print("没有需要解密的 DB（可能都已是明文）")
        sys.exit(0)

    task = get_task_port(pid)
    print("开始扫描内存...")
    found_keys = scan_for_keys(task, db_infos)

    if found_keys:
        # 整理成相对路径映射
        result = {}
        unique_keys = set()
        for db_path, key_hex in found_keys.items():
            rel = os.path.relpath(db_path, db_dir)
            result[rel] = {"enc_key": key_hex}
            unique_keys.add(key_hex)

        # 保存
        with open(KEYS_FILE, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"\n保存 {len(result)} 个密钥到 {KEYS_FILE}")
        print(f"唯一密钥数: {len(unique_keys)}")
        print(f"匹配率: {len(found_keys)}/{len(db_infos)} ({len(found_keys)*100//len(db_infos)}%)")

        # 如果某些 DB 没找到密钥，用已找到的密钥尝试
        unmatched = [info for info in db_infos if info['path'] not in found_keys]
        if unmatched and unique_keys:
            print(f"\n尝试用已找到的密钥匹配剩余 {len(unmatched)} 个 DB...")
            for info in unmatched:
                for key_hex in unique_keys:
                    if verify_key(bytes.fromhex(key_hex), info):
                        rel = os.path.relpath(info['path'], db_dir)
                        result[rel] = {"enc_key": key_hex}
                        print(f"  CROSS-MATCH: {rel}")
                        break

            with open(KEYS_FILE, 'w') as f:
                json.dump(result, f, indent=2)
            print(f"最终: {len(result)} 个密钥")
    else:
        print("\n未找到任何密钥。请确认:")
        print("  1. WeChat 已登录并运行")
        print("  2. 已 adhoc 签名: sudo codesign --force --deep --sign - /Applications/WeChat.app")
        print("  3. 签名后重启了 WeChat")
        print("  4. 本脚本使用 sudo 运行")
        sys.exit(1)


if __name__ == '__main__':
    main()
