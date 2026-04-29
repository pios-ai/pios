'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { repoRoot } = require('../helpers/fixture-vault');
const { useElectronMock, _getState } = require('../helpers/electron-mock');

// Proof-of-pattern: a main/ipc-handlers/* test using the electron mock.
// bookmarks.js takes (ipcMain, app) — we feed both from our mock + a fake
// ipcMain registry, then invoke handlers and assert disk + return shapes.

function makeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: async (channel, ...args) => handlers.get(channel)({ sender: { send: () => {} } }, ...args),
    handlers,
  };
}

test.describe('ipc-handlers/bookmarks', () => {
  useElectronMock();
  let ipcMain;
  let bookmarksFile;

  test.before(() => {
    delete require.cache[require.resolve(path.join(repoRoot, 'main/ipc-handlers/bookmarks'))];
    const bookmarks = require(path.join(repoRoot, 'main/ipc-handlers/bookmarks'));
    const electronMock = require('electron');   // resolved via the installed hook
    ipcMain = makeIpcMain();
    bookmarks.register(ipcMain, electronMock.app);
    bookmarksFile = path.join(_getState().userDataDir, 'bookmarks.json');
  });

  test('register wires bookmarks:list / :add / :remove', () => {
    for (const c of ['bookmarks:list', 'bookmarks:add', 'bookmarks:remove']) {
      assert.ok(ipcMain.handlers.has(c));
    }
  });

  test('list returns empty array when bookmarks.json is missing', async () => {
    const r = await ipcMain.invoke('bookmarks:list');
    assert.deepStrictEqual(r, []);
  });

  test('add persists to disk + dedupe by url', async () => {
    await ipcMain.invoke('bookmarks:add', { title: 'PiOS', url: 'https://github.com/pios-ai/pios' });
    await ipcMain.invoke('bookmarks:add', { title: 'PiOS dup', url: 'https://github.com/pios-ai/pios' });

    const r = await ipcMain.invoke('bookmarks:list');
    assert.strictEqual(r.length, 1, 'duplicate url should not add a second entry');
    assert.strictEqual(r[0].title, 'PiOS');
    assert.ok(fs.existsSync(bookmarksFile));
  });

  test('remove drops by url + survives a missing url (no throw)', async () => {
    await ipcMain.invoke('bookmarks:add', { title: 'A', url: 'https://a' });
    await ipcMain.invoke('bookmarks:add', { title: 'B', url: 'https://b' });

    const after = await ipcMain.invoke('bookmarks:remove', 'https://a');
    assert.strictEqual(after.find(b => b.url === 'https://a'), undefined);
    assert.ok(after.find(b => b.url === 'https://b'));

    // remove a url that isn't there — idempotent, returns current list
    const stillThere = await ipcMain.invoke('bookmarks:remove', 'https://nonexistent');
    assert.deepStrictEqual(stillThere, after);
  });
});
