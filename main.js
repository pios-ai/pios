const { app, BrowserWindow, BrowserView, ipcMain, Menu, dialog, clipboard, shell, Tray, nativeImage, Notification, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// 2026-04-24 diagnostic: earliest module-load marker
try {
  const os = require('os');
  const vault = process.env.PIOS_VAULT || path.join(os.homedir(), 'PiOS');
  fs.appendFileSync(path.join(vault, 'Pi', 'Log', 'pi-main-queue-drain-debug.log'),
    `${new Date().toISOString()} [EARLIEST] main.js line 5 reached, pid=${process.pid}\n`);
} catch (e) {
  try { fs.appendFileSync('/tmp/piOS-main-earliest.log', `${e.message}\n`); } catch {}
}

// 解锁 Chromium 自动播放策略，允许 TTS 音频无需用户交互即可播放
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const { writeAtomic: _atomicWrite } = require('./backend/lib/atomic-write');
const { getClient } = require('./backend/codex-client');
const { buildSystemContext } = require('./backend/vault-context');
const pios = require('./backend/pios-engine');
const installer = require('./backend/pios-installer');
const { getClaudeClient } = require('./backend/claude-client');
// SessionBus + 4 adapters + ContextInjector 已下放到 main/sessionbus-setup.js
const { getOpenAIDirectClient, OpenAIDirectClient } = require('./backend/openai-direct-client');
const { webSearch, formatResultsForPrompt, classifyQuery, categorizeResults } = require('./backend/web-search');
const { startDwellTracking, stopDwellTracking, searchMemories, formatMemoriesForChat, listMemories, deleteMemory } = require('./backend/browsing-memory');
const { isInvisible, addInvisible, removeInvisible, getInvisibleList, setIncognito, isIncognito } = require('./backend/privacy-rules');
const { sanitizeForTTS } = require('./backend/tts-sanitize');

const voiceRuntime = require('./main/voice-runtime');
const piosEngine = require('./main/ipc-handlers/pios-engine');
const installerBridge = require('./main/installer-bridge');
const scheduler = require('./main/scheduler');
const voiceIpc = require('./main/ipc-handlers/voice');
const { getTTS, isWhisperHallucination } = voiceIpc;
const bookmarksIpc = require('./main/ipc-handlers/bookmarks');
const browserDataIpc = require('./main/ipc-handlers/browser-data');
const browserControlApi = require('./main/browser-control-api');
const sessionManager = require('./main/session-manager');
const { loadSessions, saveSessions, findTaskRun, materializeTaskSessionFromRun, taskRunSessionId, MAIN_SESSION_ID, _flushSessionsToDisk } = sessionManager;
const tabManager = require('./main/tab-manager');

// ── Afterward module (digital continuity) ──
// Graceful fallback if module not packaged in this build (e.g. older app.asar)
let afterward = null;
try {
  afterward = require('./modules/afterward/backend/afterward-window');
} catch (e) {
  console.warn('[afterward] module not found in bundle, feature disabled:', e.code);
  afterward = {
    registerHandlers: () => {},
    open: () => { console.warn('[afterward] not available — rebuild with modules/afterward/ included'); },
  };
}

// ── Vault Root（统一路径来源，所有模块共用 backend/vault-root.js）──
const VAULT_ROOT = require('./backend/vault-root');

// ── App Version (semver + git short hash) ──
const APP_VERSION = (() => {
  const { version } = require('./package.json');
  try {
    const { execSync } = require('child_process');
    const hash = execSync(`git -C "${__dirname}" rev-parse --short HEAD`, { encoding: 'utf-8', timeout: 3000 }).trim();
    return `v${version}+${hash}`;
  } catch {
    return `v${version}+${new Date().toISOString().slice(0, 16).replace('T', '_')}`;
  }
})();

// Claude session helpers (含 _CLAUDE_BIN + /context + /compact + JSONL backup) → main/session-helpers.js
const sessionHelpers = require('./main/session-helpers');
const {
  parseContextMarkdown: _parseContextMarkdown,
  fetchContextDetail: _fetchContextDetail,
  backupSessionJsonl: _backupSessionJsonl,
  compactSession: _compactSession,
  restoreSessionFromBackup: _restoreSessionFromBackup,
  compactInFlight: _compactInFlight,
} = sessionHelpers;

// 防止 EPIPE crash（Codex 子进程退出后 stdout 管道断裂）
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});

