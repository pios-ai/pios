'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { repoRoot } = require('../helpers/fixture-vault');
const yaml = require(path.join(repoRoot, 'node_modules/js-yaml'));

// Bundle source of truth for NPC clone-voice characters. A schema regression
// here silently degrades NPC voices to the default — exactly the symptom that
// triggered the 2026-04-29 voice debug session.

test.describe('bundled characters.yaml schema', () => {
  let charsMap;
  test.before(() => {
    const doc = yaml.load(fs.readFileSync(path.join(repoRoot, 'backend/plugins/core/characters.yaml'), 'utf8'));
    charsMap = doc?.characters || {};
  });

  test('every character entry has display_name + skin', () => {
    const missing = Object.entries(charsMap)
      .filter(([, c]) => !c.display_name || !c.skin)
      .map(([id]) => id);
    assert.deepStrictEqual(missing, []);
  });

  test('voice_verified=true characters always have a non-empty voice field', () => {
    const bad = Object.entries(charsMap)
      .filter(([, c]) => c.voice_verified === true && !c.voice)
      .map(([id]) => id);
    assert.deepStrictEqual(bad, []);
  });

  test('character map is non-empty (must ship at least the default character)', () => {
    assert.ok(Object.keys(charsMap).length > 0);
  });
});
