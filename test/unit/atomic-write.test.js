'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeAtomic, writeJsonAtomic, appendJsonl } =
  require(path.join(__dirname, '../..', 'backend/lib/atomic-write'));

// 2026-04-28 atomic-write was extracted into a single helper used by 11 callers
// (pi-persona, session-manager, pi-speak, etc.). A regression here has wide blast.

test.describe('atomic-write', () => {
  let tmpDir;
  test.before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-aw-')); });
  test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('writeAtomic creates file with exact content + cleans up tmp', () => {
    const target = path.join(tmpDir, 'sub/dir/out.txt');
    writeAtomic(target, 'hello\nworld');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello\nworld');
    const leftover = fs.readdirSync(path.dirname(target)).filter(n => n.startsWith('.'));
    assert.strictEqual(leftover.length, 0, 'no .tmp.* files should remain');
  });

  test('writeJsonAtomic round-trips object across overwrite', () => {
    const p = path.join(tmpDir, 'data.json');
    writeJsonAtomic(p, { a: 1 });
    writeJsonAtomic(p, { a: 2, b: 'x' });
    const out = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(out, { a: 2, b: 'x' });
  });

  test('appendJsonl appends + creates the file when missing', () => {
    const p = path.join(tmpDir, 'log.jsonl');
    appendJsonl(p, { i: 1 });
    appendJsonl(p, { i: 2 });
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).i, 1);
    assert.strictEqual(JSON.parse(lines[1]).i, 2);
  });
});
