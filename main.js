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
const { getSessionBus } = require('./backend/session-bus');
const { ClaudeInteractiveAdapter } = require('./backend/adapters/claude-interactive');
// 刀 2: GPT/Codex adapter 走 SessionBus（step 4-6 renderer/main 全部切过去）
const { GPTDirectAdapter } = require('./backend/adapters/gpt-direct');
const { CodexInteractiveAdapter } = require('./backend/adapters/codex-interactive');
const { ContextInjector } = require('./backend/context-injector');
// 刀 3: RunSessionAdapter —— 让后台 task session 变成实时一等会话
const { RunSessionAdapter } = require('./backend/adapters/run-session');
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

// ── Claude 二进制路径 + /context 详情拉取 ──
const _CLAUDE_BIN = (() => {
  const { execSync } = require('child_process');
  try { return execSync('which claude', { encoding: 'utf-8' }).trim(); } catch {}
  const candidates = [
    path.join(process.env.HOME || '', '.claude/local/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'claude';
})();

function _parseContextMarkdown(md) {
  const out = { model: null, total: 0, max: 200000, pct: 0, categories: [], memoryFiles: [], skills: [], raw_markdown: md };
  const parseNum = (n, unit) => {
    const v = parseFloat(n);
    const u = (unit || '').toLowerCase();
    return Math.round(u === 'k' ? v * 1000 : u === 'm' ? v * 1000000 : v);
  };
  const m1 = md.match(/\*\*Model:\*\*\s+(\S+)/);
  if (m1) out.model = m1[1];
  const m2 = md.match(/\*\*Tokens:\*\*\s+([\d.]+)([km]?)\s*\/\s*([\d.]+)([km]?)\s*\((\d+)%\)/i);
  if (m2) { out.total = parseNum(m2[1], m2[2]); out.max = parseNum(m2[3], m2[4]); out.pct = parseInt(m2[5]); }
  const catSec = md.split('Estimated usage by category')[1]?.split(/\n###\s/)[0] || '';
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*([\d.]+)([km]?)\s*\|\s*([\d.]+)%\s*\|\s*$/gmi;
  let row;
  while ((row = rowRe.exec(catSec)) !== null) {
    const name = row[1].trim();
    if (/^(category|-+)$/i.test(name)) continue;
    out.categories.push({ name, tokens: parseNum(row[2], row[3]), pct: parseFloat(row[4]) });
  }
  const memSec = md.split(/###\s+Memory Files/i)[1]?.split(/\n###\s/)[0] || '';
  const memRe = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)([km]?)\s*\|\s*$/gmi;
  let mrow;
  while ((mrow = memRe.exec(memSec)) !== null) {
    const type = mrow[1].trim();
    if (/^(type|-+)$/i.test(type)) continue;
    out.memoryFiles.push({ type, path: mrow[2].trim(), tokens: parseNum(mrow[3], mrow[4]) });
  }
  const skillSec = md.split(/###\s+Skills/i)[1]?.split(/\n###\s/)[0] || '';
  let srow;
  while ((srow = memRe.exec(skillSec)) !== null) {
    const name = srow[1].trim();
    if (/^(skill|-+)$/i.test(name)) continue;
    out.skills.push({ name, source: srow[2].trim(), tokens: parseNum(srow[3], srow[4]) });
  }
  return out;
}

function _fetchContextDetail(claudeSid) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const args = ['-p', '/context', '--resume', claudeSid, '--fork-session', '--output-format', 'stream-json', '--verbose'];
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/opt/node/bin', '/usr/local/bin'];
    const envPath = (process.env.PATH || '/usr/bin:/bin');
    const fullPath = [...extraPaths, ...envPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');
    const env = { ...process.env, PATH: fullPath };
    if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    // 见 backend/claude-client.js 同段说明：剥掉宿主 Claude Desktop / 上层
    // Claude Code 注入的 OAuth env，避免 spawn 出去的 claude CLI 用错 token。
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDECODE;
    const proc = spawn(_CLAUDE_BIN, args, { cwd: VAULT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 20000);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', (e) => { clearTimeout(killer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      const lines = stdout.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]);
          if (ev.type === 'result' && ev.result) return resolve(_parseContextMarkdown(ev.result));
        } catch {}
      }
      reject(new Error(stderr || `claude /context exit ${code}, no result`));
    });
  });
}


// ── Session compact/restore helpers（auto-compact 用）──
const _SESSION_BACKUP_DIR = path.join(VAULT_ROOT, 'Pi', 'Log', 'claude-session-backup');
const _compactInFlight = new Set(); // sid -> prevent concurrent compact of same session