// 从 .app 启动时 env 缺少代理变量，从 macOS 系统设置补全
if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
  try {
    const { execSync } = require('child_process');
    const out = execSync('networksetup -getsecurewebproxy Wi-Fi', { encoding: 'utf-8', timeout: 2000 });
    const enabled = /Enabled:\s*Yes/i.test(out);
    const server = out.match(/Server:\s*(\S+)/)?.[1];
    const port = out.match(/Port:\s*(\d+)/)?.[1];
    if (enabled && server && port) {
      const proxyUrl = `http://${server}:${port}`;
      process.env.HTTPS_PROXY = proxyUrl;
      process.env.HTTP_PROXY = proxyUrl;
      console.log(`[proxy] auto-detected system proxy: ${proxyUrl}`);
    }
  } catch {}
}

// 全局去除 Electron/AppName UA 标识，让 Google 等严格检测的网站认为是正常 Chrome
app.userAgentFallback = app.userAgentFallback
  .replace(/Electron\/\S+ /g, '')
  .replace(/pios\/\S+ /g, '');

let mainWindow = null;
let tabs = []; // { id, title, url, view: BrowserView }
let activeTabId = null;
let currentMode = 'chat'; // 'chat' | 'browser'
let currentThreadId = null; // mirrors activeTab.threadId
const sidebarWidthFile = path.join(app.getPath('userData'), 'sidebar-width.json');
let sidebarWidth = 380;
try { sidebarWidth = Math.min(600, Math.max(200, JSON.parse(fs.readFileSync(sidebarWidthFile, 'utf-8')).width || 380)); } catch {}

// ── 窗口状态持久化 ──
const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
let savedWindowState = { width: 1200, height: 800 };
try {
  const raw = JSON.parse(fs.readFileSync(windowStateFile, 'utf-8'));
  if (raw.width >= 400 && raw.height >= 300) savedWindowState = raw;
} catch {}

let sidebarCollapsed = false;
let sessionSidebarOpen = false; // 左侧会话列表
let pinnedTabs = new Set(); // 置顶的 tab id
let homeTabId = null; // Home tab 不可关闭
let bubbleNpcMod = null; // set in app.whenReady(); exposed via _tabMgrState / _browserCtrlState
const savedCredentials = new Map(); // host → { username, password }
const credFile = path.join(app.getPath('userData'), 'saved-credentials.json');
// ── Auth login sessions (in-memory, ephemeral) ──
// Driven by `claude auth login` child processes; polled by pios-home.html
// via GET /pios/auth/login/status.
const _loginSessions = new Map();
// Prune sessions older than 10 min to avoid leaking memory on long-running app.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, s] of _loginSessions) {
    if (s.startedAt < cutoff && (s.state === 'done' || s.state === 'failed')) {
      _loginSessions.delete(id);
    }
  }
}, 60 * 1000);

// 2026-04-29: stub 加回。HEAD 版本 main.js 有 `function detectTripleOpt() {} // no-op，保留引用`
// 但 working tree 里有别的未提交重构（git diff HEAD main.js 显示 451 行删除）把 stub 删了，
// 调用点 line 640 还在 → 启动 before-input-event 触发时 ReferenceError 崩 main process（截图证据）。
// 顶层 function declaration 被 hoist，所有引用点都能拿到。重构者改完后应该把调用点也删。
function detectTripleOpt() {}

// 启动条件追踪
let _apiReady = false;
let _windowReady = false;

// ── Owner / Persona 小 helper（agent-mode 也用）──
function _owner() { try { return require('./backend/vault-context').getOwnerName(); } catch { return 'User'; } }
function _persona() {
  try { return require('./backend/pi-persona').personaBlock(_owner()); }
  catch { return ''; }
}

// ── Chat prompt builders → main/chat-prompts.js ──
const chatPrompts = require('./main/chat-prompts').create({
  MAIN_SESSION_ID,
  buildSystemContext,
  loadSessions,
  getContextInjector: () => contextInjector,
  webSearch,
  formatResultsForPrompt,
  classifyQuery,
  categorizeResults,
});
const prepareGPTRequest = chatPrompts.prepareGPTRequest;
const prepareCodexRequest = chatPrompts.prepareCodexRequest;

ipcMain.handle('app:getVersion', () => APP_VERSION);

ipcMain.on('gpt:reset', () => {
  getOpenAIDirectClient().reset();
});

