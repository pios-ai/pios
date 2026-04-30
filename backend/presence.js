'use strict';

/**
 * presence.js — macOS Owner Presence Detection
 *
 * Reads HIDIdleTime from ioreg to determine if the owner is at the Mac.
 * Caches result for CACHE_TTL_MS to avoid blocking repeated callers.
 *
 * Usage:
 *   const presence = require('./presence');
 *   const { idle_s, status, label } = presence.getPresence();
 *
 * status: 'present' | 'away' | 'unknown'
 * label:  'Owner 在 Mac 前' | 'Owner 离开 Xm' | '未知'
 */

const { execSync } = require('child_process');

// 2026-04-23: 60s → 300s（5min）。原 60s 太激进：owner 坐着读长文 > 1min 就判 away，
// 这段时间通知会被憋 pending，回来才 flush。改 5min 后坐着读屏仍算 present，
// 通知直接 bubble + TTS。副作用：真出门但没锁屏会晚 4 分钟才察觉 → 空房间 bubble
// 响 4 分钟（小问题，可接受）。
const IDLE_THRESHOLD_S = 300;   // < 300s idle = present
const CACHE_TTL_MS     = 10_000; // cache 10s

let _cache   = null;
let _cacheTs = 0;

/**
 * Read HIDIdleTime from ioreg (nanoseconds), returns idle seconds.
 * Returns null on failure.
 */
function readIdleSeconds() {
  try {
    const out = execSync('/usr/sbin/ioreg -c IOHIDSystem -d 4 | grep HIDIdleTime', {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) return null;
    const ns = parseInt(match[1], 10);
    return Math.floor(ns / 1e9);
  } catch {
    return null;
  }
}

/**
 * Returns current presence status (cached up to 10s).
 * @returns {{ idle_s: number|null, status: 'present'|'away'|'unknown', label: string }}
 */
function getPresence() {
  // Test override: when PIOS_TEST_MODE=1 and PIOS_TEST_PRESENCE is set, skip
  // the real ioreg probe and return the requested status. Lets P6 smoke test
  // run deterministically inside pre-commit hooks without depending on
  // whether the developer is actually idle at the keyboard.
  // PIOS_TEST_PRESENCE values: 'present' | 'away' | 'unknown'
  if (process.env.PIOS_TEST_MODE === '1' && process.env.PIOS_TEST_PRESENCE) {
    const status = process.env.PIOS_TEST_PRESENCE;
    if (status === 'present') return { idle_s: 0,    status: 'present', label: 'Owner 在 Mac 前 (test)' };
    if (status === 'away')    return { idle_s: 1800, status: 'away',    label: 'Owner 离开 30m (test)' };
    if (status === 'unknown') return { idle_s: null, status: 'unknown', label: '未知 (test)' };
  }

  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  const idle_s = readIdleSeconds();
  let status, label;

  if (idle_s === null) {
    status = 'unknown';
    label  = '未知';
  } else if (idle_s < IDLE_THRESHOLD_S) {
    status = 'present';
    label  = 'Owner 在 Mac 前';
  } else {
    const mins = Math.floor(idle_s / 60);
    const hrs  = Math.floor(mins / 60);
    status = 'away';
    if (hrs > 0) {
      label = `Owner 离开 ${hrs}h${mins % 60 > 0 ? (mins % 60) + 'm' : ''}`;
    } else {
      label = `Owner 离开 ${mins}m`;
    }
  }

  _cache   = { idle_s, status, label };
  _cacheTs = now;
  return _cache;
}

module.exports = { getPresence };