// Claude CLI 把 cwd 里所有非 [a-zA-Z0-9] 字符转成 `-`（含 `_`、`.`、`/`）。
// 只替换 `/` 会让含 `_` 的 VAULT_ROOT（如 `~/my_vault`）算成 `-Users-x-my_vault`，
// 而 Claude 实际目录是 `-Users-x-my-vault`，导致候选 existsSync 永远 false，
// 每次都 fall back 扫 20+ 子目录拖慢主进程。
function _findClaudeJsonl(sid) {
  const projectsBase = path.join(process.env.HOME || '', '.claude', 'projects');
  if (!fs.existsSync(projectsBase)) return null;
  const vaultEncoded = VAULT_ROOT.replace(/[^a-zA-Z0-9]/g, '-');
  for (const dir of [vaultEncoded, '-']) {
    const p = path.join(projectsBase, dir, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const dir of fs.readdirSync(projectsBase)) {
      const p = path.join(projectsBase, dir, `${sid}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function _backupSessionJsonl(sid) {
  const src = _findClaudeJsonl(sid);
  if (!src) throw new Error(`session JSONL not found: ${sid}`);
  if (!fs.existsSync(_SESSION_BACKUP_DIR)) fs.mkdirSync(_SESSION_BACKUP_DIR, { recursive: true });
  const ts = Date.now();
  const dst = path.join(_SESSION_BACKUP_DIR, `${sid}-${ts}.jsonl`);
  fs.copyFileSync(src, dst);
  return { backupPath: dst, ts, sizeBefore: fs.statSync(src).size, sourcePath: src };
}

function _compactSession(claudeSid) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const args = ['-p', '/compact', '--resume', claudeSid, '--output-format', 'stream-json', '--verbose'];
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/opt/node/bin', '/usr/local/bin'];
    const envPath = (process.env.PATH || '/usr/bin:/bin');
    const fullPath = [...extraPaths, ...envPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');
    const env = { ...process.env, PATH: fullPath };
    if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    // 同 _fetchContextDetail：剥宿主注入的 OAuth env，避免误用别 session 的 token。
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDECODE;
    const proc = spawn(_CLAUDE_BIN, args, { cwd: VAULT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 300000); // 5min
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', (e) => { clearTimeout(killer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(stderr || `claude /compact exit ${code}`));
      const lines = stdout.split('\n').filter(l => l.trim());
      let resultEvent = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const ev = JSON.parse(lines[i]); if (ev.type === 'result') { resultEvent = ev; break; } } catch {}
      }
      resolve({ duration_ms: resultEvent?.duration_ms || null, session_id: resultEvent?.session_id || claudeSid });
    });
  });
}

function _restoreSessionFromBackup(sid, backupPath) {
  if (!fs.existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  if (!backupPath.startsWith(_SESSION_BACKUP_DIR)) throw new Error('backup path outside backup dir');
  const dst = _findClaudeJsonl(sid);
  if (!dst) throw new Error(`cannot locate target JSONL for sid ${sid}`);
  fs.copyFileSync(backupPath, dst);
  return { restored: true, sizeAfter: fs.statSync(dst).size };
}

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
let nextTabId = 1;
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
const SESSION_SIDEBAR_WIDTH = 260;
let pinnedTabs = new Set(); // 置顶的 tab id
let homeTabId = null; // Home tab 不可关闭
let pulse = null; // Pi pulse 实例（app.whenReady 里实例化；httpServer / main scope 共享引用）
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

function loadCredentials() {
  try { for (const [k,v] of Object.entries(JSON.parse(fs.readFileSync(credFile,'utf-8')))) savedCredentials.set(k,v); } catch {}
}
function persistCredentials() {
  try { fs.writeFileSync(credFile, JSON.stringify(Object.fromEntries(savedCredentials))); } catch {}
}

// 快捷输入
function detectTripleOpt() {} // no-op，保留引用

// 启动条件追踪
let _apiReady = false;
let _windowReady = false;
let _homeCreating = false;
function tryCreateHomeTabs() {
  if (!_apiReady || !_windowReady || homeTabId || _homeCreating) return;
  // 未装完时禁建 Home BrowserView——它是 Electron 原生层，z-index 管不到，
  // 会盖住孵化仪式 / Setup Wizard overlay（renderer/index.html）。setup 完后由 pios:install handler 再触发。
  if (!installer.isInstalled()) return;
  _homeCreating = true;
  sidebarCollapsed = false;  // 启动时 sidebar 展开（跟 renderer 同步）
  homeTabId = createTab('http://127.0.0.1:17891/home');
  // 立即设置 Home 标题（不等 page-title-updated）
  const homeTab = tabs.find(t => t.id === homeTabId);
  if (homeTab) homeTab.title = 'Home';
  pinnedTabs.add(homeTabId);
  const saved = loadSavedTabs();
  for (const t of saved) {
    if (!/127\.0\.0\.1:17891|localhost:17891/.test(t.url)) {
      const id = createTab(t.url);
      const restoredTab = tabs.find(tab => tab.id === id);
      if (restoredTab && t.favicon) restoredTab.favicon = t.favicon;
      if (restoredTab && t.title) restoredTab.title = t.title;
      if (restoredTab && t.sessionId) restoredTab.sessionId = t.sessionId;
      if (t.pinned) pinnedTabs.add(id);
    }
  }
  switchToTab(homeTabId);
  sendTabsUpdate();
  // 延迟保存：等恢复的 tab 加载完 favicon 后再写盘，避免覆盖已存的 favicon
  setTimeout(() => saveTabs(), 10000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: savedWindowState.width,
    height: savedWindowState.height,
    ...(savedWindowState.x !== undefined && savedWindowState.y !== undefined
      ? { x: savedWindowState.x, y: savedWindowState.y } : {}),
    title: 'PiOS',
    backgroundColor: '#212121',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  // 全屏/最大化恢复
  if (savedWindowState.maximized) mainWindow.maximize();
  if (savedWindowState.fullscreen) mainWindow.setFullScreen(true);

  mainWindow.loadFile('renderer/index.html');

  // renderer 加载完成后同步状态
  mainWindow.webContents.on('did-finish-load', () => {
    // 同步 sidebar 宽度（防止 CSS 变量和 main.js 不一致）
    mainWindow.webContents.executeJavaScript(
      `document.documentElement.style.setProperty('--sidebar-width', '${sidebarWidth}px')`
    ).catch(() => {});
    if (activeTabId) {
      layoutActiveTab();
      mainWindow.webContents.send('mode:change', 'browser');
      sendTabsUpdate();
    }
  });

  // 开发模式打开 DevTools
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  }

  // 监听 app 激活（CMD+Tab 切回来）
  app.on('browser-window-focus', () => {
    // TODO Phase 2: 检测上一个 app 是否是 Terminal，抓取终端内容
  });
}

// Tab 信息（发给 renderer 的精简数据）
function getTabsInfo() {
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, favicon: t.favicon || '', active: t.id === activeTabId, pinned: pinnedTabs.has(t.id), isHome: t.id === homeTabId }));
}

let _saveTabsTimer = null;
function sendTabsUpdate() {
  if (mainWindow) mainWindow.webContents.send('tabs:updated', getTabsInfo());
}

function layoutActiveTab() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.view) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getContentBounds();
  if (b.width < 10 || b.height < 10) return;
  const tabBarHeight = 40;
  const topOffset = 44 + tabBarHeight;  // topbar(44) + tab bar(40)
  const leftMargin = sessionSidebarOpen ? SESSION_SIDEBAR_WIDTH : 0;
  const rightMargin = sidebarCollapsed ? 0 : sidebarWidth;
  const bounds = {
    x: leftMargin, y: topOffset,
    width: Math.max(b.width - rightMargin - leftMargin, 100),
    height: Math.max(b.height - topOffset, 100)
  };
  tab.view.setBounds(bounds);
}

// Basic Auth 对话框（替代 prompt()，Electron v35 里 prompt() 可能被拦截）
let _authDialogOpen = false;
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
      parent: mainWindow, modal: true,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    authWin.loadFile('auth-dialog.html', { query: { host } });
    function done(result) {
      _authDialogOpen = false;
      ipcMain.removeListener('auth-dialog:submit', onSubmit);
      ipcMain.removeListener('auth-dialog:cancel', onCancel);
      if (!authWin.isDestroyed()) authWin.close();
      resolve(result);
    }
    function onSubmit(_, creds) { done(creds); }
    function onCancel() { done(null); }
    ipcMain.once('auth-dialog:submit', onSubmit);
    ipcMain.once('auth-dialog:cancel', onCancel);
    authWin.on('closed', () => { _authDialogOpen = false; ipcMain.removeListener('auth-dialog:submit', onSubmit); ipcMain.removeListener('auth-dialog:cancel', onCancel); resolve(null); });
  });
}

// 创建新 tab

function createTab(url, opts = {}) {
  const focus = opts.focus !== false; // 默认 true — 只有 AI 后台任务显式传 false
  const id = nextTabId++;
  const browserPreload = path.join(__dirname, 'browser-preload.js');
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
    const cached = savedCredentials.get(cacheKey);
    if (cached) { callback(cached.username, cached.password); return; }
    showAuthDialog(authInfo.host).then(r => {
      if (r && r.u) {
        savedCredentials.set(cacheKey, { username: r.u, password: r.p });
        persistCredentials();
        callback(r.u, r.p);
      } else {
        callback(); // 用户取消 → 中止，不再重试
      }
    }).catch(() => callback());
  });

  const sessionId = require('crypto').randomUUID();
  const tab = { id, title: 'Loading...', url, view, loading: true, canGoBack: false, canGoForward: false, sessionId, threadId: null };
  tabs.push(tab);

  // Home tab 保护：外部导航不覆盖 Home
  view.webContents.on('will-navigate', (event, newUrl) => {
    if (tab.id === homeTabId && !/127\.0\.0\.1:17891|localhost:17891/.test(newUrl)) {
      event.preventDefault();
      createTab(newUrl);
    }
  });

  view.webContents.on('did-navigate', (_, newUrl) => {
    tab.url = newUrl;
    tab.canGoBack = view.webContents.canGoBack();
    tab.canGoForward = view.webContents.canGoForward();
    if (tab.id === activeTabId) {
      mainWindow.webContents.send('browser:navigated', newUrl);
      mainWindow.webContents.send('browser:navState', { canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });
    }
    sendTabsUpdate();
  });
  view.webContents.on('did-navigate-in-page', (_, newUrl) => {
    tab.url = newUrl;
    tab.canGoBack = view.webContents.canGoBack();
    tab.canGoForward = view.webContents.canGoForward();
    if (tab.id === activeTabId) {
      mainWindow.webContents.send('browser:navigated', newUrl);
      mainWindow.webContents.send('browser:navState', { canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-sidebar:close');
    }
  });

  view.webContents.on('did-finish-load', () => {
    addToHistory(tab.title, tab.url);
    const url = tab.view.webContents.getURL();
    const invisible = isInvisible(url);
    // 通知渲染进程当前页面的隐私状态
    if (tab.id === activeTabId && mainWindow) {
      mainWindow.webContents.send('privacy:status', { invisible, incognito: isIncognito() });
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
    if (tab.id === activeTabId) mainWindow.webContents.send('browser:loading', true);
  });
  view.webContents.on('did-stop-loading', () => {
    tab.loading = false;
    if (tab.id === activeTabId) mainWindow.webContents.send('browser:loading', false);
  });

  // 加载失败 → 通知渲染进程显示错误
  view.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED
    // 自动重试（API 可能还没就绪）
    if (/127\.0\.0\.1:17891|localhost:17891/.test(validatedURL)) {
      setTimeout(() => { try { view.webContents.loadURL(validatedURL); } catch {} }, 2000);
      return;
    }
    if (tab.id === activeTabId) {
      mainWindow.webContents.send('browser:loadError', { url: validatedURL, error: errorDescription, code: errorCode });
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
          mainWindow.webContents.send('terminal:context', params.selectionText);
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
    item.on('done', (_, state) => {
      if (state === 'completed') {
        mainWindow.webContents.send('browser:download', { name: item.getFilename(), path: downloadsPath, state: 'completed' });
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

// 切换 tab
function switchToTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;

  // 保存当前 tab 的 threadId
  const prev = tabs.find(t => t.id === activeTabId);
  if (prev) prev.threadId = currentThreadId;
  if (prev && prev.view) mainWindow.removeBrowserView(prev.view);

  activeTabId = id;
  // 恢复新 tab 的 threadId
  currentThreadId = tab.threadId || null;

  const wasChat = currentMode !== 'browser';
  if (wasChat) {
    currentMode = 'browser';
    // 保留已设置的折叠状态（启动时 sidebarCollapsed=true 表示全屏 Home）
    if (!sidebarCollapsed) sidebarCollapsed = false;
    sessionSidebarOpen = false;
  }
  mainWindow.setBrowserView(tab.view);
  layoutActiveTab();
  if (wasChat) {
    mainWindow.webContents.send('mode:change', 'browser');
  }
  mainWindow.webContents.send('browser:navigated', tab.url);
  mainWindow.webContents.send('session:switchToTab', tab.sessionId);
  sendTabsUpdate();
  // 切换 tab 时推送新页面上下文
  autoExtractPageContext(tab);
}

// 关闭 tab
function closeTab(id) {
  // Home tab 不可关闭
  if (id === homeTabId) return;
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];

  // 最后一个 tab → 不关闭，导航到 Home
  if (tabs.length === 1) {
    tab.view.webContents.loadURL('http://127.0.0.1:17891/home');
    return;
  }

  if (tab.id === activeTabId) mainWindow.removeBrowserView(tab.view);
  stopDwellTracking(tab.id);
  tab.view.webContents.destroy();
  tabs.splice(idx, 1);

  if (tab.id === activeTabId) {
    switchToTab(tabs[Math.min(idx, tabs.length - 1)].id);
  }
  sendTabsUpdate();
  saveTabs();
}

// 切换回聊天模式（保留 tabs）
function switchToChatMode() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) mainWindow.removeBrowserView(tab.view);
  currentMode = 'chat';
  // 有 tabs 时发 'chat-with-tabs'，renderer 保留 tab 栏
  mainWindow.webContents.send('mode:change', tabs.length > 0 ? 'chat-with-tabs' : 'chat');
}

// IPC handlers
function _owner() { try { return require('./backend/vault-context').getOwnerName(); } catch { return 'User'; } }
function _persona() {
  try { return require('./backend/pi-persona').personaBlock(_owner()); }
  catch { return ''; }
}

const CODEX_VOICE_PROMPT_TPL = () => `你是 Pi，运行在 ${_owner()} 的 AI 浏览器里。直接、清晰回答。

## 手口并用
${_owner()} 坐在电脑前，看着屏幕，戴着耳机。
你有两个输出通道：屏幕（文字）和耳机（语音）。用 <say> 标签标记要朗读的内容。

规则：
- 每次回复至少一个简短的 <say>
- <say> 只放短句、口语化内容（不超过25字）
- 长内容、列表、代码放在标签外
- 不要表演，不要寒暄，不要油腻口吻
- 优先像一个干练的 coding/debug 助手，而不是陪聊角色

## 能力边界
- 可以分析当前页面内容和对话上下文
- 可以回答代码、日志、系统设计、排查问题
- 不要默认引用 PiOS 全局状态；除非用户明确在问系统现状或任务看板
`;

// ── GPT Direct (用 Codex OAuth 直连 ChatGPT backend API) ──
const GPT_VOICE_PROMPT_TPL = () => `你是 Pi，${_owner()} 的 AI 助手。直接、简洁回答。

## 手口并用
你有两个输出通道：屏幕（文字）和耳机（语音）。用 <say> 标签标记语音内容。

想象你坐在 ${_owner()} 旁边，两人看着同一块屏幕。你可以说话，也可以在屏幕上打字，自然地选择：
- 口头说就够的事（闲聊、短回答、口头确认），直接 <say>，屏幕不用重复
- 需要看的东西（数据、代码、列表、长文、故事），放屏幕，不用念出来
- 两者配合时，语音说你的判断和结论，屏幕展开证据和细节。语音不要复述屏幕内容

唯一的硬规则：不要说废话。"我来帮你看看""以上就是结果"这种不包含信息的话，不要放进 <say>。

## 自由音色（多人声）
你可以用不同声音说话：\`<say voice="预设名">内容</say>\`。可用预设：
- **default** — 正式男声（日常工作、汇报、分析、严肃话题）
- **warm** — 温柔女声（安慰、鼓励、闲聊、关心）
- **fun** — 搞笑女声（调侃、吐槽、惊讶）
- **eric** — 方言搞笑男（极度搞笑、强烈吐槽、逗用户开心）
- **owner** — 用户克隆声（特殊场合、模拟用户说话；要求用户先用 voice-clone skill 克隆自己的声音才会启用）

选声音的原则：匹配内容的情绪，不要机械轮换。好消息用 warm，坏消息用 default，一般调侃用 fun，极度搞笑用 eric，特殊场合用 owner。
不带 voice 属性时默认用 default。

## 路由规则（仅 Auto 模式生效）
你有一个搭档引擎，擅长在用户机器上执行操作。

只有在以下情况才输出 \`<<EXEC>>\` 作为第一行，系统会自动切换到执行引擎：
- 需要**写入/修改/删除**文件或代码
- 需要**运行**脚本、命令、程序
- 需要访问**实时系统状态**（进程、日志、网络、传感器）
- 用户说"去查/去做/去搞/去看看"等明确要求操作

以下情况**不要**输出 <<EXEC>>，直接回答：
- 用户发来了文件/图片内容让你分析、解释、总结
- 用户问一般知识、做规划、聊天
- 你看了附件内容就能回答

**附件内容已在消息里，看到了就直接分析，不要甩给执行引擎。**
${_persona()}`;

// 刀 2 step 6b: `pi:gpt` + `gpt:stop` handler 已删 —— GPT 走 SessionBus 的 gpt adapter。
// 老 handler 的 prompt 构造 + web search + auto/clean 模式分支逻辑抽到这里，
// 注入给 GPTDirectAdapter，send 前调用一次拿到组装好的 prompt。
//
// 2026-04-23 · F5/Bubble 语音场景标记：owner 用 F5 快捷键 / bubble 语音按钮问话
// 时设 true，prepareGPTRequest 消费一次后清。让 Pi 知道"这一轮 owner 没在看屏幕"。
let _nextTurnVoiceOnly = false;

// prepareGPTRequest(userMessage, { sessionId, clean, auto }) →
//   { systemPrompt, fullMessage, searchResults }
async function prepareGPTRequest(userMessage, { sessionId = MAIN_SESSION_ID, clean = false, auto = false } = {}) {
  const isClean = clean === true;
  const isAuto = auto === true;
  // 消费并重置 voice-only flag（单用户单轮串行，无 race）
  const voiceOnly = _nextTurnVoiceOnly;
  _nextTurnVoiceOnly = false;

  const context = isClean ? '' : buildSystemContext({ includeProfile: true, includeDiary: true, includeCards: true });
  let basePrompt = GPT_VOICE_PROMPT_TPL();
  if (!isAuto) {
    // 非 Auto 模式：去掉路由规则段
    basePrompt = basePrompt.replace(/\n\n## 路由规则[\s\S]*$/, '');
  }
  const sessData = loadSessions();
  const proactiveCtx = (!isClean && sessData.activeId === MAIN_SESSION_ID)
    ? await contextInjector.buildContext(MAIN_SESSION_ID, { sources: ['proactive'] })
    : '';
  const eventsCtx = !isClean
    ? await contextInjector.buildContext(sessionId || MAIN_SESSION_ID, { sources: ['events'] })
    : '';

  // 2026-04-23 · 本轮 owner 按 F5 或 bubble 语音按钮——告诉 Pi 场景，让她自己判断
  const voiceChannelNote = voiceOnly ? `

---

## 本轮输入 channel：F5 / Bubble 语音快捷键

owner 是按 F5 或气泡语音按钮问的这一轮——他**多半不在看屏幕**（走路 / 做饭 / 躺着 / 开车 / 在外面）。

这意味着：
- \`<say>\` 标签**外**的文本他听不到也看不到——等同于没说
- 你要让他真收到信息，必须全部放进 \`<say>\` 里

怎么处理交给你自己判断：
- 短答就一句 \`<say>\` 说完
- 如果内容真的长到念完要 2 分钟（比如"展开 14 件 Things Need You 的每件细节"），你可以选择念几件关键的 + 在 \`<say>\` 里告诉他"剩下的你回电脑我屏幕给你"
- 一般的聊天、建议、判断，直接一段话说完，不要拆屏幕段

不要机械。按当下情境判断。` : '';

  const systemPrompt = isClean
    ? `你是一个通用 AI 助手。直接、简洁回答。用 <say> 标签标记语音内容。${voiceChannelNote}`
    : `${basePrompt}\n\n${context}${proactiveCtx}${eventsCtx}${voiceChannelNote}`;

  // 智能搜索
  let searchContext = '';
  let searchResults = null;
  const rawQuery = userMessage.replace(/^\[.*?\]\n[\s\S]*?\[(?:问题|当前问题)\]\n/m, '').trim();
  const queryClass = classifyQuery(rawQuery);
  if (queryClass.needsSearch) {
    try {
      const results = await webSearch(rawQuery, { maxResults: 8, timeout: 6000 });
      if (results.length) {
        searchContext = '\n\n' + formatResultsForPrompt(results)
          + '\n\n请在回答中引用上述搜索结果，使用 markdown 链接格式 [标题](URL) 标注来源。';
        searchResults = categorizeResults(results);
      }
    } catch (e) {
      console.warn('[prepareGPTRequest] web search failed:', e.message);
    }
  }

  const fullMessage = userMessage + searchContext;
  return { systemPrompt, fullMessage, searchResults };
}

// Short-follow-up gate：renderer 把 `[PiOS 系统状态]` / `[当前页面]` 等预注块塞在
// `[问题]\n<text>` 前面。如果 <text> 是"什么情况 / 嗯 / 继续"之类对话性追问，模型会
// 把前面的状态 dump 当作被问对象（2026-04-24 Pi Codex session mocg758jdirmde 的证据
// 链：turn 4 "什么情况" 误答 triage 队列）。命中时剥掉预注块，只传裸文本，且跳过
// events 注入，避免 `可在回答里自然转述` 指令同一圈再污染一次。
function _extractQuestionFromPreamble(msg) {
  if (typeof msg !== 'string') return '';
  // 匹配 `[问题]\n...` —— 可能在串首或前面有 preamble + `\n\n`
  const m = msg.match(/(?:^|\n)\[问题\]\n([\s\S]*)$/);
  return m ? m[1].trim() : msg.trim();
}

const _SHORT_FOLLOWUP_RE = /^(什么情况|什么意思|怎么回事|怎么了|怎么样|然后呢|然后|继续|接着|为什么|为啥|为何|好的|可以|是的|是|不是|不|对|对的|好|哦|噢|嗯|嗯嗯|啊|啥|呃|行)[。？！，.,\s]*$/;
function _isShortFollowUp(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length <= 8 && !t.includes('\n')) return true;
  return _SHORT_FOLLOWUP_RE.test(t);
}

async function prepareCodexRequest(userMessage, { sessionId, clean = false, continued = false } = {}) {
  const isClean = clean === true;

  // 2026-04-24: short follow-up gate — renderer 预注的状态/页面 dump 对"什么情况"这类
  // 追问是噪音。命中 gate 时 strip dump，并跳过 events 注入。
  const question = _extractQuestionFromPreamble(userMessage);
  const shortFollowUp = _isShortFollowUp(question);
  const effectiveMessage = shortFollowUp ? question : userMessage;

  const eventsCtx = (!isClean && !shortFollowUp)
    ? await contextInjector.buildContext(sessionId || 'codex', { sources: ['events'] })
    : '';

  if (continued) {
    const reminder = isClean
      ? '继续当前对话。记住：这不是纯文字聊天，你有屏幕和耳机两个输出通道。每次回复至少给一个简短的 <say>，只把短句放进 <say>。'
      : '继续当前对话。保持简洁、直接、像资深 coding/debug 助手。每次回复至少给一个简短、口语化的 <say> 先开口；长内容、列表、代码放在标签外。';
    return {
      fullMessage: `${reminder}${eventsCtx}\n\n[当前消息]\n${effectiveMessage}`,
    };
  }

  const systemPrompt = isClean
    ? '你是一个通用 AI 助手。直接、简洁回答。每次回复至少给一个简短的 <say> 标签内容，标签外只写屏幕文字。'
    : CODEX_VOICE_PROMPT_TPL();

  return {
    fullMessage: `${systemPrompt}${eventsCtx}\n\n## 回复要求\n- 每次回复至少一个 <say>\n- 先说一句，再展开正文\n- 只有短句放进 <say>\n- 列表、代码、长段落放在标签外\n\n[用户消息]\n${effectiveMessage}`,
  };
}

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

// 自动提取页面上下文并推送到渲染进程
async function autoExtractPageContext(tab) {
  if (!tab || !tab.view || !mainWindow) return;
  // 只推送当前活跃标签页的上下文
  if (tab.id !== activeTabId) return;
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
    if (tab.id !== activeTabId) return;
    mainWindow.webContents.send('page:contextUpdate', { title, url, text });
  } catch {
    // 页面可能已销毁，静默忽略
  }
}

ipcMain.handle('pi:getPageContent', async () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.view) return null;
  try {
    const url = tab.view.webContents.getURL();
    // AI 不可见站点：不返回内容
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

ipcMain.on('browser:navigate', (_, url) => {
  url = completeURL(url);
  // Home URL → 切到已有的 Home tab，不新建
  if (/127\.0\.0\.1:17891\/home|localhost:17891\/home/.test(url)) {
    if (homeTabId) { switchToTab(homeTabId); return; }
    const existing = tabs.find(t => /127\.0\.0\.1:17891|localhost:17891/.test(t.url));
    if (existing) { switchToTab(existing.id); return; }
  }
  if (currentMode === 'browser' && activeTabId) {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab) {
      if (pinnedTabs.has(tab.id)) { createTab(url); return; }
      tab.view.webContents.loadURL(url);
      return;
    }
  }
  createTab(url);
});

ipcMain.on('tab:new', (_, url) => {
  createTab(completeURL(url || 'http://127.0.0.1:17891/home'));
});

ipcMain.on('tab:close', (_, id) => {
  closeTab(id);
});

ipcMain.on('tab:switch', (_, id) => {
  switchToTab(id);
});

ipcMain.on('browser:backToChat', () => {
  switchToChatMode();
  // 保留 tabs 信息发送给 renderer，让 tab 栏可选回
  sendTabsUpdate();
});

// Cmd+\ 退出全屏：恢复 BrowserView，但不动 currentSession（不发 session:switchToTab）。
// switchToTab 会发 session:switchToTab → renderer 把 currentSession 换成 tab.sessionId
// 那个 ghost UUID，导致用户从 sidebar 选的 session 被偷换。view-toggle 不该有 session 副作用。
ipcMain.on('browser:restoreFromFullscreen', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.view) return;
  currentMode = 'browser';
  mainWindow.setBrowserView(tab.view);
  layoutActiveTab();
  mainWindow.webContents.send('mode:change', 'browser');
  mainWindow.webContents.send('browser:navigated', tab.url);
  sendTabsUpdate();
});

// Home 页深链接：打开指定 conversationId 的会话
ipcMain.on('home:openConversation', (_, conversationId) => {
  if (!conversationId) return;
  switchToChatMode();
  sendTabsUpdate();
  mainWindow.webContents.send('session:openConversation', conversationId);
});

// 置顶/取消置顶 tab
ipcMain.on('tab:pin', (_, id) => {
  if (pinnedTabs.has(id)) {
    pinnedTabs.delete(id);
  } else {
    pinnedTabs.add(id);
  }
  sendTabsUpdate();
  saveTabs();
});

// Tab 右键菜单（原生 Menu，不被 BrowserView 遮挡）
ipcMain.on('tab:contextmenu', (_, id) => {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  const isPinned = pinnedTabs.has(id);
  const { Menu } = require('electron');
  const menu = Menu.buildFromTemplate([
    { label: isPinned ? '取消置顶' : '置顶标签页', click: () => { if (isPinned) pinnedTabs.delete(id); else pinnedTabs.add(id); sendTabsUpdate(); saveTabs(); } },
    { label: '复制标签页', click: () => { createTab(tab.url); } },
    { type: 'separator' },
    { label: '关闭', click: () => { closeTab(id); } },
    { label: '关闭其他', click: () => { tabs.filter(t => t.id !== id && !pinnedTabs.has(t.id)).forEach(t => closeTab(t.id)); } },
  ]);
  menu.popup({ window: mainWindow });
});

// 导航控制
ipcMain.on('browser:goBack', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) tab.view.webContents.goBack();
});

