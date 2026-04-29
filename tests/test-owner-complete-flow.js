'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-owner-complete-'));

function ensureDir(relPath) {
  fs.mkdirSync(path.join(tmpVault, relPath), { recursive: true });
}

for (const rel of [
  'Cards/active',
  'Cards/inbox',
  'Cards/archive',
  'Pi/Agents',
  'Pi/Config/plugins',
  'Pi/Log',
  'Pi/Output',
  'Pi/State',
]) ensureDir(rel);

process.env.PIOS_VAULT = tmpVault;

const engine = require('../backend/pios-engine');

const cardPath = path.join(tmpVault, 'Cards/active', 'owner-complete-test.md');
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

const initialQueue = engine.getOwnerQueue();
assert.strictEqual(initialQueue.length, 1, 'act 卡应出现在 owner queue');
assert.strictEqual(initialQueue[0].queueType, 'act', 'queueType 应为 act');

const tooShort = engine.respondToOwner('owner-complete-test', 'completed', {
  response_type: 'act-complete',
  comment: 'ok',
});
assert.strictEqual(tooShort.ok, false, '过短完成说明应被拒绝');
assert.match(tooShort.error, /至少写 4 个字/, '应返回明确错误');

const afterReject = fs.readFileSync(cardPath, 'utf-8');
assert.match(afterReject, /needs_owner: act/, '拒绝后卡片仍应保留在 owner queue');
assert.doesNotMatch(afterReject, /owner_response:/, '拒绝后不应写入 owner_response');

const accepted = engine.respondToOwner('owner-complete-test', 'completed', {
  response_type: 'act-complete',
  comment: '已经验证通过',
});
assert.strictEqual(accepted.ok, true, '有效完成说明应提交成功');

const finalRaw = fs.readFileSync(cardPath, 'utf-8');
assert.match(finalRaw, /owner_response: completed/, '成功后应写入 owner_response');
// 顶层 needs_owner 必须被删；但 _owner_response_prev 里允许有 needs_owner 子键（undo 快照用）
const matter = require('gray-matter');
const { data: finalFm } = matter(finalRaw);
assert.strictEqual(finalFm.needs_owner, undefined, '成功后应清掉顶层 needs_owner');
assert.strictEqual(finalFm.needs_owner_brief, undefined, '成功后应清掉顶层 needs_owner_brief');
assert.ok(finalFm._owner_response_prev && finalFm._owner_response_prev.needs_owner === 'act',
  '_owner_response_prev 应保留原 needs_owner 作为 undo 快照');
assert.match(finalRaw, /备注：已经验证通过/, '成功后应保留完成说明');

const finalQueue = engine.getOwnerQueue();
assert.strictEqual(finalQueue.length, 0, '提交成功后卡片应离开 owner queue');

console.log('owner complete flow ok');
