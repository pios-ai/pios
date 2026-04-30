'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useFixtureVault } = require('../helpers/fixture-vault');

test.describe('presence', () => {
  // useFixtureVault sets PIOS_TEST_PRESENCE=present so getPresence returns
  // deterministically without poking ioreg (which is flaky in CI / dev
  // sessions when the test machine has been idle).
  useFixtureVault();
  let presence;
  test.before(() => { presence = require(path.join(__dirname, '../..', 'backend/presence')); });

  test('getPresence returns one of the known statuses', () => {
    const ps = presence.getPresence();
    const status = ps && (ps.status || ps);
    assert.ok(['present', 'away', 'idle', 'unknown'].includes(status), `got: ${JSON.stringify(ps)}`);
  });
});