ipcMain.on('browser:goForward', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) tab.view.webContents.goForward();
});

ipcMain.on('browser:reload', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) tab.view.webContents.reload();
});

// 页面内搜索
ipcMain.on('browser:findInPage', (_, text) => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) {
    if (text) {
      tab.view.webContents.findInPage(text);
    } else {
      tab.view.webContents.stopFindInPage('clearSelection');
    }
  }
});

// 页面缩放
ipcMain.on('browser:zoomIn', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) {
    const level = tab.view.webContents.getZoomLevel();
    tab.view.webContents.setZoomLevel(Math.min(level + 0.5, 5));
  }
});

ipcMain.on('browser:zoomOut', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) {
    const level = tab.view.webContents.getZoomLevel();
    tab.view.webContents.setZoomLevel(Math.max(level - 0.5, -5));
  }
});

ipcMain.on('browser:zoomReset', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) tab.view.webContents.setZoomLevel(0);
});

// 标签持久化 — 重启恢复
const tabsFile = path.join(app.getPath('userData'), 'saved-tabs.json');

function saveTabs() {
  if (_saveTabsTimer) { clearTimeout(_saveTabsTimer); _saveTabsTimer = null; }
  const data = tabs.map(t => ({ url: t.url, title: t.title, favicon: t.favicon || '', pinned: pinnedTabs.has(t.id), sessionId: t.sessionId || '' }));
  try { fs.writeFileSync(tabsFile, JSON.stringify(data)); } catch {}
}

function loadSavedTabs() {
  try { return JSON.parse(fs.readFileSync(tabsFile, 'utf-8')); } catch { return []; }
}

// 每 60 秒自动保存 tab 状态，防止异常退出丢数据
setInterval(() => { saveTabs(); }, 60000);

// Modal overlay：BrowserView 在 Electron 里始终压在 mainWindow.webContents 之上，
// z-index 不管用。打开 modal（如 context breakdown）时临时 removeBrowserView，
// 关闭时 setBrowserView 回来。解决 "modal 被 tab 内容盖住" 的通用问题。
let _savedActiveTabIdForModal = null;
ipcMain.handle('mainWindow:setModalOverlay', (_, open) => {
  if (!mainWindow) return { ok: false };
  if (open) {
    _savedActiveTabIdForModal = activeTabId;
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.view) mainWindow.removeBrowserView(tab.view);
    return { ok: true };
  } else {
    const tab = tabs.find(t => t.id === _savedActiveTabIdForModal);
    if (tab && tab.view) {
      mainWindow.setBrowserView(tab.view);
      layoutActiveTab();
    }
    _savedActiveTabIdForModal = null;
    return { ok: true };
  }
});

ipcMain.handle('tabs:restore', () => {
  // 恢复 pinned tabs
  const saved = loadSavedTabs();
  const pinned = saved.filter(t => t.pinned);
  for (const t of pinned) {
    const id = createTab(t.url);
    pinnedTabs.add(id);
  }
  return pinned.length;
});


ipcMain.handle('tabs:reorder', (_, { dragId, dropId }) => {
  const dragIdx = tabs.findIndex(t => t.id === dragId);
  const dropIdx = tabs.findIndex(t => t.id === dropId);
  if (dragIdx === -1 || dropIdx === -1 || dragIdx === dropIdx) return;
  const [dragTab] = tabs.splice(dragIdx, 1);
  tabs.splice(dropIdx, 0, dragTab);
  sendTabsUpdate();
  saveTabs();
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

// 强制 native BrowserView 重绘（setBounds 在 Electron 35 某些时序下不触发重绘）
function forceRelayout() {
  if (currentMode !== 'browser') return; // 非浏览器模式不需要 BrowserView
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.view || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.removeBrowserView(tab.view);
  mainWindow.setBrowserView(tab.view);
  layoutActiveTab();
}

// 侧边栏折叠/展开 — 调整 BrowserView 宽度
ipcMain.on('sidebar:collapse', () => {
  sidebarCollapsed = true;
  forceRelayout();
});

ipcMain.on('sidebar:expand', () => {
  sidebarCollapsed = false;
  forceRelayout();
});

// 左侧会话列表 — 调整 BrowserView x 偏移
ipcMain.on('session-sidebar:open', () => {
  sessionSidebarOpen = true;
  forceRelayout();
});

ipcMain.on('session-sidebar:close', () => {
  sessionSidebarOpen = false;
  forceRelayout();
});

ipcMain.on('sidebar:resize', (_, width) => {
  const maxWidth = mainWindow ? Math.floor(mainWindow.getContentBounds().width * 0.6) : 600;
  sidebarWidth = Math.max(200, Math.min(maxWidth, width));
  try { fs.writeFileSync(sidebarWidthFile, JSON.stringify({ width: sidebarWidth })); } catch {}
  layoutActiveTab();
});

// 面板打开/关闭 — 临时移除 BrowserView 以避免 native 层遮挡 HTML overlay
ipcMain.on('panel:open', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.view) mainWindow.removeBrowserView(tab.view);
});

