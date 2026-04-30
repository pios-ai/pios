'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useFixtureVault, STATIC_FIXTURE, snapshotStateFile } = require('../helpers/fixture-vault');

const CHAR_STATE = path.join(STATIC_FIXTURE, 'Pi/State/pi-character.json');
const LEGACY_NPC = path.join(STATIC_FIXTURE, 'Pi/State/pi-npc.json');

// 2026-04-29 voice issue: "user picks 特朗普 but hears 小豆温柔" was traced to
// getCurrentVoice() returning null when characters.yaml's voice field was
// missing AND state file pointed at a fallback character. These guard the
// fallback chain end-to-end.

test.describe('pi-persona', () => {
  useFixtureVault();
  snapshotStateFile('Pi/State/pi-character.json');
  snapshotStateFile('Pi/State/pi-npc.json');

  let piPersona;
  test.before(() => { piPersona = require(path.join(__dirname, '../..', 'backend/pi-persona')); });

  test('loadCharacters returns map with canonical bundle entries', () => {
    const chars = piPersona.loadCharacters();
    for (const id of ['patrick', 'doraemon', 'trump', 'starlet']) {
      assert.ok(chars[id], `missing canonical character: ${id}`);
    }
    assert.ok(Object.keys(chars).length >= 5);
  });

  test('getCurrentCharacter falls back to DEFAULT when both state files absent', () => {
    if (fs.existsSync(CHAR_STATE)) try { fs.unlinkSync(CHAR_STATE); } catch {}
    if (fs.existsSync(LEGACY_NPC)) try { fs.unlinkSync(LEGACY_NPC); } catch {}
    const c = piPersona.getCurrentCharacter();
    assert.strictEqual(c.id, piPersona.DEFAULT_CHARACTER_ID);
    assert.ok(c.display_name);
  });

  test('setCharacter writes pi-character.json atomically + getCurrentCharacter reflects it', () => {
    piPersona.setCharacter('trump');
    assert.strictEqual(piPersona.getCurrentCharacter().id, 'trump');
    const persisted = JSON.parse(fs.readFileSync(CHAR_STATE, 'utf8'));
    assert.strictEqual(persisted.current, 'trump');
  });

  test('getCurrentVoice returns yaml voice field for current character', () => {
    piPersona.setCharacter('trump');
    // bundle characters.yaml has trump.voice: 特朗普 (verified=false but voice still set)
    assert.strictEqual(piPersona.getCurrentVoice(), '特朗普');
  });

  test('setCharacter throws on unknown id (no silent state corruption)', () => {
    assert.throws(() => piPersona.setCharacter('nonexistent-char-id-xyz'));
  });
});
