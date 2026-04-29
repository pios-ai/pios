'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useFixtureVault, STATIC_FIXTURE, snapshotStateFile } = require('../helpers/fixture-vault');

const SOCIAL = path.join(STATIC_FIXTURE, 'Pi/State/pi-social.json');
const MOOD = path.join(STATIC_FIXTURE, 'Pi/State/pi-mood.json');
const CHITCHAT_LOG = path.join(STATIC_FIXTURE, 'Pi/State/chitchat-log.json');
const INTENTS = path.join(STATIC_FIXTURE, 'Pi/State/pi-speak-intents.jsonl');

function captureLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); orig(...args); };
  try { fn(); } finally { console.log = orig; }
  return logs;
}

function setSocial(extra) {
  const base = JSON.parse(fs.readFileSync(SOCIAL, 'utf8'));
  fs.writeFileSync(SOCIAL, JSON.stringify({ ...base, ...extra }, null, 2));
}

test.describe('pi-chitchat.maybeChat — gates', () => {
  useFixtureVault();
  snapshotStateFile('Pi/State/pi-social.json');
  snapshotStateFile('Pi/State/pi-mood.json');
  snapshotStateFile('Pi/State/chitchat-log.json');
  snapshotStateFile('Pi/State/pi-speak-intents.jsonl');

  let piChitchat;
  test.before(() => {
    piChitchat = require(path.join(__dirname, '../..', 'backend/pi-chitchat'));
    // Force high energy so energy gate doesn't pre-empt the gate under test.
    fs.writeFileSync(MOOD, JSON.stringify({ energy: 0.9 }, null, 2));
    fs.writeFileSync(CHITCHAT_LOG, JSON.stringify({ entries: [] }, null, 2));
  });

  const mockWin = { isDestroyed: () => false, webContents: { send: () => {} } };

  test('quiet_until in future → skip with quiet_until reason', () => {
    setSocial({ quiet_until: new Date(Date.now() + 3600e3).toISOString() });
    const logs = captureLogs(() => piChitchat.maybeChat(mockWin, STATIC_FIXTURE));
    assert.ok(logs.some(l => l.includes('quiet_until')), 'expected quiet_until skip log');
  });

  test('last_interaction_at within 2h → skip', () => {
    setSocial({ quiet_until: null, last_interaction_at: new Date(Date.now() - 30 * 60e3).toISOString() });
    const logs = captureLogs(() => piChitchat.maybeChat(mockWin, STATIC_FIXTURE));
    assert.ok(logs.some(l => l.includes('owner interacted')), 'expected interaction-cooldown skip log');
  });

  test('last_greeting_at within 30min → skip', () => {
    setSocial({ quiet_until: null, last_interaction_at: null, last_greeting_at: new Date(Date.now() - 10 * 60e3).toISOString() });
    const logs = captureLogs(() => piChitchat.maybeChat(mockWin, STATIC_FIXTURE));
    assert.ok(logs.some(l => l.includes('greeted')), 'expected greeted-cooldown skip log');
  });

  test('all gates open → proposes intent (P7), does NOT call _npcSpeak directly', () => {
    setSocial({ quiet_until: null, last_interaction_at: null, last_greeting_at: null });
    fs.writeFileSync(CHITCHAT_LOG, JSON.stringify({ entries: [] }, null, 2));
    if (fs.existsSync(INTENTS)) fs.writeFileSync(INTENTS, '');

    const npcSpeakCalls = [];
    global._npcSpeak = (text) => { npcSpeakCalls.push(text); };
    const mainSendCalls = [];
    const win = { isDestroyed: () => false, webContents: { send: (c, p) => mainSendCalls.push([c, p]) } };

    captureLogs(() => piChitchat.maybeChat(win, STATIC_FIXTURE));

    const usedPiosTalk = mainSendCalls.some(c => c[0] === 'pios:talk');
    assert.ok(!usedPiosTalk, 'must NOT use pios:talk (would loop into Claude)');
    assert.strictEqual(npcSpeakCalls.length, 0, 'P7: must propose intent, NOT _npcSpeak directly');

    const intentsRaw = fs.existsSync(INTENTS) ? fs.readFileSync(INTENTS, 'utf8') : '';
    const proposed = intentsRaw.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(i => i && i.source === 'chitchat');
    assert.ok(proposed.length > 0, 'expected at least one chitchat intent proposed');

    delete global._npcSpeak;
  });
});