ipcMain.on('panel:close', () => {
  if (currentMode === 'browser') {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.view) {
      mainWindow.setBrowserView(tab.view);
      layoutActiveTab();
    }
  }
});

// 手动请求当前页面上下文（快捷键 Cmd+I 触发）
ipcMain.on('page:requestContext', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab) autoExtractPageContext(tab);
});

// ── Browser Interaction: execJS + screenshot ──
ipcMain.handle('browser:execJS', async (_, code) => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.view) return { error: 'no active tab' };
  try {
    const result = await tab.view.webContents.executeJavaScript(code);
    return { result: String(result).substring(0, 10000) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('browser:screenshot', async () => {
  const tab = tabs.find(t => t.id === activeTabId);
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
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
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

const IMAGE_EXT = new Set(['png','jpg','jpeg','gif','webp','svg']);
const TEXT_EXT = new Set(['txt','md','js','ts','jsx','tsx','py','go','java','c','cpp','h','css','html','json','yaml','yml','sh','rb','rs','kt','swift','toml','ini','env','csv','xml','log','conf','cfg','properties','gradle','makefile','dockerfile','gitignore','editorconfig','babelrc','eslintrc']);
const EXCEL_EXT = new Set(['xlsx','xls','xlsm','ods','numbers','csv']);
const WORD_EXT = new Set(['docx','doc']);

function parseExcelBuffer(buffer) {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const parts = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (csv.trim()) parts.push(`[Sheet: ${sheetName}]\n${csv}`);
    }
    return parts.join('\n\n').substring(0, 60000) || null;
  } catch (e) {
    console.warn('[xlsx] parse failed:', e.message);
    return null;
  }
}

async function parseWordBuffer(buffer) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value ? result.value.substring(0, 60000) : null;
  } catch (e) {
    console.warn('[mammoth] parse failed:', e.message);
    return null;
  }
}

// 统一内容提取：给定 ext + buffer，返回 { isImage, isPDF, content, base64 }
async function extractFileContent(ext, buf, size) {
  const isImage = IMAGE_EXT.has(ext);
  const isPDF = ext === 'pdf';
  const isExcel = EXCEL_EXT.has(ext) && ext !== 'csv';
  const isWord = WORD_EXT.has(ext);
  const isText = TEXT_EXT.has(ext);
  let content = null, base64 = null;
  if (isImage) {
    base64 = buf.toString('base64');
  } else if (isPDF) {
    content = await parsePDFBuffer(buf);
  } else if (isExcel) {
    content = parseExcelBuffer(buf);
  } else if (isWord) {
    content = await parseWordBuffer(buf);
  } else if (isText && size < 500 * 1024) {
    content = buf.toString('utf-8');
  }
  return { isImage, isPDF, isExcel, isWord, content, base64 };
}
async function parsePDFBuffer(buffer) {
  return new Promise((resolve) => {
    try {
      const PDFParser = require('pdf2json');
      const parser = new PDFParser(null, 1); // 1 = raw text mode
      parser.on('pdfParser_dataReady', () => {
        try {
          const text = parser.getRawTextContent();
          resolve(text ? text.substring(0, 60000) : null);
        } catch { resolve(null); }
      });
      parser.on('pdfParser_dataError', (e) => {
        console.warn('[pdf2json] error:', e.parserError);
        resolve(null);
      });
      parser.parseBuffer(buffer);
    } catch (e) {
      console.warn('[pdf2json] load failed:', e.message);
      resolve(null);
    }
  });
}