ipcMain.on('gpt:restore', (_, messages) => {
  const client = getOpenAIDirectClient();
  client.reset();
  // Restore conversation history from session messages
  // 恢复所有消息（除了 claude 引擎的——Claude 有自己的 session 机制）
  for (const msg of messages) {
    if (msg.role === 'user') {
      client._conversationHistory.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'ai' && msg.engine !== 'claude') {
      // 主动消息（proactive）没有对应的 user 消息，补一条合成 user 消息保持对话结构
      const lastEntry = client._conversationHistory[client._conversationHistory.length - 1];
      if (msg.proactive && (!lastEntry || lastEntry.role !== 'user')) {
        client._conversationHistory.push({ role: 'user', content: '[系统事件通知]' });
      }
      client._conversationHistory.push({ role: 'assistant', content: msg.content });
    }
  }
  console.log(`[gpt:restore] restored ${client._conversationHistory.length} messages`);
});

// ── Bookmarks IPC → main/ipc-handlers/bookmarks.js ──
bookmarksIpc.register(ipcMain, app);

// ── Session Manager (multi-session) → main/session-manager.js ──
// loadSessions / saveSessions / findTaskRun / materializeTaskSessionFromRun /
// taskRunSessionId / MAIN_SESSION_ID / _flushSessionsToDisk 已 destructure 到顶部 require。
// IPC handlers (sessions:* / conversation:*) 在 app.whenReady 之后由 register() 注册。

// ── Session Manager IPC (sessions:* / conversation:*) → main/session-manager.js ──

// ── History / Memories / Privacy IPC → main/ipc-handlers/browser-data.js ──
const { addToHistory } = browserDataIpc;
browserDataIpc.register(ipcMain, app, () => mainWindow);

// extractRunFromLog → main/session-manager.js

// ── Tab Manager → main/tab-manager.js ──
const tabsFile = path.join(app.getPath('userData'), 'saved-tabs.json');
const _tabMgrState = {
  get mainWindow() { return mainWindow; }, set mainWindow(v) { mainWindow = v; },
  get tabs() { return tabs; },
  get activeTabId() { return activeTabId; }, set activeTabId(v) { activeTabId = v; },
  get homeTabId() { return homeTabId; }, set homeTabId(v) { homeTabId = v; },
  get currentMode() { return currentMode; }, set currentMode(v) { currentMode = v; },
  get currentThreadId() { return currentThreadId; }, set currentThreadId(v) { currentThreadId = v; },
  get sidebarWidth() { return sidebarWidth; }, set sidebarWidth(v) { sidebarWidth = v; },
  get sidebarCollapsed() { return sidebarCollapsed; }, set sidebarCollapsed(v) { sidebarCollapsed = v; },
  get sessionSidebarOpen() { return sessionSidebarOpen; }, set sessionSidebarOpen(v) { sessionSidebarOpen = v; },
  get pinnedTabs() { return pinnedTabs; },
  get pulse() { return bubbleNpcMod && bubbleNpcMod.getPulse(); },
  get savedCredentials() { return savedCredentials; },
  get _apiReady() { return _apiReady; },
  get _windowReady() { return _windowReady; },
  sidebarWidthFile,
  get credFile() { return credFile; },
  get tabsFile() { return tabsFile; },
  get savedWindowState() { return savedWindowState; },
};
const _tabMgr = tabManager.create(_tabMgrState, { installer, addToHistory });
const {
  createWindow, createTab, switchToTab, closeTab, tryCreateHomeTabs,
  sendTabsUpdate, layoutActiveTab, autoExtractPageContext, saveTabs,
  loadSavedTabs, showAuthDialog, switchToChatMode, forceRelayout,
  completeURL, deepMerge, getTabsInfo, loadCredentials, persistCredentials,
} = _tabMgr;
_tabMgr.registerIpc(ipcMain);

app.setName('Pi');

