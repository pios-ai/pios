'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { useTempVault, repoRoot } = require('../helpers/fixture-vault');

// End-to-end test of the owner respondToOwner('completed') flow:
//   1. card with needs_owner:act appears in owner queue
//   2. completion comment under 4 chars is rejected
//   3. valid completion writes owner_response, clears needs_owner, snapshots
//      previous state for undo, removes card from owner queue.

test.describe('owner respondToOwner(act-complete) round-trip', () => {
  const ctx = useTempVault();
  let engine;
  let cardPath;

  test.before(() => {
    // engine reads VAULT from process.env at require time → must require AFTER useTempVault
    delete require.cache[require.resolve(path.join(repoRoot, 'backend/pios-engine'))];
    engine = require(path.join(repoRoot, 'backend/pios-engine'));

    cardPath = path.join(ctx.vault, 'Cards/active', 'owner-complete-test.md');
    fs.writeFileSync(cardPath, `---
type: task
status: active
priority: 2
created: '2026-04-17'
needs_owner: act
needs_owner_brief: "跑完 GUI 验证后回来点完成"
---
# owner complete test
`, 'utf-8');
  });

  test('card with needs_owner:act lands in owner queue with queueType=act', () => {
    const queue = engine.getOwnerQueue();
    assert.strictEqual(queue.length, 1, 'owner queue should have exactly one card');
    assert.strictEqual(queue[0].queueType, 'act');
  });

  test('completion comment under 4 chars is rejected (preserves needs_owner)', () => {
    const r = engine.respondToOwner('owner-complete-test', 'completed', {
      response_type: 'act-complete',
      comment: 'ok',
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /至少写 4 个字/);

    const after = fs.readFileSync(cardPath, 'utf-8');
    assert.match(after, /needs_owner: act/, 'card must still be in queue');
    assert.doesNotMatch(after, /owner_response:/, 'no owner_response written on rejection');
  });

  test('valid completion writes owner_response, clears needs_owner, snapshots prev for undo', () => {
    const r = engine.respondToOwner('owner-complete-test', 'completed', {
      response_type: 'act-complete',
      comment: '已经验证通过',
    });
    assert.ok(r.ok);

    const raw = fs.readFileSync(cardPath, 'utf-8');
    assert.match(raw, /owner_response: completed/);
    assert.match(raw, /备注：已经验证通过/);

    const { data: fm } = matter(raw);
    assert.strictEqual(fm.needs_owner, undefined, 'top-level needs_owner must be cleared');
    assert.strictEqual(fm.needs_owner_brief, undefined, 'top-level needs_owner_brief must be cleared');
    assert.ok(fm._owner_response_prev?.needs_owner === 'act',
      '_owner_response_prev must keep original needs_owner for undo');
  });

  test('after completion, card is removed from owner queue', () => {
    const queue = engine.getOwnerQueue();
    assert.strictEqual(queue.length, 0);
  });
});