async function processFilePathsAsync(filePaths) {
  const results = [];
  for (const fp of filePaths) {
    const name = path.basename(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    try {
      const buf = fs.readFileSync(fp);
      const extracted = await extractFileContent(ext, buf, stat.size);
      results.push({ name, ext, size: stat.size, filePath: fp, ...extracted });
    } catch { continue; }
  }
  return results;
}

function processFilePaths(filePaths) {
  return filePaths.map(fp => {
    const name = path.basename(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    let stat;
    try { stat = fs.statSync(fp); } catch { return null; }
    const isImage = IMAGE_EXT.has(ext);
    const isText = TEXT_EXT.has(ext);
    let content = null, base64 = null;
    if (isImage) {
      try { base64 = fs.readFileSync(fp).toString('base64'); } catch {}
    } else if (isText && stat.size < 500 * 1024) {
      try { content = fs.readFileSync(fp, 'utf-8'); } catch { content = null; }
    }
    return { name, ext, size: stat.size, content, isImage, isPDF, base64, filePath: fp };
  }).filter(Boolean);
}

ipcMain.handle('browser:getStructuredPage', async () => {
  const tab = tabs.find(t => t.id === activeTabId);
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

  // 用 Menu accelerator 代替 globalShortcut，只在 app 聚焦时生效
  const menu = Menu.buildFromTemplate([
    {
      label: 'Pi',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: '新标签页', accelerator: 'CmdOrCtrl+T', click: () => createTab('http://127.0.0.1:17891/home') },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => { if (activeTabId) closeTab(activeTabId); } },
        { type: 'separator' },
        { label: '添加书签', accelerator: 'CmdOrCtrl+D', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab) mainWindow.webContents.send('bookmarks:promptAdd', { title: tab.title, url: tab.url });
        }},
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: '页面内搜索', accelerator: 'CmdOrCtrl+F', click: () => {
          mainWindow.webContents.send('browser:showFind');
        }},
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab && tab.view) tab.view.webContents.setZoomLevel(Math.min(tab.view.webContents.getZoomLevel() + 0.5, 5));
        }},
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab && tab.view) tab.view.webContents.setZoomLevel(Math.max(tab.view.webContents.getZoomLevel() - 0.5, -5));
        }},
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab && tab.view) tab.view.webContents.setZoomLevel(0);
        }},
        { type: 'separator' },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab && tab.view) tab.view.webContents.reload();
        }},
        { role: 'togglefullscreen' },
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        { label: '后退', accelerator: 'CmdOrCtrl+[', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab && tab.view) tab.view.webContents.goBack();
        }},
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab && tab.view) tab.view.webContents.goForward();
        }},
        { type: 'separator' },
        { label: '历史记录', accelerator: 'CmdOrCtrl+Y', click: () => {
          mainWindow.webContents.send('browser:showHistory');
        }},
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: '问 Pi (页面内容)', accelerator: 'CmdOrCtrl+J', click: () => {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab && tab.view) {
            tab.view.webContents.executeJavaScript(
              `window.getSelection().toString() || document.body.innerText.substring(0, 3000)`
            ).then(text => {
              mainWindow.webContents.send('terminal:context', text);
            }).catch(() => {});
          }
        }},
        { label: '切换引擎 Codex/Claude', accelerator: 'CmdOrCtrl+E', click: () => {
          mainWindow.webContents.send('engine:toggle');
        }},
        { label: '切换侧边栏', accelerator: 'CmdOrCtrl+Shift+.', click: () => {
          mainWindow.webContents.send('sidebar:toggle');
        }},
        { label: '全屏聊天', accelerator: 'CmdOrCtrl+\\', click: () => {
          mainWindow.webContents.send('chat:fullscreen-toggle');
        }},
        { label: '切换会话列表', accelerator: 'CmdOrCtrl+Shift+B', click: () => {
          mainWindow.webContents.send('session-sidebar:toggle');
        }},
        { label: '回到 Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => {
          mainWindow.webContents.send('navigate:home');
        }},
        { label: 'Talk to Pi', accelerator: 'CmdOrCtrl+P', click: () => {
          mainWindow.webContents.send('shortcut:talkToPi');
        }},
        { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => {
          mainWindow.webContents.send('shortcut:newSession');
        }},
        { label: '清空会话', accelerator: 'CmdOrCtrl+Shift+K', click: () => {
          mainWindow.webContents.send('shortcut:clearChat');
        }},
        { label: '插入/解绑页面', accelerator: 'CmdOrCtrl+I', click: () => {
          mainWindow.webContents.send('shortcut:togglePageContext');
        }},
        { label: '语音输入', accelerator: 'CmdOrCtrl+Shift+V', click: () => {
          mainWindow.webContents.send('shortcut:voiceToggle');
        }},
        { label: '查看快捷键', accelerator: 'CmdOrCtrl+/', click: () => {
          mainWindow.webContents.send('shortcut:showHelp');
        }},
        { type: 'separator' },
        { label: '聚焦地址栏', accelerator: 'CmdOrCtrl+L', click: () => {
          mainWindow.webContents.send('url:focus');
        }},
        { label: '命令面板', accelerator: 'CmdOrCtrl+K', click: () => {
          mainWindow.webContents.send('command:palette');
        }},
        { label: '搜索对话', accelerator: 'CmdOrCtrl+Shift+F', click: () => {
          mainWindow.webContents.send('chat:search');
        }},
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ]
    },
    {
      label: 'Tab',
      submenu: [
        { label: '下一个标签页', accelerator: 'CmdOrCtrl+Shift+]', click: () => {
          mainWindow.webContents.send('tab:next');
        }},
        { label: '上一个标签页', accelerator: 'CmdOrCtrl+Shift+[', click: () => {
          mainWindow.webContents.send('tab:prev');
        }},
        { type: 'separator' },
        ...[1,2,3,4,5,6,7,8,9].map(n => ({
          label: `标签页 ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => {
            mainWindow.webContents.send('tab:switchByIndex', n - 1);
          }
        })),
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  // 全局快捷键：Cmd+Shift+J → 快捷小窗
  // 全局快捷键：Cmd+Shift+J → 独立快捷小窗
  let quickWin = null;
  let quickSent = false;
  globalShortcut.register('CommandOrControl+Shift+J', () => {
    if (quickWin && !quickWin.isDestroyed()) { quickWin.close(); return; }
    quickSent = false;
    const { screen } = require('electron');
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const x = Math.round(display.bounds.x + (display.bounds.width - 560) / 2);
    const y = display.bounds.y + display.bounds.height - 120;
    quickWin = new BrowserWindow({
      width: 560, height: 56, x, y,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, hasShadow: true,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    quickWin.loadFile('quick-input.html');
    quickWin.on('blur', () => {
      if (quickWin && !quickWin.isDestroyed()) {
        if (!quickSent) app.hide(); // 先隐藏 app，再关小窗
        quickWin.close();
      }
    });
    quickWin.on('closed', () => { quickWin = null; });
  });
  ipcMain.on('quick-dismiss', () => { if (quickWin && !quickWin.isDestroyed()) quickWin.close(); });
  ipcMain.on('quick-send', (_, text) => {
    quickSent = true;
    if (quickWin && !quickWin.isDestroyed()) quickWin.close();
    switchToChatMode();
    mainWindow.show();
    mainWindow.focus();
    // 等 renderer 处理完 mode:change 后再发送
    setTimeout(() => {
      mainWindow.webContents.executeJavaScript(`
        (async () => {
          try {
            if (typeof window._quickSend === 'function') {
              await window._quickSend(${JSON.stringify(text)});
            } else {
              console.error('[quick-send] _quickSend not found');
            }
          } catch(e) { console.error('[quick-send] error:', e.message); }
        })()
      `).catch(e => console.error('[quick-send exec]', e.message));
    }, 500);
  });

  // ── Dock Icon ──
  const dockIconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(dockIconPath) && app.dock) {
    app.dock.setIcon(dockIconPath);
  }

  // ── 全局浮动语音气泡（必须在 Tray 之前定义，Tray 菜单引用 bubbleVisible/toggleBubble）──
  // NPC 相关常量（createBubbleWindow 启动时即引用，必须在函数定义前声明，避免 TDZ）
  const NPC_STATE_FILE = path.join(VAULT_ROOT, 'Pi', 'State', 'pi-npc.json');
  const NPC_SIZE_ON = { w: 420, h: 400 };
  // 大模式分 3 档：0=普通(96px), 1=大(192px), 2=超大(288px)
  const NPC_SIZE_LEVELS = [
    { w: 420, h: 400, css: '', label: '普通' },          // level 0
    { w: 520, h: 560, css: 'npc-big', label: '大' },     // level 1
    { w: 680, h: 720, css: 'npc-huge', label: '超大' },  // level 2
  ];
  const NPC_SIZE_OFF = { w: 56, h: 72 };
  let bubbleWin = null;
  let bubbleVisible = true;
  function createBubbleWindow() {
    if (bubbleWin && !bubbleWin.isDestroyed()) return;
    // 读 npc 状态决定初始尺寸（启用时直接用 NPC_SIZE_ON，避免先小后大导致 clamp 位置错位）
    let npcOnAtBoot = false;
    let savedPos = null;
    try {
      const j = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf8'));
      npcOnAtBoot = !!j.enabled;
      if (Number.isFinite(j.x) && Number.isFinite(j.y)) savedPos = { x: j.x, y: j.y };
    } catch {}
    let bootSizeLevel = 0;
    try { const jj = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf8')); bootSizeLevel = jj.sizeLevel || (jj.big ? 1 : 0); } catch {}
    const sz = npcOnAtBoot ? (NPC_SIZE_LEVELS[bootSizeLevel] || NPC_SIZE_LEVELS[0]) : NPC_SIZE_OFF;
    const w = sz.w;
    const h = sz.h;
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    // 优先用上次保存的位置；没有则默认右下角（留出窗口本身尺寸 + 留 20px 边距）
    let x, y;
    if (savedPos) {
      x = savedPos.x; y = savedPos.y;
    } else {
      x = display.bounds.x + display.bounds.width - w - 20;
      y = display.bounds.y + display.bounds.height - h - 20;
    }
    // clamp 到屏内，避免存了个屏外坐标或换屏分辨率变了
    const clamped = (() => {
      const pad = 8;
      const maxX = display.workArea.x + display.workArea.width - w - pad;
      const maxY = display.workArea.y + display.workArea.height - h - pad;
      const minX = display.workArea.x + pad;
      const minY = display.workArea.y + pad;
      return { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) };
    })();
    x = clamped.x; y = clamped.y;
    bubbleWin = new BrowserWindow({
      width: w, height: h, x, y,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, hasShadow: false,
      titleBarStyle: 'customButtonsOnHover',
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    // skipTransformProcessType: true —— 不加这个 option 的话，Electron 会把整个 app
    // 的 activation policy 从 ForegroundApplication 降到 UIElementApplication，
    // 等同 LSUIElement=true：Dock 图标消失、CMD+Tab 消失。见 Electron 文档：
    // https://www.electronjs.org/docs/latest/api/browser-window#winsetvisibleonallworkspacesvisible-options-macos
    bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    bubbleWin.setAlwaysOnTop(true, 'floating');
    // 默认整窗鼠标穿透（forward:true 让 renderer 仍收 mousemove 用于 hover 检测）。
    // renderer 检测到鼠标移到交互元素上时通过 bubble:set-ignore-mouse 关掉穿透。
    try { bubbleWin.setIgnoreMouseEvents(true, { forward: true }); } catch {}
    bubbleWin.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));
    bubbleWin.on('closed', () => { bubbleWin = null; });
    // bubble.html 加载完再推一次 NPC 状态，避免启动时 ipcRenderer.on 未注册导致 npc:enable 被吞
    bubbleWin.webContents.on('did-finish-load', () => {
      try {
        if (typeof npcEnabled !== 'undefined' && npcEnabled && bubbleWin && !bubbleWin.isDestroyed()) {
          bubbleWin.webContents.send('npc:enable', { skin: (typeof npcSkin !== 'undefined' ? npcSkin : 'patrick') });
        }
      } catch (e) { console.error('[npc] did-finish-load resend', e); }
    });
  }
  function toggleBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.close();
      bubbleVisible = false;
    } else {
      createBubbleWindow();
      bubbleVisible = true;
    }
  }
  // 未装完时不创建 NPC bubble，否则用户走 setup 时桌面就提前出现了一只 bubble。
  // setup 完成后由 pios:setup-done IPC handler 触发（global._createBubbleWindow）。
  global._createBubbleWindow = createBubbleWindow; // 让 ipcMain handler 跨 closure 调
  if (installer.isInstalled()) {
    createBubbleWindow();
  } else {
    console.log('[bubble] gated until setup-done (installer.isInstalled() === false)');
  }

  // ── NPC BEGIN ──（派大星化身 · 可插拔骨架，默认关闭）
  const PiPulse = require('./backend/pi-pulse');
  const piPersona = require('./backend/pi-persona');
  // 可用皮肤清单派生自 Pi/Config/characters.yaml（单一权威）。每个 skin 必须实现 11 个 pose
  // + 在 bubble.html 里以 `body.npc-enabled.skin-<id> #npc-<id>` 作为 CSS scope。详见 docs/components/pi-npc.md。
  // yaml 读不到时回落内置清单（pi-persona 的 BUILTIN_FALLBACK 已覆盖）。
  const NPC_SKINS = (() => {
    try {
      return piPersona.listCharacters().map(c => ({ id: c.skin || c.id, label: c.display_name || c.id }));
    } catch {
      return [
        { id: 'patrick', label: '派大星' }, { id: 'doraemon', label: '多啦A梦' },
        { id: 'baymax', label: '大白' }, { id: 'minion', label: '小黄人' },
        { id: 'kirby', label: '卡比' }, { id: 'totoro', label: '龙猫' },
        { id: 'slime', label: '史莱姆' }, { id: 'trump', label: '特朗普' },
        { id: 'starlet', label: '星仔' }, { id: 'shinchan', label: '蜡笔小新' },
      ];
    }
  })();
  const DEFAULT_NPC_SKIN = piPersona.DEFAULT_CHARACTER_ID || 'patrick';
  let npcEnabled = false;
  let npcSkin = DEFAULT_NPC_SKIN;
  let npcSizeLevel = 0; // 0=普通, 1=大, 2=超大
  // pulse 已在 top-level 声明（httpServer pios:talk 也要引用）
  let npcSavedPos = null; // { x, y } 上次关闭时的位置
  function loadNpcState() {
    try {
      const j = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf8'));
      npcEnabled = !!j.enabled;
      npcSizeLevel = (Number.isFinite(j.sizeLevel) && j.sizeLevel >= 0 && j.sizeLevel < NPC_SIZE_LEVELS.length) ? j.sizeLevel : (j.big ? 1 : 0);
      if (typeof j.skin === 'string' && NPC_SKINS.some(s => s.id === j.skin)) npcSkin = j.skin;
      else npcSkin = DEFAULT_NPC_SKIN;
      if (Number.isFinite(j.x) && Number.isFinite(j.y)) npcSavedPos = { x: j.x, y: j.y };
    } catch { npcEnabled = false; npcSkin = DEFAULT_NPC_SKIN; npcSizeLevel = 0; npcSavedPos = null; }
  }
  function saveNpcState() {
    try {
      const dir = path.dirname(NPC_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = { enabled: npcEnabled, skin: npcSkin, sizeLevel: npcSizeLevel };
      if (npcSavedPos) { payload.x = npcSavedPos.x; payload.y = npcSavedPos.y; }
      fs.writeFileSync(NPC_STATE_FILE, JSON.stringify(payload, null, 2));
    } catch (e) { console.error('[npc] saveState', e); }
  }
  // 把 (x,y,w,h) 约束到当前主屏 workArea 内，留 8px 边距
  function _clampToScreen(x, y, w, h) {
    try {
      const { screen } = require('electron');
      const d = screen.getPrimaryDisplay().workArea;
      const pad = 8;
      const maxX = d.x + d.width - w - pad;
      const maxY = d.y + d.height - h - pad;
      const minX = d.x + pad;
      const minY = d.y + pad;
      return { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) };
    } catch { return { x, y }; }
  }
  function _npcResizeBubble(w, h) {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    try {
      bubbleWin.setResizable(true);
      const [rawX, rawY] = bubbleWin.getPosition();
      const { x, y } = _clampToScreen(rawX, rawY, w, h);
      // resizable:false 时 Electron 把 width/height 同时当 min+max，必须一起调
      bubbleWin.setMinimumSize(w, h);
      bubbleWin.setMaximumSize(w, h);
      // macOS transparent+frame:false 下 setSize 对内容区的支持优于窗口区，两个都调
      bubbleWin.setContentSize(w, h, false);
      bubbleWin.setSize(w, h, false);
      bubbleWin.setPosition(x, y);
      const actual = bubbleWin.getSize();
      console.log(`[npc] resize asked=${w}x${h} actual=${actual[0]}x${actual[1]} pos=${x},${y}`);
      bubbleWin.setResizable(false);
    } catch (e) { console.error('[npc] resize', e); }
  }
  function _npcSizeLevelInfo() { return NPC_SIZE_LEVELS[npcSizeLevel] || NPC_SIZE_LEVELS[0]; }
  function enableNpc() {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const lvl = _npcSizeLevelInfo();
    _npcResizeBubble(lvl.w, lvl.h);
    try { bubbleWin.webContents.send('npc:enable', { skin: npcSkin }); } catch {}
    try { bubbleWin.webContents.send('npc:size', { level: npcSizeLevel, css: lvl.css }); } catch {}
    if (!pulse) pulse = new PiPulse(VAULT_ROOT, () => bubbleWin);
    try { pulse.start(); } catch (e) { console.error('[npc] start failed', e); }
  }
  function disableNpc() {
    try { pulse && pulse.stop(); } catch (e) { console.error('[npc] stop failed', e); }
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      try { bubbleWin.webContents.send('npc:disable'); } catch {}
      _npcResizeBubble(NPC_SIZE_OFF.w, NPC_SIZE_OFF.h);
    }
  }
  function toggleNpc() {
    npcEnabled = !npcEnabled;
    saveNpcState();
    if (npcEnabled) enableNpc(); else disableNpc();
  }
  function setNpcSizeLevel(level) {
    npcSizeLevel = Math.max(0, Math.min(NPC_SIZE_LEVELS.length - 1, level));
    saveNpcState();
    if (!npcEnabled || !bubbleWin || bubbleWin.isDestroyed()) return;
    const lvl = _npcSizeLevelInfo();
    _npcResizeBubble(lvl.w, lvl.h);
    try { bubbleWin.webContents.send('npc:size', { level: npcSizeLevel, css: lvl.css }); } catch {}
  }
  function setNpcSkin(skinId) {
    const skin = NPC_SKINS.find(s => s.id === skinId);
    if (!skin) return;
    if (npcSkin === skinId) return;
    npcSkin = skinId;
    saveNpcState();
    // 同步写入 pi-character.json（单一权威），让 personaBlock + voice 切到新戏服
    try { piPersona.setCharacter(skinId); } catch (e) { console.error('[npc] setCharacter sync failed', e.message); }
    // 热切：通知 renderer 换 body class（pulse 本身 skin-agnostic，不重启）
    if (npcEnabled && bubbleWin && !bubbleWin.isDestroyed()) {
      try { bubbleWin.webContents.send('npc:skin', { skin: npcSkin }); } catch {}
    }
    // 切皮肤立刻打招呼：让用户听到该皮肤对应的音色
    if (npcEnabled) {
      (async () => {
        try {
          const { getTTS } = require('./backend/qwen-tts');
          const tts = getTTS();
          const greet = `你好呀，我是${skin.label}`;
          const audio = await tts.speak(greet, 15000);
          if (audio && audio.length > 100 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tts:play', audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
          }
        } catch (e) { console.error('[npc:skin-greet]', e.message); }
      })();
    }
  }
  loadNpcState();
  if (npcEnabled) setTimeout(() => { try { enableNpc(); } catch (e) { console.error('[npc] auto-enable', e); } }, 800);

  // NPC 开发辅助：循环切 pose（不用 DevTools 也能看全部姿势）
  const NPC_POSES_FOR_TEST = ['thinking','working','sensing','reflecting','talking','recording','processing','alert','tired','watching','curious','remembering','delighted'];
  let npcTestIdx = -1;
  let npcTestTimer = null;
  function setTestPose(pose) {
    if (!bubbleWin || bubbleWin.isDestroyed() || !npcEnabled) return;
    try { bubbleWin.webContents.send('bubble:test-pose', pose); } catch {}
    if (npcTestTimer) clearTimeout(npcTestTimer);
    if (pose) {
      npcTestTimer = setTimeout(() => {
        try { bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.webContents.send('bubble:test-pose', null); } catch {}
      }, 3500);
    }
    return pose;
  }
  function testNextPose() {
    npcTestIdx = (npcTestIdx + 1) % NPC_POSES_FOR_TEST.length;
    return setTestPose(NPC_POSES_FOR_TEST[npcTestIdx]);
  }
  function openBubbleDevTools() {
    try { bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.webContents.openDevTools({ mode: 'detach' }); } catch (e) { console.error('[npc] devtools', e); }
  }
  // TTS 播放态 → pulse.setTalking（pulse 内部立即 _computeAndPush 推出 talking 或回真实 pose）
  ipcMain.on('tts:playback-state', (_, playing) => {
    if (!npcEnabled) return;
    try { pulse && pulse.setTalking(playing); } catch {}
  });
  // 派大星说话气泡：TTS 说什么都弹出来。窗口已永久高到足够放气泡，不再动态 resize（避免跳位）
  global._npcSpeak = function(text) {
    if (!npcEnabled) return;
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const s = String(text || '').trim();
    if (!s) return;
    try { bubbleWin.webContents.send('bubble:pulse', { type: 'speak', text: s }); } catch {}
  };
  // Pi Tab NPC bridge (accessed by HTTP /pi/data endpoint)
  global._piTabGetNpcInfo = function() {
    return { skins: NPC_SKINS.slice(), current: npcSkin };
  };
  global._piTabSetSkin = function(skinId) { setNpcSkin(skinId); };
  // 孵化仪式用：选完 NPC 直接写状态 —— 不调 setNpcSkin 的副作用（TTS greet / bubble 通知），
  // 因为孵化 preview 里 owner 刚听过该 NPC greet；且这时 setup 还没完 bubble 还没建，通知也没意义。
  // setup-done 时 createBubbleWindow + 补跑 enableNpc 让 pulse 起来。
  global._piStickNpcFromHatching = function(skinId) {
    try {
      const skin = NPC_SKINS.find(s => s.id === skinId);
      if (!skin) { console.warn('[hatching:stick-npc] unknown skinId:', skinId); return; }
      npcEnabled = true;
      npcSkin = skinId;
      saveNpcState();                                         // 写 pi-npc.json
      try { piPersona.setCharacter(skinId); } catch {}        // 写 pi-character.json（getNpcSkinVoice 源）
      console.log('[hatching] stuck NPC:', skinId);
    } catch (e) { console.error('[hatching:stick-npc]', e.message); }
  };
  // setup-done 后 bubble 刚创建完，补跑 enableNpc 让 pulse 起来 + bubble 切到 NPC 模式
  global._enableNpcAfterBubbleReady = function() {
    try {
      if (!npcEnabled || !bubbleWin || bubbleWin.isDestroyed()) return;
      // bubble 可能还没 did-finish-load，等一下再发
      setTimeout(() => {
        try { enableNpc(); } catch (e) { console.error('[hatching] post-bubble enableNpc failed:', e.message); }
      }, 800);
    } catch {}
  };
  // ── NPC END ──

  // 鼠标穿透开关（renderer 根据 hover 是否在交互元素上动态切换）
  ipcMain.on('bubble:set-ignore-mouse', (_, ignore) => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    try { bubbleWin.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {}
  });

  // 气泡拖拽
  let bubbleMoveSaveTimer = null;
  ipcMain.on('bubble:move', (_, dx, dy) => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const [x, y] = bubbleWin.getPosition();
    const nx = x + dx, ny = y + dy;
    bubbleWin.setPosition(nx, ny);
    // 拖拽停止 500ms 后保存（避免每帧写盘）
    npcSavedPos = { x: nx, y: ny };
    if (bubbleMoveSaveTimer) clearTimeout(bubbleMoveSaveTimer);
    bubbleMoveSaveTimer = setTimeout(() => {
      bubbleMoveSaveTimer = null;
      saveNpcState();
    }, 500);
  });

  // 全局快捷键：F5 → 切换录音（发到气泡窗口）
  globalShortcut.register('F5', () => {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.webContents.send('bubble:toggle-rec');
    }
  });

  // ── Tray (Menu Bar Icon) ──
  const trayIconPath = path.join(__dirname, 'tray-iconTemplate.png');
  let tray = new Tray(trayIconPath);
  tray.setToolTip('PiOS');

  const notifySettingsFile = path.join(VAULT_ROOT, 'Pi', 'Config', 'notify-settings.json');
  const getNotifySettings = () => {
    try { return JSON.parse(fs.readFileSync(notifySettingsFile, 'utf8')); } catch { return { voice: true, popup: true, freeVoice: false, reportTTS: false }; }
  };
  const buildTrayMenu = () => {
    const s = getNotifySettings();
    const voice = s.voice !== false;
    const popup = s.popup !== false;
    const freeVoice = s.freeVoice === true;
    const reportTTS = s.reportTTS === true;
    const save = (patch) => {
      fs.writeFileSync(notifySettingsFile, JSON.stringify({ ...s, ...patch }, null, 2));
      // 同步 freeVoice 到 TTS 实例
      if ('freeVoice' in patch) {
        try { const { getTTS } = require('./backend/qwen-tts'); getTTS().freeVoice = patch.freeVoice; } catch {}
      }
    };
    return Menu.buildFromTemplate([
      { label: `PiOS ${APP_VERSION}`, enabled: false },
      { type: 'separator' },
      { label: '打开 PiOS', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      {
        label: '通知',
        submenu: [
          { label: '弹窗', type: 'checkbox', checked: popup, click: () => { save({ popup: !popup }); tray.setContextMenu(buildTrayMenu()); } },
          { label: '语音', type: 'checkbox', checked: voice, click: () => { save({ voice: !voice }); tray.setContextMenu(buildTrayMenu()); } },
          { label: 'Report 也语音', type: 'checkbox', checked: reportTTS, click: () => { save({ reportTTS: !reportTTS }); tray.setContextMenu(buildTrayMenu()); } },
          { label: '自由音色（多人声）', type: 'checkbox', checked: freeVoice, click: () => { save({ freeVoice: !freeVoice }); tray.setContextMenu(buildTrayMenu()); } },
        ],
      },
      {
        label: '语音气泡',
        submenu: [
          { label: '显示气泡', type: 'checkbox', checked: bubbleVisible, click: () => { toggleBubble(); tray.setContextMenu(buildTrayMenu()); } },
          { label: 'NPC 模式', type: 'checkbox', checked: npcEnabled, click: () => { toggleNpc(); tray.setContextMenu(buildTrayMenu()); } },
          ...(npcEnabled ? [
            {
              label: 'NPC 皮肤',
              submenu: NPC_SKINS.map(s => ({
                label: s.label,
                type: 'checkbox',
                checked: npcSkin === s.id,
                click: () => { setNpcSkin(s.id); tray.setContextMenu(buildTrayMenu()); },
              })),
            },
            {
              label: 'NPC 大小',
              submenu: NPC_SIZE_LEVELS.map((lvl, i) => ({
                label: lvl.label,
                type: 'checkbox',
                checked: npcSizeLevel === i,
                click: () => { setNpcSizeLevel(i); tray.setContextMenu(buildTrayMenu()); },
              })),
            },
            {
              label: '测试 pose',
              submenu: [
                ...NPC_POSES_FOR_TEST.map(p => ({
                  label: p,
                  click: () => { setTestPose(p); },
                })),
                { type: 'separator' },
                { label: '↺ 回到 idle', click: () => { setTestPose(null); } },
                { label: '⟳ 循环下一个', click: () => { testNextPose(); } },
              ],
            },
            { type: 'separator' },
            { label: 'NPC DevTools（独立窗口）', click: () => { openBubbleDevTools(); } },
          ] : []),
        ],
      },
      { type: 'separator' },
      { label: '退出 PiOS', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
  };
  tray.setContextMenu(buildTrayMenu());

  // menubar / dock 徽标已下线：bubble + PiOS Home TNY 已是唯一数字入口，
  // 去掉 tray.setTitle / app.dock.setBadge 避免多源不同步（2026-04-24）

  // ── Pi 主动闲聊定时器：每 30min 检查门控条件 ──
  const piChitchat = require('./backend/pi-chitchat');
  setInterval(() => {
    try {
      piChitchat.maybeChat(mainWindow, VAULT_ROOT);
    } catch (e) {
      console.error('[pi-chitchat] timer error:', e.message);
    }
  }, 30 * 60 * 1000); // 30min

  // ── presence-watch 60s：flush pending + 相遇问候（pi-greet） ──
  // P6 Phase 6A+6C：让"离开 Mac <4h 的积压消息"在你回来自动 bubble 补发；
  // 同时触发 pi-greet 按 last_seen delta 判断打不打招呼（10min 内不打，10-60min 轻 ping，以此类推）。
  //
  // 2026-04-23 K2/K3 修：
  //   K2 grace period：present 稳定 20s 才 flush，防"一坐回来气泡瞬间糊脸"
  //   K3 去抖：上次 flush 不到 5min 跳过，防反复切换 present/away 刷屏
  const piRoute = require('./backend/pi-route');
  const piGreet = require('./backend/pi-greet');
  const { getPresence: _getPresenceForFlush } = require('./backend/presence');
  let _lastPresenceStatusForFlush = null;
  let _presentArrivedAt = 0;    // 本轮 present 从哪一 tick 开始
  let _flushedThisPresent = false;  // 本轮 present 是否已 flush 过（防同一轮重复）
  let _lastFlushAt = 0;         // 上一次 flush 实际发起的时间（K3 debounce 用）
  const GRACE_MS = 20 * 1000;
  const DEBOUNCE_MS = 5 * 60 * 1000;
  setInterval(() => {
    try {
      const curr = _getPresenceForFlush().status;
      const now = Date.now();

      // 状态切换 → 进 present：记起点，未 flush
      if (curr === 'present' && _lastPresenceStatusForFlush !== 'present') {
        _presentArrivedAt = now;
        _flushedThisPresent = false;
      }
      // 离开 → 重置
      if (curr !== 'present') {
        _presentArrivedAt = 0;
        _flushedThisPresent = false;
      }

      // 可以 flush 吗？K2 grace + K3 debounce
      if (curr === 'present'
          && !_flushedThisPresent
          && _presentArrivedAt > 0
          && (now - _presentArrivedAt) >= GRACE_MS
          && (now - _lastFlushAt) >= DEBOUNCE_MS) {
        _flushedThisPresent = true;
        _lastFlushAt = now;
        piRoute.flushPending(mainWindow).then(r => {
          if (r && r.flushed > 0) {
            console.log(`[pi-route] flushed ${r.flushed} pending messages on presence return (after ${Math.floor((now - _presentArrivedAt)/1000)}s grace)`);
          }
        }).catch(e => console.error('[pi-route] flushPending error:', e.message));
      }

      _lastPresenceStatusForFlush = curr;
      // pi-greet 内部维护 status 状态机 + 每次 present 刷 pi-social.last_seen_ts_ms
      piGreet.onPresenceChange(mainWindow);
    } catch (e) {
      console.error('[presence-watch] error:', e.message);
    }
  }, 60 * 1000); // 60s

  // 2026-04-23/24 WeChat 聚合器：3 条触发通道
  //   (a) setInterval 5min tick（awake 期间兜底，macOS 睡眠时暂停）
  //   (b) enqueue 时立即 fire-and-forget tick——捕获"≥3 条"/"最早 ≥20min"条件
  //       不依赖 setInterval，macOS 睡眠时也有效（因为写 queue 的 cron 会唤醒）
  //   (c) powerMonitor.on('resume')——macOS 从睡眠恢复时立即 tick，赶在 presence
  //       flush-pending 清空 queue 之前发出去
  // critical 级不经此路（立发多通道）
  const _wechatAggregator = require('./backend/wechat-aggregator');

  const _runAggregatorTick = async () => {
    const dbgLog = path.join(VAULT_ROOT, 'Pi/Log/wechat-aggregator-debug.log');
    try {
      const p = _getPresenceForFlush();
      if (p.status === 'present') {
        try { fs.appendFileSync(dbgLog, `[${new Date().toISOString()}] {"ev":"tick-skip-present","idle_s":${p.idle_s||0}}\n`); } catch {}
        return;
      }
      const r = await _wechatAggregator.tick({
        sendWeChatDirect: async (text, source) => {
          const { execSync } = require('child_process');
          const wechatSh = path.join(VAULT_ROOT, 'Pi', 'Tools', 'notify-wechat.sh');
          try {
            const out = execSync(`bash "${wechatSh}" ${JSON.stringify(text)}`, {
              timeout: 15000, stdio: ['ignore','pipe','pipe'], encoding: 'utf8',
            });
            try { fs.appendFileSync(dbgLog, `[${new Date().toISOString()}] {"ev":"direct-send-ok","len":${text.length},"out":${JSON.stringify((out||'').slice(0,200))}}\n`); } catch {}
            try { global._appendPiMainProactive && global._appendPiMainProactive(text, source || 'wechat-aggregator'); } catch {}
          } catch (e) {
            try { fs.appendFileSync(dbgLog, `[${new Date().toISOString()}] {"ev":"direct-send-fail","err":${JSON.stringify(e.message)},"stderr":${JSON.stringify((e.stderr||'').toString().slice(0,300))}}\n`); } catch {}
            console.error('[wechat-aggregator direct send] failed:', e.message);
          }
        },
      });
      if (r && r.fired) {
        console.log(`[wechat-aggregator] fired reason=${r.reason} count=${r.count||0} fallback=${!!r.fallback} suppressed=${!!r.suppressed}`);
      }
    } catch (e) { console.error('[wechat-aggregator] tick error:', e.message); }
  };

  // (a) 周期 tick
  const _wechatAggTimer = setInterval(_runAggregatorTick, 5 * 60 * 1000);
  app.on('will-quit', () => { if (_wechatAggTimer) clearInterval(_wechatAggTimer); });

  // (b) enqueue 时立即触发
  _wechatAggregator.setOnEnqueueTickCb(_runAggregatorTick);

  // (c) macOS 睡眠恢复时立即触发
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', () => {
      console.log('[wechat-aggregator] powerMonitor resume → immediate tick');
      _runAggregatorTick().catch(() => {});
    });
  } catch (e) { console.warn('[wechat-aggregator] powerMonitor unavailable:', e.message); }

  // 气泡 IPC：语音 → ASR → 主会话 → GPT → TTS
  ipcMain.handle('bubble:voice-send', async (_, audioData) => {
    const os = require('os');
    const { execFile } = require('child_process');
    try {
      // ASR — 复用 voice:asr 的逻辑
      bubbleWin?.webContents.send('bubble:status', '识别中...');
      const tmpWebm = path.join(os.tmpdir(), `bubble-asr-${Date.now()}.webm`);
      const tmpWav = tmpWebm.replace('.webm', '.wav');
      fs.writeFileSync(tmpWebm, Buffer.from(audioData));

      const ffmpegBin = fs.existsSync('/opt/homebrew/bin/ffmpeg')
        ? '/opt/homebrew/bin/ffmpeg'
        : (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');
      try {
        await new Promise((resolve, reject) => {
          execFile(ffmpegBin, ['-y', '-i', tmpWebm, '-ar', '16000', '-ac', '1', tmpWav],
            { timeout: 5000 }, (err) => err ? reject(err) : resolve());
        });
      } catch (ffErr) {
        try { fs.unlinkSync(tmpWebm); } catch {}
        // ffmpeg 没装时 execFile 会 ENOENT——把具体原因回给 bubble，而不是静默 error:''
        const msg = /ENOENT|not found/i.test(ffErr.message || '')
          ? '缺 ffmpeg（brew install ffmpeg）'
          : `ffmpeg 转码失败：${ffErr.message}`;
        return { error: msg };
      }

      const wavStat = fs.statSync(tmpWav);
      const durationSec = (wavStat.size - 44) / (16000 * 2);
      if (durationSec < 0.6) { try { fs.unlinkSync(tmpWebm); fs.unlinkSync(tmpWav); } catch {} return { error: '' }; }

      const FormData = require('form-data');
      const httpLib = require('http');
      const form = new FormData();
      form.append('file', fs.createReadStream(tmpWav), { filename: 'audio.wav', contentType: 'audio/wav' });
      const userText = await new Promise((resolve, reject) => {
        const req = httpLib.request({ method: 'POST', hostname: 'localhost', port: 7860, path: '/api/asr', headers: form.getHeaders(), timeout: 15000 }, (res) => {
          let body = '';
          res.on('data', (c) => body += c);
          res.on('end', () => { try { resolve((JSON.parse(body).text || '').trim()); } catch { resolve(''); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('ASR timeout')); });
        form.pipe(req);
      });
      try { fs.unlinkSync(tmpWebm); fs.unlinkSync(tmpWav); } catch {}

      if (!userText || isWhisperHallucination(userText)) return { error: '' };

      console.log('[bubble] ASR:', userText);

      // 统一路由到 renderer 的 onTalkToPi 处理（走 SessionBus，不再直接调 GPT + 写 sessions.json）。
      // renderer 的 sendMessage 流程负责：SessionBus ensure → send → 流式显示 → 保存消息 → TTS。
      // 这样 F5 语音和 Home Talk to Pi 走完全相同的代码路径，避免三路并发写 pi-main 的竞态。
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 2026-04-23 · 标记"本轮语音输入"：prepareGPTRequest 消费一次后清
        // 让 Pi 知道 owner 没在看屏幕，全部回复都应放进 <say>
        _nextTurnVoiceOnly = true;
        mainWindow.webContents.send('pios:talk', userText);
        // P6 · 用户等 Claude 期间显示 thinking 姿势（setTalking(true) 时自动清，60s 超时兜底）
        try { pulse && pulse.setThinking(true); } catch {}
      }
      return { ok: true, userText };
    } catch (e) {
      console.error('[bubble:voice-send]', e);
      return { error: e.message };
    }
  });

  ipcMain.on('bubble:interrupt-tts', () => {
    mainWindow?.webContents.send('tts:interrupt');
    // P6 · 打断 TTS = 对话链中止 → 清 thinking 避免卡住
    try { pulse && pulse.setThinking(false); pulse && pulse.setTalking(false); } catch {}
  });

  // 派大星 stream tag 点击 → 打开 PiOS Home 并聚焦指定 Card
  ipcMain.on('bubble:open-card', (_, arg) => {
    try {
      const stem = (arg && arg.stem) || '';
      const dir = (arg && arg.dir) || 'active';
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('mode:change', 'pios-home');
      if (stem) mainWindow.webContents.send('pios:focus-card', { stem, dir });
    } catch (e) { console.error('[bubble:open-card]', e); }
  });

  // 关闭窗口时最小化到 Tray（macOS 行为）
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    saveTabs(); // 确保退出前持久化
    // 2026-04-22 bug 修：saveSessions 是 debounced 800ms 写盘，如果 Cmd+Q 发生在 debounce 窗口内
    // （例如刚点 Call Pi 分配 groupId 后立刻退出），cache 里的变更永远没落盘 → 重启看到旧数据
    // （比如新会话不在 "Things Need You" 分组、标题没保存等）。这里强制 flush 一次，跳过 debounce。
    try { _flushSessionsToDisk(); } catch {}
  });

  // 点 Dock 图标 / Cmd+Tab 重新显示并聚焦
  app.on('activate', () => {
    if (mainWindow) {
      if (app.dock) app.dock.show(); // 确保 Dock 图标可见
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 确保 app 始终出现在 Cmd+Tab 切换器中
  mainWindow.on('hide', () => {
    if (app.dock) app.dock.show();
  });

  // ── 窗口状态保存 ──
  let lastNormalBounds = mainWindow.getBounds();

  mainWindow.on('resize', () => {
    if (currentMode === 'browser') layoutActiveTab();
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      lastNormalBounds = mainWindow.getBounds();
    }
  });

  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      lastNormalBounds = mainWindow.getBounds();
    }
  });

  mainWindow.on('close', () => {
    const state = {
      ...lastNormalBounds,
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    };
    try { fs.writeFileSync(windowStateFile, JSON.stringify(state)); } catch {}
  });
});

