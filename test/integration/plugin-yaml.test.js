'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { repoRoot } = require('../helpers/fixture-vault');
const yaml = require(path.join(repoRoot, 'node_modules/js-yaml'));

const PLUGINS_DIR = path.join(repoRoot, 'backend/plugins');

// 2026-04-29 voice issue: success_marker hardcoded /Users/<owner>/qwen-voice/...
// failed for any non-owner install. These guards lock the placeholder shape
// + every bundled plugin.yaml stays valid YAML across edits.

test.describe('bundled plugin.yaml schema', () => {
  test('voice plugin.yaml: id=voice + non-empty success_marker[]', () => {
    const doc = yaml.load(fs.readFileSync(path.join(PLUGINS_DIR, 'voice/plugin.yaml'), 'utf8'));
    assert.strictEqual(doc.id, 'voice');
    assert.ok(Array.isArray(doc.activation?.success_marker));
    assert.ok(doc.activation.success_marker.length > 0);
  });

  test('voice success_marker uses {home}/{vault}/{pios_home} placeholder, never hardcoded /Users/<owner>/', () => {
    const doc = yaml.load(fs.readFileSync(path.join(PLUGINS_DIR, 'voice/plugin.yaml'), 'utf8'));
    const markers = doc.activation.success_marker.join(' ');
    const hasPlaceholder = ['{home}', '{vault}', '{pios_home}'].some(p => markers.includes(p));
    const hardcodedHome = /\/Users\/[a-z][a-z0-9_-]+\//i.test(markers);
    assert.ok(hasPlaceholder, 'must use {home}/{vault}/{pios_home} placeholder');
    assert.ok(!hardcodedHome, `must not hardcode /Users/<owner>/ — got: ${markers}`);
  });

  test('every bundled plugin.yaml parses and declares an id (regression guard)', () => {
    const ids = fs.readdirSync(PLUGINS_DIR).filter(d => {
      const yamlPath = path.join(PLUGINS_DIR, d, 'plugin.yaml');
      return fs.statSync(path.join(PLUGINS_DIR, d)).isDirectory() && fs.existsSync(yamlPath);
    });
    assert.ok(ids.length > 0, 'expected at least one bundled plugin');
    const failures = [];
    for (const id of ids) {
      try {
        const doc = yaml.load(fs.readFileSync(path.join(PLUGINS_DIR, id, 'plugin.yaml'), 'utf8'));
        if (!doc?.id) failures.push(`${id}: missing 'id' field`);
      } catch (e) { failures.push(`${id}: ${e.message}`); }
    }
    assert.deepStrictEqual(failures, []);
  });
});
