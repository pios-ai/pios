'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const installer = require(path.join(__dirname, '../..', 'backend/pios-installer'));

test.describe('pios-installer — paths + config tolerance', () => {
  test('PIOS_HOME ends with /.pios', () => {
    assert.match(installer.PIOS_HOME, /\/\.pios$/);
  });

  test('CONFIG_PATH ends with /.pios/config.json', () => {
    assert.match(installer.CONFIG_PATH, /\/\.pios\/config\.json$/);
  });

  test('isInstalled returns boolean (never throws)', () => {
    const r = installer.isInstalled();
    assert.strictEqual(typeof r, 'boolean');
  });

  test('loadConfig returns object or null (never throws on missing/malformed)', () => {
    let cfg, err;
    try { cfg = installer.loadConfig(); } catch (e) { err = e; }
    assert.ok(!err, `should not throw, got: ${err && err.message}`);
    assert.ok(cfg === null || (typeof cfg === 'object' && cfg !== null));
  });
});
