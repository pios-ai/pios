'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Pure formatters — no DOM, no IPC. Loaded via require() since the UMD
// wrapper detects CommonJS context.

const fmt = require(path.join(__dirname, '../../..', 'renderer/lib/format-helpers'));

test.describe('renderer/lib/format-helpers — relativeTime', () => {
  test('< 60s → "刚刚"', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    assert.strictEqual(fmt.relativeTime(new Date('2026-04-29T11:59:30Z'), now), '刚刚');
  });

  test('< 1h → "N 分钟前"', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    assert.strictEqual(fmt.relativeTime(new Date('2026-04-29T11:45:00Z'), now), '15 分钟前');
  });

  test('< 24h → "N 小时前"', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    assert.strictEqual(fmt.relativeTime(new Date('2026-04-29T08:00:00Z'), now), '4 小时前');
  });

  test('older → locale date string', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const out = fmt.relativeTime(new Date('2026-04-12T08:00:00Z'), now);
    assert.match(out, /4|Apr|月/, `expected month/date marker, got "${out}"`);
  });
});

test.describe('renderer/lib/format-helpers — fileSize', () => {
  test('bytes → "NB"', () => {
    assert.strictEqual(fmt.fileSize(0), '0B');
    assert.strictEqual(fmt.fileSize(512), '512B');
  });
  test('KB → rounded with no decimal', () => {
    assert.strictEqual(fmt.fileSize(1024), '1KB');
    assert.strictEqual(fmt.fileSize(2048), '2KB');
  });
  test('MB → 1 decimal', () => {
    assert.strictEqual(fmt.fileSize(1024 * 1024), '1.0MB');
    assert.strictEqual(fmt.fileSize(2.5 * 1024 * 1024), '2.5MB');
  });
});

test.describe('renderer/lib/format-helpers — cronSchedule', () => {
  test('empty/null → empty string', () => {
    assert.strictEqual(fmt.cronSchedule(''), '');
    assert.strictEqual(fmt.cronSchedule(null), '');
    assert.strictEqual(fmt.cronSchedule(undefined), '');
  });
  test('every-N-min form → "every Nmin"', () => {
    assert.strictEqual(fmt.cronSchedule('*/15 * * * *'), 'every 15min');
    assert.strictEqual(fmt.cronSchedule('*/5 * * * *'), 'every 5min');
  });
  test('time + every-day (*) → HH:MM', () => {
    assert.strictEqual(fmt.cronSchedule('0 9 * * *'), '9:00');
    assert.strictEqual(fmt.cronSchedule('30 14 * * *'), '14:30');
  });
  test('time + day-of-week list → "Mon/Wed/Fri HH:MM"', () => {
    assert.strictEqual(fmt.cronSchedule('0 9 * * 1,3,5'), 'Mon/Wed/Fri 9:00');
  });
});

test.describe('renderer/lib/format-helpers — inlineImageSrc', () => {
  test('empty/null pass through', () => {
    assert.strictEqual(fmt.inlineImageSrc(''), '');
    assert.strictEqual(fmt.inlineImageSrc(null), null);
  });
  test('absolute file path with image extension → file:// prefix', () => {
    assert.strictEqual(fmt.inlineImageSrc('/Users/x/photo.png'), 'file:///Users/x/photo.png');
    assert.strictEqual(fmt.inlineImageSrc('/tmp/diary/2026-04-29.jpg'), 'file:///tmp/diary/2026-04-29.jpg');
  });
  test('http(s) and data URIs pass through unchanged', () => {
    assert.strictEqual(fmt.inlineImageSrc('https://example.com/x.png'), 'https://example.com/x.png');
    assert.strictEqual(fmt.inlineImageSrc('data:image/png;base64,abc'), 'data:image/png;base64,abc');
  });
  test('non-image extension passes through', () => {
    assert.strictEqual(fmt.inlineImageSrc('/Users/x/notes.md'), '/Users/x/notes.md');
  });
});

test.describe('renderer/lib/format-helpers — parseSayBlocks', () => {
  test('no <say> tags: say="" show=text', () => {
    const r = fmt.parseSayBlocks('hello world');
    assert.strictEqual(r.say, '');
    assert.strictEqual(r.show, 'hello world');
  });
  test('single <say> block: say=inner show=text with tags removed (inner content stays)', () => {
    const r = fmt.parseSayBlocks('intro <say>spoken part</say> outro');
    assert.strictEqual(r.say, 'spoken part');
    // Tags are stripped but the inner text remains (so the bubble shows the
    // full sentence; TTS reads only the <say> portion).
    assert.match(r.show, /intro/);
    assert.match(r.show, /spoken part/);
    assert.match(r.show, /outro/);
  });
  test('multiple <say> blocks join with "，"', () => {
    const r = fmt.parseSayBlocks('<say>part one</say> middle <say>part two</say>');
    assert.strictEqual(r.say, 'part one，part two');
  });
  test('voice attribute: <say voice="x"> opening + </say> closing both stripped', () => {
    // Tags are stripped, inner content remains in `show` (also captured into `say`).
    // The bubble renderer shows `show`; TTS reads `say`. Both contain the inner text.
    const r = fmt.parseSayBlocks('<say voice="trump">special voice</say>');
    assert.strictEqual(r.say, 'special voice');
    assert.strictEqual(r.show, 'special voice');
  });
});
