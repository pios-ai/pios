'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useFixtureVault, STATIC_FIXTURE, snapshotStateFile } = require('../helpers/fixture-vault');

test.describe('pi-route.send', () => {
  useFixtureVault();
  let piRoute;
  test.before(() => { piRoute = require(path.join(__dirname, '../..', 'backend/pi-route')); });

  test('audience=self routes self-only (does not disturb owner)', async () => {
    const r = await piRoute.send({ text: 'self test', level: 'info', source: 't', audience: 'self' });
    assert.ok(r.ok);
    assert.strictEqual(r.routed, 'self-only');
  });

  test('audience=owner level=info presence=present routes local-present', async () => {
    const r = await piRoute.send({ text: 'owner test', level: 'info', source: 't', audience: 'owner' });
    assert.strictEqual(r.routed, 'local-present');
  });

  test('empty text does not crash (graceful)', async () => {
    let r, err;
    try { r = await piRoute.send({ text: '', level: 'info', source: 't', audience: 'self' }); }
    catch (e) { err = e; }
    assert.ok(!err, `unexpected throw: ${err && err.message}`);
    assert.ok(r);
    assert.ok(typeof r.ok === 'boolean');
  });

  test('critical level + audience=self still routes self-only (audience overrides level)', async () => {
    const r = await piRoute.send({ text: 'critical-self', level: 'critical', source: 't', audience: 'self' });
    assert.ok(r.ok);
    assert.strictEqual(r.routed, 'self-only');
  });
});

test.describe('pi-route.flushPending', () => {
  useFixtureVault();
  snapshotStateFile('Pi/State/pi-pending-messages.jsonl');
  let piRoute;
  const PENDING = path.join(STATIC_FIXTURE, 'Pi/State/pi-pending-messages.jsonl');

  test.before(() => { piRoute = require(path.join(__dirname, '../..', 'backend/pi-route')); });

  test('flushed count + queue cleared + uses safe channel (NOT pios:talk)', async () => {
    fs.writeFileSync(PENDING,
      JSON.stringify({ ts: new Date().toISOString(), text: 'msg-1', source: 't4', level: 'info' }) + '\n' +
      JSON.stringify({ ts: new Date().toISOString(), text: 'msg-2', source: 't4', level: 'info' }) + '\n'
    );

    const mainSendCalls = [];
    const npcSpeakCalls = [];
    global._npcSpeak = (text) => { npcSpeakCalls.push(text); };
    const mockWin = {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => { mainSendCalls.push([channel, payload]); } },
    };

    const r = await piRoute.flushPending(mockWin);

    assert.strictEqual(r.flushed, 2, 'should flush both pending messages');

    const after = fs.existsSync(PENDING) ? fs.readFileSync(PENDING, 'utf8').trim() : '';
    assert.strictEqual(after, '', 'queue file should be empty after flush');

    // Channel safety: pios:talk is the user-input channel — sending into it makes
    // Claude treat it as owner speech and reply (the chitchat self-conversation
    // bug). flushPending must use bubble:pulse OR _npcSpeak.
    const usedPiosTalk = mainSendCalls.some(c => c[0] === 'pios:talk');
    const usedSafeChannel = mainSendCalls.some(c => c[0] === 'bubble:pulse') || npcSpeakCalls.length > 0;
    assert.ok(!usedPiosTalk, 'must NOT use pios:talk (user-input channel — would loop into Claude as owner)');
    assert.ok(usedSafeChannel, 'must use bubble:pulse or _npcSpeak (NPC bubble channels)');

    delete global._npcSpeak;
  });
});