// ── Engine: Codex / Claude Code switch ──
let currentEngine = 'auto'; // 'auto' | 'codex' | 'gpt' | 'claude' | 'clean'

ipcMain.on('engine:switch', (_, engine) => {
  currentEngine = engine;
  console.log('[engine] switched to:', engine);
});

ipcMain.handle('engine:current', () => currentEngine);

// ── 桌面通知 ──
ipcMain.on('app:notify', (_, title, body) => {
  sendNotification(title, body, 'app');
});

// ══════════════════════════════════════════════════════
// ── Pi 后台事件：静默留档到主会话，不打扰 Owner ──
// 原则：做完一件事 ≠ 通知。真正要通知 Owner 必须显式走 notify.sh。
// 这里只负责把后台 task 完成事件拼成一条短文本，留在主会话里，
// Owner 主动打开 PiBrowser 主对话才看得到。
// ══════════════════════════════════════════════════════
async function handlePiEvent(event) {
  // event: { type, action, output, reflection, duration, cost, triage, archive, agent, task }

  // 事件字段拼一句静默留档文本。不再调 GPT 编散文。
  const headParts = [event.agent, event.task].filter(Boolean);
  const head = headParts.length ? `[${headParts.join('/')}] ` : '';
  const primary = event.action || event.triage || event.archive || event.output || '后台任务完成';
  const piMessage = `${head}${String(primary).substring(0, 160)}`.trim();
  if (!piMessage) return;

  console.log('[pi-event] silent log:', piMessage.substring(0, 100));

  // 写主会话（Owner 主动打开才看到）
  const data = loadSessions();
  const mainSession = data.sessions.find(s => s.id === MAIN_SESSION_ID);
  if (mainSession) {
    mainSession.messages.push({
      role: 'ai',
      content: piMessage,
      engine: 'silent',
      timestamp: new Date().toISOString(),
      proactive: true,
      silent: true,
    });
    mainSession.updated = new Date().toISOString();
    saveSessions(data);
  }

  // 推 renderer：只在打开主会话时显示气泡，不触发通知
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pi:proactive', { text: piMessage, timestamp: new Date().toISOString(), silent: true });
  }

  // ⚠️ 刻意不调 sendNotification —— macOS 通知 + TTS 由 notify.sh 按级别统一处理。
  // 真要通知 Owner，task prompt 自己显式调 `bash Pi/Tools/notify.sh <level> "..."`。
}