// 单实例锁：防止多个 Pi Browser 同时运行
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  loadCredentials();

  // Electron renderer 默认 deny navigator.mediaDevices.getUserMedia — 导致 F5 录音
  // 触发 bubble.html 的 startRec 时 getUserMedia reject，catch 静默吞掉 → 用户感觉"F5 没反应"
  // 系统 TCC mic 权限是另一层（Info.plist 已声明）— 这里是 Electron 应用内的 permission gate
  const { session } = require('electron');
  const ALLOW_PERMS = new Set(['media', 'microphone', 'audioCapture', 'display-capture', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    if (ALLOW_PERMS.has(permission)) return cb(true);
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    if (ALLOW_PERMS.has(permission)) return true;
    return false;
  });

  createWindow();
  _windowReady = true;
  tryCreateHomeTabs();

  // ── Afterward module: register IPC + global shortcut ──
  // Data dir defaults to ~/.afterward (configurable via AFTERWARD_BASE env)
  afterward.registerHandlers(process.env.AFTERWARD_BASE || null);
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    afterward.open();
  });

  // ── 内置 Scheduler → main/scheduler.js ──
  scheduler.start(VAULT_ROOT, installer);

  mainWindow.webContents.on('did-finish-load', () => {
    if (activeTabId) {
      layoutActiveTab();
      // 重发 session:switchToTab，防止首次加载时事件丢失
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab) mainWindow.webContents.send('session:switchToTab', activeTab.sessionId);
    }
  });

  // Ctrl 三击检测（主窗口）
  mainWindow.webContents.on('before-input-event', (_, input) => detectTripleOpt(input));

  // ── App Menu + Cmd+Shift+J quick input → main/app-menu.js ──
  require('./main/app-menu').setup(ipcMain, {
    APP_VERSION,
    createTab, closeTab, switchToChatMode,
    getMainWindow: () => mainWindow,
    getActiveTabId: () => activeTabId,
    getTabs: () => tabs,
  });

  // ── Dock Icon ──
  const dockIconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(dockIconPath) && app.dock) {
    app.dock.setIcon(dockIconPath);
  }

  // ── Bubble + NPC + Tray + bubble IPC → main/bubble-npc-tray.js ──
  bubbleNpcMod = require('./main/bubble-npc-tray').setup(ipcMain, {
    vaultRoot: VAULT_ROOT,
    APP_VERSION,
    getMainWindow: () => mainWindow,
    installer,
    markVoiceOnly: chatPrompts.markVoiceOnly.bind(chatPrompts),
    isWhisperHallucination,
  });

  // ── Lifecycle 定时器（pi-chitchat 30min / presence-watch 60s / wechat-aggregator 5min） → main/lifecycle-timers.js ──
  require('./main/lifecycle-timers').start({
    vaultRoot: VAULT_ROOT,
    getMainWindow: () => mainWindow,
    app,
  });

  // ── mainWindow + app 生命周期事件 → main/window-lifecycle.js ──
  require('./main/window-lifecycle').attach({
    app,
    getMainWindow: () => mainWindow,
    getCurrentMode: () => currentMode,
    layoutActiveTab,
    saveTabs,
    flushSessionsToDisk: _flushSessionsToDisk,
    windowStateFile,
  });
});

// ── Engine: Codex / Claude Code switch ──
let currentEngine = 'auto'; // 'auto' | 'codex' | 'gpt' | 'claude' | 'clean'

ipcMain.on('engine:switch', (_, engine) => {
  currentEngine = engine;
  console.log('[engine] switched to:', engine);
});

ipcMain.handle('engine:current', () => currentEngine);

// ── Notification + handlePiEvent → main/notification.js ──
const notification = require('./main/notification');
const _notifyMod = notification.create({
  VAULT_ROOT,
  MAIN_SESSION_ID,
  loadSessions,
  saveSessions,
  sanitizeForTTS,
  get mainWindow() { return mainWindow; },
});
const sendNotification = _notifyMod.sendNotification;
const handlePiEvent = _notifyMod.handlePiEvent;
_notifyMod.register(ipcMain);


// ── Browser Control HTTP API (for MCP server bridge) → main/browser-control-api.js ──
const _browserCtrlState = {
  // Mutable scalars — accessed via getters so the module always reads current value
  get mainWindow()       { return mainWindow; },
  get tabs()             { return tabs; },
  get activeTabId()      { return activeTabId; },
  get homeTabId()        { return homeTabId; },
  get pulse()            { return bubbleNpcMod && bubbleNpcMod.getPulse(); },
  get afterward()        { return afterward; },
  get sidebarCollapsed() { return sidebarCollapsed; },
  set sidebarCollapsed(v){ sidebarCollapsed = v; },
  get _apiReady()        { return _apiReady; },
  set _apiReady(v)       { _apiReady = v; },
  get sessionBus()       { return sessionBus; }, // initialized later at module level
  // By-reference mutable collections (const, never reassigned)
  _loginSessions, _compactInFlight,
  // Functions (hoisted — safe to reference here)
  createTab, switchToTab, closeTab, sendNotification, handlePiEvent, switchToChatMode,
  forceRelayout, completeURL, deepMerge,
  loadSessions, saveSessions, findTaskRun, materializeTaskSessionFromRun,
  taskRunSessionId, tryCreateHomeTabs,
  _backupSessionJsonl, _compactSession, _fetchContextDetail, _restoreSessionFromBackup,
  getClaudeClient,
  // Service objects and constants (initialized before this line)
  pios, installer,
  VAULT_ROOT, APP_VERSION,
};
const httpServer = browserControlApi.create(_browserCtrlState);


