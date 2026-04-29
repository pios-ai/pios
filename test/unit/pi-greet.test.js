'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { useFixtureVault, repoRoot } = require('../helpers/fixture-vault');
const path = require('path');

test.describe('pi-greet.buildGreeting', () => {
  useFixtureVault();
  let piGreet;

  test.before(() => {
    piGreet = require(path.join(repoRoot, 'backend/pi-greet'));
  });

  // Time-decay band ladder: <10min nothing, then progressively more elaborate.
  // Lock the band shape so tweaks to mood / catchphrase don't silently flip
  // the back-from-away copy off.
  test('5min absence → no greet (band 1, below threshold)', () => {
    const g = piGreet.buildGreeting(5 * 60e3, piGreet.DEFAULT_BANDS, '有情绪不记仇');
    assert.strictEqual(g, null);
  });

  test('15min absence → light_ping string', () => {
    const g = piGreet.buildGreeting(15 * 60e3, piGreet.DEFAULT_BANDS, '有情绪不记仇');
    assert.strictEqual(typeof g, 'string');
    assert.ok(g.length > 0);
  });

  test('120min absence → back_with_ctx string', () => {
    const g = piGreet.buildGreeting(120 * 60e3, piGreet.DEFAULT_BANDS, '有情绪不记仇');
    assert.strictEqual(typeof g, 'string');
  });

  test('720min absence → morning_style string', () => {
    const g = piGreet.buildGreeting(720 * 60e3, piGreet.DEFAULT_BANDS, '有情绪不记仇');
    assert.strictEqual(typeof g, 'string');
  });

  test('48h absence → long_away string', () => {
    const g = piGreet.buildGreeting(48 * 60 * 60e3, piGreet.DEFAULT_BANDS, '有情绪不记仇');
    assert.strictEqual(typeof g, 'string');
  });

  test('zero ms doesn\'t crash (callers pass 0 on first tick)', () => {
    let r;
    assert.doesNotThrow(() => { r = piGreet.buildGreeting(0, piGreet.DEFAULT_BANDS, ''); });
    assert.ok(r === null || typeof r === 'string');
  });
});

test.describe('pi-greet.onPresenceChange', () => {
  useFixtureVault();
  let piGreet;

  test.before(() => {
    piGreet = require(path.join(repoRoot, 'backend/pi-greet'));
  });

  // First call after process start must NOT trigger a greeting — _lastPresenceStatus
  // is null then and we'd fire a stray greeting at boot otherwise.
  test('first call (lastStatus=null) does not trigger greeting', () => {
    const npcSpeakCalls = [];
    global._npcSpeak = (text) => { npcSpeakCalls.push(text); };
    const mockWin = {
      isDestroyed: () => false,
      webContents: { send: () => {} },
    };
    piGreet.onPresenceChange(mockWin);
    assert.strictEqual(npcSpeakCalls.length, 0, 'should not fire on first call');
    delete global._npcSpeak;
  });
});
