'use strict';
//
// Fixture-vault helper for tests.
//
// Real owner runs use a vault under $HOME (path is config-driven via
// ~/.pios/config.json). Tests need hermetic state that doesn't race with a
// live PiOS daemon and doesn't leak owner content. Three strategies:
//
//   1. **Static fixture** (default): use tests/fixtures/vault/ — committed,
//      auto-bootstrapped state files. Cheap; safe for tests that mostly
//      read modules + don't write back.
//
//   2. **Per-test temp vault** (`makeTempVault()`): create a fresh
//      `mkdtemp` vault per describe-block when the test mutates state.
//      Caller restores nothing — process exit cleans /tmp.
//
//   3. **Owner vault** (live): never. Tests must NEVER target owner state.
//
// Use:
//   const { useFixtureVault, useTempVault, repoRoot } = require('./helpers/fixture-vault');
//
//   describe('pi-persona', () => {
//     useFixtureVault();           // sets PIOS_VAULT before requires
//     // tests …
//   });
//
//   describe('owner-complete-flow', () => {
//     const ctx = useTempVault();  // ctx.vault = mkdtemp dir, fresh
//     // tests can mutate freely
//   });
//
// Both call `before()` / `after()` from node:test under the hood.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { before, after } = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

const STATIC_FIXTURE = path.join(repoRoot, 'tests', 'fixtures', 'vault');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function bootstrapStateFiles(vaultRoot) {
  const stateDir = path.join(vaultRoot, 'Pi', 'State');
  ensureDir(stateDir);
  const social = path.join(stateDir, 'pi-social.json');
  const chitchat = path.join(stateDir, 'chitchat-log.json');
  if (!fs.existsSync(social)) {
    fs.writeFileSync(social, JSON.stringify({
      last_interaction_at: null,
      last_greeting_at: null,
      quiet_until: null,
      last_seen_ts_ms: Date.now(),
    }, null, 2));
  }
  if (!fs.existsSync(chitchat)) {
    fs.writeFileSync(chitchat, JSON.stringify({ entries: [] }, null, 2));
  }
}

/**
 * Wire the static fixture vault for the surrounding describe block.
 * Sets process.env.PIOS_VAULT and bootstraps the minimal state files.
 * Nothing to clean up — the fixture lives in the repo (.gitignore'd dynamic state).
 */
function useFixtureVault() {
  const prev = {};
  before(() => {
    prev.PIOS_VAULT = process.env.PIOS_VAULT;
    prev.PIOS_TEST_MODE = process.env.PIOS_TEST_MODE;
    prev.PIOS_TEST_PRESENCE = process.env.PIOS_TEST_PRESENCE;
    process.env.PIOS_VAULT = STATIC_FIXTURE;
    process.env.PIOS_TEST_MODE = '1';
    process.env.PIOS_TEST_PRESENCE = 'present';
    bootstrapStateFiles(STATIC_FIXTURE);
  });
  after(() => {
    if (prev.PIOS_VAULT === undefined) delete process.env.PIOS_VAULT;
    else process.env.PIOS_VAULT = prev.PIOS_VAULT;
    if (prev.PIOS_TEST_MODE === undefined) delete process.env.PIOS_TEST_MODE;
    else process.env.PIOS_TEST_MODE = prev.PIOS_TEST_MODE;
    if (prev.PIOS_TEST_PRESENCE === undefined) delete process.env.PIOS_TEST_PRESENCE;
    else process.env.PIOS_TEST_PRESENCE = prev.PIOS_TEST_PRESENCE;
  });
}

/**
 * Create a fresh mkdtemp vault per describe block. Returns a context object
 * whose `.vault` property is populated in `before()`. Tests can mutate freely.
 */
function useTempVault() {
  const ctx = { vault: null };
  const prev = {};
  before(() => {
    ctx.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-test-'));
    for (const rel of ['Cards/active', 'Cards/inbox', 'Cards/archive', 'Pi/Agents', 'Pi/Config/plugins', 'Pi/Log', 'Pi/Output', 'Pi/State']) {
      ensureDir(path.join(ctx.vault, rel));
    }
    bootstrapStateFiles(ctx.vault);
    prev.PIOS_VAULT = process.env.PIOS_VAULT;
    process.env.PIOS_VAULT = ctx.vault;
  });
  after(() => {
    try { fs.rmSync(ctx.vault, { recursive: true, force: true }); } catch {}
    if (prev.PIOS_VAULT === undefined) delete process.env.PIOS_VAULT;
    else process.env.PIOS_VAULT = prev.PIOS_VAULT;
  });
  return ctx;
}

/**
 * Snapshot a state file before mutation; restore in after(). Use within
 * useFixtureVault() blocks where a single test needs to write a state
 * file but the next test wants the original back.
 */
function snapshotStateFile(relPath) {
  const full = path.join(STATIC_FIXTURE, relPath);
  let orig = null;
  before(() => {
    orig = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  });
  after(() => {
    if (orig === null) {
      if (fs.existsSync(full)) try { fs.unlinkSync(full); } catch {}
    } else {
      fs.writeFileSync(full, orig);
    }
  });
}

module.exports = {
  repoRoot,
  STATIC_FIXTURE,
  useFixtureVault,
  useTempVault,
  snapshotStateFile,
};