// ══════════════════════════════════════════════════════
// ── 统一通知函数 ──
// ══════════════════════════════════════════════════════
function sendNotification(title, text, source = 'system', { skipHistory = false } = {}) {
  const { exec } = require('child_process');
  const escaped = (s) => s.replace(/"/g, '\\"');

  // 读取设置
  const settingsFile = path.join(VAULT_ROOT, 'Pi', 'Config', 'notify-settings.json');
  let settings = { voice: true, popup: true };
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch {}

  // 1. 写入历史（skipHistory=true 时跳过，避免与 notify.sh 重复写）
  if (!skipHistory) {
    const histFile = path.join(VAULT_ROOT, 'Pi', 'Log', 'notify-history.jsonl');
    try {
      fs.appendFileSync(histFile, JSON.stringify({ time: new Date().toISOString(), title, text, source }) + '\n');
    } catch {}
  }

  // 2. PiOS Home toast（始终）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pios:notification', { title, body: text, time: new Date().toISOString() });
  }

  // 3. macOS 原生通知
  if (settings.popup !== false) {
    const { execFile } = require('child_process');
    execFile('/usr/bin/osascript', ['-e', `display notification "${escaped(text)}" with title "${escaped(title)}"`], (err, stdout, stderr) => {
      if (err) console.error('[notify] osascript error:', err.message, stderr);
      else console.log('[notify] osascript ok');
    });
  }

  // 4. TTS 语音（P7 fix v3 · 2026-04-19 晚）
  // 核心发现：对话 TTS 有声是因为 renderer **本地**调 voiceTTS 拿 buffer → audioQueue，
  // 不跨 IPC 传 buffer。通知 TTS 以前走 main→IPC→renderer buffer 传输，
  // onTTSPlay 回调在 renderer 端 byteLength 检查 skip（真因待定，可能序列化可能别的）。
  //
  // v2 尝试走 `_npcSpeak` 失败 —— 那条路 bubble.html speak handler 只 showSpeakBubble（显字）
  // 不调 TTS，所以反而"有字无声"。
  //
  // v3 正解：main 只发 text 给 renderer（notify:speak 事件），renderer 自己调 voiceTTS，
  // 和对话 TTS 走完全一样的路。buffer 不跨 IPC = 和对话一样的成功路径。
  // 同时保留 `_npcSpeak` 让派大星嘴动 + 显字气泡。
  if (settings.voice !== false && mainWindow && !mainWindow.isDestroyed()) {
    const ttsText = sanitizeForTTS(text || title);
    // DEBUG 埋点 2026-04-19
    try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] main: send notify:speak text="${ttsText.slice(0, 40)}" mainWindow.isVisible=${mainWindow.isVisible()} webContents.isDestroyed=${mainWindow.webContents.isDestroyed()}\n`); } catch {}
    // 声：renderer 本地合成
    try { mainWindow.webContents.send('notify:speak', ttsText); } catch (e) { console.error('[notify:speak]', e.message); try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] main: send notify:speak FAILED: ${e.message}\n`); } catch {} }
    // 脸/字气泡：派大星嘴动
    if (typeof global._npcSpeak === 'function') {
      try { global._npcSpeak(ttsText); } catch {}
    }
  } else {
    try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] main: SKIP notify:speak voice=${settings.voice} mainWindow=${!!mainWindow} destroyed=${mainWindow ? mainWindow.isDestroyed() : 'n/a'}\n`); } catch {}
  }

  // 5. Electron 通知
  console.log('[notify] isSupported:', Notification.isSupported(), 'popup:', settings.popup);
  if (settings.popup !== false && Notification.isSupported()) {
    const n = new Notification({ title, body: text, silent: true });
    n.on('show', () => console.log('[notify] Notification shown'));
    n.on('failed', (e, err) => console.error('[notify] Notification failed:', err));
    n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    n.show();
  }
}


// ── Browser Control HTTP API (for MCP server bridge) → main/browser-control-api.js ──
const _browserCtrlState = {
  // Mutable scalars — accessed via getters so the module always reads current value
  get mainWindow()       { return mainWindow; },
  get tabs()             { return tabs; },
  get activeTabId()      { return activeTabId; },
  get homeTabId()        { return homeTabId; },
  get pulse()            { return pulse; },
  get afterward()        { return afterward; },
  get sidebarCollapsed() { return sidebarCollapsed; },
  set sidebarCollapsed(v){ sidebarCollapsed = v; },
  get _apiReady()        { return _apiReady; },
  set _apiReady(v)       { _apiReady = v; },
  get sessionBus()       { return sessionBus; }, // initialized later at module level
  // By-reference mutable collections (const, never reassigned)
  _loginSessions, _compactInFlight,
  // Functions (hoisted — safe to reference here)
  createTab, switchToTab, closeTab, sendNotification, switchToChatMode,
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

// ── Pi 通知文件监听：notify.sh 写 pi_notify.json → PiBrowser 弹通知 + TTS ──
(() => {
  const notifyFile = path.join(VAULT_ROOT, 'Pi', 'Inbox', 'pi_notify.json');
  let lastText = '';
  let lastTime = 0;
  fs.watchFile(notifyFile, { interval: 1000 }, () => {
    let raw;
    try { raw = fs.readFileSync(notifyFile, 'utf-8'); } catch { return; }
    let text;
    try { text = JSON.parse(raw).text; } catch { return; }
    if (!text) return;
    // 去重：60 秒内同内容跳过（laptop-host + worker-host 各跑 reminder，Syncthing 同步延迟可达数十秒）
    const now = Date.now();
    if (text === lastText && now - lastTime < 60000) {
      try { fs.unlinkSync(notifyFile); } catch {}
      return;
    }
    lastText = text;
    lastTime = now;
    // 删文件（先删再通知，避免重复触发）
    try { fs.unlinkSync(notifyFile); } catch {}
    console.log('[pi-notify] file trigger:', text);
    sendNotification('Pi', text, 'pibrowser', { skipHistory: true });
  });
  console.log('[pi-notify] watching', notifyFile);
})();

// ── Pi 主动说话队列：外部 bash/cron 写 queue，主进程在进程内调 fireReflex ──
// 2026-04-20 修复 Bug A/B：原 notify.sh 用 `node -e fireReflex ... &` 起子进程，
//   - 子进程里 global._npcSpeak 不存在 → bubble 永远 null（Pi "只弹通知不说话"）
//   - cron 环境 PATH 没带 /opt/homebrew/bin → node 找不到 → stderr 被 `>/dev/null 2>&1` 吞
//     → fireReflex 完全没跑，连 pi-speak-log 都没 entry（今晚 17:00/18:30 reminder 症状）
// 改法：notify.sh 只写 JSON 行到 pi-speak-queue.jsonl，主进程按 cursor 读增量，
//       在进程内 require pi-speak → fireReflex/proposeIntent。_npcSpeak 能调。
(() => {
  const queueFile = path.join(VAULT_ROOT, 'Pi', 'Inbox', 'pi-speak-queue.jsonl');
  const queueDir = path.dirname(queueFile);
  try { fs.mkdirSync(queueDir, { recursive: true }); } catch {}

  // 启动时把 cursor 设到文件尾（不回放历史，避免 PiOS 重启把 queue 里旧消息全补发）
  let cursor = 0;
  try { if (fs.existsSync(queueFile)) cursor = fs.statSync(queueFile).size; } catch {}

  let processing = false;
  async function drain() {
    if (processing) return;
    processing = true;
    try {
      let size;
      try { size = fs.statSync(queueFile).size; } catch { processing = false; return; }
      if (size < cursor) { cursor = 0; } // 文件被截断/重建
      if (size <= cursor) { processing = false; return; }
      let buf;
      try {
        const fd = fs.openSync(queueFile, 'r');
        buf = Buffer.alloc(size - cursor);
        fs.readSync(fd, buf, 0, buf.length, cursor);
        fs.closeSync(fd);
      } catch (e) {
        console.error('[pi-speak-queue] read:', e.message);
        processing = false; return;
      }
      cursor = size;

      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
      const piSpeak = require('./backend/pi-speak');
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || !obj.text) continue;
        try {
          if (obj.type === 'intent') {
            piSpeak.proposeIntent({
              source: obj.source || 'queue',
              level: obj.level || 'info',
              text: obj.text,
              priority: obj.priority || 3,
              expires_at: obj.expires_at || null,
            });
          } else {
            await piSpeak.fireReflex({
              source: obj.source || 'queue',
              level: obj.level || 'info',
              text: obj.text,
              mainWindow,
              expires_at: obj.expires_at || null,
              ts: obj.ts || null,
              eventId: obj.event_id || null,
            });
          }
        } catch (e) {
          console.error('[pi-speak-queue] dispatch failed:', e.message);
        }
      }
    } finally {
      processing = false;
    }
  }

  fs.watchFile(queueFile, { interval: 1000 }, () => { drain().catch(() => {}); });
  console.log('[pi-speak-queue] watching', queueFile);
})();

// ── global._appendPiMainProactive：pi-speak.js 调这个把 Pi 主动话回写 pi-main ──
// 让 Talk to Pi / Home-Team-Pi tab 历史看到 Pi 今天主动说过什么，不再与输入侧脱节。
global._appendPiMainProactive = function (text, source) {
  try {
    const data = loadSessions();
    if (!data || !Array.isArray(data.sessions)) return;
    let main = data.sessions.find(s => s.id === MAIN_SESSION_ID);
    if (!main) return;
    if (!Array.isArray(main.messages)) main.messages = [];
    main.messages.push({
      role: 'assistant',
      content: text,
      ts: new Date().toISOString(),
      meta: { kind: 'proactive', source: source || 'pi' },
    });
    main.updated_at = new Date().toISOString();
    saveSessions(data);
  } catch (e) {
    console.error('[pi-main proactive append] failed:', e.message);
  }
};

// ── pi-main-proactive-queue watcher ───────────────────────────────────────
// 2026-04-24 module-top-level marker: 证明 main.js 加载到这一行
try {
  fs.appendFileSync(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-main-queue-drain-debug.log'),
    `${new Date().toISOString()} [MODULE-LOAD] reached IIFE definition\n`);
} catch {}
(() => {
  try {
    fs.appendFileSync(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-main-queue-drain-debug.log'),
      `${new Date().toISOString()} [IIFE-START] entering IIFE body\n`);
  } catch {}
  // M1: 只监听本机分片（pi-speak.js 按 host 写）。跨机事件走
  // agent-event-inbox-{host}.jsonl 的老通路，不在这里 merge。
  // host canonical 映射通过 backend/lib/host-resolve.js 统一解析（用户在
  // ~/.pios/config.json 的 hostname_aliases 里配自己的多机 alias）。
  const { resolveHost } = require('./backend/lib/host-resolve');
  const _hostShard = resolveHost();
  const qFile = path.join(VAULT_ROOT, 'Pi', 'Inbox', `pi-main-proactive-queue-${_hostShard}.jsonl`);
  try { fs.mkdirSync(path.dirname(qFile), { recursive: true }); } catch {}
  // 2026-04-24 instrument: 磁盘日志 (Electron stdout 捕不到)
  const _drainLog = path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-main-queue-drain-debug.log');
  const _logDrain = (msg) => {
    try { fs.appendFileSync(_drainLog, `${new Date().toISOString()} ${msg}\n`); } catch {}
  };
  let cursor = 0;
  try { if (fs.existsSync(qFile)) cursor = fs.statSync(qFile).size; } catch {}
  _logDrain(`[init] qFile=${qFile} initial cursor=${cursor} file_exists=${fs.existsSync(qFile)}`);
  let draining = false;
  let _tickCount = 0;
  async function drain() {
    _tickCount++;
    if (draining) { _logDrain(`[tick#${_tickCount}] skip: draining=true`); return; }
    draining = true;
    try {
      let size;
      try { size = fs.statSync(qFile).size; } catch (e) { _logDrain(`[tick#${_tickCount}] statSync fail: ${e.message}`); draining = false; return; }
      if (_tickCount <= 3 || _tickCount % 60 === 0) _logDrain(`[tick#${_tickCount}] size=${size} cursor=${cursor}`);
      if (size < cursor) { _logDrain(`[tick#${_tickCount}] file truncated size<cursor, reset cursor=0`); cursor = 0; }
      if (size <= cursor) { draining = false; return; }
      let buf;
      try {
        const fd = fs.openSync(qFile, 'r');
        buf = Buffer.alloc(size - cursor);
        fs.readSync(fd, buf, 0, buf.length, cursor);
        fs.closeSync(fd);
      } catch (e) {
        _logDrain(`[tick#${_tickCount}] read err: ${e.message}`);
        draining = false; return;
      }
      cursor = size;
      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
      _logDrain(`[tick#${_tickCount}] processing ${lines.length} lines, global._appendPiMainProactive typeof=${typeof global._appendPiMainProactive}`);
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { _logDrain(`  parse fail: ${line.slice(0,60)}`); continue; }
        if (!obj || !obj.text) { _logDrain('  skip no text'); continue; }
        try {
          global._appendPiMainProactive(obj.text, obj.source || 'pi');
          _logDrain(`  ✓ dispatched: ${String(obj.text).slice(0,60)}`);
        } catch (e) {
          _logDrain(`  ✗ dispatch err: ${e.message}`);
        }
      }
    } finally {
      draining = false;
    }
  }
  fs.watchFile(qFile, { interval: 1000 }, () => { drain().catch(() => {}); });
  // 2026-04-24 fs.watchFile 在 Electron main process 有时不 fire（观测证据：
  // laptop-host.jsonl 有 7345 字节积压 mtime 01:49 但 pi-main 从不写入，21min 过去
  // watchFile 从没触发 drain）。加一条 setInterval 1s 作 backup polling。
  // macOS 睡眠时和 watchFile 一样暂停，但 powerMonitor resume 立即 kick 一次。
  setInterval(() => { drain().catch(() => {}); }, 1000);
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', () => {
      console.log('[pi-main-proactive-queue] powerMonitor resume → immediate drain');
      drain().catch(() => {});
    });
  } catch {}
  console.log('[pi-main-proactive-queue] watching', qFile, '(fs.watchFile + setInterval backup)');
})();