// ── qwen-voice TTS/ASR 服务 + 相关 IPC → main/voice-runtime.js ──
voiceRuntime.register(app, ipcMain);

// ── PiOS Engine + Card + Runtime IPC → main/ipc-handlers/pios-engine.js ──
piosEngine.register(ipcMain);

// ── Installer + Deps + Plugin IPC → main/installer-bridge.js ──
// 注意：mainWindow 此刻还是 null（`let mainWindow = null` 在文件顶上，BrowserWindow 实例化在
// app.whenReady 回调里，本行在模块加载阶段就跑），所以传 getter 而不是值。
// 历史 bug：之前直接传 { mainWindow }，IPC handler 闭包捕获到 null，用户点"激活 WeChat"按钮
// 时永远报"PiOS 主窗口未就绪"（issue #3）。
installerBridge.register(ipcMain, {
  getMainWindow: () => mainWindow,
  tryCreateHomeTabs,
  switchToChatMode,
});

// ── Session Manager IPC (sessions:* / conversation:*) → main/session-manager.js ──
// getSessionBus 用 getter 模式，sessionBus 在本文件下方 const sessionBus = getSessionBus() 赋值
// handler 在 IPC 触发时才调 getSessionBus()，保证 sessionBus 已初始化
sessionManager.register(ipcMain, { getSessionBus: () => sessionBus, getClaudeClient });

// 调度器 timer 清理（qwenVoiceProc 由 voice-runtime.js 自己的 will-quit handler 负责）
app.on('will-quit', () => {
  scheduler.stop();
});

// ── TTS pre-warm + ASR pre-warm → main/ipc-handlers/voice.js ──

// ── Pi/Inbox/* 文件监听（pi_notify / pi-speak-queue / pi-main-proactive-queue） → main/pi-inbox-watchers.js ──
require('./main/pi-inbox-watchers').start({
  VAULT_ROOT,
  MAIN_SESSION_ID,
  loadSessions,
  saveSessions,
  sendNotification,
  getMainWindow: () => mainWindow,
});

// claude:reset 保留（agent mode / session 切换时清 singleton）；其余 Claude 交互走 SessionBus
ipcMain.on('claude:reset', () => {
  const claude = getClaudeClient();
  claude.reset();
});

// ── SessionBus v2 + 4 engine adapter + ContextInjector → main/sessionbus-setup.js ──
const { sessionBus, contextInjector } = require('./main/sessionbus-setup').setup({
  vaultRoot: VAULT_ROOT,
  MAIN_SESSION_ID,
  loadSessions,
  getMainWindow: () => mainWindow,
  getTTS,
  prepareGPTRequest,
  prepareCodexRequest,
});

// ── SessionBus IPC → main/ipc-handlers/session-bus.js ──
require('./main/ipc-handlers/session-bus').register(ipcMain, { sessionBus, vaultRoot: VAULT_ROOT });

// ── Agent Mode: AI 自主浏览 → main/agent-mode.js ──
require('./main/agent-mode').register(ipcMain, {
  getMainWindow: () => mainWindow,
  getClaudeClient,
  getTTS,
  getOwner: _owner,
  getPersona: _persona,
});

// ── Voice TTS / ASR / debug:trace + 预热 → main/ipc-handlers/voice.js ──
voiceIpc.register(ipcMain);

// ── PiOS Engine + Card + Runtime IPC → main/ipc-handlers/pios-engine.js (registered above) ──
// ── Installer + Deps + Plugin IPC → main/installer-bridge.js (registered above) ──
// pios:qwen-status + pios:qwen-tts-wav → main/voice-runtime.js（已由 voiceRuntime.register() 注册）

app.on('window-all-closed', async () => {
  saveTabs(); // 保存标签以便下次恢复
  const client = getClient();
  await client.stop();
  const claudeClient = getClaudeClient();
  claudeClient.stop();
  if (httpServer) httpServer.close();
  app.quit();
});
