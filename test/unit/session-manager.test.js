'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useFixtureVault, repoRoot } = require('../helpers/fixture-vault');
const { useElectronMock, _getState } = require('../helpers/electron-mock');

// session-manager requires('electron') for app.getPath('userData') at load
// time. The Electron mock supplies a tmpdir for userData; useFixtureVault
// supplies the surrounding vault for backend deps (vault-root, pios-engine).
//
// This file is the proof-of-concept that main/* modules become testable
// once the mock layer is in place. Real bug class it would catch:
// "Pi-Main session never seeded" (issue #3, 2026-04-29) — the renderer
// expects a sessions.json containing a session with id='pi-main' to exist
// after first install. session-manager today has no seed. A regression test
// for the FIX would assert loadSessions() returns one entry with that id;
// the test below documents the current (buggy) contract pending that fix.

test.describe('session-manager', () => {
  useFixtureVault();
  const ctx = useElectronMock();
  let sessMgr;

  test.before(() => {
    // Bust any stale require so it loads against the freshly-installed mock.
    const sessMgrPath = path.join(repoRoot, 'main/session-manager');
    delete require.cache[require.resolve(sessMgrPath)];
    sessMgr = require(sessMgrPath);
  });

  test('module loads under electron mock + exports the expected surface', () => {
    assert.strictEqual(typeof sessMgr.loadSessions, 'function');
    assert.strictEqual(typeof sessMgr.saveSessions, 'function');
    assert.strictEqual(typeof sessMgr.findTaskRun, 'function');
    assert.strictEqual(typeof sessMgr.taskRunSessionId, 'function');
  });

  test('MAIN_SESSION_ID exported is the pi-main string the renderer expects', () => {
    // renderer/app.js hardcodes 'pi-main' for proactive context lookup; this
    // anchor catches a rename that would silently break that wiring.
    assert.strictEqual(sessMgr.MAIN_SESSION_ID, 'pi-main');
  });

  test('loadSessions on fresh userData returns empty sessions (regression anchor for issue #3)', () => {
    // userData is a fresh mkdtemp dir per useElectronMock — no sessions.json yet.
    // This documents today's buggy contract: nothing seeds pi-main, so the
    // renderer's main-session lookup fails after fresh install. When seed lands,
    // flip this assertion to: assert.ok(data.sessions.find(s => s.id === 'pi-main')).
    const data = sessMgr.loadSessions();
    assert.deepStrictEqual(data.sessions, []);
  });

  test('saveSessions persists to disk via _flushSessionsToDisk + loadSessions reads it back', async () => {
    const userData = ctx.state.userDataDir;
    const sample = {
      sessions: [
        { id: 'chat-test-1', origin: 'chat', messages: [{ role: 'user', content: 'hi' }], created: Date.now() },
      ],
      activeId: 'chat-test-1',
    };
    sessMgr.saveSessions(sample);
    await sessMgr._flushSessionsToDisk();   // synchronously force the 800ms-delayed write

    const sessFile = path.join(userData, 'sessions.json');
    assert.ok(fs.existsSync(sessFile), 'sessions.json should exist after flush');
    const onDisk = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    assert.strictEqual(onDisk.activeId, 'chat-test-1');
    assert.strictEqual(onDisk.sessions[0].id, 'chat-test-1');
  });

  test('saveSessions caps non-main chat sessions at 200 (older entries trimmed)', async () => {
    const data = { sessions: [], activeId: null };
    for (let i = 0; i < 250; i++) {
      data.sessions.push({ id: `chat-${i}`, origin: 'chat', messages: [], created: Date.now() + i });
    }
    sessMgr.saveSessions(data);
    await sessMgr._flushSessionsToDisk();

    const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.state.userDataDir, 'sessions.json'), 'utf8'));
    const chats = onDisk.sessions.filter(s => s.origin === 'chat');
    assert.ok(chats.length <= 200, `got ${chats.length} chats — must be ≤200`);
  });
});