// 刀 2 step 6b: `pi:claude` + `claude:stop` handler 已删
// —— Claude 交互走 SessionBus 的 ClaudeInteractiveAdapter，
// 事件通过 `session:event` 而不是全局 `claude:event` 广播。
// `claude:reset` 保留（agent mode / session 切换时清 singleton）。

ipcMain.on('claude:reset', () => {
  const claude = getClaudeClient();
  claude.reset();
});

// ── SessionBus v2（刀 1 + 刀 2 spike）──────────────────────────────────
// 初始化 bus + 三个 engine adapter + context injector
// 对应卡片：Cards/active/pibrowser-session-model-v2.md
const sessionBus = getSessionBus();
sessionBus.registerAdapter(
  'claude',
  new ClaudeInteractiveAdapter({
    getTTS: () => {
      try { return getTTS(); } catch { return null; }
    },
    onAudio: (sessionId, buf) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session:audio', sessionId, buf);
      }
    },
    // 刀 3: `vaultRoot` 不再需要 —— task 路径走 RunSessionAdapter（那里有 vaultRoot）
  })
);

// 刀 2 spike：GPT + Codex adapter + context injector 注册，但 renderer 老路径还没切过来。
// 这一步只是让 `sessionBus.hasAdapter('gpt' | 'codex')` 返回 true，
// 让刀 2 step 4/5（renderer 拆补丁）明天早上做的时候 bus 已经就位。
// 今晚没有任何代码调 `sessionBus.send(sid, text, { engine: 'gpt' | 'codex' })`。
const contextInjector = new ContextInjector({
  loadSessions,
  mainSessionId: MAIN_SESSION_ID,
});
sessionBus.registerAdapter(
  'gpt',
  new GPTDirectAdapter({
    // 注入 prompt 构造函数（buildSystemContext + proactiveCtx + webSearch + voice 模板）
    prepareRequest: prepareGPTRequest,
  })
);
sessionBus.registerAdapter(
  'codex',
  new CodexInteractiveAdapter({
    prepareRequest: prepareCodexRequest,
  })
);

// 刀 3: RunSessionAdapter 给后台 task session 用（registerSession 时用 engineKey 'run'）
sessionBus.registerAdapter(
  'run',
  new RunSessionAdapter({ vaultRoot: VAULT_ROOT })
);

// 把 bus 的所有事件转发到 renderer（按 sessionId 路由在 renderer 侧处理）
sessionBus.subscribeAll((payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('session:event', payload); } catch {}
  }
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
