'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Resolves OS hostname → canonical PiOS host id. Bug here = wrong host id in
// cron locks → silent dispatch failures across multi-machine setups.

const HOST_RESOLVE_PATH = path.join(__dirname, '../..', 'backend/lib/host-resolve');

function freshLoad() {
  delete require.cache[require.resolve(HOST_RESOLVE_PATH)];
  return require(HOST_RESOLVE_PATH);
}

test.describe('host-resolve', () => {
  let prevPiosHost;
  test.before(() => { prevPiosHost = process.env.PIOS_HOST; });
  test.after(() => {
    if (prevPiosHost === undefined) delete process.env.PIOS_HOST;
    else process.env.PIOS_HOST = prevPiosHost;
  });

  test('PIOS_HOST env override wins over hostname-based resolution', () => {
    process.env.PIOS_HOST = 'test-override-xyz';
    const { resolveHost } = freshLoad();
    assert.strictEqual(resolveHost(), 'test-override-xyz');
  });

  test('without override, returns sanitised non-empty string (never throws)', () => {
    delete process.env.PIOS_HOST;
    const { resolveHost } = freshLoad();
    const h = resolveHost();
    assert.strictEqual(typeof h, 'string');
    assert.ok(h.length > 0);
    assert.match(h, /^[a-z0-9-]+$/, 'output must be sanitised (lowercase + alnum + hyphen)');
  });
});
