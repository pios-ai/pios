'use strict';

const test = require('node:test');
const assert = require('node:assert');

// getOwnerQueue classification logic — this is a *mirror* of the inline
// classifier in pios-engine.js. Kept inline so this test runs without an
// Electron context. If you change pios-engine.js's classifier, update both.

function classifyCard(card) {
  const today = new Date().toISOString().slice(0, 10);
  if (card.deferred_until && String(card.deferred_until) > today) return null;
  if (card.needs_owner) {
    const valid = ['alert', 'respond', 'act', 'check'];
    const queueType = valid.includes(card.needs_owner) ? card.needs_owner : 'respond';
    const reasonMap = { alert: '系统告警', respond: '需要回复', act: '需要操作', check: '需要验收' };
    return {
      queueType,
      reason: reasonMap[queueType],
      brief: card.needs_owner_brief || card.title,
      protocol: 'new',
    };
  }
  return null;
}

test.describe('owner-queue classifier — needs_owner protocol', () => {
  test('needs_owner=alert → queueType=alert + reason=系统告警', () => {
    const r = classifyCard({ title: 'P1 Alert', needs_owner: 'alert', needs_owner_brief: 'DB连接断了' });
    assert.strictEqual(r.queueType, 'alert');
    assert.strictEqual(r.reason, '系统告警');
    assert.strictEqual(r.brief, 'DB连接断了');
    assert.strictEqual(r.protocol, 'new');
  });

  test('needs_owner=respond → queueType=respond + reason=需要回复', () => {
    const r = classifyCard({ title: 'Direction Q', needs_owner: 'respond', needs_owner_brief: '选策略方向' });
    assert.strictEqual(r.queueType, 'respond');
    assert.strictEqual(r.reason, '需要回复');
  });

  test('needs_owner=act → queueType=act + reason=需要操作', () => {
    const r = classifyCard({ title: 'Build', needs_owner: 'act', needs_owner_brief: '跑 npm run build' });
    assert.strictEqual(r.queueType, 'act');
    assert.strictEqual(r.reason, '需要操作');
  });

  test('needs_owner=check → queueType=check + reason=需要验收', () => {
    const r = classifyCard({ title: 'Report', needs_owner: 'check', needs_owner_brief: '验收' });
    assert.strictEqual(r.queueType, 'check');
    assert.strictEqual(r.reason, '需要验收');
  });

  test('unknown needs_owner value falls back to respond', () => {
    const r = classifyCard({ title: 'Unknown', needs_owner: 'mystery-value' });
    assert.strictEqual(r.queueType, 'respond');
  });

  test('missing needs_owner_brief → brief falls back to title', () => {
    const r = classifyCard({ title: 'No brief card', needs_owner: 'respond' });
    assert.strictEqual(r.brief, 'No brief card');
  });

  test('needs_owner takes priority when legacy blocked_on also present', () => {
    const r = classifyCard({ title: 'Mixed', needs_owner: 'alert', blocked_on: 'owner-decision(x)' });
    assert.strictEqual(r.queueType, 'alert');
    assert.strictEqual(r.protocol, 'new');
  });
});

test.describe('owner-queue classifier — exclusion rules', () => {
  test('legacy blocked_on owner-decision (no needs_owner) → null (not in queue)', () => {
    const r = classifyCard({ title: 'Legacy', blocked_on: 'owner-decision(选择 A 还是 B)' });
    assert.strictEqual(r, null);
  });

  test('status=in_review (no needs_owner) → null', () => {
    const r = classifyCard({ title: 'Done Report', status: 'in_review' });
    assert.strictEqual(r, null);
  });

  test('blocked_on external-person → null (waiting on outside party, not owner)', () => {
    const r = classifyCard({ title: 'External', blocked_on: 'external-person(等对方回复)' });
    assert.strictEqual(r, null);
  });

  test('plain active card with no blockers → null', () => {
    const r = classifyCard({ title: 'Normal', status: 'active', blocked_on: '' });
    assert.strictEqual(r, null);
  });

  test('deferred card with future deferred_until → null even if needs_owner is set', () => {
    const r = classifyCard({ title: 'Deferred', needs_owner: 'respond', deferred_until: '2099-12-31' });
    assert.strictEqual(r, null);
  });
});
