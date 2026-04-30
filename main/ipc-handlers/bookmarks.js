// main/ipc-handlers/bookmarks.js — bookmarks IPC handlers
// 导出: register(ipcMain, app)

'use strict';

const path = require('path');
const fs   = require('fs');

let bookmarksFile = null;

function loadBookmarks() {
  try { return JSON.parse(fs.readFileSync(bookmarksFile, 'utf-8')); } catch { return []; }
}

function saveBookmarks(bookmarks) {
  fs.writeFileSync(bookmarksFile, JSON.stringify(bookmarks, null, 2));
}

function register(ipcMain, app) {
  bookmarksFile = path.join(app.getPath('userData'), 'bookmarks.json');

  ipcMain.handle('bookmarks:list', () => loadBookmarks());

  ipcMain.handle('bookmarks:add', (_, { title, url }) => {
    const bookmarks = loadBookmarks();
    if (!bookmarks.find(b => b.url === url)) {
      bookmarks.push({ title, url, added: new Date().toISOString() });
      saveBookmarks(bookmarks);
    }
    return bookmarks;
  });

  ipcMain.handle('bookmarks:remove', (_, url) => {
    let bookmarks = loadBookmarks();
    bookmarks = bookmarks.filter(b => b.url !== url);
    saveBookmarks(bookmarks);
    return bookmarks;
  });
}

module.exports = { register };
