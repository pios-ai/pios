/**
 * Unit tests: getOwnerQueue owner-facing classification
 *
 * Tests the classification logic inline — no file system access, no Electron.
 * Run with: node test-owner-queue.js
 */

'use strict';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

// ── Inline classification logic (mirrors pios-engine.js getOwnerQueue) ────────
// Keep in sync with the real implementation.

function classifyCard(card) {
  const today = new Date().toISOString().slice(0, 10);
  if (card.deferred_until && String(card.deferred_until) > today) return null;

  // NEW: needs_owner protocol
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

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Owner Queue Classification Tests ===\n');

// --- NEW PROTOCOL: 4 needs_owner types ---

console.log('--- NEW: needs_owner protocol ---');

const alertCard = { title: 'P1 Alert', needs_owner: 'alert', needs_owner_brief: 'DB连接断了' };
const r1 = classifyCard(alertCard);
assert(r1?.queueType === 'alert', 'needs_owner:alert → queueType=alert');
assert(r1?.protocol === 'new', 'needs_owner:alert → protocol=new');
assert(r1?.brief === 'DB连接断了', 'needs_owner:alert → brief from needs_owner_brief');

const respondCard = { title: 'Direction Q', needs_owner: 'respond', needs_owner_brief: '选策略方向', response_type: 'pick-one' };
const r2 = classifyCard(respondCard);
assert(r2?.queueType === 'respond', 'needs_owner:respond → queueType=respond');
assert(r2?.reason === '需要回复', 'needs_owner:respond → reason=需要回复');

const actCard = { title: 'Build needed', needs_owner: 'act', needs_owner_brief: '跑 npm run build' };
const r3 = classifyCard(actCard);
assert(r3?.queueType === 'act', 'needs_owner:act → queueType=act');
assert(r3?.reason === '需要操作', 'needs_owner:act → reason=需要操作');

const checkCard = { title: 'Report ready', needs_owner: 'check', needs_owner_brief: '小红书策略报告请验收' };
const r4 = classifyCard(checkCard);
assert(r4?.queueType === 'check', 'needs_owner:check → queueType=check');
assert(r4?.reason === '需要验收', 'needs_owner:check → reason=需要验收');

// unknown needs_owner value → fallback to 'respond'
const unknownCard = { title: 'Unknown', needs_owner: 'mystery' };
const r5 = classifyCard(unknownCard);
assert(r5?.queueType === 'respond', 'needs_owner:unknown → fallback to respond');

// brief fallback to title when needs_owner_brief missing
const noBriefCard = { title: 'No brief card', needs_owner: 'respond' };
const r6 = classifyCard(noBriefCard);
assert(r6?.brief === 'No brief card', 'no needs_owner_brief → brief falls back to title');

// --- Legacy / implicit waiting states should NOT leak into owner queue ---

console.log('\n--- Legacy / implicit states stay out of owner queue ---');

const legacyDecision = { title: 'Legacy', blocked_on: 'owner-decision(选择 A 还是 B)' };
const r7 = classifyCard(legacyDecision);
assert(r7 === null, 'legacy blocked_on owner decision → not in queue');

const reviewCard = { title: 'Done Report', status: 'in_review' };
const r8 = classifyCard(reviewCard);
assert(r8 === null, 'status:in_review → not in owner queue');

const followupCard = { title: 'External followup', blocked_on: 'external-person(等对方回复)' };
const r9 = classifyCard(followupCard);
assert(r9 === null, 'external-person followup → not in owner queue');

// --- NOT in queue ---

console.log('\n--- Cards NOT in queue ---');

const normalCard = { title: 'Normal', status: 'active', blocked_on: '' };
const r10 = classifyCard(normalCard);
assert(r10 === null, 'active card with no blockers → not in queue');

const deferredCard = { title: 'Deferred', needs_owner: 'respond', deferred_until: '2099-12-31' };
const r11 = classifyCard(deferredCard);
assert(r11 === null, 'deferred card → not in queue');

// needs_owner takes priority over blocked_on legacy
const mixedCard = { title: 'Mixed', needs_owner: 'alert', blocked_on: 'owner-decision(x)' };
const r12 = classifyCard(mixedCard);
assert(r12?.queueType === 'alert', 'needs_owner takes priority over legacy fields');
assert(r12?.protocol === 'new', 'needs_owner protocol wins when both fields present');

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
