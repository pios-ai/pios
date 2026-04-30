// main/ipc-handlers/browser-data.js — history / memories / privacy IPC handlers
// 导出: register(ipcMain, app, getMainWindow) — 注册全部 IPC
//       addToHistory(title, url) — createTab 的 did-finish-load 调

'use strict';

const path = require('path');
const fs   = require('fs');
const { listMemories, deleteMemory, searchMemories } = require('../../backend/browsing-memory');
const { isInvisible, addInvisible, removeInvisible, getInvisibleList, setIncognito, isIncognito } = require('../../backend/privacy-rules');

let historyFile = null;

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(historyFile, 'utf-8')); } catch { return []; }
}

function addToHistory(title, url) {
  if (!url || url === 'about:blank') return;
  const history = loadHistory();
  history.push({ title, url, visited: new Date().toISOString() });
  // 保留最近 500 条
  const trimmed = history.slice(-500);
  fs.writeFileSync(historyFile, JSON.stringify(trimmed, null, 2));
}

function register(ipcMain, app, getMainWindow) {
  historyFile = path.join(app.getPath('userData'), 'history.json');

  // 历史记录
  ipcMain.handle('history:list', () => loadHistory().slice(-100).reverse());

  ipcMain.handle('history:remove', (_, url) => {
    let h = loadHistory();
    h = h.filter(i => i.url !== url);
    fs.writeFileSync(historyFile, JSON.stringify(h, null, 2));
  });

  ipcMain.handle('history:clear', () => {
    fs.writeFileSync(historyFile, '[]');
  });

  // 浏览记忆管理
  ipcMain.handle('memories:list', () => listMemories(50));
  ipcMain.handle('memories:delete', (_, filename) => { deleteMemory(filename); });
  ipcMain.handle('memories:search', (_, query) => searchMemories(query, 5));

  // 隐私控制
  ipcMain.handle('privacy:list', () => getInvisibleList());
  ipcMain.handle('privacy:add', (_, domain) => { addInvisible(domain); });
  ipcMain.handle('privacy:remove', (_, domain) => { removeInvisible(domain); });
  ipcMain.handle('privacy:incognito', (_, enabled) => {
    if (typeof enabled === 'boolean') {
      const result = setIncognito(enabled);
      const mainWindow = getMainWindow();
      if (mainWindow) mainWindow.webContents.send('privacy:status', { invisible: result, incognito: result });
      return result;
    }
    return isIncognito();
  });
  ipcMain.handle('privacy:check', (_, url) => isInvisible(url));
}

module.exports = { register, addToHistory };
