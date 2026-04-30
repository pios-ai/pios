// tab-manager 的 IPC handler 集合（提取自 tab-manager.js 的 registerIpc 函数体）
// 通过 ctx 接收 state + 函数 + 工具函数，跟主 create() factory 解耦。

const { Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function register(ipcMain, ctx) {
  const {
    state,
    VAULT_ROOT,
    // pure utility
    completeURL,
    isInvisible,
    extractFileContent,
    processFilePathsAsync,
    // tab-manager functions
    createTab, switchToTab, closeTab, switchToChatMode,
    sendTabsUpdate, layoutActiveTab, forceRelayout,
    autoExtractPageContext, saveTabs, loadSavedTabs,
  } = ctx;

  let _savedActiveTabIdForModal = null;

  // 每 60 秒自动保存 tab 状态，防止异常退出丢数据
  setInterval(() => { saveTabs(); }, 60000);

  ipcMain.handle('pi:getPageContent', async () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !tab.view) return null;
    try {
      const url = tab.view.webContents.getURL();
      if (isInvisible(url)) return { title: '', url, text: '', invisible: true };
      const text = await tab.view.webContents.executeJavaScript(
        `document.body.innerText.substring(0, 8000)`
      );
      const title = await tab.view.webContents.executeJavaScript(`document.title`);
      return { title, url, text };
    } catch {
      return null;
    }
  });

  ipcMain.on('browser:navigate', (_, url) => {
    url = completeURL(url);
    if (/127\.0\.0\.1:17891\/home|localhost:17891\/home/.test(url)) {
      if (state.homeTabId) { switchToTab(state.homeTabId); return; }
      const existing = state.tabs.find(t => /127\.0\.0\.1:17891|localhost:17891/.test(t.url));
      if (existing) { switchToTab(existing.id); return; }
    }
    if (state.currentMode === 'browser' && state.activeTabId) {
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab) {
        if (state.pinnedTabs.has(tab.id)) { createTab(url); return; }
        tab.view.webContents.loadURL(url);
        return;
      }
    }
    createTab(url);
  });

  ipcMain.on('tab:new', (_, url) => {
    createTab(completeURL(url || 'http://127.0.0.1:17891/home'));
  });

  ipcMain.on('tab:close', (_, id) => { closeTab(id); });
  ipcMain.on('tab:switch', (_, id) => { switchToTab(id); });

  ipcMain.on('browser:backToChat', () => {
    switchToChatMode();
    sendTabsUpdate();
  });

  // Cmd+\ 退出全屏：恢复 BrowserView，但不动 currentSession（不发 session:switchToTab）。
  // switchToTab 会发 session:switchToTab → renderer 把 currentSession 换成 tab.sessionId
  // 那个 ghost UUID，导致用户从 sidebar 选的 session 被偷换。view-toggle 不该有 session 副作用。
  ipcMain.on('browser:restoreFromFullscreen', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !tab.view) return;
    state.currentMode = 'browser';
    state.mainWindow.setBrowserView(tab.view);
    layoutActiveTab();
    state.mainWindow.webContents.send('mode:change', 'browser');
    state.mainWindow.webContents.send('browser:navigated', tab.url);
    sendTabsUpdate();
  });

  // Home 页深链接：打开指定 conversationId 的会话
  ipcMain.on('home:openConversation', (_, conversationId) => {
    if (!conversationId) return;
    switchToChatMode();
    sendTabsUpdate();
    state.mainWindow.webContents.send('session:openConversation', conversationId);
  });

  ipcMain.on('tab:pin', (_, id) => {
    if (state.pinnedTabs.has(id)) state.pinnedTabs.delete(id);
    else state.pinnedTabs.add(id);
    sendTabsUpdate();
    saveTabs();
  });

  // Tab 右键菜单（原生 Menu，不被 BrowserView 遮挡）
  ipcMain.on('tab:contextmenu', (_, id) => {
    const tab = state.tabs.find(t => t.id === id);
    if (!tab) return;
    const isPinned = state.pinnedTabs.has(id);
    const menu = Menu.buildFromTemplate([
      { label: isPinned ? '取消置顶' : '置顶标签页', click: () => {
        if (isPinned) state.pinnedTabs.delete(id); else state.pinnedTabs.add(id);
        sendTabsUpdate(); saveTabs();
      }},
      { label: '复制标签页', click: () => { createTab(tab.url); } },
      { type: 'separator' },
      { label: '关闭', click: () => { closeTab(id); } },
      { label: '关闭其他', click: () => {
        state.tabs.filter(t => t.id !== id && !state.pinnedTabs.has(t.id)).forEach(t => closeTab(t.id));
      }},
    ]);
    menu.popup({ window: state.mainWindow });
  });

  // 导航控制
  ipcMain.on('browser:goBack', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) tab.view.webContents.goBack();
  });
  ipcMain.on('browser:goForward', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) tab.view.webContents.goForward();
  });
  ipcMain.on('browser:reload', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) tab.view.webContents.reload();
  });

  ipcMain.on('browser:findInPage', (_, text) => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) {
      if (text) tab.view.webContents.findInPage(text);
      else tab.view.webContents.stopFindInPage('clearSelection');
    }
  });

  ipcMain.on('browser:zoomIn', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) {
      const level = tab.view.webContents.getZoomLevel();
      tab.view.webContents.setZoomLevel(Math.min(level + 0.5, 5));
    }
  });
  ipcMain.on('browser:zoomOut', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) {
      const level = tab.view.webContents.getZoomLevel();
      tab.view.webContents.setZoomLevel(Math.max(level - 0.5, -5));
    }
  });
  ipcMain.on('browser:zoomReset', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) tab.view.webContents.setZoomLevel(0);
  });

  // Modal overlay：BrowserView 在 Electron 里始终压在 mainWindow.webContents 之上，
  // z-index 不管用。打开 modal（如 context breakdown）时临时 removeBrowserView，
  // 关闭时 setBrowserView 回来。
  ipcMain.handle('mainWindow:setModalOverlay', (_, open) => {
    if (!state.mainWindow) return { ok: false };
    if (open) {
      _savedActiveTabIdForModal = state.activeTabId;
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab && tab.view) state.mainWindow.removeBrowserView(tab.view);
      return { ok: true };
    } else {
      const tab = state.tabs.find(t => t.id === _savedActiveTabIdForModal);
      if (tab && tab.view) {
        state.mainWindow.setBrowserView(tab.view);
        layoutActiveTab();
      }
      _savedActiveTabIdForModal = null;
      return { ok: true };
    }
  });

  ipcMain.handle('tabs:restore', () => {
    const saved = loadSavedTabs();
    const pinned = saved.filter(t => t.pinned);
    for (const t of pinned) {
      const id = createTab(t.url);
      state.pinnedTabs.add(id);
    }
    return pinned.length;
  });

  ipcMain.handle('tabs:reorder', (_, { dragId, dropId }) => {
    const dragIdx = state.tabs.findIndex(t => t.id === dragId);
    const dropIdx = state.tabs.findIndex(t => t.id === dropId);
    if (dragIdx === -1 || dropIdx === -1 || dragIdx === dropIdx) return;
    const [dragTab] = state.tabs.splice(dragIdx, 1);
    state.tabs.splice(dropIdx, 0, dragTab);
    sendTabsUpdate();
    saveTabs();
  });

  // 侧边栏折叠/展开 — 调整 BrowserView 宽度
  ipcMain.on('sidebar:collapse', () => { state.sidebarCollapsed = true; forceRelayout(); });
  ipcMain.on('sidebar:expand', () => { state.sidebarCollapsed = false; forceRelayout(); });

  // 左侧会话列表 — 调整 BrowserView x 偏移
  ipcMain.on('session-sidebar:open', () => { state.sessionSidebarOpen = true; forceRelayout(); });
  ipcMain.on('session-sidebar:close', () => { state.sessionSidebarOpen = false; forceRelayout(); });

  ipcMain.on('sidebar:resize', (_, width) => {
    const maxWidth = state.mainWindow ? Math.floor(state.mainWindow.getContentBounds().width * 0.6) : 600;
    state.sidebarWidth = Math.max(200, Math.min(maxWidth, width));
    try { fs.writeFileSync(state.sidebarWidthFile, JSON.stringify({ width: state.sidebarWidth })); } catch {}
    layoutActiveTab();
  });

  // 面板打开/关闭 — 临时移除 BrowserView 以避免 native 层遮挡 HTML overlay
  ipcMain.on('panel:open', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) state.mainWindow.removeBrowserView(tab.view);
  });
  ipcMain.on('panel:close', () => {
    if (state.currentMode === 'browser') {
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab && tab.view) {
        state.mainWindow.setBrowserView(tab.view);
        layoutActiveTab();
      }
    }
  });

  // 手动请求当前页面上下文（快捷键 Cmd+I 触发）
  ipcMain.on('page:requestContext', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab) autoExtractPageContext(tab);
  });

  // ── Browser Interaction: execJS + screenshot ──
  ipcMain.handle('browser:execJS', async (_, code) => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !tab.view) return { error: 'no active tab' };
    try {
      const result = await tab.view.webContents.executeJavaScript(code);
      return { result: String(result).substring(0, 10000) };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('browser:screenshot', async () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !tab.view) return null;
    try {
      const img = await tab.view.webContents.capturePage();
      const png = img.toPNG();
      return { image: png.toString('base64') };
    } catch {
      return null;
    }
  });

  ipcMain.handle('browser:saveScreenshot', async (_, base64) => {
    const screenshotDir = path.join(VAULT_ROOT, '.screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const filePath = path.join(screenshotDir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return filePath;
  });

  ipcMain.handle('browser:processFilePaths', async (_, filePaths) => {
    return processFilePathsAsync(filePaths);
  });

  // 处理从 renderer 传来的文件 buffer（paste 时无 path）
  ipcMain.handle('browser:parseFileBuffer', async (_, { name, arrayBuffer }) => {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const buf = Buffer.from(arrayBuffer);
    const size = buf.length;
    const extracted = await extractFileContent(ext, buf, size);
    return { name, ext, size, filePath: null, ...extracted };
  });

  ipcMain.handle('browser:pickFiles', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(state.mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有文件', extensions: ['*'] },
        { name: '图片', extensions: ['png','jpg','jpeg','gif','webp','svg'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Excel / 表格', extensions: ['xlsx','xls','xlsm','ods','csv'] },
        { name: 'Word / 文档', extensions: ['docx','doc'] },
        { name: '文本 / 代码', extensions: ['txt','md','js','ts','py','go','java','c','cpp','css','html','json','yaml','yml','sh'] },
      ]
    });
    if (canceled || !filePaths.length) return [];
    return processFilePathsAsync(filePaths);
  });

  ipcMain.handle('browser:getStructuredPage', async () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !tab.view) return null;
    try {
      const data = await tab.view.webContents.executeJavaScript(`
        (function() {
          const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => ({level: h.tagName, text: h.textContent.trim()})).slice(0, 20);
          const links = [...document.querySelectorAll('a[href]')].map(a => ({text: a.textContent.trim(), href: a.href})).filter(l => l.text).slice(0, 30);
          const forms = [...document.querySelectorAll('form')].map(f => ({
            action: f.action,
            fields: [...f.querySelectorAll('input,select,textarea')].map(i => ({name: i.name, type: i.type, value: i.value}))
          })).slice(0, 5);
          const tables = [...document.querySelectorAll('table')].map(t => {
            const rows = [...t.querySelectorAll('tr')].slice(0, 10).map(r => [...r.querySelectorAll('td,th')].map(c => c.textContent.trim()));
            return rows;
          }).slice(0, 3);
          return { title: document.title, url: location.href, headings, links, forms, tables };
        })()
      `);
      return data;
    } catch (err) {
      return { error: err.message };
    }
  });
}

module.exports = { register };
