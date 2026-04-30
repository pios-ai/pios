'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const voiceFilter = require(path.join(__dirname, '../..', 'backend/voice-filter'));

// Every NPC bubble pulls through getPreset(). Silent fallback bug = wrong
// voice for a character (the today's-bug class).

test.describe('voice-filter', () => {
  test('listPresets contains the 6 canonical presets', () => {
    const presets = voiceFilter.listPresets();
    for (const expected of ['default', 'warm', 'fun', 'eric', 'cloned', 'npc']) {
      assert.ok(presets.includes(expected), `missing preset: ${expected}`);
    }
  });

  test('getPreset(default) returns object with ttsVoice + ttsInstruct + filter strings', () => {
    const p = voiceFilter.getPreset('default');
    assert.strictEqual(typeof p.ttsVoice, 'string');
    assert.strictEqual(typeof p.ttsInstruct, 'string');
    assert.strictEqual(typeof p.filter, 'string');
    assert.ok(p.filter.length > 0);
  });

  test('getPreset(unknown name) falls back gracefully (no throw)', () => {
    let p, err;
    try { p = voiceFilter.getPreset('totally-bogus-preset-name'); } catch (e) { err = e; }
    assert.ok(!err, 'unknown preset must not throw');
    assert.ok(p && typeof p.filter === 'string');
  });

  test('listMagneticLevels exposes the 4 canonical NPC levels', () => {
    const levels = voiceFilter.listMagneticLevels();
    for (const level of ['raw', 'soft', 'mid', 'strong']) {
      assert.ok(levels.includes(level), `missing magnetic level: ${level}`);
    }
  });
});
