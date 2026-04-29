'use strict';

// ── tab-manager.js ──────────────────────────────────────────────────────────
// Extracted from main.js tick 7 (2026-04-29).
// Manages all tab state, window creation, layout, and tab-related IPC handlers.
// Factory: create(state, deps) → { createWindow, createTab, switchToTab, ... }
// ────────────────────────────────────────────────────────────────────────────

const { BrowserWindow, BrowserView, Menu, dialog, clipboard, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { startDwellTracking, stopDwellTracking } = require('../backend/browsing-memory');
const { isInvisible, isIncognito } = require('../backend/privacy-rules');
const VAULT_ROOT = require('../backend/vault-root');

// ── Pure utility functions ──────────────────────────────────────────────────

function deepMerge(target, source) {
  if (!source) return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function completeURL(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    // localhost 和 IP 地址用 http
    if (/^(localhost|127\.\d+\.\d+\.\d+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?(\/|$)/.test(url)) {
      return 'http://' + url;
    }
    if (url.includes('.') && !url.includes(' ')) {
      return 'https://' + url;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
  }
  return url;
}

function detectTripleOpt() {} // no-op，保留引用

// ── File processing → main/file-processing.js ───────────────────────────────
const {
  IMAGE_EXT, TEXT_EXT, EXCEL_EXT, WORD_EXT,
  parseExcelBuffer, parseWordBuffer, parsePDFBuffer,
  extractFileContent, processFilePathsAsync, processFilePaths,
} = require('./file-processing');

// ── Factory ─────────────────────────────────────────────────────────────────
// state: getter/setter proxy to main.js module-level variables
// deps: { installer, addToHistory }

function create(state, deps) {
  const SESSION_SIDEBAR_WIDTH = 260;

  // Closure-local variables (not shared with main.js)
  let _nextTabId = 1;
  let _saveTabsTimer = null;
  let _authDialogOpen = false;
  let _savedActiveTabIdForModal = null;
  let _homeCreating = false;

  // ── Tab info ──────────────────────────────────────────────────────────────

  function getTabsInfo() {
    return state.tabs.map(t => ({
      id: t.id, title: t.title, url: t.url, favicon: t.favicon || '',
      active: t.id === state.activeTabId, pinned: state.pinnedTabs.has(t.id),
      isHome: t.id === state.homeTabId,
    }));
  }

  function sendTabsUpdate() {
    if (state.mainWindow) state.mainWindow.webContents.send('tabs:updated', getTabsInfo());
  }

  function layoutActiveTab() {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !tab.view) return;
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    const b = state.mainWindow.getContentBounds();
    if (b.width < 10 || b.height < 10) return;
    const tabBarHeight = 40;
    const topOffset = 44 + tabBarHeight;  // topbar(44) + tab bar(40)
    const leftMargin = state.sessionSidebarOpen ? SESSION_SIDEBAR_WIDTH : 0;
    const rightMargin = state.sidebarCollapsed ? 0 : state.sidebarWidth;
    const bounds = {
      x: leftMargin, y: topOffset,
      width: Math.max(b.width - rightMargin - leftMargin, 100),
      height: Math.max(b.height - topOffset, 100)
    };
    tab.view.setBounds(bounds);
  }

  function forceRelayout() {
    if (state.currentMode !== 'browser') return; // 非浏览器模式不需要 BrowserView
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab || !tab.view || !state.mainWindow || state.mainWindow.isDestroyed()) return;
    state.mainWindow.removeBrowserView(tab.view);
    state.mainWindow.setBrowserView(tab.view);
    layoutActiveTab();
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  function loadCredentials() {
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(state.credFile, 'utf-8')))) {
        state.savedCredentials.set(k, v);
      }
    } catch {}
  }

  function persistCredentials() {
    try { fs.writeFileSync(state.credFile, JSON.stringify(Object.fromEntries(state.savedCredentials))); } catch {}
  }

  // ── Auth Dialog ───────────────────────────────────────────────────────────

  // Basic Auth 对话框（替代 prompt()，Electron v35 里 prompt() 可能被拦截）
  function showAuthDialog(host) {
    if (_authDialogOpen) return Promise.resolve(null);
    _authDialogOpen = true;
    return new Promise((resolve) => {
      const { screen } = require('electron');
      const d = screen.getPrimaryDisplay();
      const x = Math.round(d.bounds.x + (d.bounds.width - 320) / 2);
      const y = Math.round(d.bounds.y + (d.bounds.height - 220) / 2);
      const authWin = new BrowserWindow({
        width: 320, height: 260, x, y,
        frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
        parent: state.mainWindow, modal: true,
        webPreferences: { contextIsolation: false, nodeIntegration: true },
      });
      authWin.loadFile('auth-dialog.html', { query: { host } });
      function done(result) {
        _authDialogOpen = false;
        ipcMainRef.removeListener('auth-dialog:submit', onSubmit);
        ipcMainRef.removeListener('auth-dialog:cancel', onCancel);
        if (!authWin.isDestroyed()) authWin.close();
        resolve(result);
      }
      function onSubmit(_, creds) { done(creds); }
      function onCancel() { done(null); }
      ipcMainRef.once('auth-dialog:submit', onSubmit);
      ipcMainRef.once('auth-dialog:cancel', onCancel);
      authWin.on('closed', () => {
        _authDialogOpen = false;
        ipcMainRef.removeListener('auth-dialog:submit', onSubmit);
        ipcMainRef.removeListener('auth-dialog:cancel', onCancel);
        resolve(null);
      });
    });
  }

  // ── Tab persistence ────────────────────────────────────────────────────────

  function saveTabs() {
    if (_saveTabsTimer) { clearTimeout(_saveTabsTimer); _saveTabsTimer = null; }
    const data = state.tabs.map(t => ({
      url: t.url, title: t.title, favicon: t.favicon || '',
      pinned: state.pinnedTabs.has(t.id), sessionId: t.sessionId || '',
    }));
    try { fs.writeFileSync(state.tabsFile, JSON.stringify(data)); } catch {}
  }

  function loadSavedTabs() {
    try { return JSON.parse(fs.readFileSync(state.tabsFile, 'utf-8')); } catch { return []; }
  }

  // ── Page context ──────────────────────────────────────────────────────────

  // 自动提取页面上下文并推送到渲染进程
  async function autoExtractPageContext(tab) {
    if (!tab || !tab.view || !state.mainWindow) return;
    // 只推送当前活跃标签页的上下文
    if (tab.id !== state.activeTabId) return;
    try {
      const url = tab.view.webContents.getURL();
      // AI 不可见站点：不提取内容
      if (isInvisible(url)) return;
      const text = await tab.view.webContents.executeJavaScript(
        `document.body.innerText.substring(0, 8000)`
      );
      const title = await tab.view.webContents.executeJavaScript(`document.title`);
      // 再次检查 activeTab —— 启动恢复多 tab 时，executeJavaScript 期间 activeTabId 会被后续
      // switchToTab 改掉，如果不 recheck，后加载的背景 tab（如远程 Google）会把自己的 ctx
      // 盖到当前活跃 tab（通常是 Home）上，导致 chip 残留别的页。
      if (tab.id !== state.activeTabId) return;
      state.mainWindow.webContents.send('page:contextUpdate', { title, url, text });
    } catch {
      // 页面可能已销毁，静默忽略
    }
  }

  // ── tryCreateHomeTabs ──────────────────────────────────────────────────────

  function tryCreateHomeTabs() {
    if (!state._apiReady || !state._windowReady || state.homeTabId || _homeCreating) return;
    // 未装完时禁建 Home BrowserView——它是 Electron 原生层，z-index 管不到，
    // 会盖住孵化仪式 / Setup Wizard overlay（renderer/index.html）。setup 完后由 pios:install handler 再触发。
    if (!deps.installer.isInstalled()) return;
    _homeCreating = true;
    state.sidebarCollapsed = false;  // 启动时 sidebar 展开（跟 renderer 同步）
    state.homeTabId = createTab('http://127.0.0.1:17891/home');
    // 立即设置 Home 标题（不等 page-title-updated）
    const homeTab = state.tabs.find(t => t.id === state.homeTabId);
    if (homeTab) homeTab.title = 'Home';
    state.pinnedTabs.add(state.homeTabId);
    const saved = loadSavedTabs();
    for (const t of saved) {
      if (!/127\.0\.0\.1:17891|localhost:17891/.test(t.url)) {
        const id = createTab(t.url);
        const restoredTab = state.tabs.find(tab => tab.id === id);
        if (restoredTab && t.favicon) restoredTab.favicon = t.favicon;
        if (restoredTab && t.title) restoredTab.title = t.title;
        if (restoredTab && t.sessionId) restoredTab.sessionId = t.sessionId;
        if (t.pinned) state.pinnedTabs.add(id);
      }
    }
    switchToTab(state.homeTabId);
    sendTabsUpdate();
    // 延迟保存：等恢复的 tab 加载完 favicon 后再写盘，避免覆盖已存的 favicon
    setTimeout(() => saveTabs(), 10000);
  }

  // ── createWindow ───────────────────────────────────────────────────────────

  function createWindow() {
    const sw = state.savedWindowState;
    state.mainWindow = new BrowserWindow({
      width: sw.width,
      height: sw.height,
      ...(sw.x !== undefined && sw.y !== undefined ? { x: sw.x, y: sw.y } : {}),
      title: 'PiOS',
      backgroundColor: '#212121',
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: true }),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    // 全屏/最大化恢复
    if (sw.maximized) state.mainWindow.maximize();
    if (sw.fullscreen) state.mainWindow.setFullScreen(true);

    state.mainWindow.loadFile('renderer/index.html');

    // renderer 加载完成后同步状态
    state.mainWindow.webContents.on('did-finish-load', () => {
      // 同步 sidebar 宽度（防止 CSS 变量和 main.js 不一致）
      state.mainWindow.webContents.executeJavaScript(
        `document.documentElement.style.setProperty('--sidebar-width', '${state.sidebarWidth}px')`
      ).catch(() => {});
      if (state.activeTabId) {
        layoutActiveTab();
        state.mainWindow.webContents.send('mode:change', 'browser');
        sendTabsUpdate();
      }
    });

    // 开发模式打开 DevTools
    if (process.argv.includes('--dev')) {
      state.mainWindow.webContents.openDevTools({ mode: 'bottom' });
    }

    // 监听 app 激活（CMD+Tab 切回来）
    app.on('browser-window-focus', () => {
      // TODO Phase 2: 检测上一个 app 是否是 Terminal，抓取终端内容
    });
  }

  // ── createTab ──────────────────────────────────────────────────────────────

  // 创建新 tab
  function createTab(url, opts = {}) {
    const focus = opts.focus !== false; // 默认 true — 只有 AI 后台任务显式传 false
    const id = _nextTabId++;
    const browserPreload = path.join(__dirname, '..', 'browser-preload.js');
    const view = new BrowserView({
      webPreferences: {
        preload: browserPreload,
        contextIsolation: true,
        sandbox: false,  // preload 需要访问 electron API (webFrame)
        partition: 'persist:pi',
      }
    });
    // 恢复 Chromium 正常的 User-Agent（Electron 默认会在 UA 里加 Electron/xxx）
    view.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Ctrl 三击检测
    view.webContents.on('before-input-event', (_, input) => detectTripleOpt(input));

    // HTTP Basic Auth（Syncthing 等需要）— 缓存凭据，避免重复输入和 401 无限循环
    view.webContents.on('login', (event, details, authInfo, callback) => {
      event.preventDefault();
      const cacheKey = `${authInfo.host}:${authInfo.realm || ''}`;
      const cached = state.savedCredentials.get(cacheKey);
      if (cached) { callback(cached.username, cached.password); return; }
      showAuthDialog(authInfo.host).then(r => {
        if (r && r.u) {
          state.savedCredentials.set(cacheKey, { username: r.u, password: r.p });
          persistCredentials();
          callback(r.u, r.p);
        } else {
          callback(); // 用户取消 → 中止，不再重试
        }
      }).catch(() => callback());
    });

    const sessionId = require('crypto').randomUUID();
    const tab = {
      id, title: 'Loading...', url, view, loading: true,
      canGoBack: false, canGoForward: false, sessionId, threadId: null,
    };
    state.tabs.push(tab);

    // Home tab 保护：外部导航不覆盖 Home
    view.webContents.on('will-navigate', (event, newUrl) => {
      if (tab.id === state.homeTabId && !/127\.0\.0\.1:17891|localhost:17891/.test(newUrl)) {
        event.preventDefault();
        createTab(newUrl);
      }
    });

    view.webContents.on('did-navigate', (_, newUrl) => {
      tab.url = newUrl;
      tab.canGoBack = view.webContents.canGoBack();
      tab.canGoForward = view.webContents.canGoForward();
      if (tab.id === state.activeTabId) {
        state.mainWindow.webContents.send('browser:navigated', newUrl);
        state.mainWindow.webContents.send('browser:navState', { canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });
      }
      sendTabsUpdate();
    });
    view.webContents.on('did-navigate-in-page', (_, newUrl) => {
      tab.url = newUrl;
      tab.canGoBack = view.webContents.canGoBack();
      tab.canGoForward = view.webContents.canGoForward();
      if (tab.id === state.activeTabId) {
        state.mainWindow.webContents.send('browser:navigated', newUrl);
        state.mainWindow.webContents.send('browser:navState', { canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });
      }
    });
    view.webContents.on('page-title-updated', (_, title) => {
      // 内部页面用友好名称
      if (/127\.0\.0\.1:17891|localhost:17891/.test(tab.url)) {
        tab.title = 'Home';
      } else {
        tab.title = title;
      }
      sendTabsUpdate();
    });
    view.webContents.on('page-favicon-updated', async (_, favicons) => {
      if (!favicons || !favicons.length) return;
      const faviconUrl = favicons[0];
      // 尝试 fetch 转 data-uri；失败则尝试 origin/favicon.ico；都失败则存 URL
      const tryFetchDataUri = async (u) => {
        const resp = await view.webContents.session.fetch(u);
        if (!resp.ok) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 100) return null; // 太小，可能是错误页
        const type = resp.headers.get('content-type') || 'image/png';
        return `data:${type};base64,${buf.toString('base64')}`;
      };
      try {
        let dataUri = await tryFetchDataUri(faviconUrl);
        if (!dataUri) {
          // fallback: 试 origin/favicon.ico
          const pageUrl = view.webContents.getURL();
          if (pageUrl) {
            const origin = new URL(pageUrl).origin;
            dataUri = await tryFetchDataUri(`${origin}/favicon.ico`).catch(() => null);
          }
        }
        tab.favicon = dataUri || faviconUrl;
      } catch { tab.favicon = faviconUrl; }
      sendTabsUpdate();
      saveTabs();
    });

    // 页面加载完成 → 写历史记录 + 自动提取页面上下文 + 启动浏览记忆追踪
    // 点击 BrowserView 时关闭会话列表
    view.webContents.on('focus', () => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('session-sidebar:close');
      }
    });

    view.webContents.on('did-finish-load', () => {
      deps.addToHistory(tab.title, tab.url);
      const url = tab.view.webContents.getURL();
      const invisible = isInvisible(url);
      // 通知渲染进程当前页面的隐私状态
      if (tab.id === state.activeTabId && state.mainWindow) {
        state.mainWindow.webContents.send('privacy:status', { invisible, incognito: isIncognito() });
      }
      if (invisible) {
        // AI 不可见：跳过内容提取和浏览记忆
        stopDwellTracking(tab.id);
        return;
      }
      autoExtractPageContext(tab);
      // Start dwell tracking: if user stays 30s+, auto-extract memory
      startDwellTracking(tab.id, tab.url, async () => {
        const text = await tab.view.webContents.executeJavaScript(`document.body.innerText.substring(0, 12000)`);
        const title = await tab.view.webContents.executeJavaScript(`document.title`);
        return { title, url: tab.view.webContents.getURL(), text };
      });
    });

    // 加载状态
    view.webContents.on('did-start-loading', () => {
      tab.loading = true;
      if (tab.id === state.activeTabId) state.mainWindow.webContents.send('browser:loading', true);
    });
    view.webContents.on('did-stop-loading', () => {
      tab.loading = false;
      if (tab.id === state.activeTabId) state.mainWindow.webContents.send('browser:loading', false);
    });

    // 加载失败 → 通知渲染进程显示错误
    view.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return; // ERR_ABORTED
      // 自动重试（API 可能还没就绪）
      if (/127\.0\.0\.1:17891|localhost:17891/.test(validatedURL)) {
        setTimeout(() => { try { view.webContents.loadURL(validatedURL); } catch {} }, 2000);
        return;
      }
      if (tab.id === state.activeTabId) {
        state.mainWindow.webContents.send('browser:loadError', { url: validatedURL, error: errorDescription, code: errorCode });
      }
    });

    // target="_blank" 链接 → 新 tab 打开
    view.webContents.setWindowOpenHandler(({ url }) => {
      createTab(url);
      return { action: 'deny' };
    });

    // 右键菜单
    view.webContents.on('context-menu', (_, params) => {
      const menuItems = [];
      if (params.linkURL) {
        menuItems.push(
          { label: '在新标签页中打开', click: () => createTab(params.linkURL) },
          { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' }
        );
      }
      if (params.selectionText) {
        menuItems.push(
          { label: '复制', role: 'copy' },
          { label: `问 Pi: "${params.selectionText.substring(0, 30)}..."`, click: () => {
            state.mainWindow.webContents.send('terminal:context', params.selectionText);
          }},
          { type: 'separator' }
        );
      }
      menuItems.push(
        { label: '后退', enabled: view.webContents.canGoBack(), click: () => view.webContents.goBack() },
        { label: '前进', enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() },
        { label: '刷新', click: () => view.webContents.reload() },
        { type: 'separator' },
        { label: '在外部浏览器中打开', click: () => shell.openExternal(params.pageURL || tab.url) }
      );
      Menu.buildFromTemplate(menuItems).popup();
    });

    // 下载管理
    view.webContents.session.on('will-download', (_, item) => {
      const downloadsPath = path.join(app.getPath('downloads'), item.getFilename());
      item.setSavePath(downloadsPath);
      item.on('done', (_, state_) => {
        if (state_ === 'completed') {
          state.mainWindow.webContents.send('browser:download', { name: item.getFilename(), path: downloadsPath, state: 'completed' });
        }
      });
    });

    view.webContents.loadURL(url);
    if (focus) {
      switchToTab(id);
    } else {
      // 后台 tab：不绑 mainWindow，不改 activeTabId，只进 tabs 数组让 owner 能看到
      sendTabsUpdate();
    }
    return id;
  }

  // ── switchToTab ────────────────────────────────────────────────────────────

  // 切换 tab
  function switchToTab(id) {
    const tab = state.tabs.find(t => t.id === id);
    if (!tab) return;

    // 保存当前 tab 的 threadId
    const prev = state.tabs.find(t => t.id === state.activeTabId);
    if (prev) prev.threadId = state.currentThreadId;
    if (prev && prev.view) state.mainWindow.removeBrowserView(prev.view);

    state.activeTabId = id;
    // 恢复新 tab 的 threadId
    state.currentThreadId = tab.threadId || null;

    const wasChat = state.currentMode !== 'browser';
    if (wasChat) {
      state.currentMode = 'browser';
      // 保留已设置的折叠状态（启动时 sidebarCollapsed=true 表示全屏 Home）
      if (!state.sidebarCollapsed) state.sidebarCollapsed = false;
      state.sessionSidebarOpen = false;
    }
    state.mainWindow.setBrowserView(tab.view);
    layoutActiveTab();
    if (wasChat) {
      state.mainWindow.webContents.send('mode:change', 'browser');
    }
    state.mainWindow.webContents.send('browser:navigated', tab.url);
    state.mainWindow.webContents.send('session:switchToTab', tab.sessionId);
    sendTabsUpdate();
    // 切换 tab 时推送新页面上下文
    autoExtractPageContext(tab);
  }

  // ── closeTab ───────────────────────────────────────────────────────────────

  // 关闭 tab
  function closeTab(id) {
    // Home tab 不可关闭
    if (id === state.homeTabId) return;
    const idx = state.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tab = state.tabs[idx];

    // 最后一个 tab → 不关闭，导航到 Home
    if (state.tabs.length === 1) {
      tab.view.webContents.loadURL('http://127.0.0.1:17891/home');
      return;
    }

    if (tab.id === state.activeTabId) state.mainWindow.removeBrowserView(tab.view);
    stopDwellTracking(tab.id);
    tab.view.webContents.destroy();
    state.tabs.splice(idx, 1);

    if (tab.id === state.activeTabId) {
      switchToTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
    }
    sendTabsUpdate();
    saveTabs();
  }

  // ── switchToChatMode ───────────────────────────────────────────────────────

  // 切换回聊天模式（保留 tabs）
  function switchToChatMode() {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab && tab.view) state.mainWindow.removeBrowserView(tab.view);
    state.currentMode = 'chat';
    // 有 tabs 时发 'chat-with-tabs'，renderer 保留 tab 栏
    state.mainWindow.webContents.send('mode:change', state.tabs.length > 0 ? 'chat-with-tabs' : 'chat');
  }

  // ── IPC registration ───────────────────────────────────────────────────────

  function registerIpc(ipcMain) {
    require('./tab-manager-ipc').register(ipcMain, {
      state,
      VAULT_ROOT,
      completeURL,
      isInvisible,
      extractFileContent,
      processFilePathsAsync,
      createTab, switchToTab, closeTab, switchToChatMode,
      sendTabsUpdate, layoutActiveTab, forceRelayout,
      autoExtractPageContext, saveTabs, loadSavedTabs,
    });
  }

  return {
    createWindow,
    createTab,
    switchToTab,
    closeTab,
    tryCreateHomeTabs,
    sendTabsUpdate,
    layoutActiveTab,
    autoExtractPageContext,
    saveTabs,
    loadSavedTabs,
    showAuthDialog,
    switchToChatMode,
    forceRelayout,
    completeURL,
    deepMerge,
    getTabsInfo,
    loadCredentials,
    persistCredentials,
    registerIpc,
  };
} // end create

module.exports = { create };
