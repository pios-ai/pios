'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useFixtureVault } = require('../helpers/fixture-vault');

// vault-context is required by nearly every backend module. A silent failure
// here cascades into broken system-prompt building.

test.describe('vault-context', () => {
  useFixtureVault();
  let vaultCtx;
  test.before(() => { vaultCtx = require(path.join(__dirname, '../..', 'backend/vault-context')); });

  test('VAULT_PATH is non-empty and exists on disk', () => {
    assert.strictEqual(typeof vaultCtx.VAULT_PATH, 'string');
    assert.ok(vaultCtx.VAULT_PATH.length > 0);
    assert.ok(fs.existsSync(vaultCtx.VAULT_PATH));
  });

  test('getOwnerName returns a non-empty string (config-driven, never throws)', () => {
    const name = vaultCtx.getOwnerName();
    assert.strictEqual(typeof name, 'string');
    assert.ok(name.length > 0);
  });

  test('readFile returns "" or null for missing path (graceful, no throw)', () => {
    let r, err;
    try { r = vaultCtx.readFile('Pi/Config/nonexistent-test-file.md'); }
    catch (e) { err = e; }
    assert.ok(!err, 'should not throw on missing file');
    assert.ok(r === '' || r === null, `expected "" or null, got: ${JSON.stringify(r)?.slice(0,80)}`);
  });
});
