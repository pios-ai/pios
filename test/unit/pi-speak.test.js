'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useFixtureVault, snapshotStateFile } = require('../helpers/fixture-vault');

test.describe('pi-speak — P7 intent lifecycle', () => {
  useFixtureVault();
  snapshotStateFile('Pi/State/pi-speak-intents.jsonl');
  snapshotStateFile('Pi/State/pi-speak-decisions.jsonl');

  let piSpeak;
  test.before(() => { piSpeak = require(path.join(__dirname, '../..', 'backend/pi-speak')); });

  test('proposeIntent returns intent with intent- prefixed id', () => {
    const r = piSpeak.proposeIntent({ source: 'unit-test', level: 'info', text: 'hello' });
    assert.ok(r.ok);
    assert.ok(r.intent.id.startsWith('intent-'), `id=${r.intent.id}`);
  });

  test('loadPendingIntents includes a freshly proposed intent', () => {
    const r = piSpeak.proposeIntent({ source: 'unit-test', level: 'info', text: 'find me' });
    const loaded = piSpeak.loadPendingIntents();
    assert.ok(loaded.some(i => i.id === r.intent.id), 'just-proposed intent should be in pending');
  });

  test('executeDecision(action=drop) returns executed=false (no real send)', async () => {
    const r = piSpeak.proposeIntent({ source: 'unit-test', level: 'info', text: 'drop me' });
    piSpeak.writeDecision({ intent_id: r.intent.id, action: 'drop', source: 'unit-test', reason: 'test' });
    const exec = await piSpeak.executeDecision({ intent_id: r.intent.id, action: 'drop', source: 'unit-test' });
    assert.strictEqual(exec.executed, false);
  });

  test('clearConsumedIntents removes the named intent from pending', () => {
    const r = piSpeak.proposeIntent({ source: 'unit-test', level: 'info', text: 'clear me' });
    piSpeak.clearConsumedIntents([r.intent.id]);
    const after = piSpeak.loadPendingIntents();
    assert.ok(!after.find(i => i.id === r.intent.id), 'cleared intent should be gone');
  });

  test('clearConsumedIntents tolerates unknown id (no-op, no throw)', () => {
    assert.doesNotThrow(() => piSpeak.clearConsumedIntents(['intent-doesnt-exist-xyz']));
  });

  test('proposeIntent generates monotonically unique ids across rapid calls', () => {
    const id1 = piSpeak.proposeIntent({ source: 'u', level: 'info', text: 'a' }).intent.id;
    const id2 = piSpeak.proposeIntent({ source: 'u', level: 'info', text: 'b' }).intent.id;
    const id3 = piSpeak.proposeIntent({ source: 'u', level: 'info', text: 'c' }).intent.id;
    assert.notStrictEqual(id1, id2);
    assert.notStrictEqual(id2, id3);
    assert.notStrictEqual(id1, id3);
    piSpeak.clearConsumedIntents([id1, id2, id3]);
  });
});
