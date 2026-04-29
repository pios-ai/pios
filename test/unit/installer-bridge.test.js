'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { repoRoot } = require('../helpers/fixture-vault');
const { useElectronMock, _getState } = require('../helpers/electron-mock');

// Tests for the IPC handler shell — verifies plugin activation contract:
//   * pios:plugin-activate reports a clear error when mainWindow isn't ready
//     (regression anchor for issue #3 — getMainWindow getter pattern).
//   * pios:plugin-list activated flag uses the success_marker {home}/{vault}
//     placeholder expansion.
//
// installer-bridge takes ipcMain as an argument to register(), so we don't
// need the full electron mock for the IPC machinery — but we DO need a
// userData (transitive backend/pios-installer load) and a fake ipcMain
// registry we can invoke handlers against.

function makeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: async (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for ${channel}`);
      // pass an event-like object as first arg (handlers ignore it for these channels)
      return fn({ sender: { send: () => {} } }, ...args);
    },
    handlers,
  };
}

test.describe('installer-bridge — IPC handlers', () => {
  // installer-bridge requires backend/pios-installer which uses os.homedir() —
  // it doesn't need the electron mock for that. But session-manager-style
  // require('electron') doesn't appear in installer-bridge's load path so the
  // mock isn't strictly needed; install it for safety + cleanup.
  useElectronMock();

  let ipcMain, vault, mockMainWindow, switchToChatModeCalled;
  const sentEvents = [];

  test.before(() => {
    // Create a temp vault with a stub voice plugin.yaml that uses placeholders
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-installer-bridge-'));
    const voiceDir = path.join(vault, 'Pi', 'Plugins', 'voice');
    fs.mkdirSync(voiceDir, { recursive: true });
    fs.writeFileSync(path.join(voiceDir, 'plugin.yaml'), yaml.dump({
      id: 'voice',
      name: 'NPC 语音引擎',
      description: 'test plugin',
      activation: {
        prompt: 'prompts/activate.md',
        success_marker: ['{home}/qwen-voice/bin/python3.12', '{home}/qwen-voice/app.py'],
      },
      tasks: {},
    }));
    fs.mkdirSync(path.join(voiceDir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(voiceDir, 'prompts', 'activate.md'), '# voice\n{owner}\n{vault}\n');

    // pios.yaml manifest with a known agent.task to test task-enabled fallback
    const cfgDir = path.join(vault, 'Pi', 'Config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'pios.yaml'), yaml.dump({
      agents: {},
      sense: { pipelines: {} },
    }));

    // Stub HOME = a temp dir holding ~/.pios/config.json so plugin-list /
    // plugin-activate find the vault. The handlers read $HOME/.pios/config.json
    // directly (not via PIOS_HOME), so HOME must be set such that .pios/config.json
    // resolves under it.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-bridge-home-'));
    fs.mkdirSync(path.join(fakeHome, '.pios'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.pios', 'config.json'), JSON.stringify({
      vault_root: vault, owner_name: 'TestOwner', plugins: ['voice'],
    }));
    process.env.HOME = fakeHome;

    // Reload installer-bridge against the mock (it caches js-yaml on first require)
    delete require.cache[require.resolve(path.join(repoRoot, 'main/installer-bridge'))];
    delete require.cache[require.resolve(path.join(repoRoot, 'backend/pios-installer'))];
    const bridge = require(path.join(repoRoot, 'main/installer-bridge'));

    ipcMain = makeIpcMain();
    mockMainWindow = null;            // simulate "not ready yet" for the issue #3 test
    switchToChatModeCalled = false;
    bridge.register(ipcMain, {
      mainWindow: null,
      getMainWindow: () => mockMainWindow,   // getter pattern, see issue #3
      tryCreateHomeTabs: () => {},
      switchToChatMode: () => { switchToChatModeCalled = true; },
    });
  });

  test('register() wires the canonical IPC channels', () => {
    for (const channel of ['pios:is-installed', 'pios:get-config', 'pios:install',
                            'pios:setup-done', 'pios:stick-npc',
                            'deps:check', 'deps:install',
                            'pios:plugin-list', 'pios:plugin-activate']) {
      assert.ok(ipcMain.handlers.has(channel), `channel ${channel} should be registered`);
    }
  });

  test('pios:plugin-list expands {home} placeholder in success_marker (file missing → not activated)', async () => {
    const r = await ipcMain.invoke('pios:plugin-list');
    assert.ok(r.ok);
    const voice = r.plugins.find(p => p.id === 'voice');
    assert.ok(voice, 'voice plugin should appear in list');
    // {home}/qwen-voice/bin/python3.12 expands to $HOME/qwen-voice/... which doesn't
    // exist in our stub HOME → activated should be false (and the test verifies
    // placeholder expansion didn't crash on the literal "{home}" path).
    assert.strictEqual(voice.activated, false);
    assert.strictEqual(voice.has_activation, true);
  });

  test('pios:plugin-list activated=true when success_marker files exist (placeholder resolved)', async () => {
    // Materialise the marker files at the expanded paths
    const home = process.env.HOME;
    const qvBin = path.join(home, 'qwen-voice', 'bin');
    fs.mkdirSync(qvBin, { recursive: true });
    fs.writeFileSync(path.join(qvBin, 'python3.12'), '#!/bin/sh\necho stub');
    fs.writeFileSync(path.join(home, 'qwen-voice', 'app.py'), 'print("stub")');

    const r = await ipcMain.invoke('pios:plugin-list');
    const voice = r.plugins.find(p => p.id === 'voice');
    assert.strictEqual(voice.activated, true, '{home} expansion + marker presence → activated');
  });

  test('pios:plugin-activate returns clear error when mainWindow is null (issue #3 anchor)', async () => {
    mockMainWindow = null;
    const r = await ipcMain.invoke('pios:plugin-activate', 'voice');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /主窗口未就绪|mainWindow|resolveMainWindow/, 'error should hint at the mainWindow root cause');
  });

  test('pios:plugin-activate fires plugin:start-activation with placeholder-substituted prompt when mainWindow ready', async () => {
    sentEvents.length = 0;
    mockMainWindow = {
      isDestroyed: () => false,
      show: () => {}, focus: () => {},
      webContents: { send: (channel, payload) => sentEvents.push({ channel, payload }) },
    };
    const r = await ipcMain.invoke('pios:plugin-activate', 'voice');
    assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
    const evt = sentEvents.find(e => e.channel === 'plugin:start-activation');
    assert.ok(evt, 'plugin:start-activation event should be emitted');
    // {owner} → 'TestOwner', {vault} → real vault path inside firstUserMessage
    assert.match(evt.payload.firstUserMessage, /TestOwner/);
    assert.match(evt.payload.firstUserMessage, new RegExp(vault.replace(/\//g, '\\/')));
    assert.ok(switchToChatModeCalled, 'switchToChatMode should be called to surface the activation chat');
  });
});
