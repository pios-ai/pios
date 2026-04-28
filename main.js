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

// 调度器 tick timer（whenReady 内启动，will-quit 清理 —— 必须模块作用域）
let _tickTimer = null;

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

// 书签
const bookmarksFile = path.join(app.getPath('userData'), 'bookmarks.json');

function loadBookmarks() {
  try { return JSON.parse(fs.readFileSync(bookmarksFile, 'utf-8')); } catch { return []; }
}

function saveBookmarks(bookmarks) {
  fs.writeFileSync(bookmarksFile, JSON.stringify(bookmarks, null, 2));
}

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

// 对话管理 — 多 session
const sessionsFile = path.join(app.getPath('userData'), 'sessions.json');
const sessionMessages = require('./backend/session-messages');
sessionMessages.configure(app.getPath('userData'));

// sessions.json 内存缓存（避免每次请求都做 readFileSync）
// in-memory 仍然保留 .messages[]；只在磁盘上 messages 走各自的 JSONL。
// 300 sessions × 平均 60KB messages = 19MB 每次 flush 冻主进程 100ms+，
// 拆开后 sessions.json 只剩 metadata ~200KB，messages 并行 fsp.writeFile。
let _sessionsCache = null;
let _sessionsCacheMtime = 0;
// 每个 session 上次落盘的 messages.length。length 变化视作需要重写 JSONL；
// 同长不同内容（罕见 in-place 编辑）下次 loadSessions 的时候会从 JSONL 读回覆盖。
const _messagesLenOnDisk = new Map();

function _rehydrateMessages(data) {
  // 首次进入拆分后的状态：sessions.json 没有 messages → 从 JSONL 读回 in-memory。
  // 兼容旧格式：如果 session 自带 inline messages（未迁移），保留它，此次 flush 会
  // 触发拆分写 JSONL。
  if (!data || !Array.isArray(data.sessions)) return data;
  for (const s of data.sessions) {
    if (!s || !s.id) continue;
    if (Array.isArray(s.messages) && s.messages.length > 0) continue; // inline 存在，等待迁移
    const msgs = sessionMessages.loadMessages(s.id);
    s.messages = msgs;
    // 认可当前 JSONL 长度，避免 _doFlush 把刚读回的每个 session 无差别重写一次
    _messagesLenOnDisk.set(s.id, msgs.length);
  }
  return data;
}

function loadSessions() {
  if (_sessionsCache) {
    try {
      const mtime = fs.statSync(sessionsFile).mtimeMs;
      if (mtime <= _sessionsCacheMtime) return _sessionsCache;
    } catch {}
  }
  try {
    _sessionsCache = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    try { _sessionsCacheMtime = fs.statSync(sessionsFile).mtimeMs; } catch {}
  } catch {
    _sessionsCache = { sessions: [], activeId: null };
  }
  _rehydrateMessages(_sessionsCache);
  return _sessionsCache;
}

const MAIN_SESSION_ID = 'pi-main';

// 刀 2 step 5: `getRecentProactiveContext` 已搬到 backend/context-injector.js
// 的 _buildProactiveContext source。main.js 三处调用已改走
// `contextInjector.buildContext(MAIN_SESSION_ID, { sources: ['proactive'] })`。

// sessions.json 写入：延迟批量写盘 + 原子写入
let _sessDirtyTimer = null;
let _sessFlushInflight = null; // Promise — 防止并发 flush 互相覆盖
const SESS_FLUSH_DELAY = 800;

function saveSessions(data) {
  // 保护主会话不被截断；chat 和 task session 分别限额，互不挤占
  const before = new Set((data.sessions || []).map(s => s && s.id).filter(Boolean));
  const main = data.sessions.find(s => s.id === MAIN_SESSION_ID);
  const tasks = data.sessions.filter(s => s.id !== MAIN_SESSION_ID && s.origin === 'task').slice(-100);
  const chats = data.sessions.filter(s => s.id !== MAIN_SESSION_ID && s.origin !== 'task').slice(-200);
  data.sessions = [...(main ? [main] : []), ...chats, ...tasks];
  // 被 slice 踢出的 session → 删掉它的 JSONL 避免泄露
  const after = new Set(data.sessions.map(s => s && s.id).filter(Boolean));
  for (const sid of before) {
    if (!after.has(sid)) {
      sessionMessages.deleteMessages(sid);
      _messagesLenOnDisk.delete(sid);
    }
  }
  _sessionsCache = data;
  // 延迟写盘
  if (_sessDirtyTimer) clearTimeout(_sessDirtyTimer);
  _sessDirtyTimer = setTimeout(() => { _flushSessionsToDisk(); }, SESS_FLUSH_DELAY);
}

function _flushSessionsToDisk() {
  _sessDirtyTimer = null;
  if (!_sessionsCache) return Promise.resolve();
  // 如果上一轮 flush 还在跑，等它完再跑（避免并发 rename 冲突或 thin snapshot 竞态）
  if (_sessFlushInflight) {
    _sessFlushInflight = _sessFlushInflight.then(_doFlush);
  } else {
    _sessFlushInflight = _doFlush();
  }
  const cur = _sessFlushInflight;
  cur.finally(() => { if (_sessFlushInflight === cur) _sessFlushInflight = null; });
  return cur;
}

async function _doFlush() {
  if (!_sessionsCache) return;
  try {
    // 1. 并行把有 messages 的 session 写 JSONL —— 仅长度变化的重写，避免每次
    //    flush 都 300 个文件。successIds 也包含已落盘的（prev===cur 视为"当前版本
    //    可从 JSONL 读到"），可以安全 strip。写失败保留 inline 作 fallback。
    const writeJobs = [];
    const successIds = new Set();
    for (const s of (_sessionsCache.sessions || [])) {
      if (!s || !s.id || !Array.isArray(s.messages)) continue;
      const sid = s.id;
      const len = s.messages.length;
      const prev = _messagesLenOnDisk.get(sid);
      if (prev !== undefined && prev === len) {
        successIds.add(sid);
        continue;
      }
      const msgs = s.messages;
      writeJobs.push(
        sessionMessages.writeMessagesAsync(sid, msgs)
          .then(() => { _messagesLenOnDisk.set(sid, len); successIds.add(sid); })
          .catch((e) => { console.error(`[sessions] msg flush ${sid} failed:`, e.message); })
      );
    }
    await Promise.all(writeJobs);

    // 2. 构造 thin 副本：JSONL 写成功的 session 去掉 messages；失败的保留 inline
    const thin = {
      ..._sessionsCache,
      sessions: (_sessionsCache.sessions || []).map(s => {
        if (s && s.id && successIds.has(s.id)) {
          const { messages, ...rest } = s;
          return rest;
        }
        return s;
      }),
    };

    // 3. 原子写 sessions.json（从 19MB 降到 ~200KB）
    const tmp = sessionsFile + '.tmp.' + process.pid;
    await require('fs').promises.writeFile(tmp, JSON.stringify(thin, null, 2));
    await require('fs').promises.rename(tmp, sessionsFile);
    try { _sessionsCacheMtime = fs.statSync(sessionsFile).mtimeMs; } catch {}
  } catch (e) { console.error('[sessions] flush error:', e.message); }
}

// Worker-log: record PiBrowser AI interactions (debounced per session, 5 min)
const _workerLogLastWrite = {}; // sessionId -> timestamp
function _writeWorkerLogEntry(session, msgCount) {
  try {
    const sid = session.id;
    const now = Date.now();
    if (_workerLogLastWrite[sid] && (now - _workerLogLastWrite[sid]) < 5 * 60 * 1000) return;
    _workerLogLastWrite[sid] = now;

    const { resolveHost } = require('./backend/host-helper');
    const hostShort = resolveHost();

    const vault = VAULT_ROOT;
    const logFile = path.join(vault, 'Pi', 'Log', `worker-log-${hostShort}.md`);
    const d = new Date();
    const ts = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const engine = session.engine || 'unknown';
    const title = (session.title || 'untitled').substring(0, 50);
    const turns = Math.floor(msgCount / 2);

    const entry = `\n### ${ts} [${hostShort}] | engine:${engine} | agent:pibrowser | task:interactive\n- 话题：${title} | ${turns} turns\n`;
    fs.appendFileSync(logFile, entry, 'utf-8');
  } catch (e) {
    // silent — don't break session save on log failure
  }
}

// ── Task run 发现层（tick 7）──────────────────────────────────────────
// 核心理念：chat 和 task session 在底层是同一种东西（都是一个 Claude CLI jsonl
// 加上"当前 turn 所有权"）。区别只在**发现路径**：chat 通过 sessions.json 发现，
// task 通过 Pi/State/runs/ 发现。tick 7 把两条发现路径在 sessions:list 里合流。
//
// materializeTaskSessionFromRun 把一个 run 展成完整 sessionObj（读 jsonl/log/
// remote log 构造 messages），/pios/open-session 和 sessions:load 都调它，
// 两条入口的行为从此完全一致。

// 列出最近的 task runs（用于 sessions:list 合流）
function listRecentTaskRuns({ limit = 50, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const runsDir = path.join(VAULT_ROOT, 'Pi', 'State', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const cutoff = Date.now() - maxAgeMs;
  const out = [];
  try {
    const files = fs.readdirSync(runsDir).filter(f => {
      if (!f.endsWith('.json')) return false;
      if (f.endsWith('.stats') || f.endsWith('.jsonl')) return false;
      return true;
    });
    for (const f of files) {
      try {
        const full = path.join(runsDir, f);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) continue;
        const r = JSON.parse(fs.readFileSync(full, 'utf-8'));
        if (!r.run_id || !r.agent) continue;
        out.push({ run: _annotateRunIfZombie(r), mtime: stat.mtimeMs });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map(e => e.run);
}

// Zombie 检测：status=running 但 heartbeat_at 已超 90s 未更新 = adapter 进程死了 trap 没触发。
// adapter 后台心跳每 30s 写一次（pios-adapter.sh）；3 次没更新视为僵尸。
const ZOMBIE_HEARTBEAT_TIMEOUT_MS = 90 * 1000;
function _annotateRunIfZombie(r) {
  if (r.status !== 'running') return r;
  const hb = r.heartbeat_at;
  if (!hb) return r;  // 老 run record 没 heartbeat_at 字段，保留 running 状态不动
  const ageMs = Date.now() - (Number(hb) * 1000);
  if (ageMs > ZOMBIE_HEARTBEAT_TIMEOUT_MS) {
    return { ...r, status: 'zombie', _zombieAgeMs: ageMs };
  }
  return r;
}

// 按 runId / sessionId 查找单个 run record
function findTaskRun({ runId, sessionId } = {}) {
  const runsDir = path.join(VAULT_ROOT, 'Pi', 'State', 'runs');
  if (!fs.existsSync(runsDir)) return null;
  try {
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json') && !f.endsWith('.stats') && !f.endsWith('.jsonl'));
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf-8'));
        if (runId && r.run_id === runId) return _annotateRunIfZombie(r);
        if (sessionId && r.session_id === sessionId) return _annotateRunIfZombie(r);
      } catch {}
    }
  } catch {}
  return null;
}

// 一个 run 对应的 session.id：永远用 `run:<run_id>` 保证唯一。
// 2026-04-23 修：以前用 run.session_id 当 id 会导致 Claude session 复用时
// 多个 run 物化成同一个 sessionObj.id，互相覆盖 sessions.json，造成"点 A 看 B"。
// Claude resume 需要的真 uuid 单独保存在 sessionObj.claudeSessionId 字段。
function taskRunSessionId(run) {
  return 'run:' + run.run_id;
}

function formatLocalDateYmd(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function looksLikeRawTaskTranscript(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /(^|\n)(\[adapter\]|diff --git|@@ -\d|tokens used|apply patch|patch: completed|exec\n|codex\n)/i.test(t) ||
         /You've hit your limit|Failed to authenticate|authentication_error|Unable to connect to API|ECONNRESET/i.test(t) ||
         /^\[[^\]]+\]\s+\[[^\]]+\]\s+START: /m.test(t);
}

function prettifyTaskRunContent(run, text) {
  if (!text) return text;
  const raw = String(text).replace(/\r\n/g, '\n').trim();
  let out = raw;
  const marker = out.match(/(?:^|\n)tokens used\s*\n[^\n]*\n([\s\S]*)$/i);
  if (marker && marker[1] && marker[1].trim()) {
    out = marker[1].trim();
  }

  out = out
    .replace(/\[adapter\]\s+claude-cli configs-mode:[^\n]*/g, '')
    .replace(/\[adapter\]\s+codex-cli configs-mode:[^\n]*/g, '')
    .replace(/\[adapter\]\s+CLAUDE-FAIL:[^\n]*/g, '')
    .replace(/\[adapter\]\s+ENGINE-FALLBACK:[^\n]*/g, '')
    .replace(/You've hit your limit\s*·\s*resets [^\n]*/g, '');

  out = out
    .split('\n')
    .filter(line => {
      if (/^\[[^\]]+\]\s+\[[^\]]+\]\s+START: /.test(line)) return false;
      if (/^\[[^\]]+\]\s+\[[^\]]+\]\s+END: /.test(line)) return false;
      if (/^\[adapter\]\s+(CLAUDE-FAIL|ENGINE-FALLBACK|claude-cli configs-mode:|codex-cli configs-mode:)/.test(line)) return false;
      return true;
    })
    .join('\n')
    .trim();

  if (!out && run?.status === 'running') {
    return '任务正在运行 — 正在接入实时日志流（几秒后自动显示执行过程）';
  }

  if (run?.status === 'running' && looksLikeRawTaskTranscript(raw) && !marker) {
    return '任务正在运行 — 正在接入实时日志流（几秒后自动显示执行过程）';
  }

  if (!out) {
    if (/Failed to authenticate|authentication_error|API Error:\s*401/i.test(raw)) {
      return '任务启动失败：Claude 认证失效，未产生有效会话内容。';
    }
    if (/You\'ve hit your limit/i.test(raw)) {
      return '任务未执行完成：Claude 达到使用上限，未产生有效会话内容。';
    }
    if (/Unable to connect to API|ECONNRESET/i.test(raw)) {
      return '任务执行中断：连接上游 API 失败，未产生完整会话内容。';
    }
  }

  return out;
}

function taskRunOutcomeNote(run) {
  if (!run) return '';
  if (run.status === 'running') return '';
  if (run.status === 'failed' || (run.exit_code != null && Number(run.exit_code) !== 0)) {
    const bits = [];
    bits.push(`任务最终失败`);
    if (run.exit_code != null) bits.push(`退出码 ${run.exit_code}`);
    if (run.finished_at) bits.push(`结束于 ${run.finished_at}`);
    return `${bits.join('，')}。以下内容是失败前最后一次可恢复输出，不代表任务已完整成功。`;
  }
  if (run.status === 'degraded' && run.fallback_from) {
    return `任务已通过 fallback 完成：${run.fallback_from} -> ${run.runtime || 'unknown'}`;
  }
  return '';
}

function shouldRefreshMaterializedTaskSession(existing) {
  if (!existing || existing.origin !== 'task') return false;
  const messages = Array.isArray(existing.messages) ? existing.messages : [];
  if (messages.length === 0) return true;
  if (messages.some(m => m && m.role === 'user')) return false;
  if (messages.length === 1) return true;
  return messages.some(m => m && m.role !== 'user' && looksLikeRawTaskTranscript(m.content || ''));
}

// sessions:list 用的轻量 entry（没 messages，messageCount = 0）
// tick 8: 加 running 字段 —— renderer 会用它同步进 store，这样没点过的 task
// 在列表里也能看到 running pill。run record 是单一真相源。
function taskRunListEntry(run) {
  const ts = run.started_at ? new Date(run.started_at) : new Date();
  const tsLabel = `${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
  const engine = (run.runtime || '').includes('codex') ? 'codex' : 'claude';
  const taskTitle = run.plugin_name || run.run_id?.replace(/-\d{8}-\d{6}$/, '') || run.agent;
  const updated = run.finished_at || run.started_at || new Date().toISOString();
  return {
    id: taskRunSessionId(run),
    title: `${taskTitle} ${tsLabel}`,
    engine,
    updated,
    messageCount: 0,
    groupId: null,
    origin: 'task',
    taskId: run.plugin_name || run.run_id?.replace(/-\d{8}-\d{6}$/, '') || run.agent,
    runId: run.run_id,
    running: run.status === 'running',
    runStatus: run.status || null,
    exitCode: run.exit_code ?? null,
    finishedAt: run.finished_at || null,
    fallbackFrom: run.fallback_from || null,
    fallbackReason: run.fallback_reason || null,
    runtime: run.runtime || null,
    triggerSource: run.trigger_source || null,
  };
}

// 从 run record 构造完整 sessionObj（含 messages）。
// 数据源优先级：jsonl → log → remote ssh log → fallback stub。
// 这是 `/pios/open-session` 老代码抽出来的通用版本，不 side-effect（不写 sessions.json、
// 不 broadcast、不设 singleton），调用方自己决定如何持久化和通知。
function materializeTaskSessionFromRun(run) {
  const runtime = run.runtime || 'claude-cli';
  const taskId = run.plugin_name || run.run_id?.replace(/-\d{8}-\d{6}$/, '') || run.agent || 'task';
  const runId = run.run_id;
  const sessionId = taskRunSessionId(run);
  const hasFallback = !!run.fallback_from;
  const isCodex = runtime.includes('codex');
  const engine = isCodex ? 'codex' : 'claude';

  let conv = { messages: [], found: false };
  const useJsonl = !isCodex && !hasFallback && run.session_id;

  if (useJsonl) {
    conv = pios.getSessionConversation(run.session_id);
    if (conv.found && conv.messages && conv.messages.length > 0 && conv.messages.length <= 3) {
      const allText = conv.messages.map(m => m.content || '').join('\n');
      if (/You've hit your limit|Not logged in|Failed to authenticate|API Error: 40[13]/.test(allText) ||
          looksLikeRawTaskTranscript(allText)) {
        conv = { messages: [], found: false };
      }
    }
  }

  const localHost = require('./backend/host-helper').resolveHost();
  const runHost = run.host || localHost;
  if (!conv.found || (conv.messages || []).length === 0) {
    if (runHost !== localHost) {
      let _instances = {};
      try {
        const _yaml = require('js-yaml');
        const _m = _yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
        if (_m && _m.infra && _m.infra.instances) _instances = _m.infra.instances;
      } catch (e) { console.error('[materialize] yaml error:', e.message); }
      const _inst = _instances[runHost] || {};
      const remote = _inst.ssh ? { ssh: _inst.ssh, vault: _inst.vault || '/data/AI_Vault' } : null;
      if (remote) {
        const startedAt = run.started_at ? new Date(run.started_at) : new Date();
        const logDate = formatLocalDateYmd(startedAt);
        const remoteLog = `${remote.vault}/Pi/Log/cron/${taskId}-${logDate}-${runHost}.log`;
        try {
          const { execSync } = require('child_process');
          const remoteContent = execSync(`ssh ${remote.ssh} "cat '${remoteLog}' 2>/dev/null"`, { timeout: 10000, encoding: 'utf-8' });
          const startStr = startedAt.toTimeString().slice(0, 5);
          // Parse log: find content between START and END markers matching this run's time
          const lines = remoteContent.split('\n');
          let runOutput = '';
          let inRun = false;
          for (const line of lines) {
            if (!inRun && line.includes('START: ' + taskId) && line.includes(startStr)) {
              inRun = true;
              continue; // skip the START marker line itself
            }
            if (inRun && line.includes('END: ' + taskId)) {
              break; // done
            }
            if (inRun) runOutput += line + '\n';
          }
          if (!runOutput.trim()) runOutput = remoteContent.slice(-2000);
          conv.messages = [{ role: 'assistant', content: `[${runHost}] ${runOutput.trim().substring(0, 3000)}` }];
          conv.found = true;
        } catch (sshErr) {
          conv.messages = [{ role: 'assistant', content: `此任务在 ${runHost} 上执行。\n\n退出码: ${run.exit_code ?? '—'}\n时间: ${run.started_at || '?'}\n状态: ${run.status || '?'}\n\nSSH 错误: ${sshErr.message?.substring(0, 200)}` }];
          conv.found = true;
        }
      } else {
        conv.messages = [{ role: 'assistant', content: `此任务在 ${runHost} 上执行。\n退出码: ${run.exit_code ?? '—'}\n时间: ${run.started_at || '?'}` }];
        conv.found = true;
      }
    } else {
      const logDir = path.join(VAULT_ROOT, 'Pi', 'Log', 'cron');
      const startedAt = run.started_at ? new Date(run.started_at) : null;
      const logDate = startedAt ? formatLocalDateYmd(startedAt) : formatLocalDateYmd(new Date());
      const logFile = path.join(logDir, `${taskId}-${logDate}-${localHost}.log`);
      const logFileAlt = path.join(logDir, `${taskId}-${logDate}.log`);
      const actualLog = fs.existsSync(logFile) ? logFile : fs.existsSync(logFileAlt) ? logFileAlt : null;
      if (actualLog) {
        try {
          const logContent = fs.readFileSync(actualLog, 'utf-8');
          let runOutput = logContent;
          if (run.started_at) runOutput = extractRunFromLog(logContent, run);
          if (runOutput.trim()) {
            conv.messages = [{ role: 'assistant', content: runOutput.trim() }];
            conv.found = true;
          }
        } catch {}
      }
    }
  }

  const messages = (conv.messages || []).map(m => ({
    role: m.role === 'user' ? 'user' : 'ai',
    content: m.role === 'user' ? (m.content || '') : prettifyTaskRunContent(run, m.content || ''),
    engine,
  }));
  const outcomeNote = taskRunOutcomeNote(run);
  if (outcomeNote) {
    messages.push({ role: 'ai', content: outcomeNote, engine });
  }
  const tsSource = run.started_at ? new Date(run.started_at) : new Date();
  const tsLabel = `${String(tsSource.getMonth()+1).padStart(2,'0')}-${String(tsSource.getDate()).padStart(2,'0')} ${String(tsSource.getHours()).padStart(2,'0')}:${String(tsSource.getMinutes()).padStart(2,'0')}`;
  const createdAt = run.started_at || new Date().toISOString();
  const updatedAt = run.finished_at || run.started_at || new Date().toISOString();

  return {
    id: sessionId,
    title: `${taskId} ${tsLabel}`,
    engine,
    messages,
    created: createdAt,
    updated: updatedAt,
    origin: 'task',
    taskId,
    runId: runId || null,
    runStatus: run.status || null,
    exitCode: run.exit_code ?? null,
    finishedAt: run.finished_at || null,
    fallbackFrom: run.fallback_from || null,
    claudeSessionId: run.session_id || null,  // Claude resume 用，与 sessionObj.id 解耦
    // Codex rollout 用的真 thread_id；adapter 提取后写到 run.session_id（同一字段）
    fallbackReason: run.fallback_reason || null,
    triggerSource: run.trigger_source || null,
  };
}

ipcMain.handle('sessions:list', () => {
  const data = loadSessions();

  // tick 8: 提前读 runs/ —— materialized 的 task session 也用 run record 决定 running，
  // 避免 sessions.json 里 stale 的 status 漏掉刚 handed_off 的 session
  const recent = (() => {
    try { return listRecentTaskRuns({ limit: 50, maxAgeMs: 24 * 3600 * 1000 }); }
    catch (e) { console.warn('[sessions:list] runs read failed:', e.message); return []; }
  })();
  const runsByRunId = new Map(recent.map(r => [r.run_id, r]));
  const runsBySessionId = new Map(recent.filter(r => r.session_id).map(r => [r.session_id, r]));

  const chatEntries = data.sessions.filter(s => !s.archived).map(s => {
    // 如果是 task origin 且能在 runs/ 找到对应的 run，用它的 status 决定 running
    const run = (s.runId && runsByRunId.get(s.runId)) || runsBySessionId.get(s.id);
    const running = run ? run.status === 'running' : false;
    return {
      id: s.id, title: s.title, engine: s.engine,
      updated: run ? (run.finished_at || run.started_at || s.updated) : s.updated, messageCount: s.messages.length,
      groupId: s.groupId || null,
      origin: s.origin || null,
      taskId: s.taskId || null,
      runId: s.runId || null,
      running,
      runStatus: run ? (run.status || null) : (s.runStatus || null),
      exitCode: run ? (run.exit_code ?? null) : (s.exitCode ?? null),
      finishedAt: run ? (run.finished_at || null) : (s.finishedAt || null),
      fallbackFrom: run ? (run.fallback_from || null) : (s.fallbackFrom || null),
      fallbackReason: run ? (run.fallback_reason || null) : (s.fallbackReason || null),
      runtime: run ? (run.runtime || null) : (s.engine || null),
      triggerSource: run ? (run.trigger_source || null) : (s.triggerSource || null),
    };
  });

  // tick 7a: 合流 runs/ 里最近的 task runs 作为虚拟 list entries。
  // dedupe: 已经在 sessions.json 里的 task session（按 runId 或 session.id）不重复添加
  const seenRunIds = new Set(chatEntries.map(e => e.runId).filter(Boolean));
  const seenIds = new Set(chatEntries.map(e => e.id));
  const virtualTaskEntries = [];
  for (const run of recent) {
    if (seenRunIds.has(run.run_id)) continue;
    const entry = taskRunListEntry(run);
    if (seenIds.has(entry.id)) continue;
    virtualTaskEntries.push(entry);
    seenIds.add(entry.id);
    seenRunIds.add(run.run_id);
  }

  return [...chatEntries, ...virtualTaskEntries];
});

ipcMain.handle('sessions:list-archived', () => {
  const data = loadSessions();
  return data.sessions.filter(s => s.archived).map(s => ({
    id: s.id, title: s.title, engine: s.engine,
    updated: s.updated, messageCount: s.messages.length
  }));
});

ipcMain.handle('sessions:load', async (_, id) => {
  const data = loadSessions();
  const existing = data.sessions.find(s => s.id === id);
  if (existing) {
    if (shouldRefreshMaterializedTaskSession(existing)) {
      try {
        const run = findTaskRun({ sessionId: id }) ||
                    (existing.runId ? findTaskRun({ runId: existing.runId }) : null);
        if (run) {
          const refreshed = materializeTaskSessionFromRun(run);
          const idx = data.sessions.findIndex(s => s.id === existing.id);
          const merged = {
            ...existing,
            ...refreshed,
            id: existing.id,
            runId: existing.runId || refreshed.runId || null,
          };
          if (idx >= 0) data.sessions[idx] = merged;
          else data.sessions.push(merged);
          data.activeId = merged.id;
          saveSessions(data);
          if (sessionBus.hasAdapter('run') && (run.session_id || run.status === 'running')) {
            try {
              const _jsonlSid = run.session_id || null;
              sessionBus.registerSession(merged.id, 'run', {
                origin: 'task',
                taskId: merged.taskId,
                runtime: run.runtime,
                runId: run.run_id,
                host: run.host,
              });
              await sessionBus.attach(merged.id, {
                runtime: run.runtime,
                taskId: merged.taskId,
                runId: run.run_id,
                host: run.host,
                jsonlSessionId: _jsonlSid,
              });
            } catch (e) { console.warn('[sessions:load] refreshed task attach failed:', e.message); }
          }
          return merged;
        }
      } catch (e) {
        console.warn('[sessions:load] refresh materialized task failed:', e.message);
      }
    }
    // tick 11b + 刀 3: 已物化的 task session — 重新 attach 到 RunSessionAdapter
    // （PiBrowser 重启后 adapter 的 per-session state 清空，需要从 run record 恢复）
    if (existing.origin === 'task' && sessionBus.hasAdapter('run')) {
      try {
        const run = (existing.runId ? findTaskRun({ runId: existing.runId }) : null) ||
                    findTaskRun({ sessionId: id });
        if (run && (run.session_id || run.status === 'running')) {
          const _jsonlSid = run.session_id || null;
          sessionBus.registerSession(id, 'run', {
            origin: 'task',
            taskId: existing.taskId,
            runtime: run.runtime,
            runId: run.run_id,
            host: run.host,
          });
          await sessionBus.attach(id, {
            runtime: run.runtime,
            taskId: existing.taskId,
            runId: run.run_id,
            host: run.host,
            jsonlSessionId: _jsonlSid,
          });
        }
      } catch (e) { console.warn('[sessions:load] task re-attach (run) failed:', e.message); }
    }
    return existing;
  }

  // tick 7a: lazy 物化 —— sessions:list 返回的虚拟 task entry 点击时会走到这里。
  // 从 runs/ 里找到对应 run record，用 materializeTaskSessionFromRun 构造完整
  // sessionObj，写回 sessions.json，让后续的 save/load 都走 chat session 同一路径。
  try {
    let run = null;
    if (id.startsWith('run:')) {
      run = findTaskRun({ runId: id.slice(4) });
    } else {
      // id 可能是 Claude CLI session uuid（老路径 /pios/open-session 写的那种）
      run = findTaskRun({ sessionId: id });
    }
    if (!run) return null;

    const sessionObj = materializeTaskSessionFromRun(run);
    // 用 sessionObj.id（不是传入的 id），因为 materialize 内部会重新计算
    // 对于 Claude 有 session_id 的 run，两者等价；对于 run:xxx 前缀的也等价
    const data2 = loadSessions();
    const idx = data2.sessions.findIndex(s => s.id === sessionObj.id);
    if (idx >= 0) data2.sessions[idx] = sessionObj;
    else data2.sessions.push(sessionObj);
    data2.activeId = sessionObj.id;
    saveSessions(data2);

    // 刀 3: task session 路由到 RunSessionAdapter（run engine key）
    // jsonlSessionId 传 Claude/Codex 的真 ID 给 adapter 找 jsonl，sessionObj.id 自身保持唯一
    // 2026-04-23: 跑中的 task 即使还没 session_id 也要 attach —— 让 late-attach poll
    //   去 poll run record，watcher 写上 session_id 后立刻接管 tail
    const _shouldAttach = run.session_id || run.status === 'running';
    if (_shouldAttach && sessionBus.hasAdapter('run')) {
      try {
        const _jsonlSid = run.session_id || null;
        sessionBus.registerSession(sessionObj.id, 'run', {
          origin: 'task',
          taskId: sessionObj.taskId,
          runtime: run.runtime,
          runId: run.run_id,
          host: run.host,
        });
        await sessionBus.attach(sessionObj.id, {
          runtime: run.runtime,
          taskId: sessionObj.taskId,
          runId: run.run_id,
          host: run.host,
          jsonlSessionId: _jsonlSid,
        });
      } catch (e) { console.warn('[sessions:load] bus attach (run) failed:', e.message); }
    }
    // Legacy singleton for agent mode path
    if (sessionObj.engine === 'claude' && run.session_id) {
      try { getClaudeClient()._sessionId = run.session_id; } catch {}
    }
    return sessionObj;
  } catch (e) {
    console.warn('[sessions:load] materialize failed:', e.message);
    return null;
  }
});

ipcMain.handle('sessions:save', (_, session) => {
  const data = loadSessions();
  const idx = data.sessions.findIndex(s => s.id === session.id);
  const prev = idx >= 0 ? data.sessions[idx] : null;
  const prevMsgCount = prev?.messages?.length || 0;
  // tick 5: 保留 task 来源字段 —— renderer 发回的 session 对象可能没有 origin/
  // taskId/runId（它只读不写这些字段），full-replace 会抹掉。merge 一下保住。
  // 2026-04-22 加 groupId：sessionSetGroup 写完 groupId 后，renderer 紧接着跑
  // sendMessage → saveCurrentSession 全量覆盖，会把 groupId 抹掉（Call Pi 新会话
  // 落不进 "Things Need You" 分组的根因）。groupId 必须和 task 字段一样 merge 保住。
  const merged = prev
    ? {
        ...session,
        origin: session.origin ?? prev.origin,
        taskId: session.taskId ?? prev.taskId,
        runId: session.runId ?? prev.runId,
        groupId: session.groupId ?? prev.groupId,
      }
    : session;
  if (idx >= 0) data.sessions[idx] = merged;
  else data.sessions.push(merged);
  data.activeId = merged.id;
  saveSessions(data);

  // Worker-log hook: write entry when AI replies
  const newMsgCount = merged.messages?.length || 0;
  const lastMsg = merged.messages?.[newMsgCount - 1];
  if (newMsgCount > prevMsgCount && lastMsg?.role === 'ai') {
    _writeWorkerLogEntry(merged, newMsgCount);
  }
});

ipcMain.handle('sessions:archive', (_, id) => {
  if (id === MAIN_SESSION_ID) return null; // 主会话不可归档
  const data = loadSessions();
  const s = data.sessions.find(s => s.id === id);
  if (s) s.archived = true;
  if (data.activeId === id) {
    const active = data.sessions.filter(s => !s.archived);
    data.activeId = active[active.length - 1]?.id || null;
  }
  saveSessions(data);
  return data.activeId;
});

ipcMain.handle('sessions:unarchive', (_, id) => {
  const data = loadSessions();
  const s = data.sessions.find(s => s.id === id);
  if (s) delete s.archived;
  saveSessions(data);
});

ipcMain.handle('sessions:delete-archived', () => {
  const data = loadSessions();
  const archived = data.sessions.filter(s => s.archived).map(s => s.id);
  data.sessions = data.sessions.filter(s => !s.archived);
  for (const sid of archived) sessionMessages.deleteMessages(sid);
  saveSessions(data);
});

ipcMain.handle('sessions:rename', (_, id, title) => {
  const data = loadSessions();
  const s = data.sessions.find(s => s.id === id);
  if (s) { s.title = title; saveSessions(data); }
});

ipcMain.handle('sessions:delete', (_, id) => {
  const data = loadSessions();
  data.sessions = data.sessions.filter(s => s.id !== id);
  if (data.activeId === id) data.activeId = data.sessions[data.sessions.length - 1]?.id || null;
  sessionMessages.deleteMessages(id);
  saveSessions(data);
  return data.activeId;
});

ipcMain.handle('sessions:getActive', () => {
  const data = loadSessions();
  return data.activeId;
});

// ── 自定义分组 ──
ipcMain.handle('sessions:groups-list', () => {
  const data = loadSessions();
  return data.groups || [];
});

ipcMain.handle('sessions:group-create', (_, name) => {
  const data = loadSessions();
  if (!data.groups) data.groups = [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const order = data.groups.length;
  data.groups.push({ id, name, order });
  saveSessions(data);
  return { id, name, order };
});

ipcMain.handle('sessions:group-rename', (_, id, name) => {
  const data = loadSessions();
  const g = (data.groups || []).find(g => g.id === id);
  if (g) { g.name = name; saveSessions(data); }
});

ipcMain.handle('sessions:group-delete', (_, id) => {
  const data = loadSessions();
  data.groups = (data.groups || []).filter(g => g.id !== id);
  // 移除会话的 groupId
  for (const s of data.sessions) {
    if (s.groupId === id) delete s.groupId;
  }
  saveSessions(data);
});

ipcMain.handle('sessions:set-group', (_, sessionId, groupId) => {
  const data = loadSessions();
  const s = data.sessions.find(s => s.id === sessionId);
  if (s) {
    if (groupId) s.groupId = groupId;
    else delete s.groupId;
    saveSessions(data);
  }
});

// 保留旧 API 兼容（不再写文件）
ipcMain.handle('conversation:save', (_, engine, role, content) => {});
ipcMain.handle('conversation:load', () => []);
ipcMain.handle('conversation:clear', () => {});

// 历史记录
const historyFile = path.join(app.getPath('userData'), 'history.json');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(historyFile, 'utf-8')); } catch { return []; }
}

ipcMain.handle('history:list', () => loadHistory().slice(-100).reverse());

ipcMain.handle('history:remove', (_, url) => {
  let h = loadHistory();
  h = h.filter(i => i.url !== url);
  fs.writeFileSync(historyFile, JSON.stringify(h, null, 2));
});

ipcMain.handle('history:clear', () => {
  fs.writeFileSync(historyFile, '[]');
});

function addToHistory(title, url) {
  if (!url || url === 'about:blank') return;
  const history = loadHistory();
  history.push({ title, url, visited: new Date().toISOString() });
  // 保留最近 500 条
  const trimmed = history.slice(-500);
  fs.writeFileSync(historyFile, JSON.stringify(trimmed, null, 2));
}

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
    // 通知渲染进程隐身模式状态变化
    if (mainWindow) mainWindow.webContents.send('privacy:status', { invisible: result, incognito: result });
    return result;
  }
  return isIncognito();
});
ipcMain.handle('privacy:check', (_, url) => isInvisible(url));

// 从日志文件中提取指定 run 的输出片段
// 日志结构：pios-tick 写 [date] [host] START/END 标记，adapter 在中间 append tail -80 行输出
// 有些 run 缺少 START/END 标记，只有 adapter 输出直接 append
function extractRunFromLog(logContent, runRecord) {
  const lines = logContent.split('\n');
  const taskName = runRecord.plugin_name ||
                   runRecord.taskId ||
                   (runRecord.run_id ? String(runRecord.run_id).replace(/-\d{8}-\d{6}$/, '') : '') ||
                   runRecord.agent || '';
  const startTime = new Date(runRecord.started_at);
  const startHm = runRecord.started_at ? String(runRecord.started_at).slice(11, 16) : '';

  // 策略1: START/END 标记匹配（最可靠）
  const startMarker = `START: ${taskName}`;
  const endMarker = `END: ${taskName}`;
  let bestStart = -1, bestEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startMarker)) {
      if (!startHm || lines[i].includes(startHm)) {
        bestStart = i;
      }
    }
    if (bestStart >= 0 && lines[i].includes(endMarker) && i > bestStart) {
      bestEnd = i;
      break;
    }
  }

  if (bestStart >= 0) {
    let end = bestEnd >= 0 ? bestEnd + 1 : -1;
    if (end < 0) {
      for (let i = bestStart + 1; i < lines.length; i++) {
        if (lines[i].includes(startMarker)) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) end = Math.min(bestStart + 400, lines.length);
    return lines.slice(bestStart, end).join('\n');
  }

  // 策略2: 用 adapter 输出中的时间戳定位（### YYYY-MM-DD HH:MM 格式的段落标题）
  // 找所有有时间戳的行作为边界
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const tsMatch = lines[i].match(/### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    if (tsMatch) {
      boundaries.push({ line: i, time: new Date(`${tsMatch[1]}T${tsMatch[2]}:00`) });
    }
    // 也检查 [date] 格式
    const bracketMatch = lines[i].match(/^\[(\w+ \w+ \d+ [\d:]+ \w+ \d+)\]/);
    if (bracketMatch) {
      boundaries.push({ line: i, time: new Date(bracketMatch[1]) });
    }
  }

  // 找最接近 run started_at 的边界
  let closestIdx = -1, closestDist = Infinity;
  for (let i = 0; i < boundaries.length; i++) {
    const dist = Math.abs(boundaries[i].time.getTime() - startTime.getTime());
    if (dist < closestDist && dist < 300000) { // 5 分钟容差
      closestDist = dist;
      closestIdx = i;
    }
  }

  if (closestIdx >= 0) {
    const startLine = boundaries[closestIdx].line;
    // 找下一个边界（属于不同 run 的）
    let endLine = lines.length;
    for (let i = closestIdx + 1; i < boundaries.length; i++) {
      const gap = boundaries[i].time.getTime() - boundaries[closestIdx].time.getTime();
      if (gap > 60000) { // 下一个边界超过 1 分钟后 = 不同 run
        endLine = boundaries[i].line;
        break;
      }
    }
    return lines.slice(startLine, endLine).join('\n');
  }

  // 策略3: 回退 — 返回最后 80 行（adapter 默认 tail 长度）
  if (lines.length > 80) {
    return lines.slice(-80).join('\n');
  }
  return logContent;
}

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

  // ── 内置 Scheduler: 每 60 秒 spawn pios-tick.sh ──
  // 替代外部 cron，让 PiOS.app 成为独立可分发产品
  const _tickScript = (() => {
    // bash 不能 exec asar 内部路径——必须用 asar.unpacked 的真实路径
    // （backend/tools/** 已在 package.json asarUnpack，打包时会同时解出到 app.asar.unpacked/）
    const bundleTick = path.join(__dirname, 'backend', 'tools', 'pios-tick.sh');
    const bundleTickUnpacked = bundleTick.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const vaultTick = path.join(VAULT_ROOT, 'Pi', 'Tools', 'pios-tick.sh');
    // 优先 asar.unpacked（真实文件，bash 可 exec），fallback 到 vault 副本（旧安装兜底），最后 dev 模式用 __dirname
    if (bundleTickUnpacked !== bundleTick && fs.existsSync(bundleTickUnpacked)) return bundleTickUnpacked;
    if (fs.existsSync(vaultTick)) return vaultTick;
    if (fs.existsSync(bundleTick)) return bundleTick; // dev 模式（非打包运行）
    return null;
  })();
  if (_tickScript) {
    const { spawn } = require('child_process');
    const _runTick = () => {
      // 未装完（vault 不存在）就跑 tick 会挂；另 PATH 必须扩展，否则 tick → adapter → claude/codex 找不到二进制
      if (!installer.isInstalled()) return;
      const child = spawn('bash', [_tickScript], {
        env: {
          ...process.env,
          PIOS_VAULT: VAULT_ROOT,
          // Electron 子进程默认 PATH 只有 /usr/bin:/bin，不含 Homebrew / npm global。
          // adapter 调 claude/codex 需要扩 PATH，否则 task 静默失败（owner 报 pi-worker 到点没跑根因）
          PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${process.env.HOME}/.claude/local:${process.env.HOME}/.npm-global/bin:${process.env.PATH || '/usr/bin:/bin'}`,
        },
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
    };
    _runTick(); // 启动时立即跑一次（isInstalled=false 会 early return）
    _tickTimer = setInterval(_runTick, 60 * 1000);
    console.log(`[scheduler] pios-tick.sh started (${_tickScript})`);

    // 2026-04-27: macOS sleep 唤醒后立即补一次 pios-tick（不等下个 60s 周期）。
    // 根因：laptop-host 合盖 sleep → setInterval 暂停 → 醒来等 ≤60s 才跑第一次 →
    //   catch-up 每 tick 最多 2 个 → 8h 空窗漏 reflect/sense-maker/wechat 等 N
    //   个 task → reflect 连续 2 天没自动跑实锤（pi-state-now 04-27 顶段记录）。
    // 修：powerMonitor.on('resume') 立即 kick 一次 _runTick，让 catch-up 链早
    //   启动 6 小时。同时落盘 sleep marker 给 diagnostic。
    try {
      const { powerMonitor } = require('electron');
      const _sleepMarkerPath = path.join(VAULT_ROOT, 'Pi/Log/pios-tick-sleep-marker.jsonl');
      powerMonitor.on('suspend', () => {
        try { fs.appendFileSync(_sleepMarkerPath, JSON.stringify({ ev: 'suspend', ts: new Date().toISOString() }) + '\n'); } catch {}
      });
      powerMonitor.on('resume', () => {
        try { fs.appendFileSync(_sleepMarkerPath, JSON.stringify({ ev: 'resume', ts: new Date().toISOString() }) + '\n'); } catch {}
        console.log('[scheduler] powerMonitor resume → immediate pios-tick');
        _runTick();
      });
    } catch (e) {
      console.warn('[scheduler] powerMonitor unavailable:', e.message);
    }
  } else {
    console.warn('[scheduler] pios-tick.sh not found, internal scheduler disabled');
  }

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

// ══════════════════════════════════════════════════════
// ── Browser Control HTTP API (for MCP server bridge) ──
// ══════════════════════════════════════════════════════
const httpServer = require('http').createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const endpoint = url.pathname;

  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // Afterward API: /afterward/api/* — delegated to module for token-based vault access.
  // Placed BEFORE the GET block so GET list/read/whoami don't fall through to the block's
  // terminal 404, and BEFORE the POST body-reading loop so write ops can read their own body.
  if (endpoint.startsWith('/afterward/api/') && afterward && typeof afterward.handleApiRequest === 'function') {
    try {
      const handled = await afterward.handleApiRequest(req, res, endpoint, url);
      if (handled) return;
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // ── GET routes (PiOS Home + API) ──
  if (req.method === 'GET') {
    if (endpoint === '/home') {
      // Prefer vault copy (live-editable) over bundled copy
      const vaultHome = path.join(VAULT_ROOT, 'Projects', 'pios', 'pios-home.html');
      const homePath = fs.existsSync(vaultHome) ? vaultHome : path.join(__dirname, 'pios-home.html');
      try {
        const html = fs.readFileSync(homePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('PiOS Home not found');
      }
      return;
    }
    if (endpoint.startsWith('/vendor/')) {
      const rel = endpoint.replace(/^\/vendor\//, '');
      if (rel.includes('..') || rel.includes('\0') || rel.startsWith('/')) {
        res.writeHead(400); res.end('bad path'); return;
      }
      const vaultVendor = path.join(VAULT_ROOT, 'Projects', 'pios', 'vendor', rel);
      const bundledVendor = path.join(__dirname, 'vendor', rel);
      const vendorPath = fs.existsSync(vaultVendor) ? vaultVendor : bundledVendor;
      try {
        const data = fs.readFileSync(vendorPath);
        const ct = rel.endsWith('.js')  ? 'application/javascript; charset=utf-8'
                 : rel.endsWith('.css') ? 'text/css; charset=utf-8'
                 : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }
    if (endpoint === '/pios/overview') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(pios.getSystemOverview()));
      return;
    }
    if (endpoint === '/pios/owner-queue') {
      // Single-source-of-truth endpoint for "things needing owner attention".
      // Query params: include=outputs,inbox (comma-separated)
      const inc = (url.searchParams.get('include') || '').split(',').map(s => s.trim());
      const opts = { includeOutputs: inc.includes('outputs'), includeInbox: inc.includes('inbox') };
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getOwnerQueue(opts)));
      return;
    }
    if (endpoint === '/pios/my-todos') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getMyTodos()));
      return;
    }
    if (endpoint === '/pios/voices') {
      // 代理 qwen-voice /api/voices（绕开 renderer 跨源限制）
      const httpMod = require('http');
      httpMod.get('http://localhost:7860/api/voices', (up) => {
        let buf = '';
        up.on('data', (c) => (buf += c));
        up.on('end', () => {
          res.writeHead(up.statusCode || 200, jsonHeaders);
          res.end(buf || '{"voices":[],"builtin_voices":[],"clone_voices":[]}');
        });
      }).on('error', (e) => {
        res.writeHead(502, jsonHeaders);
        res.end(JSON.stringify({ error: e.message, voices: [], builtin_voices: [], clone_voices: [] }));
      });
      return;
    }
    // ── Real-time events (SSE): subscribe to Cards/ + Pi/Output/ file changes ──
    if (endpoint === '/pios/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      // Tell client to reconnect with a short delay if the connection drops
      res.write('retry: 2000\n\n');
      res.write('event: hello\ndata: {"ok":true}\n\n');

      // Debounce: collect events, flush every 400ms so a flurry of fs.watch events
      // (e.g. Syncthing writing 10 files) collapses into one SSE message.
      let pending = { cards: new Set(), outputs: new Set() };
      let flushTimer = null;
      const flush = () => {
        flushTimer = null;
        const cards = [...pending.cards];
        const outputs = [...pending.outputs];
        pending = { cards: new Set(), outputs: new Set() };
        if (cards.length || outputs.length) {
          try {
            const events = cards.length ? pios.buildEvents(cards) : [];
            res.write('event: change\ndata: ' + JSON.stringify({ cards, outputs, events, ts: Date.now() }) + '\n\n');
          } catch {}
        }
      };

      const unsub = pios.subscribeChanges(({ kind, filename }) => {
        const stem = filename.replace(/\.md$/, '').split('/').pop();
        if (kind === 'card') pending.cards.add(stem);
        else if (kind === 'output') pending.outputs.add(filename);
        if (!flushTimer) flushTimer = setTimeout(flush, 400);
      });

      // Heartbeat every 30s to keep proxies + client EventSource alive
      const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch {}
      }, 30000);

      const cleanup = () => {
        try { unsub(); } catch {}
        clearInterval(heartbeat);
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      };
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      // Don't end the response — keep alive until client disconnects
      return;
    }
    // 刀 3: GET /session/{id}/attach —— SSE 流，订阅 SessionBus 事件
    // 给外部 HTTP 客户端（pios-home 未来、命令行工具等）一个不走 Electron IPC
    // 就能实时看任务的口子。
    //
    // 参数：?engine=run&runtime=claude-cli&taskId=xxx&runId=xxx&host=laptop-host
    //       可选，如果 session 还没 register 的话用这组参数 lazy register
    //
    // Format: SSE 每行 `data: {JSON}\n\n`，JSON = BusEvent (type/content/sessionId/replay)
    const attachMatch = endpoint.match(/^\/session\/([\w-]+)\/attach$/);
    if (attachMatch) {
      const sid = attachMatch[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ sessionId: sid, ok: true })}\n\n`);

      // 如果 session 没 register，按查询参数做 lazy register（给外部客户端方便）
      if (!sessionBus.getSession(sid)) {
        const engine = url.searchParams.get('engine') || 'run';
        try {
          sessionBus.registerSession(sid, engine, {
            origin: url.searchParams.get('origin') || 'task',
            taskId: url.searchParams.get('taskId') || null,
            runtime: url.searchParams.get('runtime') || 'claude-cli',
            runId: url.searchParams.get('runId') || null,
            host: url.searchParams.get('host') || null,
          });
          await sessionBus.attach(sid, {
            runtime: url.searchParams.get('runtime') || 'claude-cli',
            taskId: url.searchParams.get('taskId') || null,
            runId: url.searchParams.get('runId') || null,
            host: url.searchParams.get('host') || null,
          });
        } catch (e) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
        }
      }

      // 订阅 bus 事件 → 写 SSE
      const unsub = sessionBus.subscribe(sid, (ev) => {
        try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
      });

      // 心跳
      const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch {}
      }, 30000);

      const cleanup = () => {
        try { unsub(); } catch {}
        clearInterval(heartbeat);
      };
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      return;
    }

    if (endpoint === '/pios/decisions') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(pios.getDecisionQueue()));
      return;
    }
    if (endpoint === '/pios/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(pios.loadAgents()));
      return;
    }
    if (endpoint === '/pios/projects') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(pios.getProjects()));
      return;
    }
    if (endpoint === '/pios/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(installer.loadConfig()));
      return;
    }
    if (endpoint === '/pios/runs') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getRecentRuns(30)));
      return;
    }
    // Host × Runtime 矩阵真相：读每台 host 的 auth-status 文件，返回
    // { host: [runtime-names 可用的] }。UI 用这个判断"给 agent 加 host 时
    // 这个 host 装了没 agent 需要的 runtime"。
    if (endpoint === '/pios/host-runtimes') {
      try {
        const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
        const out = {};
        if (fs.existsSync(logDir)) {
          for (const f of fs.readdirSync(logDir)) {
            const m = f.match(/^auth-status-(.+)\.json$/);
            if (!m) continue;
            const host = m[1];
            try {
              const data = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf-8'));
              const engines = data.engines || {};
              out[host] = Object.keys(engines).filter(e => engines[e] && engines[e].ok !== false);
            } catch { out[host] = []; }
          }
        }
        // 同时保证 pios.yaml 里声明的 infra.instances 每个 host 都出现（就算没 auth-status）
        try {
          const yaml = require('js-yaml');
          const manifestPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
          const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
          const instances = (manifest && manifest.infra && manifest.infra.instances) || {};
          for (const h of Object.keys(instances)) if (!(h in out)) out[h] = [];
        } catch {}
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // Schema 合规性校验（静态检查，返回违规清单给 UI 展示）
    // 规则：
    //  1. task.host 必须 ∈ agent.hosts
    //  2. task.runtimes 里每个都必须 ∈ agent.runtimes
    //  3. task.host 必须装了 task.runtimes 至少一个（与 host-runtimes 矩阵对照）
    //  4. agent.hosts 里每个必须至少装了 agent.runtimes 一个
    if (endpoint === '/pios/validate-manifest') {
      try {
        const yaml = require('js-yaml');
        const manifestPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
        const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
        const agents = (manifest && manifest.agents) || {};
        // 复用 host-runtimes 逻辑
        const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
        const hostRt = {};
        if (fs.existsSync(logDir)) {
          for (const f of fs.readdirSync(logDir)) {
            const m = f.match(/^auth-status-(.+)\.json$/);
            if (!m) continue;
            try {
              const data = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf-8'));
              const engines = data.engines || {};
              hostRt[m[1]] = Object.keys(engines).filter(e => engines[e] && engines[e].ok !== false);
            } catch { hostRt[m[1]] = []; }
          }
        }
        const violations = [];
        for (const [aid, a] of Object.entries(agents)) {
          const declaredHosts = Array.isArray(a.hosts) ? a.hosts : (a.host ? [a.host] : []);
          const declaredRt = Array.isArray(a.runtimes) ? a.runtimes : (a.runtime ? [a.runtime] : []);
          // Rule 4: agent hosts × runtimes 至少交集
          for (const h of declaredHosts) {
            if (h === 'any') continue;
            const hostRts = hostRt[h] || [];
            if (!declaredRt.some(r => hostRts.includes(r))) {
              violations.push({ severity: 'error', kind: 'agent-host-runtime-mismatch',
                agent: aid, host: h, detail: `host ${h} 没装 agent.runtimes(${declaredRt.join(',')}) 任何一个（该 host 支持 ${hostRts.join(',') || '无'}）` });
            }
          }
          for (const [tid, t] of Object.entries(a.tasks || {})) {
            if (t.enabled === false) continue;
            // Rule 1: task.host ∈ agent.hosts
            const th = t.host;
            if (th && th !== 'any' && !declaredHosts.includes(th)) {
              violations.push({ severity: 'error', kind: 'task-host-not-declared',
                agent: aid, task: tid, host: th, detail: `task.host=${th} 未在 agent.hosts 声明` });
            }
            // Rule 2: task.runtimes ⊆ agent.runtimes
            const trts = Array.isArray(t.runtimes) ? t.runtimes : (Array.isArray(t.engines) ? t.engines : []);
            for (const r of trts) {
              if (!declaredRt.includes(r)) {
                violations.push({ severity: 'error', kind: 'task-runtime-not-declared',
                  agent: aid, task: tid, runtime: r, detail: `task.runtimes 含 ${r}，未在 agent.runtimes 声明` });
              }
            }
            // Rule 3: task.host 必须装了 task.runtimes 至少一个
            if (th && th !== 'any' && trts.length) {
              const hostRts = hostRt[th] || [];
              if (!trts.some(r => hostRts.includes(r))) {
                violations.push({ severity: 'error', kind: 'task-host-runtime-unavailable',
                  agent: aid, task: tid, host: th, detail: `${th} 没装 task.runtimes(${trts.join(',')}) 任何一个（该 host 支持 ${hostRts.join(',') || '无'}）` });
              }
            }
          }
        }
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: violations.length === 0, violations }));
      } catch (e) {
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/agent-runs') {
      const id = url.searchParams.get('id');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(id ? pios.getAgentRuns(id, limit) : []));
      return;
    }
    if (endpoint === '/pios/agent/retire-stats') {
      const id = url.searchParams.get('id');
      if (!id) { res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: 'id required' })); return; }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getAgentRetireStats(id)));
      return;
    }
    if (endpoint === '/pios/agent-log') {
      const id = url.searchParams.get('id');
      const lines = parseInt(url.searchParams.get('lines') || '50');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(id ? pios.getAgentLog(id, lines) : { lines: [] }));
      return;
    }
    if (endpoint === '/pios/services') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getServices()));
      return;
    }
    if (endpoint === '/pios/services/health') {
      const results = await pios.checkAllServices();
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(results));
      return;
    }
    if (endpoint === '/pios/health-report') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getHealthReport()));
      return;
    }
    if (endpoint === '/pios/notify-settings') {
      const settingsFile = path.join(VAULT_ROOT, 'Pi', 'Config', 'notify-settings.json');
      try {
        const data = fs.readFileSync(settingsFile, 'utf-8');
        res.writeHead(200, jsonHeaders);
        res.end(data);
      } catch {
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ voice: true, popup: true }));
      }
      return;
    }
    if (endpoint === '/pios/notifications') {
      const limit = parseInt(url.searchParams.get('limit') || '500');
      const dateFilter = url.searchParams.get('date') || ''; // YYYY-MM-DD
      const histFile = path.join(VAULT_ROOT, 'Pi', 'Log', 'notify-history.jsonl');
      let items = [];
      // 从 config.json 读 host_map 做显示映射
      const HOST_LABELS = (() => {
        try { return (require('./backend/host-helper').loadConfig().host_map) || {}; }
        catch { return {}; }
      })();
      try {
        const lines = fs.readFileSync(histFile, 'utf-8').trim().split('\n').filter(Boolean);
        const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        // Normalize to unified format: {time, text, level, source}
        const normalized = all.map(item => {
          const rawSource = item.source || item.host || '';
          return {
            time: item.time || item.ts || '',
            text: item.text || item.msg || item.body || '',
            level: item.level || '',
            source: HOST_LABELS[rawSource] || rawSource,
          };
        });
        // Filter out empty
        const nonEmpty = normalized.filter(item => item.text.trim());
        // 去重：同文本 60 秒内只保留第一条
        const seen = [];
        items = nonEmpty.reverse().filter(item => {
          const t = new Date(item.time).getTime() || 0;
          const dup = seen.find(s => s.text === item.text && Math.abs(t - s.t) < 60000);
          if (dup) return false;
          seen.push({ text: item.text, t });
          return true;
        });
        // Filter by date if provided
        if (dateFilter) {
          items = items.filter(item => {
            const d = item.time ? new Date(item.time) : null;
            return d && d.toLocaleDateString('sv-SE') === dateFilter;
          });
        }
        items = items.slice(0, limit);
      } catch {}
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(items));
      return;
    }
    // Activity log — parse worker-log files locally, filter by ?date=YYYY-MM-DD
    if (endpoint === '/pios/activity') {
      const dateFilter = url.searchParams.get('date') || ''; // YYYY-MM-DD
      const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
      let allText = '';
      try {
        const shards = fs.readdirSync(logDir).filter(f => f.startsWith('worker-log-') && f.endsWith('.md')).sort();
        for (const s of shards) {
          try { allText += fs.readFileSync(path.join(logDir, s), 'utf-8') + '\n'; } catch {}
        }
        const legacy = path.join(logDir, 'worker-log.md');
        if (fs.existsSync(legacy)) { try { allText += fs.readFileSync(legacy, 'utf-8'); } catch {} }
      } catch {}
      const HOST_NORM = (() => {
        try { return (require('./backend/host-helper').loadConfig().host_map) || {}; }
        catch { return {}; }
      })();
      const entries = [];
      let current = null;
      for (const line of allText.split('\n')) {
        if (line.startsWith('### ')) {
          if (current) entries.push(current);
          const header = line.slice(4).trim();
          const hostMatch = header.match(/\[([^\]]+)\]/);
          const rawHost = hostMatch ? hostMatch[1] : '';
          const meta = { engine: '', agent: '', task: '', host: HOST_NORM[rawHost] || rawHost };
          for (const key of ['engine', 'agent', 'task']) {
            const km = header.match(new RegExp(`\\b${key}:(\\S+)`));
            if (km) meta[key] = km[1].replace(/\|$/, '').trim();
          }
          current = { header, lines: [], ...meta };
        } else if (current && line.startsWith('- ')) {
          current.lines.push(line.slice(2));
        } else if (current && line.startsWith('  ')) {
          current.lines.push(line);
        }
      }
      if (current) entries.push(current);
      // Filter by date if provided
      const filtered = dateFilter
        ? entries.filter(e => e.header.match(/(\d{4}-\d{2}-\d{2})/)?.[1] === dateFilter)
        : entries;
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(filtered));
      return;
    }
    if (endpoint === '/pios/token-status') {
      // 直接读 Vault 里的 token-snapshot.json（worker-host 写，Syncthing 同步）
      try {
        const raw = fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Log', 'token-snapshot.json'), 'utf-8');
        res.writeHead(200, jsonHeaders);
        res.end(raw);
      } catch (e) {
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ error: e.message, five_hour_pct: null, seven_day_pct: null }));
      }
      return;
    }
    if (endpoint === '/pios/pipeline-freshness') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getPipelineFreshness()));
      return;
    }
    if (endpoint === '/pios/auth-status') {
      // New per-host model: read Pi/Log/auth-status-*.json (each host writes its own),
      // plus probe remote hosts that haven't written one yet via SSH.
      // Returns:
      //   {
      //     updated_at: <latest>,
      //     hosts: {
      //       laptop-host:    { updated_at, engines: {claude-cli: {ok, detail, login_supported}, ...}},
      //       worker-host: { updated_at, engines: {...}}
      //     },
      //     // Backward-compat flat "engines" key: merged view with the *worst* state per engine
      //     engines: { "claude-cli": {ok, detail}, ... }
      //   }
      const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
      const hosts = {};
      let latestTs = null;

      // 1. Read all per-host files
      try {
        for (const f of fs.readdirSync(logDir)) {
          const m = f.match(/^auth-status-([a-z0-9_-]+)\.json$/i);
          if (!m) continue;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8'));
            const hostName = data.host || m[1];
            hosts[hostName] = data;
            if (data.updated_at && (!latestTs || data.updated_at > latestTs)) latestTs = data.updated_at;
          } catch {}
        }
      } catch {}

      // 2. For any host registered in pios.yaml but missing from per-host files,
      //    derive its state from **adapter run records** (Pi/State/runs/*.json).
      //    This is a ZERO-cost probe — we read files that adapter already writes
      //    as a side-effect of running tasks. No SSH, no API calls, no tokens.
      //    Run records are Syncthing-shared so laptop-host can see worker-host's records.
      try {
        const yaml = require('js-yaml');
        const manifest = yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
        const instances = (manifest && manifest.infra && manifest.infra.instances) || {};
        const allAgents = (manifest && manifest.agents) || {};
        // Only infer for hosts that are actually targets of a claude-cli agent
        // or task. Storage/relay nodes (storage-host, vpn-host) have no AI engines
        // and should not appear in the auth UI at all.
        const hostsWithClaudeCli = new Set();
        for (const agent of Object.values(allAgents)) {
          if (agent.runtime !== 'claude-cli') continue;
          const agentHosts = Array.isArray(agent.hosts) ? agent.hosts : (agent.host ? [agent.host] : []);
          for (const h of agentHosts) if (h) hostsWithClaudeCli.add(h);
          for (const task of Object.values(agent.tasks || {})) {
            const taskHosts = Array.isArray(task.hosts) ? task.hosts : (task.host ? [task.host] : []);
            for (const h of taskHosts) if (h) hostsWithClaudeCli.add(h);
          }
        }
        // Target hosts = pios.yaml instances that (a) have no auth-status file yet
        // AND (b) are actually used by a claude-cli agent
        const missing = Object.keys(instances).filter(h => !hosts[h] && hostsWithClaudeCli.has(h));
        if (missing.length) {
          // Build an index: { host: { runtime: latestRun } } by scanning recent run records.
          const runsDir = path.join(VAULT_ROOT, 'Pi', 'State', 'runs');
          const recentByHostRuntime = {};  // host -> runtime -> latest run record
          try {
            const files = fs.readdirSync(runsDir);
            // Only look at runs from the past 24 hours (by filename date) to keep this fast
            const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
            const recent = files.filter(f => f.includes(today) || f.includes(yesterday));
            for (const fname of recent) {
              try {
                const rec = JSON.parse(fs.readFileSync(path.join(runsDir, fname), 'utf8'));
                const h = rec.host;
                const rt = rec.runtime || rec.requested_runtime;
                if (!h || !rt) continue;
                const startedAt = rec.started_at || rec.finished_at;
                if (!recentByHostRuntime[h]) recentByHostRuntime[h] = {};
                const existing = recentByHostRuntime[h][rt];
                if (!existing || (startedAt && startedAt > (existing.started_at || ''))) {
                  recentByHostRuntime[h][rt] = rec;
                }
              } catch {}
            }
          } catch {}

          // Honest classification: failed = failed (don't pretend ok from a failure).
          // ok:   last run succeeded
          // fail: last run failed (any reason — auth, quota, runtime-error, tool error, whatever)
          // null: no recent runs
          const classifyRun = (rec) => {
            if (!rec) return { ok: null, detail: 'no recent runs' };
            const succeeded = rec.status === 'success' || rec.status === 'ok' || rec.exit_code === 0;
            if (succeeded) {
              return { ok: true, detail: `last run ok (${rec.agent || rec.run_id || '?'})` };
            }
            const reason = rec.fallback_reason || `exit ${rec.exit_code != null ? rec.exit_code : '?'}`;
            return { ok: false, detail: `last run failed — ${reason}` };
          };

          for (const host of missing) {
            const runtimes = recentByHostRuntime[host] || {};
            const engines = {};
            // For each runtime we've seen recent runs on, classify it
            for (const [rt, rec] of Object.entries(runtimes)) {
              const c = classifyRun(rec);
              if (c.ok === null) continue;
              engines[rt] = {
                ok: c.ok,
                detail: c.detail,
                login_supported: rt === 'claude-cli',
              };
            }
            // If no runs recorded for claude-cli on this host, still show a row
            // so user can explicitly Login. Mark as "unknown (no recent runs)".
            if (!engines['claude-cli']) {
              engines['claude-cli'] = {
                ok: null,  // tri-state: null = unknown
                detail: 'no recent runs on this host',
                login_supported: true,
              };
            }
            hosts[host] = {
              host,
              updated_at: new Date().toISOString(),
              engines,
              probe_method: 'run-records',
            };
          }
        }
      } catch {}

      // 3. Flat merged "engines" view for backward compat — worst status wins.
      const mergedEngines = {};
      for (const [hostName, hostData] of Object.entries(hosts)) {
        const engines = (hostData && hostData.engines) || {};
        for (const [ename, einfo] of Object.entries(engines)) {
          if (!mergedEngines[ename]) {
            mergedEngines[ename] = { ...einfo };
          } else if (mergedEngines[ename].ok && einfo && einfo.ok === false) {
            // Downgrade to the failing state
            mergedEngines[ename] = { ...einfo, detail: `${hostName}: ${einfo.detail}` };
          }
        }
      }

      const result = {
        updated_at: latestTs,
        hosts,
        engines: mergedEngines,  // backward compat
      };
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(result));
      return;
    }
    // ── GET: Auth login session status (polling) ──
    if (endpoint === '/pios/auth/login/status') {
      const sessionId = url.searchParams.get('id');
      const session = _loginSessions.get(sessionId);
      if (!session) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'not_found', id: sessionId }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({
        id: sessionId,
        host: session.host,
        state: session.state,
        url: session.url,
        email: session.email,
        exitCode: session.exitCode,
        elapsed: Math.floor((Date.now() - session.startedAt) / 1000),
        lines: session.lines.slice(-30),
        error: session.error || null,
      }));
      return;
    }
    if (endpoint === '/pios/daily-briefing') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getDailyBriefing()));
      return;
    }
    if (endpoint === '/pios/search') {
      const q = url.searchParams.get('q') || '';
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.searchFullText(q, { limit })));
      return;
    }
    if (endpoint === '/pios/suggestions') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.getPiSuggestions()));
      return;
    }
    if (endpoint === '/pios/cards') {
      const filter = {};
      if (url.searchParams.get('status')) filter.status = url.searchParams.get('status');
      if (url.searchParams.get('type')) filter.type = url.searchParams.get('type');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.loadCards(filter)));
      return;
    }
    if (endpoint === '/pios/direction/heat') {
      const w = parseInt(url.searchParams.get('window') || '7', 10);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.computeDirectionHeat(w)));
      return;
    }
    if (endpoint === '/pios/card') {
      const name = url.searchParams.get('name');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(name ? pios.readCard(name) : null));
      return;
    }

    // ── GET: Outputs ──
    if (endpoint === '/pios/outputs') {
      const category = url.searchParams.get('category') || '';
      const list = pios.loadOutputs(category || undefined);
      // Strip _preview for list performance unless requested
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(list));
      return;
    }
    if (endpoint === '/pios/output') {
      const id = url.searchParams.get('id');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(id ? pios.readOutput(id) : null));
      return;
    }
    if (endpoint === '/pios/output/pdf') {
      const id = url.searchParams.get('id');
      if (!id) { res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: 'missing id' })); return; }
      try {
        const doc = pios.readOutput(id);
        if (!doc) { res.writeHead(404, jsonHeaders); res.end(JSON.stringify({ error: 'not found' })); return; }
        // Lazy-load marked (already a dep)
        let mdHtml;
        try {
          const { marked } = require('marked');
          mdHtml = marked.parse(doc.content || '');
        } catch (e) {
          mdHtml = '<pre>' + String(doc.content || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>';
        }
        const title = (doc.frontmatter && doc.frontmatter.title) || id.split('/').pop().replace(/\.md$/, '');
        const category = id.split('/')[0] || '';
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>
<style>
  body { font-family: -apple-system, 'PingFang SC', 'Helvetica Neue', system-ui, sans-serif; padding: 48px 64px; max-width: 780px; margin: 0 auto; color: #111; line-height: 1.7; }
  h1 { font-size: 22px; border-bottom: 2px solid #222; padding-bottom: 6px; margin-top: 0; }
  h2 { font-size: 17px; margin-top: 22px; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
  h3 { font-size: 15px; margin-top: 18px; }
  h4, h5, h6 { font-size: 14px; margin-top: 14px; }
  p { margin: 8px 0; }
  code { background: #f3f3f3; padding: 2px 5px; border-radius: 3px; font-family: 'SF Mono', Consolas, monospace; font-size: 12px; }
  pre { background: #f6f8fa; padding: 12px 16px; border-radius: 6px; overflow: auto; font-size: 12px; border: 1px solid #e0e0e0; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 10px 0; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; font-size: 13px; }
  th { background: #f3f3f3; }
  blockquote { border-left: 3px solid #ccc; padding-left: 12px; color: #555; margin: 10px 0; }
  ul, ol { padding-left: 22px; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 20px 0; }
  .meta { font-size: 11px; color: #777; margin-bottom: 20px; }
  a { color: #1f6feb; }
</style></head><body>
<div class="meta">${category} &nbsp;·&nbsp; ${id}</div>
<h1>${title.replace(/</g, '&lt;')}</h1>
${mdHtml}
</body></html>`;

        const pdfWin = new BrowserWindow({
          show: false,
          webPreferences: { offscreen: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        await pdfWin.loadURL(dataUrl);
        const pdfBuffer = await pdfWin.webContents.printToPDF({
          marginsType: 0,
          pageSize: 'A4',
          printBackground: true,
        });
        try { pdfWin.close(); } catch {}
        const filename = (title || 'output').replace(/[^\w\-]+/g, '_').slice(0, 80) + '.pdf';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': pdfBuffer.length,
        });
        res.end(pdfBuffer);
      } catch (e) {
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── GET: Task management ──
    if (endpoint === '/pios/tasks') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(pios.loadTasks()));
      return;
    }
    if (endpoint === '/pios/task') {
      const id = url.searchParams.get('id');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(id ? pios.getTask(id) : null));
      return;
    }
    if (endpoint === '/pios/task-runs') {
      const id = url.searchParams.get('id');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(id ? pios.getTaskRuns(id, limit) : []));
      return;
    }
    if (endpoint === '/pios/session') {
      const id = url.searchParams.get('id');
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(id ? pios.getSessionConversation(id) : { messages: [], found: false }));
      return;
    }

    // ── User Management API ──
    if (endpoint === '/pios/users') {
      const configPath = path.join(process.env.HOME, '.pios', 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const vaults = config.known_vaults || [{ name: config.owner_name || 'Default', path: config.vault_root }];
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ current: config.vault_root, owner: config.owner_name, vaults }));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Manifest API ──
    if (endpoint === '/pios/manifest') {
      const yaml = require('js-yaml');
      const manifestPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
      try {
        const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(manifest));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // ── Profile API (Cognition Layer P4) ──
    if (endpoint === '/pios/profile') {
      try {
        const profile = require('./backend/profile');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(profile.loadProfile()));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/profile/file') {
      try {
        const profile = require('./backend/profile');
        const name = url.searchParams.get('name');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(profile.loadProfileFile(name)));
      } catch (e) {
        res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // ── Sense API (Pipeline + Radar) ──
    if (endpoint === '/pios/sense') {
      try {
        const sense = require('./backend/sense');
        const pios = require('./backend/pios-engine');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(sense.loadSense(pios.loadTasks)));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/sense/project-list') {
      try {
        const projectsDir = path.join(VAULT_ROOT, 'Projects');
        const ids = fs.existsSync(projectsDir)
          ? fs.readdirSync(projectsDir).filter(f => !f.startsWith('.') && fs.statSync(path.join(projectsDir, f)).isDirectory())
          : [];
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(ids));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/sense/output') {
      try {
        const sense = require('./backend/sense');
        const section = url.searchParams.get('section');
        const id = url.searchParams.get('id');
        const limit = parseInt(url.searchParams.get('limit') || '3', 10);
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(sense.readOutput({ section, id, limit })));
      } catch (e) {
        res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/agent-latest-runs') {
      // Overview 员工墙的 status / 光晕 数据源（per-agent 最近一条 run）
      try {
        const pios = require('./backend/pios-engine');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(pios.getAgentLatestRuns()));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/token-stats') {
      // Overview 员工墙 + Pi 大秘卡用。{agentId: {today: N, avg7d: N}}
      try {
        const pios = require('./backend/pios-engine');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(pios.getAgentTokenStats()));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/pi-overview') {
      // Home/Overview 的"Pi 大秘卡"数据源（当前戏服 + 当前节奏 + 正在做的卡 + 今日统计）
      try {
        const pios = require('./backend/pios-engine');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(pios.getPiOverview()));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/manifest/file') {
      const filePath = url.searchParams.get('path');
      if (!filePath) { res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: 'path required' })); return; }
      const configDir = path.join(VAULT_ROOT, 'Pi', 'Config');
      const fullPath = path.resolve(configDir, filePath);
      // Security: only allow files under Config/ or Projects/
      const vaultDir = path.join(VAULT_ROOT);
      if (!fullPath.startsWith(vaultDir)) { res.writeHead(403, jsonHeaders); res.end(JSON.stringify({ error: 'forbidden' })); return; }
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ path: filePath, content }));
      } catch (e) {
        res.writeHead(404, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── GET: 通用 vault 文件读取（openVaultFile → 读任意 .md，供详情 modal 展示）──
    // 400 = 路径格式不合法（非 .md 或含 ..），403 = 越权，404 = 文件不存在
    if (endpoint === '/pios/vault-file') {
      const relPath = url.searchParams.get('path');
      if (!relPath || relPath.includes('..') || !relPath.endsWith('.md')) {
        res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: 'invalid path: must be a .md file without ..' }));
        return;
      }
      const fullPath = path.resolve(VAULT_ROOT, relPath);
      if (!fullPath.startsWith(path.join(VAULT_ROOT) + path.sep)) {
        res.writeHead(403, jsonHeaders); res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ path: relPath, content }));
      } catch (e) {
        res.writeHead(404, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── GET: character SVG 静态服务（Pi Tab D 区角色卡 + Overview 员工墙）──
    if (endpoint.startsWith('/assets/characters/')) {
      const fname = endpoint.slice('/assets/characters/'.length);
      if (!/^[a-z][a-z0-9_-]{0,40}\.svg$/.test(fname)) {
        res.writeHead(400); res.end('bad filename'); return;
      }
      const vaultSvg = path.join(VAULT_ROOT, 'Projects', 'pios', 'assets', 'characters', fname);
      const bundledSvg = path.join(__dirname, 'assets', 'characters', fname);
      const svgPath = fs.existsSync(vaultSvg) ? vaultSvg : bundledSvg;
      try {
        const svg = fs.readFileSync(svgPath);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=300' });
        res.end(svg);
      } catch {
        res.writeHead(404); res.end('not found');
      }
      return;
    }

    // ── GET: character PNG thumb（idle pose 缩略图，比 SVG 更接近真实 NPC 形象）──
    // 命名规则：pi / xiaojiang 走 npc-sprite pipeline 出的 pi-idle.png；
    //          其他 NPC 走早期管线的 <skin>-idle.png。
    if (endpoint.startsWith('/assets/character-thumb/')) {
      const fname = endpoint.slice('/assets/character-thumb/'.length);
      const m = fname.match(/^([a-z][a-z0-9_-]{0,40})\.png$/);
      if (!m) { res.writeHead(400); res.end('bad filename'); return; }
      const skin = m[1];
      const candidates = [
        // npc-sprite pipeline 风格（pi / xiaojiang 等）
        path.join(VAULT_ROOT, 'Projects', 'pios', 'renderer', 'assets', skin, 'pi-idle.png'),
        path.join(__dirname, 'renderer', 'assets', skin, 'pi-idle.png'),
        // 早期管线风格 <skin>-idle.png
        path.join(VAULT_ROOT, 'Projects', 'pios', 'renderer', 'assets', skin, `${skin}-idle.png`),
        path.join(__dirname, 'renderer', 'assets', skin, `${skin}-idle.png`),
      ];
      const found = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (!found) { res.writeHead(404); res.end('not found'); return; }
      try {
        const png = fs.readFileSync(found);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=300' });
        res.end(png);
      } catch {
        res.writeHead(404); res.end('not found');
      }
      return;
    }

    // ── Pi Tab ──
    if (endpoint === '/pi') {
      const vaultPiTab = require('path').join(VAULT_ROOT, 'Projects', 'pios', 'renderer', 'pi-tab.html');
      const piTabPath = require('fs').existsSync(vaultPiTab) ? vaultPiTab : require('path').join(__dirname, 'renderer', 'pi-tab.html');
      try {
        const html = require('fs').readFileSync(piTabPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500); res.end('Pi Tab not found');
      }
      return;
    }
    if (endpoint === '/pi/data') {
      try {
        const piTabIpc = require('./backend/pi-tab-ipc');
        const data = piTabIpc.getPiTabData(VAULT_ROOT, loadSessions, global._piTabGetNpcInfo);
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // /pi/debug-log?msg=<urlencoded>  — renderer 把关键事件落盘，
    // 让后端（或人）不开 DevTools 就能读 renderer 的运行日志。
    // 文件：Pi/Log/pibrowser-debug.log（自动 rotate：>5MB 截半）
    // GET 请求 + query string，因为本路由块是 GET-only（line 3539 if(method==='GET')）
    if (endpoint === '/pi/debug-log') {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const msg = urlObj.searchParams.get('msg') || '';
        const logPath = path.join(VAULT_ROOT, 'Pi', 'Log', 'pibrowser-debug.log');
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
          const content = fs.readFileSync(logPath, 'utf-8');
          fs.writeFileSync(logPath, content.slice(content.length / 2));
        }
        const ts = new Date().toISOString();
        fs.appendFileSync(logPath, `[${ts}] ${msg.slice(0, 4000)}\n`);
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // /pi/session-compact?sid=<sid>
    // backup 原 JSONL → 调 `claude -p /compact --resume <sid>` → 返回 backup 路径让前端可还原
    if (endpoint === '/pi/session-compact') {
      const urlObj = new URL(req.url, 'http://localhost');
      const sid = urlObj.searchParams.get('sid');
      if (!sid) { res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ ok: false, error: 'sid required' })); return; }
      if (_compactInFlight.has(sid)) { res.writeHead(409, jsonHeaders); res.end(JSON.stringify({ ok: false, error: '该 session 正在压缩中' })); return; }
      _compactInFlight.add(sid);
      try {
        const { backupPath, ts, sizeBefore, sourcePath } = _backupSessionJsonl(sid);
        const result = await _compactSession(sid);
        const sizeAfter = fs.existsSync(sourcePath) ? fs.statSync(sourcePath).size : 0;
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, backupPath, backupTs: ts, sizeBefore, sizeAfter, duration_ms: result.duration_ms }));
      } catch (e) {
        console.warn('[pi/session-compact] failed:', e.message);
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } finally {
        _compactInFlight.delete(sid);
      }
      return;
    }

    // /pi/session-restore?sid=<sid>&backup=<absolute_path>
    if (endpoint === '/pi/session-restore') {
      const urlObj = new URL(req.url, 'http://localhost');
      const sid = urlObj.searchParams.get('sid');
      const backup = urlObj.searchParams.get('backup');
      if (!sid || !backup) { res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ ok: false, error: 'sid and backup required' })); return; }
      try {
        const r = _restoreSessionFromBackup(sid, backup);
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // /pi/context-detail?sid=<claudeSessionId>
    // 调 `claude -p '/context' --resume <sid> --fork-session` 拿详细 breakdown。
    // 30s 内同 sid 走缓存，避免每点一次都 spawn claude。
    if (endpoint === '/pi/context-detail') {
      const urlObj = new URL(req.url, 'http://localhost');
      let sid = urlObj.searchParams.get('sid');
      if (!sid) {
        const _cc = getClaudeClient();
        sid = _cc && _cc._sessionId;
      }
      if (!sid) {
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: 'no claude session yet（先发一条 Claude 消息）' }));
        return;
      }

      if (!global._contextDetailCache) global._contextDetailCache = new Map();
      const cache = global._contextDetailCache;
      const cached = cache.get(sid);
      if (cached && Date.now() - cached.ts < 30_000) {
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, cached: true, ...cached.data }));
        return;
      }

      try {
        const data = await _fetchContextDetail(sid);
        cache.set(sid, { data, ts: Date.now() });
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, ...data }));
      } catch (e) {
        console.warn('[pi/context-detail] failed:', e.message);
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // Scratch Pad GET endpoints
    if (endpoint === '/pios/scratch/list') {
      try {
        const scratch = require('./backend/scratch');
        const items = scratch.list().map(it => {
          const { content, ...rest } = it;
          return rest;
        });
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(items));
      } catch (e) {
        res.writeHead(500, jsonHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/scratch/read') {
      try {
        const scratch = require('./backend/scratch');
        const filename = url.searchParams.get('filename');
        const item = filename ? scratch.read(filename) : null;
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(item));
      } catch (e) {
        res.writeHead(400, jsonHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // Scratch attachment static: /pios/scratch/attachments/<name>
    if (endpoint.startsWith('/pios/scratch/attachments/')) {
      try {
        const name = endpoint.slice('/pios/scratch/attachments/'.length);
        if (!/^[\w:.-]+\.(png|jpg|jpeg|gif|webp)$/i.test(name) || name.includes('..')) {
          res.writeHead(400); res.end('bad filename'); return;
        }
        const scratch = require('./backend/scratch');
        const p = path.join(scratch.getAttachDir(), name);
        const buf = fs.readFileSync(p);
        const ext = name.toLowerCase().split('.').pop();
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=300' });
        res.end(buf);
      } catch {
        res.writeHead(404); res.end('not found');
      }
      return;
    }

    res.writeHead(404); res.end(); return;
  }

  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body = '';
  for await (const chunk of req) body += chunk;
  let params = {};
  try { params = body ? JSON.parse(body) : {}; } catch {}

  let result = { error: 'unknown endpoint' };

  // Afterward POST endpoint: open the Afterward window
  if (endpoint === '/afterward/open') {
    try {
      afterward.open();
      res.writeHead(200, jsonHeaders); res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Profile POST endpoints (approve / reject / approve-all / save / refresh-now)
  if (endpoint === '/pios/profile/approve' || endpoint === '/pios/profile/reject' ||
      endpoint === '/pios/profile/approve-all' || endpoint === '/pios/profile/save' ||
      endpoint === '/pios/profile/refresh-now') {
    try {
      const profile = require('./backend/profile');
      let out;
      if (endpoint === '/pios/profile/approve') out = profile.approveDiff(params.id);
      else if (endpoint === '/pios/profile/reject') out = profile.rejectDiff(params.id);
      else if (endpoint === '/pios/profile/approve-all') out = profile.approveAll();
      else if (endpoint === '/pios/profile/save') out = profile.saveProfile(params.name, params.content);
      else {
        // refresh-now: trigger profile-refresh task via existing task/run mechanism
        const pios = require('./backend/pios-engine');
        out = pios.runTask ? pios.runTask('pipeline', 'profile-refresh') : { ok: true, note: 'queued for next tick' };
      }
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Sense POST endpoints (toggle / edit / install-radar)
  if (endpoint === '/pios/sense/toggle' || endpoint === '/pios/sense/edit' || endpoint === '/pios/sense/install-radar') {
    try {
      const sense = require('./backend/sense');
      let out;
      if (endpoint === '/pios/sense/toggle') out = sense.toggle(params);
      else if (endpoint === '/pios/sense/edit') out = sense.editConfig(params);
      else out = sense.installRadar(params);
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Scratch Pad POST endpoints
  if (endpoint === '/pios/scratch/create' || endpoint === '/pios/scratch/update' ||
      endpoint === '/pios/scratch/delete' || endpoint === '/pios/scratch/attach') {
    try {
      const scratch = require('./backend/scratch');
      let out;
      if (endpoint === '/pios/scratch/create') out = scratch.create(params);
      else if (endpoint === '/pios/scratch/update') out = scratch.update(params);
      else if (endpoint === '/pios/scratch/delete') out = scratch.remove(params);
      else out = scratch.attach(params);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, jsonHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 分支会话：POST /pios/fork-session
  if (endpoint === '/pios/fork-session') {
    try {
      const { title, content, engine } = params;
      if (!title || !content) { res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: 'title and content required' })); return; }
      const id = require('crypto').randomUUID().substring(0, 8) + '-fork';
      const now = new Date().toISOString();
      const newSession = {
        id, title: (title || '').substring(0, 30), permissionLevel: 'full',
        engine: engine || 'claude', created: now, updated: now,
        threadId: null, claudeSessionId: null,
        messages: [{ role: 'user', content, engine: engine || 'claude', timestamp: now }],
      };
      const data = loadSessions();
      data.sessions.push(newSession);
      saveSessions(data);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sessions:refresh');
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: true, id, title: newSession.title }));
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 刀 3: POST /session/{id}/message —— 插话，walks through bus.send
  const msgMatch = endpoint.match(/^\/session\/([\w-]+)\/message$/);
  if (msgMatch) {
    const sid = msgMatch[1];
    const text = (params.text || '').trim();
    if (!text) {
      res.writeHead(400, jsonHeaders);
      res.end(JSON.stringify({ error: 'empty text' }));
      return;
    }
    if (!sessionBus.getSession(sid)) {
      res.writeHead(404, jsonHeaders);
      res.end(JSON.stringify({ error: 'session not registered; call GET /session/{id}/attach with query params first' }));
      return;
    }
    try {
      const r = await sessionBus.send(sid, text, params.opts || {});
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 刀 3: POST /session/{id}/interrupt —— SIGINT 或 cancel 当前 turn
  const intMatch = endpoint.match(/^\/session\/([\w-]+)\/interrupt$/);
  if (intMatch) {
    const sid = intMatch[1];
    try {
      const ok = await sessionBus.interrupt(sid);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: !!ok }));
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST: Owner Profile 新建（D 区模板化）──
  if (endpoint === '/pi/profile/create') {
    try {
      const name = String(params.name || '').trim();
      const content = String(params.content || '').trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,50}$/.test(name)) throw new Error('文件名必须是英文字母/数字/下划线/连字符，首字母是字母，<=51 字');
      if (content.length < 10) throw new Error('骨架内容太短');
      const yaml = require('js-yaml');
      const manifest = yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
      const owner = manifest.owner || 'owner';
      const profileDir = path.join(VAULT_ROOT, owner, 'Profile');
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
      const target = path.join(profileDir, `${name}.md`);
      if (fs.existsSync(target)) throw new Error(`Profile "${name}.md" 已存在`);
      const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, target);
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true, name, path: `${owner}/Profile/${name}.md` }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: Pi Tab 身份文件编辑（SOUL / alignment）──
  if (endpoint === '/pi/identity/update') {
    try {
      const file = String(params.file || '');
      const content = String(params.content || '');
      // 白名单：只允许编辑 SOUL 和 alignment，BOOT/HEARTBEAT 不开放（系统文件）
      const writeMap = {
        soul: path.join(VAULT_ROOT, 'Pi', 'SOUL.md'),
        alignment: path.join(VAULT_ROOT, 'Pi', 'Config', 'alignment.md'),
      };
      const target = writeMap[file];
      if (!target) throw new Error(`file "${file}" not editable（只允许 soul / alignment）`);
      if (content.length < 20) throw new Error('content too short（至少 20 字）');
      // 原子写入（feedback_atomic_file_write）
      const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, target);
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true, file, bytes: content.length }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: Pi Tab character 编辑（D 区 ✎）──
  if (endpoint === '/pi/character/update') {
    try {
      const id = String(params.id || '');
      const updates = params.updates || {};
      if (!/^[a-z][a-z0-9_-]{0,40}$/.test(id)) throw new Error('invalid character id');
      // 字段白名单：不允许改 id / skin / voice_verified（这三个是绑定 / 自动计算的）
      const ALLOWED = new Set(['display_name','nickname','avatar_emoji','speech_style','catchphrases','how_it_addresses_owner','disagreement_style','metaphor_pool','emoji_level','voice','voice_magnetic']);
      const MAGNETIC_VALUES = new Set(['raw','soft','mid','strong']);
      const yaml = require('js-yaml');
      const charsPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'characters.yaml');
      const doc = yaml.load(fs.readFileSync(charsPath, 'utf-8')) || {};
      if (!doc.characters) doc.characters = {};
      if (!doc.characters[id]) throw new Error(`character "${id}" not found`);
      for (const [k, v] of Object.entries(updates)) {
        if (!ALLOWED.has(k)) continue;  // 默默忽略非法字段，不抛错
        // voice_magnetic 只接受 soft/mid/strong；空串/null 清字段（回落 mid）
        if (k === 'voice_magnetic' && v && !MAGNETIC_VALUES.has(v)) continue;
        if (v === null || v === undefined || v === '') {
          // 允许清空可选字段（但保留核心）
          if (k === 'display_name') continue;
          delete doc.characters[id][k];
        } else {
          doc.characters[id][k] = v;
        }
      }
      // 原子写（feedback_atomic_file_write）
      const yml = yaml.dump(doc, { lineWidth: 120, noRefs: true });
      const tmp = `${charsPath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, yml);
      fs.renameSync(tmp, charsPath);
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true, id, updated: Object.keys(updates).filter(k => ALLOWED.has(k)) }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: Pi Tab skin switch ──
  if (endpoint === '/pi/skin') {
    try {
      const skinId = params.skin;
      if (skinId && typeof global._piTabSetSkin === 'function') {
        global._piTabSetSkin(skinId);
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, skin: skinId }));
      } else {
        res.writeHead(400, jsonHeaders);
        res.end(JSON.stringify({ error: 'invalid skin or NPC not ready' }));
      }
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST: User Management ──
  if (endpoint === '/pios/users/create') {
    try {
      const { name, vault_path, runtimes: rts, plugins: plgs } = params;
      if (!name || !vault_path) throw new Error('name and vault_path required');
      const result = installer.install({
        owner_name: name,
        vault_root: vault_path,
        runtimes: rts || { 'claude-cli': true },
        plugins: plgs || ['vault', 'shell', 'web-search'],
      });
      // Add to known_vaults
      const configPath = path.join(process.env.HOME, '.pios', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!config.known_vaults) {
        config.known_vaults = [{ name: config.owner_name || 'Default', path: config.vault_root }];
      }
      config.known_vaults.push({ name, path: vault_path });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true, vault_path }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (endpoint === '/pios/users/switch') {
    try {
      const { vault_path } = params;
      if (!vault_path) throw new Error('vault_path required');
      if (!fs.existsSync(path.join(vault_path, 'Pi', 'Config', 'pios.yaml'))) {
        throw new Error('Not a valid PiOS vault (pios.yaml not found)');
      }
      const configPath = path.join(process.env.HOME, '.pios', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const yaml = require('js-yaml');
      const targetManifest = yaml.load(fs.readFileSync(path.join(vault_path, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
      config.vault_root = vault_path;
      config.owner_name = targetManifest.owner || config.owner_name;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: true }));
      // Relaunch the app to load new vault
      setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: Open Tab ──
  if (endpoint === '/pios/open-tab') {
    try {
      const { url: tabUrl } = params;
      if (!tabUrl) throw new Error('url required');
      createTab(completeURL(tabUrl));
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: Run Terminal Command ──
  if (endpoint === '/pios/run-terminal') {
    try {
      const { command } = params;
      if (!command) throw new Error('command required');
      const { exec } = require('child_process');
      // Open Terminal.app with the command
      const escaped = command.replace(/'/g, "'\\''");
      exec(`osascript -e 'tell application "Terminal" to do script "${escaped}"' -e 'tell application "Terminal" to activate'`);
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: 一键重新探活 auth-based runtime ──
  // 跑 auth-manager.sh check + auth-check.sh，两个脚本都会按实时结果写回 pios.yaml。
  // 用在 quota 提前恢复 / 外部登录后系统没察觉的场景。
  // 返回：{ ok, engine, runtime_status, active_account, output }
  if (endpoint === '/pios/auth-refresh') {
    // 探活 — real liveness probe for claude-cli on a specific host.
    //
    //   host absent / host is local → run local auth-manager.sh check + auth-check.sh
    //     (refreshes Keychain harvest + codex file check + rewrites auth-status-laptop-host.json)
    //
    //   host is a remote instance (has ssh field) → SSH and run `claude auth status`
    //     there, parse loggedIn, write auth-status-<host>.json. This is the ONLY
    //     way to know if a remote host's credentials still work.
    try {
      const { engine, host } = params;
      const vault = VAULT_ROOT;
      const yaml = require('js-yaml');
      const manifest = yaml.load(fs.readFileSync(path.join(vault, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
      const instances = (manifest?.infra?.instances) || {};
      const inst = host ? instances[host] : null;
      const localHostname = require('os').hostname().toLowerCase();
      const isRemote = inst && inst.ssh && !localHostname.startsWith(host);

      if (isRemote) {
        // Real remote probe: SSH probe differs by engine
        const { spawn } = require('child_process');
        const probeEngine = engine || 'claude-cli';
        const probeCmd = probeEngine === 'codex-cli'
          // codex-cli: check ~/.codex/auth.json exists and has access_token
          ? `python3 -c "
import json, os, sys
try:
    d = json.load(open(os.path.expanduser('~/.codex/auth.json')))
    t = d.get('tokens', {}).get('access_token', '')
    lr = d.get('last_refresh', '')
    print('ok|' + lr if t else 'no_token|')
except FileNotFoundError:
    print('not_found|')
except Exception as e:
    print('error|' + str(e))
" 2>&1 || echo PROBE_FAILED`
          // claude-cli: run claude auth status
          : 'export PATH=$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin; claude auth status 2>&1 || echo PROBE_FAILED';
        const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', inst.ssh, probeCmd]);
        let stdout = '', stderr = '';
        ssh.stdout.on('data', d => stdout += d.toString());
        ssh.stderr.on('data', d => stderr += d.toString());
        ssh.on('close', (code) => {
          const combined = (stdout + '\n' + stderr).trim();
          let loggedIn = false, detail = 'probe failed';
          try {
            if (probeEngine === 'codex-cli') {
              // Output format: "ok|<last_refresh>" or "no_token|" or "not_found|" or "error|..."
              const line = combined.trim().split('\n').find(l => l.includes('|')) || '';
              const [status, extra] = line.split('|');
              if (status === 'ok') {
                loggedIn = true;
                const hoursAgo = extra ? (() => {
                  try {
                    const ms = Date.now() - new Date(extra).getTime();
                    return Math.round(ms / 3600000);
                  } catch { return null; }
                })() : null;
                detail = hoursAgo != null ? `ok (refreshed ${hoursAgo}h ago)` : 'ok';
              } else if (status === 'no_token') {
                detail = 'no access_token in auth.json';
              } else if (status === 'not_found') {
                detail = 'auth.json not found on remote';
              } else if (combined.includes('PROBE_FAILED')) {
                detail = 'python3 not found or errored on remote';
              } else {
                detail = extra || combined.slice(0, 200) || 'unknown error';
              }
            } else {
              // claude auth status emits JSON on stdout when successful
              const jsonMatch = combined.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const j = JSON.parse(jsonMatch[0]);
                loggedIn = j.loggedIn === true;
                detail = loggedIn
                  ? `ok (authMethod=${j.authMethod || '?'}, subscription=${j.subscriptionType || '?'})`
                  : 'not logged in';
              } else if (combined.includes('PROBE_FAILED')) {
                detail = 'claude CLI not found or errored on remote';
              } else {
                detail = combined.slice(0, 200) || 'empty response';
              }
            }
          } catch (e) {
            detail = 'parse error: ' + e.message;
          }
          // Write per-host auth status file
          try {
            const logDir = path.join(vault, 'Pi', 'Log');
            const file = path.join(logDir, `auth-status-${host}.json`);
            let existing = {};
            try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
            const engines = existing.engines || {};
            engines[probeEngine] = {
              ok: loggedIn,
              detail,
              login_supported: true,
            };
            fs.mkdirSync(logDir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify({
              host,
              updated_at: new Date().toISOString(),
              engines,
              probe_method: 'ssh-live-probe',
            }, null, 2));
          } catch (e) {
            res.writeHead(500, jsonHeaders);
            res.end(JSON.stringify({ ok: false, error: 'failed to write auth-status file: ' + e.message }));
            return;
          }
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({
            ok: loggedIn,
            host,
            engine: probeEngine,
            runtime_status: loggedIn ? 'ok' : 'down',
            detail,
            output: combined.slice(0, 500),
          }));
        });
        ssh.on('error', (e) => {
          res.writeHead(500, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'ssh spawn error: ' + e.message }));
        });
        return;
      }

      // Local probe: keep the existing auth-manager + auth-check flow
      const { exec } = require('child_process');
      const cmd = `bash "${vault}/Pi/Tools/auth-manager.sh" check 2>&1; bash "${vault}/Pi/Tools/auth-check.sh" 2>&1`;
      exec(cmd, { timeout: 30000, env: { ...process.env, PIOS_VAULT: vault } }, (err, stdout, stderr) => {
        const output = ((stdout || '') + (stderr || '')).trim();
        const tail = output.split('\n').slice(-8).join('\n');
        try {
          const pios = yaml.load(fs.readFileSync(path.join(vault, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
          const runtimes = pios?.infra?.runtimes || {};
          const rtFor = (id) => runtimes[id] || {};
          const summary = engine
            ? { engine, runtime_status: rtFor(engine).status || 'unknown', error: rtFor(engine).error || null, active_account: rtFor(engine).active_account || null }
            : { engines: Object.fromEntries(Object.entries(runtimes).map(([k,v]) => [k, { status: v.status, error: v.error }])) };
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({ ok: engine ? (rtFor(engine).status === 'ok') : true, ...summary, output: tail }));
        } catch (e) {
          res.writeHead(500, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: e.message, output: tail }));
        }
      });
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: Auth Login (claude-cli) ──
  // Body: { engine: 'claude-cli', host: 'laptop-host' | 'worker-host' | ... }
  // Always runs `claude auth logout; claude auth login` LOCALLY on laptop-host via
  // node-pty (real TTY for Ink). After success, reads the fresh OAuth JSON from
  // macOS Keychain and SSH-pushes it to every remote host that runs claude-cli
  // agents (derived from pios.yaml). The clicked host param is display-only.
  // Returns sessionId; frontend polls /pios/auth/login/status.
  if (endpoint === '/pios/auth/login') {
    try {
      const engine = params.engine || 'claude-cli';
      const host = params.host || require('./backend/host-helper').resolveHost();
      if (engine !== 'claude-cli' && engine !== 'codex-cli') {
        res.writeHead(400, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: `engine '${engine}' login not supported (supported: claude-cli, codex-cli)` }));
        return;
      }

      // ── Architecture: local-only login + auto-sync ──
      // Any click on any host's Login button runs the auth login LOCALLY on
      // laptop-host (where a real browser + user interaction exists). On success,
      // we read the fresh token locally and SSH-push it to every remote host
      // that needs the same engine (derived from pios.yaml agents).
      //
      // claude-cli: reads OAuth JSON from macOS Keychain, writes ~/.claude/.credentials.json
      // codex-cli:  reads ~/.codex/auth.json, writes ~/.codex/auth.json on remotes
      const yaml = require('js-yaml');
      const manifest = yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
      const instances = (manifest && manifest.infra && manifest.infra.instances) || {};
      const agents = (manifest && manifest.agents) || {};
      const localHostname = require('os').hostname().toLowerCase();

      // Figure out our own canonical instance name (the one matching this hostname)
      let localInstanceName = null;
      for (const [name, inst] of Object.entries(instances)) {
        if (localHostname.startsWith(name)) { localInstanceName = name; break; }
      }
      if (!localInstanceName) localInstanceName = require('./backend/host-helper').resolveHost();  // fallback

      // Collect remote hosts that need credentials for this engine.
      // claude-cli: derive from agents (agents with runtime=claude-cli) —
      //   not every SSH host runs claude-cli agents.
      // codex-cli and others: sync to ALL SSH-accessible instances —
      //   codex is a system tool; no agents are defined with runtime=codex-cli.
      const syncTargetHosts = new Set();
      if (engine === 'claude-cli') {
        for (const agent of Object.values(agents)) {
          if (agent.runtime !== 'claude-cli') continue;
          const agentHosts = Array.isArray(agent.hosts) ? [...agent.hosts] : (agent.host ? [agent.host] : []);
          for (const task of Object.values(agent.tasks || {})) {
            const taskHosts = Array.isArray(task.hosts) ? task.hosts : (task.host ? [task.host] : []);
            for (const h of taskHosts) agentHosts.push(h);
          }
          for (const h of agentHosts) {
            if (!h || h === localInstanceName) continue;
            const inst = instances[h];
            if (inst && inst.ssh) syncTargetHosts.add(h);
          }
        }
      } else {
        // For codex-cli and other tools: sync to all SSH-accessible instances
        for (const [name, inst] of Object.entries(instances)) {
          if (!inst.ssh || name === localInstanceName) continue;
          syncTargetHosts.add(name);
        }
      }
      const syncTargets = [...syncTargetHosts].map(h => ({ host: h, ssh: instances[h].ssh }));

      // Original host from UI click is only used for display ("you clicked X's
      // Login button, here's what happened"). The actual login always runs local.
      const clickedHost = host;

      const pty = require('node-pty');
      const loginCmd = engine === 'claude-cli'
        ? 'claude auth logout 2>&1 || true; claude auth login'
        : 'codex login';
      const child = pty.spawn('bash', ['-lc', loginCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`, TERM: 'xterm-256color' },
      });

      const sessionId = require('crypto').randomUUID();
      const session = {
        id: sessionId,
        engine,
        host: localInstanceName,   // the host we actually run on
        clickedHost,               // the host the user clicked (for UI display)
        syncTargets,               // [{host, ssh}, ...]
        isLocal: true,             // always
        proc: child,
        startedAt: Date.now(),
        state: 'starting',         // starting → await_auth → syncing → done | failed
        lines: [],
        url: null,
        email: null,
        exitCode: null,
        error: null,
      };
      _loginSessions.set(sessionId, session);
      session.lines.push(`[pios] running ${engine} login on ${localInstanceName} (local)`);
      if (clickedHost !== localInstanceName) {
        session.lines.push(`[pios] will sync credentials to ${clickedHost} after login completes`);
      }
      if (syncTargets.length > 0) {
        session.lines.push(`[pios] sync targets: ${syncTargets.map(t => t.host).join(', ')}`);
      }

      // Helper: open browser exactly once
      const openBrowser = (reason) => {
        if (session._browserOpened) return;
        session._browserOpened = true;
        try {
          shell.openExternal(session.url);
          session.lines.push(`[pios] opened authorization URL in your default browser (${reason})`);
        } catch (e) {
          session.lines.push(`[pios] failed to open URL: ${e.message}`);
        }
      };

      const processChunk = (chunk) => {
        const text = chunk.toString();
        session._buf = (session._buf || '') + text;
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (line) session.lines.push(line);
        }

        // Find the auth URL and open it. For local login the browser hits the
        // ephemeral localhost callback on this same machine — no port extraction,
        // no tunnel, no stdin paste needed. The CLI exits 0 when the browser
        // flow completes; we sync credentials in onExit.
        if (!session.url) {
          const flat = session._buf
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
            .replace(/\s+/g, '');
          const urlMatch = flat.match(/https?:\/\/[^\s'"`)]+/);
          if (urlMatch) {
            session.url = urlMatch[0];
            session.state = 'await_auth';
            openBrowser('local');
          }
        }

        const successMatch = text.match(/Logged in as ([^\s]+)|Successfully logged in|Login successful/i);
        if (successMatch) {
          session.email = successMatch[1] || session.email;
        }
      };

      child.onData(processChunk);

      // Helper: read fresh token JSON after login succeeds (engine-specific source)
      const readLocalToken = () => {
        if (engine === 'claude-cli') {
          try {
            const out = require('child_process')
              .execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8', timeout: 5000 })
              .trim();
            JSON.parse(out);  // validate
            return out;
          } catch (e) {
            session.lines.push(`[pios] ERROR reading Keychain: ${e.message}`);
            return null;
          }
        } else {
          // codex-cli: read ~/.codex/auth.json directly
          try {
            const tokenPath = path.join(require('os').homedir(), '.codex', 'auth.json');
            const out = fs.readFileSync(tokenPath, 'utf8').trim();
            JSON.parse(out);  // validate
            return out;
          } catch (e) {
            session.lines.push(`[pios] ERROR reading ~/.codex/auth.json: ${e.message}`);
            return null;
          }
        }
      };

      // Helper: push OAuth JSON to a remote host's ~/.claude/.credentials.json
      const syncToRemote = (target, oauthJson) => {
        return new Promise((resolve) => {
          const b64 = Buffer.from(oauthJson).toString('base64');
          // Single SSH command: write file via base64 decode, chmod, then confirm
          const remoteScript = engine === 'claude-cli'
            ? [
                'set -e',
                'mkdir -p ~/.claude',
                `echo '${b64}' | base64 -d > ~/.claude/.credentials.json.tmp`,
                'mv ~/.claude/.credentials.json.tmp ~/.claude/.credentials.json',
                'chmod 600 ~/.claude/.credentials.json',
                'echo SYNC_OK',
              ].join(' && ')
            : [
                'set -e',
                // 1. Write ~/.codex/auth.json
                'mkdir -p ~/.codex',
                `echo '${b64}' | base64 -d > ~/.codex/auth.json.tmp`,
                'mv ~/.codex/auth.json.tmp ~/.codex/auth.json',
                'chmod 600 ~/.codex/auth.json',
                // 2. Update openclaw agent auth-profiles.json (best-effort, || true so set -e is not triggered)
                `python3 -c "
import json,glob,os,tempfile,sys
try:
  c=json.load(open(os.path.expanduser('~/.codex/auth.json')))
  t=c.get('tokens',{});a=t.get('access_token','');r=t.get('refresh_token','')
  if not a: sys.exit(0)
  for f in glob.glob(os.path.expanduser('~/.openclaw/agents/*/agent/auth-profiles.json')):
    try:
      d=json.load(open(f));changed=False
      for k,p in d.get('profiles',{}).items():
        if 'openai-codex' in k:
          p['access']=a
          if r: p['refresh']=r
          changed=True
      if changed:
        fd,tmp=tempfile.mkstemp(dir=os.path.dirname(f))
        with os.fdopen(fd,'w') as out: json.dump(d,out,indent=2)
        os.replace(tmp,f)
    except Exception as e: print('warn:'+f+':'+str(e),file=sys.stderr)
except Exception as e: print('warn:openclaw:'+str(e),file=sys.stderr)
" || true`,
                // 3. Restart openclaw gateway (best-effort)
                'systemctl --user restart openclaw-gateway.service 2>/dev/null || true',
                'echo SYNC_OK',
              ].join(' && ');
          const ssh = require('child_process').spawn('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=10',
            '-o', 'BatchMode=yes',
            target.ssh,
            remoteScript,
          ]);
          let stdout = '', stderr = '';
          ssh.stdout.on('data', d => stdout += d.toString());
          ssh.stderr.on('data', d => stderr += d.toString());
          ssh.on('close', (code) => {
            if (code === 0 && stdout.includes('SYNC_OK')) {
              session.lines.push(`[pios] ✅ synced credentials to ${target.host}`);
              resolve(true);
            } else {
              session.lines.push(`[pios] ❌ sync to ${target.host} failed (exit ${code}): ${(stderr || stdout).slice(0, 200)}`);
              resolve(false);
            }
          });
          ssh.on('error', (e) => {
            session.lines.push(`[pios] ❌ sync to ${target.host}: ssh spawn error: ${e.message}`);
            resolve(false);
          });
        });
      };

      // Helper: write/merge Pi/Log/auth-status-<host>.json for a remote host
      // after a successful sync. This is the HIGHER-priority data source that
      // UI /pios/auth-status reads first (Step 1 in that endpoint) — without
      // this, UI falls through to inferring state from task run records, which
      // can be stale (e.g. "last run failed — quota" from hours ago).
      const writeRemoteAuthStatus = (hostName) => {
        try {
          const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
          const file = path.join(logDir, `auth-status-${hostName}.json`);
          let existing = {};
          try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
          const engines = existing.engines || {};
          engines[engine] = {
            ok: true,
            detail: `synced from ${localInstanceName} at ${new Date().toISOString()}`,
            login_supported: true,
          };
          const data = {
            host: hostName,
            updated_at: new Date().toISOString(),
            engines,
            probe_method: 'credential-sync',
          };
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(data, null, 2));
          session.lines.push(`[pios] wrote auth-status-${hostName}.json (ok)`);
        } catch (e) {
          session.lines.push(`[pios] warning: failed to write auth-status-${hostName}.json: ${e.message}`);
        }
      };

      // Helper: update local auth-status-<localInstanceName>.json after login succeeds.
      // For claude-cli: runs `claude auth status` to extract email/authMethod.
      // For codex-cli: marks ok with timestamp.
      // Never throws — best-effort UI update only.
      const writeLocalAuthStatus = () => {
        try {
          const logDir = path.join(VAULT_ROOT, 'Pi', 'Log');
          const file = path.join(logDir, `auth-status-${localInstanceName}.json`);
          let existing = {};
          try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
          const engines = existing.engines || {};

          if (engine === 'claude-cli') {
            // Run claude auth status to get actual email + authMethod
            try {
              const out = require('child_process').execSync(
                'claude auth status 2>&1',
                { encoding: 'utf8', timeout: 8000,
                  env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` } }
              );
              const jsonMatch = out.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const j = JSON.parse(jsonMatch[0]);
                if (j.loggedIn) {
                  const parts = [`authMethod=${j.authMethod || 'claude.ai'}`];
                  if (j.emailAddress || session.email) parts.push(`email=${j.emailAddress || session.email}`);
                  if (j.subscriptionType) parts.push(`subscription=${j.subscriptionType}`);
                  engines['claude-cli'] = { ok: true, detail: `ok (${parts.join(', ')})`, login_supported: true };
                  session.lines.push(`[pios] local auth-status updated: ${parts.join(', ')}`);
                }
              }
            } catch (e) {
              session.lines.push(`[pios] note: claude auth status check skipped (${e.message.slice(0, 60)})`);
            }
          } else {
            // codex-cli: just mark ok
            engines['codex-cli'] = { ok: true, detail: `ok (logged in at ${new Date().toISOString()})`, login_supported: true };
          }

          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify({
            ...existing,
            host: localInstanceName,
            updated_at: new Date().toISOString(),
            engines,
          }, null, 2));
        } catch (e) {
          session.lines.push(`[pios] warning: could not write local auth-status: ${e.message}`);
        }
      };

      // On login success: update local auth-status, then fan out credentials to remote hosts.
      const syncCredentialsToAllTargets = async () => {
        session.state = 'syncing';

        // Step 1: always update local auth-status (captures email for UI display)
        writeLocalAuthStatus();

        if (session.syncTargets.length === 0) {
          session.lines.push('[pios] no remote hosts need credential sync');
          return;
        }
        session.lines.push(`[pios] reading fresh ${engine} token…`);
        const oauthJson = readLocalToken();
        if (!oauthJson) {
          session.state = 'failed';
          session.error = engine === 'claude-cli'
            ? 'could not read Keychain after login (is `security` accessible?)'
            : 'could not read ~/.codex/auth.json after login';
          return;
        }
        session.lines.push(`[pios] token obtained (${oauthJson.length} bytes)`);
        const results = await Promise.all(session.syncTargets.map(t => syncToRemote(t, oauthJson)));
        // For each host that synced successfully, mark its auth-status file
        // as ok so the UI stops showing stale "last run failed" inference.
        session.syncTargets.forEach((t, i) => {
          if (results[i]) writeRemoteAuthStatus(t.host);
        });
        const okCount = results.filter(Boolean).length;
        const total = results.length;
        if (okCount === total) {
          session.lines.push(`[pios] ✅ all ${total} remote host(s) synced`);
        } else {
          session.lines.push(`[pios] ⚠️  ${okCount}/${total} remote host(s) synced — see errors above`);
        }
      };

      child.onExit(({ exitCode, signal }) => {
        session.exitCode = exitCode;
        if (exitCode === 0) {
          // Login succeeded locally. Fire off the sync; onExit itself doesn't
          // wait, but the UI state stays 'syncing' until syncCredentialsToAllTargets resolves.
          (async () => {
            try {
              await syncCredentialsToAllTargets();
              if (session.state !== 'failed') {
                session.state = 'done';
              }
            } catch (e) {
              session.state = 'failed';
              session.error = 'sync error: ' + e.message;
              session.lines.push(`[pios] ERROR during sync: ${e.message}`);
            }
          })();
        } else {
          session.state = 'failed';
          if (!session.error) session.error = `${engine} login exited with code ${exitCode}${signal ? ' (signal ' + signal + ')' : ''}`;
        }
      });

      // 5-min timeout safety: if still waiting for auth after 5 min, mark failed.
      setTimeout(() => {
        if (session.state !== 'done' && session.state !== 'failed' && session.state !== 'syncing') {
          try { child.kill(); } catch {}
          session.state = 'failed';
          session.error = 'timeout (5 min) waiting for OAuth callback';
          session.lines.push('[pios] timed out waiting for browser authorization');
        }
      }, 5 * 60 * 1000);

      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({
        ok: true,
        sessionId,
        engine,
        host: localInstanceName,
        clickedHost,
        syncTargets: syncTargets.map(t => t.host),
      }));
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: Cancel an in-progress login session ──
  if (endpoint === '/pios/auth/login/cancel') {
    const sessionId = params.sessionId || params.id;
    const session = _loginSessions.get(sessionId);
    if (!session) {
      res.writeHead(404, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    try { session.proc.kill(); } catch {}
    session.state = 'failed';
    session.error = session.error || 'cancelled by user';
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST: Manifest API ──
  if (endpoint === '/pios/manifest') {
    const yaml = require('js-yaml');
    const manifestPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
    try {
      // Merge params into existing manifest
      const existing = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
      const merged = deepMerge(existing, params);
      // Collections like goals should replace entirely (not merge) to support deletion
      if (params.direction && 'goals' in params.direction) {
        if (!merged.direction) merged.direction = {};
        merged.direction.goals = params.direction.goals;
      }
      // 原子写入：tmp → rename，避免 tick reader 读到半写入状态
      {
        const _tmp = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(_tmp, yaml.dump(merged, { lineWidth: 120, noRefs: true }));
        fs.renameSync(_tmp, manifestPath);
      }
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (endpoint === '/pios/manifest/file') {
    const filePath = params.path;
    const content = params.content;
    if (!filePath || content === undefined) { res.writeHead(400, jsonHeaders); res.end(JSON.stringify({ error: 'path and content required' })); return; }
    const configDir = path.join(VAULT_ROOT, 'Pi', 'Config');
    const fullPath = path.resolve(configDir, filePath);
    const vaultDir = path.join(VAULT_ROOT);
    if (!fullPath.startsWith(vaultDir)) { res.writeHead(403, jsonHeaders); res.end(JSON.stringify({ error: 'forbidden' })); return; }
    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content);
      res.writeHead(200, jsonHeaders); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: PiOS notify-settings (save) ──
  if (endpoint === '/pios/notify-settings') {
    const settingsFile = path.join(VAULT_ROOT, 'Pi', 'Config', 'notify-settings.json');
    try {
      fs.writeFileSync(settingsFile, JSON.stringify(params, null, 2));
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST: PiOS notify ──
  if (endpoint === '/notify' || endpoint === '/pios/notify') {
    sendNotification(params.title || 'PiOS', params.body || params.text || '', 'pibrowser');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST: PiOS event → AI 生成 Pi 的主动消息 ──
  if (endpoint === '/pios/event') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: true }));
    // 异步处理，不阻塞 adapter
    handlePiEvent(params).catch(e => console.error('[pi-event] error:', e.message));
    return;
  }

  // ── POST: Agent CRUD ──
  if (endpoint === '/pios/agent/create') {
    const r = pios.createAgent(params.agentId, params);
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/agent/delete') {
    const r = pios.deleteAgent(params.agentId);
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/agent/retire') {
    const r = pios.retireAgent(params.agentId, params.mode || 'pause');
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }

  // ── POST: PiOS actions ──
  if (endpoint === '/pios/approve-decision') {
    const r = pios.approveDecision(params.filename, params.comment || '');
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/defer-card') {
    const r = pios.deferCard(params.filename, params.until || '');
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/approve-review') {
    const r = pios.approveReview(params.filename, params.comment || '');
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/rework-review') {
    const r = pios.reworkReview(params.filename, params.comment || '');
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/resolve-decision') {
    result = pios.resolveDecision(params.filename, params.decision);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
    return;
  }
  if (endpoint === '/pios/move-card') {
    result = pios.moveCard(params.filename, params.status);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
    return;
  }
  if (endpoint === '/pios/respond-to-owner') {
    const r = pios.respondToOwner(params.filename, params.response || '', params);
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/undo-owner-response') {
    const r = pios.undoOwnerResponse(params.filename);
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/dismiss-card') {
    const r = pios.dismissCard(params.filename, params.reason || '');
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/acknowledge-action') {
    const r = pios.acknowledgeAction(params.filename);
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/skip-card') {
    const r = pios.skipCard(params.filename);
    res.writeHead(200, jsonHeaders); res.end(JSON.stringify(r));
    return;
  }

  // ── POST: Agent management ──
  if (endpoint === '/pios/spawn-agent') {
    const r = pios.spawnAgent(params.agentId);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/agent-status') {
    const r = pios.updateAgentStatus(params.agentId, params.status);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/update-card') {
    const r = pios.updateCardFrontmatter(params.filename, params.updates);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/restore-card') {
    // Used by frontend Undo. Restores frontmatter + content + folder from a
    // client-captured snapshot (from /pios/card fetch).
    const r = pios.restoreCard(params.filename, params.snapshot || {});
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/create-card') {
    // Quick-add card from Home (`c` shortcut). Rejects if filename already exists.
    const r = pios.createCard(params.filename, {
      dir: params.dir || 'inbox',
      frontmatter: params.frontmatter || {},
      content: params.content || '',
    });
    if (r && r.ok) {
      pios.appendDevAction({
        type: 'change',
        agent: 'manual',
        card: r.filename,
        file: `Cards/${r.dir}/${r.filename}.md`,
        desc: '快捷创建卡片',
        instance: 'pios-home',
      });
    }
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }

  // ── POST: Outputs ──
  if (endpoint === '/pios/output/read') {
    pios.markOutputRead(params.id, params.read !== false);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (endpoint === '/pios/outputs/read-all') {
    const count = pios.markAllOutputsRead();
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true, count }));
    return;
  }
  if (endpoint === '/pios/output/bookmark') {
    const bookmarked = pios.toggleOutputBookmark(params.id);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true, bookmarked }));
    return;
  }
  if (endpoint === '/pios/output/comment') {
    const card = pios.commentOutput(params.id, params.comment);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true, card }));
    return;
  }
  if (endpoint === '/pios/output/tag') {
    const tags = pios.tagOutput(params.id, params.tags);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true, tags }));
    return;
  }

  // ── POST: Task management ──
  if (endpoint === '/pios/task/create') {
    const r = pios.createTask(params.taskId, params, params.prompt || '');
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/task/update') {
    const r = pios.updateTaskMeta(params.taskId, params.updates || {});
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/task/update-prompt') {
    const r = pios.updateTaskPrompt(params.taskId, params.prompt || '');
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/task/delete') {
    const r = pios.deleteTask(params.taskId);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/task/run') {
    const r = pios.spawnTask(params.taskId);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/task/resume') {
    const r = pios.spawnTask(params.taskId, { resumeSession: params.sessionId });
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(r));
    return;
  }
  if (endpoint === '/pios/task/stop') {
    const taskId = params.taskId;
    if (!taskId) {
      res.writeHead(400, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: 'taskId required' }));
      return;
    }
    // 找到 adapter 进程并杀掉（adapter 有 TERM trap 会清理 run record）
    try {
      const { execSync } = require('child_process');
      // 找 adapter 主进程 PID（bash pios-adapter.sh --task taskId）
      const psOut = execSync(`ps ax -o pid,command | grep "pios-adapter.*--task ${taskId}" | grep -v grep`, { encoding: 'utf-8', timeout: 3000 }).trim();
      const pids = psOut.split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
      if (pids.length > 0) {
        for (const pid of pids) {
          try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
        }
        // 等一下让 trap 处理完，然后强制更新 run record
        setTimeout(() => {
          const runsDir = path.join(VAULT_ROOT, 'Pi', 'State', 'runs');
          try {
            const files = fs.readdirSync(runsDir).filter(f => f.startsWith(taskId + '-')).sort().reverse();
            if (files.length > 0) {
              const runFile = path.join(runsDir, files[0]);
              const rec = JSON.parse(fs.readFileSync(runFile, 'utf-8'));
              if (rec.status === 'running') {
                rec.status = 'stopped';
                rec.finished_at = new Date().toISOString();
                rec.error = 'stopped by user';
                fs.writeFileSync(runFile, JSON.stringify(rec, null, 2));
              }
            }
          } catch {}
        }, 1000);
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, killed: pids.length }));
      } else {
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: false, error: 'no running process found' }));
      }
    } catch (e) {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: 'no running process found' }));
    }
    return;
  }
  // 在主窗口打开一个 task run 的会话（导入 session 并切换）
  // tick 10: 加 idempotent guard —— 如果 session 已经在 sessions.json 里，
  // 不要 re-materialize，只切 activeId 和广播 session:open。
  // 原因：之前每次都 overwrite 会清掉 renderer 刚 push 的 user message
  // （rolling interjection 期间：用户发了"停一下/别搞"，sessions.json 被重新 materialize 后
  // user push 丢失，只剩 jsonl 解析出来的历史 + addAI 的 ai push）。
  if (endpoint === '/pios/open-session') {
    const sessionIdParam = params.sessionId;
    const runId = params.runId || '';
    if (!sessionIdParam && !runId) {
      res.writeHead(400, jsonHeaders);
      res.end(JSON.stringify({ ok: false, error: 'sessionId or runId required' }));
      return;
    }
    // 先按 runId 查 run record（它才是权威），若调用方只传了 sessionId 也能查
    let runRecord = null;
    if (runId) {
      const runFile = path.join(VAULT_ROOT, 'Pi', 'State', 'runs', runId + '.json');
      try { runRecord = JSON.parse(fs.readFileSync(runFile, 'utf-8')); } catch {}
    }
    if (!runRecord && sessionIdParam) {
      runRecord = findTaskRun({ sessionId: sessionIdParam });
    }
    if (!runRecord) {
      // 老兼容路径：调用方只给了 sessionId + taskId + runtime，run record 找不到。
      // 合成一个最小 run 让 materialize 能工作
      runRecord = {
        run_id: runId || null,
        agent: params.taskId || 'task',
        runtime: params.runtime || 'claude-cli',
        session_id: sessionIdParam,
        started_at: new Date().toISOString(),
        host: require('./backend/host-helper').resolveHost(),
      };
    }

    // 先算出 session id（永远用 'run:' + run_id 唯一）
    // 2026-04-23 修：以前用 runRecord.session_id 会让 Claude 复用 session 时
    // 多个 run 算出同 candidateId 互相覆盖 → "点 A 看 B"。
    // 现在和 taskRunSessionId 统一规则。
    const candidateId = runRecord.run_id ? ('run:' + runRecord.run_id) : (runRecord.session_id || 'run:unknown');
    const data = loadSessions();
    const existingIdx = data.sessions.findIndex(s => s.id === candidateId);
    let sessionObj;
    let engine;
    let taskId;

    if (existingIdx >= 0) {
      // tick 10: idempotent —— 已经物化过，直接用 disk 版本，不动 messages
      // （避免覆盖 renderer 可能 push 过的 user/ai message）
      sessionObj = data.sessions[existingIdx];
      engine = sessionObj.engine;
      taskId = sessionObj.taskId || runRecord.agent;
      data.activeId = candidateId;
      saveSessions(data);
      console.log(`[open-session] idempotent: session ${candidateId} already exists, not re-materializing`);
    } else {
      // 首次物化
      sessionObj = materializeTaskSessionFromRun(runRecord);
      engine = sessionObj.engine;
      taskId = sessionObj.taskId;
      data.sessions.push(sessionObj);
      data.activeId = sessionObj.id;
      saveSessions(data);
    }

    const sessionId = sessionObj.id;

    // 刀 3: task session 统一用 RunSessionAdapter（engineKey 'run'）接管
    // 无论 claude-cli 还是 codex-cli 的 run，都走 RunSessionAdapter —— 它根据 runtime
    // 选 parser，tail jsonl 实时 publish 事件，interrupt 走 SIGINT，send 走 spawn resume。
    // 老的 ClaudeInteractiveAdapter.task 路径（tick 11 的 _interruptTaskSession）被 RunSessionAdapter
    // 取代，后者把同样的逻辑 port 过去 + 加了 tail。
    if ((runRecord.session_id || runRecord.status === 'running') && sessionBus.hasAdapter('run')) {
      try {
        const _jsonlSid = runRecord.session_id || null;
        sessionBus.registerSession(sessionId, 'run', {
          origin: 'task',
          taskId,
          runtime: runRecord.runtime,
          runId: runRecord.run_id,
          host: runRecord.host,
        });
        await sessionBus.attach(sessionId, {
          runtime: runRecord.runtime,
          taskId,
          runId: runRecord.run_id,
          host: runRecord.host,
          jsonlSessionId: _jsonlSid,
        });
      } catch (e) { console.warn('[open-session] bus attach (run) failed:', e.message); }
    }

    // Legacy singleton —— 给 agent mode 用（不是 SessionBus 路径）
    if (engine === 'claude' && runRecord.session_id) {
      const claude = getClaudeClient();
      claude._sessionId = runRecord.session_id;
    } else if (engine === 'codex' && existingIdx < 0) {
      // Codex 用 in-memory conversation history，需要 restore
      // 只在首次 materialize 时 restore（idempotent 路径不重建，避免把用户 push 过的 ai 当成历史再丢回去）
      const gptClient = getOpenAIDirectClient();
      gptClient.reset();
      for (const m of (sessionObj.messages || [])) {
        if (m.role === 'user') {
          gptClient._conversationHistory.push({ role: 'user', content: m.content || '' });
        } else if (m.role === 'ai') {
          gptClient._conversationHistory.push({ role: 'assistant', content: m.content || '' });
        }
      }
      console.log(`[open-session] codex: restored ${gptClient._conversationHistory.length} messages`);
    }

    // 通知主窗口切换到这个 session
    if (mainWindow && !mainWindow.isDestroyed()) {
      sidebarCollapsed = false;
      forceRelayout();
      mainWindow.webContents.send('session:open', sessionId, engine);
      if (!mainWindow.isVisible()) mainWindow.show();
    }
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ ok: true, sessionId, engine }));
    return;
  }

  // ── POST: Talk to Pi（Home 页面 → 切到 chat 并注入消息） ──
  if (endpoint === '/pios/talk') {
    const text = (params.text || '').trim();
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'empty text' }));
      return;
    }
    switchToChatMode();
    mainWindow.webContents.send('pios:talk', text);
    // P6 · 用户（Home Talk to Pi 或 HTTP 外部调用）等 Claude → thinking pose
    try { pulse && pulse.setThinking(true); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST: Call Pi（Things Need You 右上角按钮 → 新会话 + 预填 + 拉出右边栏） ──
  // 和 /pios/talk 的区别：
  //   1. 不复用 pi-main，让 renderer 跑 createSession 起一条新会话（title 用卡名）
  //   2. 不 switchToChatMode（Home 停留，只展开右边栏，消息走 sidebarInput）
  // 所以 owner 可以一边看 Things Need You 卡、一边和 Pi 在右边栏对话，不被切到全屏聊天。
  if (endpoint === '/pios/call-pi') {
    const text = (params.text || '').trim();
    const title = (params.title || '').trim();
    const engine = (params.engine || '').trim() || 'claude';
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'empty text' }));
      return;
    }
    mainWindow.webContents.send('pios:call-pi', { text, title, engine });
    try { pulse && pulse.setThinking(true); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  try {
    // 选择目标 tab：优先 params.tab_id，其次 activeTab
    function pickTab() {
      if (params.tab_id != null) {
        const t = tabs.find(x => x.id === params.tab_id);
        return t || null;
      }
      return tabs.find(t => t.id === activeTabId) || null;
    }
    const tab = pickTab();
    const wc = tab && tab.view ? tab.view.webContents : null;

    switch (endpoint) {
      case '/navigate': {
        const target = completeURL(params.url || '');
        const wantNewTab = params.new_tab === true || !wc;
        const focus = params.focus !== false; // 默认 true（兼容）
        if (wantNewTab) {
          const newId = createTab(target, { focus });
          result = { result: 'ok', url: target, tab_id: newId, newTab: true };
        } else {
          await wc.loadURL(target);
          result = { result: 'ok', url: target, tab_id: tab.id };
        }
        break;
      }
      case '/new_tab': {
        const target = completeURL(params.url || 'https://www.google.com');
        const focus = params.focus !== false; // 默认 true（兼容手动入口）
        const mute = params.muted === true || (params.focus === false); // 后台 tab 默认静音
        const newId = createTab(target, { focus });
        const newTab = tabs.find(t => t.id === newId);
        if (newTab && mute) newTab.view.webContents.audioMuted = true;
        result = { result: 'ok', url: target, tab_id: newId, focus, muted: mute };
        break;
      }
      case '/read_page': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const data = await wc.executeJavaScript(`
          (function() {
            const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => ({level: h.tagName, text: h.textContent.trim()})).slice(0, 20);
            const links = [...document.querySelectorAll('a[href]')].map(a => ({text: a.textContent.trim(), href: a.href})).filter(l => l.text).slice(0, 50);
            const forms = [...document.querySelectorAll('form')].map(f => ({
              action: f.action,
              fields: [...f.querySelectorAll('input,select,textarea')].map(i => ({name: i.name, type: i.type, placeholder: i.placeholder, value: i.value}))
            })).slice(0, 5);
            const tables = [...document.querySelectorAll('table')].map(t => {
              const rows = [...t.querySelectorAll('tr')].slice(0, 10).map(r => [...r.querySelectorAll('td,th')].map(c => c.textContent.trim()));
              return rows;
            }).slice(0, 3);
            return { title: document.title, url: location.href, headings, links, forms, tables };
          })()
        `);
        result = data;
        break;
      }
      case '/get_text': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const text = await wc.executeJavaScript(`document.body.innerText.substring(0, 8000)`);
        const title = await wc.executeJavaScript(`document.title`);
        const pageUrl = await wc.executeJavaScript(`location.href`);
        result = { title, url: pageUrl, text };
        break;
      }
      case '/screenshot': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const img = await wc.capturePage();
        const png = img.toPNG();
        result = { image: png.toString('base64') };
        break;
      }
      case '/click': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const sel = (params.selector || '').replace(/'/g, "\\'");
        const clicked = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector('${sel}');
            if (!el) return { error: 'element not found: ${sel}' };
            el.click();
            return { result: 'clicked', tag: el.tagName, text: el.textContent.substring(0, 100) };
          })()
        `);
        result = clicked;
        break;
      }
      case '/fill': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const fSel = (params.selector || '').replace(/'/g, "\\'");
        const fVal = (params.value || '').replace(/'/g, "\\'");
        const filled = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector('${fSel}');
            if (!el) return { error: 'element not found: ${fSel}' };
            el.focus();
            el.value = '${fVal}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { result: 'filled', tag: el.tagName, value: '${fVal}' };
          })()
        `);
        result = filled;
        break;
      }
      case '/quick-dismiss': {
        // 快捷小窗 Esc — 隐藏 app，不带出主窗口
        app.hide();
        result = { ok: true };
        break;
      }
      case '/quick-send': {
        // 快捷小窗发送 — 显示主窗口 + 执行
        mainWindow.show();
        mainWindow.focus();
        const text = params.text || '';
        if (text && mainWindow) {
          mainWindow.webContents.executeJavaScript(`window._quickSend && window._quickSend(${JSON.stringify(text)})`);
        }
        result = { ok: true };
        break;
      }
      case '/exec_js': {
        const target = params.target === 'main' ? mainWindow.webContents : wc;
        if (!target) { result = { error: 'no target' }; break; }
        const jsResult = await target.executeJavaScript(params.code);
        result = { result: String(jsResult).substring(0, 10000) };
        break;
      }
      case '/tabs': {
        result = { tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.id === activeTabId })) };
        break;
      }
      case '/switch_tab': {
        const target = tabs.find(t => t.id === params.id);
        if (target) { switchToTab(params.id); result = { result: 'ok', url: target.url }; }
        else { result = { error: `tab ${params.id} not found` }; }
        break;
      }
      case '/mute_tab': {
        const mtId = params.tab_id != null ? params.tab_id : (params.id != null ? params.id : activeTabId);
        const mt = tabs.find(t => t.id === mtId);
        if (!mt) { result = { error: `tab ${mtId} not found` }; break; }
        const muted = params.muted !== undefined ? !!params.muted : true;
        mt.view.webContents.audioMuted = muted;
        result = { result: 'ok', tab_id: mtId, muted };
        break;
      }
      case '/close_tab': {
        const id = params.tab_id != null ? params.tab_id : params.id;
        if (id == null) { result = { error: 'missing tab_id' }; break; }
        if (id === homeTabId) { result = { error: 'cannot close Home tab' }; break; }
        const existed = tabs.some(t => t.id === id);
        if (!existed) { result = { error: `tab ${id} not found` }; break; }
        closeTab(id);
        result = { result: 'ok', closed: id };
        break;
      }
      case '/back': {
        if (wc) { wc.goBack(); result = { result: 'ok' }; }
        else { result = { error: 'no active tab' }; }
        break;
      }
      case '/forward': {
        if (wc) { wc.goForward(); result = { result: 'ok' }; }
        else { result = { error: 'no active tab' }; }
        break;
      }
    }
  } catch (err) {
    result = { error: err.message };
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port 17891 in use, killing old process...');
    try { require('child_process').execSync('lsof -ti :17891 | xargs kill -9 2>/dev/null'); } catch {}
    setTimeout(() => httpServer.listen(17891, '127.0.0.1'), 1000);
  }
});

httpServer.listen(17891, '127.0.0.1', () => {
  if (_apiReady) return; // 防止重试时重复触发
  console.log('[browser-api] listening on 127.0.0.1:17891');
  _apiReady = true;
  tryCreateHomeTabs();
});

// ── 启动 qwen-voice TTS/ASR 服务（跟随 PiBrowser 生命周期）──
// 优先用 ~/qwen-voice（开发者本地路径）；fallback 到 app bundle 里打包的 qwen-voice（extraResources）
// 打包的 venv 依赖系统 Homebrew Python 3.12（见 INSTALL.md §Voice Engine）
let qwenVoiceProc = null;
const _home = require('os').homedir();
function _resolveQwenVoiceRoot() {
  // 候选顺序：分包模式（~/.pios/voice/）→ 开发机 ~ → 合包 Resources/ → dev .
  const candidates = [
    path.join(_home, '.pios', 'voice', 'qwen-voice'),     // 分包模式 — PiOS 升级不动
    path.join(_home, 'qwen-voice'),                       // 开发机
    path.join(process.resourcesPath || '', 'qwen-voice'), // 合包模式（兼容）
    path.join(__dirname, 'qwen-voice'),                   // dev electron .
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'bin', 'python3')) && fs.existsSync(path.join(c, 'app.py'))) {
      return c;
    }
  }
  return null;
}
const QWEN_VOICE_ROOT = _resolveQwenVoiceRoot();
const QWEN_VOICE_PY = QWEN_VOICE_ROOT ? path.join(QWEN_VOICE_ROOT, 'bin', 'python3') : null;
const QWEN_VOICE_APP = QWEN_VOICE_ROOT ? path.join(QWEN_VOICE_ROOT, 'app.py') : null;

/**
 * 启动 qwen-voice service（可重复调用，idempotent）
 * 失败原因常见：venv 的 bin/python3.12 symlink 指向 /opt/homebrew/opt/python@3.12 不存在
 * （用户还没 brew install python@3.12 时）。用户装完 Python 后 renderer 可以调
 * pios:qwen-ensure-started IPC 触发重试。
 */
function startQwenVoiceService() {
  if (qwenVoiceProc) return { ok: true, reason: 'already-running-by-pios' };
  if (!QWEN_VOICE_ROOT || !fs.existsSync(QWEN_VOICE_PY) || !fs.existsSync(QWEN_VOICE_APP)) {
    return { ok: false, reason: 'qwen-voice root not found' };
  }
  // venv 的 python symlink 必须能 resolve 到真实 Python（否则 spawn 立即 ENOENT）
  try { fs.realpathSync(QWEN_VOICE_PY); }
  catch (e) { return { ok: false, reason: `venv python symlink broken: ${e.message} (need: brew install python@3.12)` }; }
  console.log('[qwen-voice] starting…');
  // bundle 里塞了预下载的 MLX 模型（4.7GB），HF_HOME 指向 bundle 让 huggingface_hub
  // 库直接 hit 本地 cache，新用户首启零下载就 ready
  const BUNDLED_MODELS = path.join(QWEN_VOICE_ROOT, '..', 'qwen-voice-models');
  const useBundledModels = fs.existsSync(path.join(BUNDLED_MODELS, 'hub'));
  try {
    qwenVoiceProc = require('child_process').spawn(QWEN_VOICE_PY, [QWEN_VOICE_APP], {
      cwd: QWEN_VOICE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`,
        ...(useBundledModels ? { HF_HOME: BUNDLED_MODELS, HF_HUB_OFFLINE: '1' } : {}),
      },
    });
    if (useBundledModels) console.log('[qwen-voice] using bundled models at', BUNDLED_MODELS);
  } catch (e) {
    return { ok: false, reason: `spawn failed: ${e.message}` };
  }
  qwenVoiceProc.stdout.on('data', (d) => { const s = d.toString().trim(); if (s) console.log('[qwen-voice]', s); });
  qwenVoiceProc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.log('[qwen-voice]', s); });
  qwenVoiceProc.on('exit', (code) => { console.log('[qwen-voice] exited with', code); qwenVoiceProc = null; });
  return { ok: true, reason: 'spawned' };
}

/** 先查 7860 是否已经活（可能是外部装的）；没活就尝试 spawn */
function ensureQwenStarted() {
  return new Promise((resolve) => {
    const req = require('http').request({ hostname: 'localhost', port: 7860, path: '/api/status', method: 'GET', timeout: 1500 }, () => {
      resolve({ ok: true, reason: 'already-running' });
    });
    req.on('error', () => resolve(startQwenVoiceService()));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(startQwenVoiceService()); });
    req.end();
  });
}

if (QWEN_VOICE_ROOT) {
  console.log('[qwen-voice] root resolved to:', QWEN_VOICE_ROOT);
  // 首次启动试一次 — 如果用户没装 Python，renderer 装完 deps 后会再调 ensureQwenStarted
  ensureQwenStarted().then(r => console.log('[qwen-voice] startup probe:', r));

  // PiBrowser 退出时清理
  app.on('will-quit', () => {
    if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
    if (qwenVoiceProc) { try { qwenVoiceProc.kill(); } catch {} }
  });
} else {
  console.log('[qwen-voice] not found in any candidate path — NPC voice disabled. Install: see INSTALL.md §Voice Engine');
}

ipcMain.handle('pios:qwen-ensure-started', async () => ensureQwenStarted());

// ── Claude Code: streaming execution with 🗣 voice events ──
// TTS 预热
setTimeout(() => {
  try {
    const tts = getTTS();
    // 从配置恢复 freeVoice 状态
    try {
      const sf = path.join(VAULT_ROOT, 'Pi', 'Config', 'notify-settings.json');
      const ns = JSON.parse(fs.readFileSync(sf, 'utf8'));
      tts.freeVoice = ns.freeVoice === true;
    } catch {}
    console.log('[TTS] connection pre-warmed, freeVoice=%s', tts.freeVoice);
  } catch {}
}, 5000); // 等 qwen-voice 启动

// Pre-warm whisper model (load into OS page cache)
setTimeout(() => {
  const silenceWav = path.join(os.tmpdir(), 'pi-warmup.wav');
  execFile('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.1', silenceWav],
    { timeout: 3000 }, (err) => {
      if (err) return;
      execFile(WHISPER_CLI, ['-m', WHISPER_MODEL, '-l', 'zh', '-f', silenceWav, '--no-timestamps', '-nt'],
        { timeout: 10000 }, () => {
          try { fs.unlinkSync(silenceWav); } catch {}
          console.log('[whisper] model pre-warmed');
        });
    });
}, 3000);

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

function _getSkipPermissions() {
  try {
    const yaml = require('js-yaml');
    const manifestPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    return !!(manifest && manifest.infra && manifest.infra.claude_settings && manifest.infra.claude_settings.skip_permissions);
  } catch { return false; }
}

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

ipcMain.handle('session:attach', async (_, { sessionId, engine, meta }) => {
  try {
    if (!sessionBus.hasAdapter(engine)) {
      return { ok: false, error: `engine "${engine}" not supported by session bus v2 yet` };
    }
    sessionBus.registerSession(sessionId, engine, meta || {});
    await sessionBus.attach(sessionId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ensure: 只在未注册或引擎不同时 register，保留现有 client 的 _sessionId（--resume 连续性）
ipcMain.handle('session:ensure', async (_, { sessionId, engine, claudeSessionId, codexThreadId }) => {
  try {
    const existing = sessionBus.getSession(sessionId);
    if (existing && existing.engine === engine) return { ok: true, reused: true };
    // 引擎不同 → forget 旧的再重建
    if (existing) sessionBus.forgetSession(sessionId);
    if (!sessionBus.hasAdapter(engine)) {
      return { ok: false, error: `engine "${engine}" not supported` };
    }
    sessionBus.registerSession(sessionId, engine, {});
    // 传已保存的 session/thread 身份给 adapter，避免切会话/重启后丢上下文。
    await sessionBus.attach(sessionId, { claudeSessionId, codexThreadId });
    return { ok: true, reused: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('session:send', async (_, { sessionId, text, opts }) => {
  try {
    // 容错：send 前若未注册就按 opts.engine（默认 claude）注册
    if (!sessionBus.getSession(sessionId)) {
      const engine = (opts && opts.engine) || 'claude';
      if (!sessionBus.hasAdapter(engine)) {
        return { error: `engine "${engine}" not supported by session bus v2 yet` };
      }
      sessionBus.registerSession(sessionId, engine, (opts && opts.meta) || {});
    }
    const yamlSkip = _getSkipPermissions();
    // per-session permissionLevel 优先；fallback 到 yaml 全局配置
    const permissionLevel = (opts && opts.permissionLevel) || (yamlSkip ? 'full' : 'safe');
    const skipPermissions = permissionLevel === 'full';
    const result = await sessionBus.send(sessionId, text, { skipPermissions, permissionLevel, ...(opts || {}) });
    return result;
  } catch (e) {
    // 友好错误：按当前 session 的真实引擎返回，不要把 Codex 错误伪装成 Claude。
    const msg = e.message || '';
    const engine = sessionBus.getSession(sessionId)?.engine || (opts && opts.engine) || 'claude';
    if (msg.includes('401') || msg.includes('authentication') || msg.includes('unauthorized')) {
      if (engine === 'codex') {
        return { error: 'Codex 未认证。请在终端运行 codex login，或到 Resources 页面重新登录。' };
      }
      return { error: 'Claude 未认证。请在终端运行 claude login 完成登录，然后重试。' };
    }
    if (msg.includes('ENOENT') || /command not found|spawn .*ENOENT/i.test(msg)) {
      if (engine === 'codex') {
        return { error: 'Codex CLI 未安装。请先安装 codex，并确认命令在 PATH 里可见。' };
      }
      return { error: 'Claude CLI 未安装。请先安装：npm install -g @anthropic-ai/claude-code' };
    }
    if (/timed out after \d+ms/i.test(msg) && engine === 'codex') {
      return { error: 'Codex 响应超时。PiBrowser 已把等待时间放宽到 5 分钟；如果还是超时，这次请求更像长任务，建议切 Claude/Agent 路径处理。' };
    }
    return { error: msg };
  }
});

// tick 7: handle (async) 而不是 on (fire-and-forget)，让 renderer 能 await
// SIGINT + wait jsonl 写完 的完成（task session 路径最多 10s）
ipcMain.handle('session:interrupt', async (_, sessionId) => {
  try {
    return await sessionBus.interrupt(sessionId);
  } catch (e) {
    console.warn('[session:interrupt]', e.message);
    return false;
  }
});

ipcMain.on('session:forget', (_, sessionId) => {
  try { sessionBus.forgetSession(sessionId); } catch {}
});

// ── Agent Mode: AI 自主浏览 ──
const AGENT_PROMPT_TPL = () => `你是 Pi Agent，运行在 ${_owner()} 的 AI 浏览器里。你正在执行一个自主浏览任务。

## 任务执行协议

1. **先输出计划**：收到任务后，先用 <plan> 标签输出编号步骤计划（3-10步）。
   格式：<plan>
   1. 打开目标网站
   2. 搜索关键词
   3. 提取前3个结果的信息
   4. 整理成表格返回
   </plan>

   **输出计划后，必须用 <confirm>确认执行此计划？</confirm> 等待用户确认。** 用户确认后才开始执行。

2. **逐步执行**：用户确认计划后，每执行一步前用 <step>N</step> 标记当前步骤编号。

3. **每步验证**：执行操作后截图或读取页面确认操作成功。如果失败，重试一次或调整方案。

4. **敏感操作暂停**：遇到以下场景必须用 <confirm>操作描述</confirm> 请求用户确认：
   - 提交表单（非搜索框）
   - 登录/注册
   - 支付/购买/下单
   - 下载文件
   - 涉及个人信息的操作

5. **最终结果**：任务完成后用 <result> 标签输出结构化结果。

## 浏览器控制（通过 Bash curl 调用 HTTP API）
HTTP API 在 http://127.0.0.1:17891，用 Bash 执行 curl。

常用操作：
- 导航：curl -s -X POST http://127.0.0.1:17891/navigate -H 'Content-Type: application/json' -d '{"url":"https://..."}'
- 新标签页：curl -s -X POST http://127.0.0.1:17891/new_tab -H 'Content-Type: application/json' -d '{"url":"https://..."}'
- 读取页面结构：curl -s -X POST http://127.0.0.1:17891/read_page -d '{}'
- 读取页面文本：curl -s -X POST http://127.0.0.1:17891/get_text -d '{}'
- 截图：curl -s -X POST http://127.0.0.1:17891/screenshot -d '{}' | python3 -c "import sys,json,base64; d=json.load(sys.stdin); open('/tmp/pi-screen.png','wb').write(base64.b64decode(d['image']))"
  然后用 Read 工具读取 /tmp/pi-screen.png
- 点击元素：curl -s -X POST http://127.0.0.1:17891/click -H 'Content-Type: application/json' -d '{"selector":"#btn"}'
- 填写表单：curl -s -X POST http://127.0.0.1:17891/fill -H 'Content-Type: application/json' -d '{"selector":"#input","value":"hello"}'
- 执行 JS：curl -s -X POST http://127.0.0.1:17891/exec_js -H 'Content-Type: application/json' -d '{"code":"document.title"}'
- 列出标签：curl -s -X POST http://127.0.0.1:17891/tabs -d '{}'

## 输出规则
- 用 <say> 标签包裹要语音播报的内容（≤25字，口语化）
- 屏幕文字不限，详细展示过程和结果
- 所有浏览器操作用 curl，禁止用 open 命令
${_persona()}`;

let agentClient = null;
let agentConfirmResolve = null;

ipcMain.handle('pi:agent', async (event, task) => {
  const claude = getClaudeClient();
  claude.reset(); // Agent 任务独立 session

  const fullTask = `${AGENT_PROMPT_TPL()}\n\n---\n## 用户任务\n${task}\n\n请先输出 <plan>，然后逐步执行。`;

  agentClient = claude;
  let finalContent = '';

  try {
    for await (const ev of claude.run(fullTask)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Parse agent-specific tags
        if (ev.type === 'text') {
          const content = ev.content;
          // Extract <plan>...</plan>
          const planMatch = content.match(/<plan>([\s\S]*?)<\/plan>/);
          if (planMatch) {
            const steps = planMatch[1].trim().split('\n').filter(l => l.trim());
            mainWindow.webContents.send('agent:event', { type: 'plan', steps });
          }
          // Extract <step>N</step>
          const stepMatch = content.match(/<step>(\d+)<\/step>/);
          if (stepMatch) {
            mainWindow.webContents.send('agent:event', { type: 'step', current: parseInt(stepMatch[1]) });
          }
          // Extract <confirm>...</confirm>
          const confirmMatch = content.match(/<confirm>([\s\S]*?)<\/confirm>/);
          if (confirmMatch) {
            mainWindow.webContents.send('agent:event', { type: 'confirm', action: confirmMatch[1].trim() });
            // Wait for user confirmation
            const confirmed = await new Promise(resolve => { agentConfirmResolve = resolve; });
            if (!confirmed) {
              claude.stop();
              mainWindow.webContents.send('agent:event', { type: 'cancelled' });
              return { content: '任务已取消', cancelled: true };
            }
          }
          // Extract <result>...</result>
          const resultMatch = content.match(/<result>([\s\S]*?)<\/result>/);
          if (resultMatch) {
            mainWindow.webContents.send('agent:event', { type: 'result', content: resultMatch[1].trim() });
          }
          // Forward cleaned text
          const cleanText = content
            .replace(/<plan>[\s\S]*?<\/plan>/g, '')
            .replace(/<step>\d+<\/step>/g, '')
            .replace(/<confirm>[\s\S]*?<\/confirm>/g, '')
            .replace(/<result>[\s\S]*?<\/result>/g, '')
            .replace(/<say>[\s\S]*?<\/say>/g, '')
            .trim();
          if (cleanText) {
            mainWindow.webContents.send('agent:event', { type: 'text', content: cleanText });
          }
        } else if (ev.type === 'voice') {
          mainWindow.webContents.send('agent:event', { type: 'voice', content: ev.content });
          // TTS
          try {
            const tts = getTTS();
            const audio = await tts.speak(ev.content, 15000);
            if (audio && audio.length > 100 && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('claude:audio',
                audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
              try { global._npcSpeak && global._npcSpeak(ev.content); } catch {}
            }
          } catch (e) { console.error('[Agent TTS]', e.message); }
        } else if (ev.type === 'tool') {
          mainWindow.webContents.send('agent:event', { type: 'tool', content: ev.content });
        } else if (ev.type === 'done') {
          finalContent = ev.content;
          mainWindow.webContents.send('agent:event', { type: 'done' });
        }
      }
    }
    return { content: finalContent };
  } catch (err) {
    return { content: '', error: err.message };
  } finally {
    agentClient = null;
    agentConfirmResolve = null;
  }
});

ipcMain.on('agent:stop', () => {
  if (agentClient) {
    agentClient.stop();
    agentClient = null;
  }
});

ipcMain.on('agent:confirm', (_, confirmed) => {
  if (agentConfirmResolve) {
    agentConfirmResolve(confirmed);
    agentConfirmResolve = null;
  }
});

// TTS（Codex 模式 + run-session task voice 用）— 完整 buffer
// 串行 chain：避免并发请求撞 QwenTTS 单例的 _busy 锁被 throw 吃掉（造成静默丢词）。
// 一次只跑一个 speak，后面的排队等着——对用户来说就是每句按顺序念完，不会丢句子。
let _voiceTTSChain = Promise.resolve();
ipcMain.handle('voice:tts', async (_, text, preset) => {
  const task = _voiceTTSChain.then(async () => {
    try {
      const tts = getTTS();
      const wavBuf = await tts.speak(text, 15000, preset);
      if (!wavBuf || wavBuf.length < 100) return null;
      try { global._npcSpeak && global._npcSpeak(text); } catch {}
      return wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.byteLength);
    } catch (err) {
      // 不再 fallback 到 macOS `say`——那会绕过 AudioQueue 造成双声（Qwen 返回的迟到音频
      // 和 say 同时响），也是 qwen-voice(MLX Python) 崩溃时"TTS 变 macOS 声音"的根因。
      // 宁可这一句静默，等下句（Qwen 恢复后）正常。
      console.error('[TTS]', err.message);
      return null;
    }
  });
  // 把 chain 的尾巴挪到这个任务之后（即使它 reject 也不能断链）
  _voiceTTSChain = task.catch(() => {});
  return task;
});

// DEBUG 埋点：renderer 把诊断信息发回 main，main 写文件（renderer 没有 fs 权限）
ipcMain.handle('debug:trace', (_, tag, info) => {
  try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] ${tag}: ${info}\n`); } catch {}
});

// ── Voice: Local ASR (Qwen/whisper-large-v3-turbo) + Local TTS (Qwen3-TTS) ──
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const { getTTS } = require('./backend/qwen-tts');

// medium model still downloading — use small for now, swap when ready
const WHISPER_MODEL_MEDIUM = '/opt/homebrew/share/whisper-cpp/ggml-medium.bin';
const WHISPER_MODEL_SMALL = '/opt/homebrew/share/whisper-cpp/ggml-small.bin';
const WHISPER_MODEL = fs.existsSync(WHISPER_MODEL_MEDIUM) && fs.statSync(WHISPER_MODEL_MEDIUM).size > 500_000_000
  ? WHISPER_MODEL_MEDIUM : WHISPER_MODEL_SMALL;
const WHISPER_CLI = '/opt/homebrew/bin/whisper-cli';

// Whisper 幻觉过滤（静音/噪音时的经典误识别）
const WHISPER_HALLUCINATIONS = [
  '請不吝點贊訂閱轉發打賞支持明鏡與點點欄目',
  '请不吝点赞订阅转发打赏支持明镜与点点栏目',
  '字幕製作', '字幕制作', '字幕由', 'Amara.org',
  '按下按鈕', '按下按钮', '(音樂)', '(音乐)',
  'Thank you for watching', 'thanks for watching',
  'Subscribe', 'Please subscribe',
  '謝謝觀看', '谢谢观看', '感谢收看',
  'MING PAO', '明鏡', '明镜', '點點', '点点',
  '在对话中', '在對話中',
  'music', 'applause', '掌声', '笑声',
  '歡迎收看', '欢迎收看', '感謝收看',
  'The End', 'Bye', 'Goodbye',
  '志愿者', '李宗盛', '中文字幕', '英文字幕',
  '翻译', '校对', '审核', '时间轴',
  '字幕组', '字幕君', '翻譯', '校對',
];

function isWhisperHallucination(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 2) return true;  // 单字太短，必定是噪音
  if (t.length <= 3 && /^[a-zA-Z\u4e00-\u9fff]+$/.test(t)) return true; // <=3字符孤立词
  if (t.length > 50 && !t.includes(' ')) return true; // 超长无空格 = 乱码
  const lower = t.toLowerCase();
  for (const h of WHISPER_HALLUCINATIONS) {
    if (lower.includes(h.toLowerCase())) return true;
  }
  // 全是括号内容 = 注释幻觉
  if (/^\(.*\)$/.test(t) || /^（.*）$/.test(t) || /^\[.*\]$/.test(t)) return true;
  // 全大写英文 = 字幕/水印
  if (/^[A-Z\s|]+$/.test(t) && t.length > 5) return true;
  return false;
}

ipcMain.handle('voice:asr', async (_, audioBuffer) => {
  const tmpWebm = path.join(os.tmpdir(), `pi-asr-${Date.now()}.webm`);
  const tmpWav = tmpWebm.replace('.webm', '.wav');
  fs.writeFileSync(tmpWebm, Buffer.from(audioBuffer));

  try {
    // Convert webm → wav 16kHz mono
    const ffmpegBin = require('fs').existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
    await new Promise((resolve, reject) => {
      execFile(ffmpegBin, ['-y', '-i', tmpWebm, '-ar', '16000', '-ac', '1', tmpWav],
        { timeout: 5000 }, (err) => err ? reject(err) : resolve());
    });

    // 检查音频时长（< 0.6s 直接丢弃）
    const wavStat = fs.statSync(tmpWav);
    const durationSec = (wavStat.size - 44) / (16000 * 2); // 16kHz 16bit mono
    if (durationSec < 0.6) {
      console.log('[ASR] too short:', durationSec.toFixed(2), 's, skipping');
      return { text: '', error: 'too_short' };
    }

    // 检查音频能量（RMS 太低 = 静音）
    const wavData = fs.readFileSync(tmpWav);
    const samples = new Int16Array(wavData.buffer, 44); // skip WAV header
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples.length);
    // 0.008：owner 报"语音识别不了"时实测 rms=0.01072 被 0.02 门限挡掉
    // 再降到 0.005 真会捕到背景底噪，0.008 是实测能说"你好"的最低值
    if (rms < 0.008) {
      console.log('[ASR] too quiet: rms =', rms.toFixed(5), ', skipping');
      return { text: '', error: '声音太小，靠近点再说' };
    }

    // Qwen ASR（本地 whisper-large-v3-turbo，比 whisper-cli medium 更准）
    const text = await new Promise((resolve, reject) => {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', fs.createReadStream(tmpWav), { filename: 'audio.wav', contentType: 'audio/wav' });
      const reqOpts = {
        method: 'POST',
        hostname: 'localhost',
        port: 7860,
        path: '/api/asr',
        headers: form.getHeaders(),
        timeout: 15000,
      };
      const req = http.request(reqOpts, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            resolve((result.text || '').trim());
          } catch { resolve(''); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('ASR timeout')); });
      form.pipe(req);
    });

    // 幻觉过滤
    if (isWhisperHallucination(text)) {
      console.log('[ASR] hallucination filtered:', text);
      return { text: '', error: 'hallucination' };
    }

    console.log('[ASR] recognized:', text, `(${durationSec.toFixed(1)}s, rms=${rms.toFixed(3)})`);
    return { text };
  } catch (err) {
    console.error('[ASR error]', err.message);
    return { text: '', error: err.message };
  } finally {
    try { fs.unlinkSync(tmpWebm); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }
});

// ── PiOS Engine IPC ──────────────────────────────────

ipcMain.handle('pios:agents', () => pios.loadAgents());
ipcMain.handle('pios:agent', (_, agentId) => pios.getAgent(agentId));
ipcMain.handle('pios:cards', (_, filter) => pios.loadCards(filter));
ipcMain.handle('pios:agent-cards', (_, agentId) => pios.getAgentCards(agentId));
ipcMain.handle('pios:projects', () => pios.getProjects());
ipcMain.handle('pios:decisions', () => pios.getDecisionQueue());
ipcMain.handle('pios:overview', () => pios.getSystemOverview());
ipcMain.handle('pios:plugins', () => pios.loadPlugins());
ipcMain.handle('pios:agent-workspace', (_, agentId) => pios.getAgentWorkspace(agentId));
ipcMain.handle('pios:update-agent-status', (_, agentId, status) => pios.updateAgentStatus(agentId, status));
ipcMain.handle('pios:sync-crontab', () => pios.syncCrontab());
ipcMain.handle('pios:spawn-agent', (_, agentId) => pios.spawnAgent(agentId));
ipcMain.handle('pios:is-installed', () => installer.isInstalled());
ipcMain.handle('pios:get-config', () => installer.loadConfig());
ipcMain.handle('pios:install', (_, options) => installer.install(options));
// renderer 在 setup overlay 关闭（用户点 "Start Using PiOS"）后调本 IPC 才创建 Home BrowserView，
// 否则原生 BrowserView 层会盖住 setup-done "PiOS is ready!" 屏
ipcMain.handle('pios:setup-done', async () => {
  try { tryCreateHomeTabs(); } catch (e) { return { ok: false, err: e.message }; }
  // setup 走完了，bubble window 也可以建了（之前被 isInstalled gate 拦着）
  try { if (typeof global._createBubbleWindow === 'function') global._createBubbleWindow(); } catch {}
  // 孵化里如果选了 NPC 并 stick（npcEnabled=true），bubble 刚建完，补跑 enableNpc
  try { if (typeof global._enableNpcAfterBubbleReady === 'function') global._enableNpcAfterBubbleReady(); } catch {}
  // 立即跑一次 auth-check.sh 刷新 runtime status（否则要等 cron 每小时才第一次跑，
  // 用户装完 codex/claude 看 System panel 会显示 down —— 这是 owner 之前报"登录了 codex 似乎无效"的根因）
  try {
    const cfg = installer.loadConfig();
    if (cfg && cfg.vault_root) {
      const authCheck = path.join(cfg.vault_root, 'Pi', 'Tools', 'auth-check.sh');
      if (fs.existsSync(authCheck)) {
        require('child_process').spawn('bash', [authCheck], {
          detached: true, stdio: 'ignore',
          env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`, VAULT: cfg.vault_root },
        }).unref();
        console.log('[setup-done] kicked off auth-check.sh for initial runtime status');
      }
    }
  } catch (e) { console.error('[setup-done] auth-check spawn failed:', e.message); }
  return { ok: true };
});

// 孵化仪式选定 NPC 后，把它粘到 pi-character.json + 启用 NPC，
// 让 Home 里 Pi 说话走固定音色，不再每句换。
ipcMain.handle('pios:stick-npc', (_, skinId) => {
  try {
    if (typeof global._piStickNpcFromHatching === 'function') {
      global._piStickNpcFromHatching(skinId);
      return { ok: true };
    }
    return { ok: false, err: 'stick-npc function not ready' };
  } catch (e) { return { ok: false, err: e.message }; }
});

// 孵化前需要确认 qwen-voice 服务 (localhost:7860) 已 ready，否则只能用 mac say 兜底——
// 这俩 IPC 让 renderer 在装完 deps + 起 qwen 后能轮询 + 直接调 qwen TTS（不用走 webkit speechSynthesis）
ipcMain.handle('pios:qwen-status', async () => {
  return await new Promise((resolve) => {
    const req = require('http').get('http://localhost:7860/api/status', { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve({ ready: !!j.ready, raw: j }); }
        catch { resolve({ ready: false }); }
      });
    });
    req.on('error', () => resolve({ ready: false }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ready: false }); });
  });
});
ipcMain.handle('pios:qwen-tts-wav', async (_, opts = {}) => {
  let { text, voice, npcId, instruct = '用温柔自然的语气说话' } = opts;
  if (!text) return { ok: false, err: 'empty text' };
  // 传 npcId 时从 characters.yaml 查该 NPC 的 voice（单一权威）
  // 保证孵化预览的声音和 Home 里 Pi 说话用同一套音色
  if (!voice && npcId) {
    try {
      const pp = require('./backend/pi-persona');
      const c = pp.listCharacters().find(x => (x.skin || x.id) === npcId);
      if (c && c.voice) voice = c.voice;
    } catch {}
  }
  if (!voice) voice = 'Serena'; // 兜底
  return await new Promise((resolve) => {
    const body = JSON.stringify({ text, voice, instruct });
    const req = require('http').request('http://localhost:7860/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ ok: true, audio_b64: Buffer.concat(chunks).toString('base64') });
        } else {
          resolve({ ok: false, err: `qwen status ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}` });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, err: e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, err: 'qwen tts timeout' }); });
    req.write(body); req.end();
  });
});

// Setup Wizard 第 0 页：环境依赖检查 + 一键装
const _depsCheck = require('./backend/deps-check');
const _depsInstall = require('./backend/deps-install');
ipcMain.handle('deps:check', () => _depsCheck.check());
ipcMain.handle('deps:install', async (evt, which) => {
  const onProgress = (chunk) => {
    try { evt.sender.send('deps:progress', which, chunk); } catch {}
  };
  try {
    let r;
    if (which === 'xcode_clt') r = await _depsInstall.installXcodeCLT(onProgress);
    else if (which === 'brew') r = await _depsInstall.installBrew(onProgress);
    else if (which === 'node') r = await _depsInstall.installNode(onProgress);
    else if (which === 'python312') r = await _depsInstall.installPython312(onProgress);
    else if (which === 'ffmpeg') r = await _depsInstall.installFfmpeg(onProgress);
    else if (which === 'claude') r = await _depsInstall.installClaudeCli(onProgress);
    else if (which === 'codex') r = await _depsInstall.installCodex(onProgress);
    else return { ok: false, code: -1, tail: `unknown dep: ${which}` };
    return r;
  } catch (e) {
    return { ok: false, code: -1, tail: `[install error] ${e.message}` };
  }
});
// ── Plugin 激活：开一个 Terminal + claude 跑 plugin.yaml 里指定的 activate prompt ──
// 这条引导是 AI-mediated，不再用阶梯向导（owner 2026-04-25 决定：一个按钮进会话，AI 看人下药）
ipcMain.handle('pios:plugin-list', async () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pios', 'config.json'), 'utf-8'));
    const vault = cfg.vault_root || path.join(process.env.HOME, 'PiOS');
    const installed = Array.isArray(cfg.plugins) ? cfg.plugins : [];
    const pluginState = cfg.plugin_state || {};
    const pluginsDir = path.join(vault, 'Pi', 'Plugins');
    const result = [];
    for (const id of installed) {
      if (['vault', 'shell', 'web-search', 'browser'].includes(id)) continue; // core 无需激活
      const metaFile = path.join(pluginsDir, id, 'plugin.yaml');
      if (!fs.existsSync(metaFile)) continue; // 2026-04-25: 没 plugin.yaml 说明该 id 产品已不支持（老 config 残留 health/photos 等），过滤掉不展示
      const meta = require('js-yaml').load(fs.readFileSync(metaFile, 'utf-8'));
      let activated = false;
      if (meta && Array.isArray(meta.activation?.success_marker)) {
        activated = meta.activation.success_marker.every(f => {
          const p = f.replace('{pios_home}', path.join(process.env.HOME, '.pios'));
          return fs.existsSync(p);
        });
      }
      result.push({
        id,
        name: meta?.name || id,
        description: meta?.description || '',
        has_activation: !!(meta?.activation?.prompt),
        activated,
        last_activated_at: pluginState[id]?.activated_at || null,
      });
    }
    return { ok: true, plugins: result };
  } catch (e) {
    return { ok: false, error: e.message, plugins: [] };
  }
});
ipcMain.handle('pios:plugin-activate', async (_, pluginId) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pios', 'config.json'), 'utf-8'));
    const vault = cfg.vault_root || path.join(process.env.HOME, 'PiOS');
    const owner = cfg.owner_name || 'User';
    const pluginDir = path.join(vault, 'Pi', 'Plugins', pluginId);
    const metaFile = path.join(pluginDir, 'plugin.yaml');
    if (!fs.existsSync(metaFile)) return { ok: false, error: `plugin ${pluginId} not installed` };
    const meta = require('js-yaml').load(fs.readFileSync(metaFile, 'utf-8'));
    const promptFile = path.join(pluginDir, meta.activation?.prompt || 'prompts/activate.md');
    if (!fs.existsSync(promptFile)) return { ok: false, error: `activation prompt not found at ${promptFile}` };

    // 读 prompt + 把 {vault} / {owner} 填进去
    let promptText = fs.readFileSync(promptFile, 'utf-8');
    promptText = promptText.replace(/\{vault\}/g, vault).replace(/\{owner\}/g, owner);

    // 不开 Terminal——在 PiBrowser 主窗口里 fork 一个新 session，让 Pi 在 native chat 里跟用户聊
    // mainWindow 收到事件 → renderer 调 createSession + sendMessage(text=promptText)
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: 'PiOS 主窗口未就绪' };
    }
    try { mainWindow.show(); mainWindow.focus(); } catch {}
    // 用户当前在 Home BrowserView 点的"激活"——切回 chat 模式让用户能看见会话
    // （Home 还在，tabs 保留；用户激活完点 toolbar Home 图标可以回去）
    try { switchToChatMode(); } catch (e) { console.error('[plugin-activate] switchToChatMode:', e.message); }
    mainWindow.webContents.send('plugin:start-activation', {
      pluginId,
      title: `激活 ${meta.name || pluginId}`,
      // 第一条 user message：直接把 activate.md 整段传给 Pi。Pi 看到一段"激活 X 的完整说明"，
      // 按里面写的成功标准 + 工具清单 + 阶段节奏一步步带用户走。
      firstUserMessage: promptText + '\n\n---\n\n现在开始，先做"阶段 1：环境自检"。',
    });
    return { ok: true, pluginId };
  } catch (e) {
    console.error('[plugin-activate]', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pios:read-card', (_, filename) => pios.readCard(filename));
ipcMain.handle('pios:update-card', (_, filename, updates) => pios.updateCardFrontmatter(filename, updates));
ipcMain.handle('pios:resolve-decision', (_, filename, decision) => pios.resolveDecision(filename, decision));
ipcMain.handle('pios:move-card', (_, filename, toStatus) => pios.moveCard(filename, toStatus));
ipcMain.handle('pios:approve-review', (_, filename, comment) => pios.approveReview(filename, comment));
ipcMain.handle('pios:rework-review', (_, filename, comment) => pios.reworkReview(filename, comment));
ipcMain.handle('pios:respond-to-owner', (_, filename, response, opts) => pios.respondToOwner(filename, response, opts || {}));
ipcMain.handle('pios:approve-permission', (_, filename) => pios.approvePermission(filename));
ipcMain.handle('pios:defer-card', (_, filename, until) => pios.deferCard(filename, until));
ipcMain.handle('pios:runtimes', () => {
  try {
    const yaml = require('js-yaml');
    const piosPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
    const pios = yaml.load(fs.readFileSync(piosPath, 'utf-8'));
    const runtimes = (pios.infra && pios.infra.runtimes) ? pios.infra.runtimes : {};
    return Object.entries(runtimes).map(([id, r]) => ({
      id,
      name: r.name || id,
      status: r.status || 'unknown',
      error: r.error || null,
      last_success: r.last_success || null,
      down_since: r.down_since || null,
    }));
  } catch {
    return [];
  }
});

ipcMain.handle('pios:runtime-restart', async (_, runtimeId) => {
  if (runtimeId !== 'openclaw') return { ok: false, error: 'Only openclaw restart is supported' };
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('openclaw gateway restart', { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: stderr || err.message });
      else resolve({ ok: true, output: stdout.trim() });
    });
  });
});

// 一键重新探活 auth-based runtimes (claude-cli / codex-cli)
// 跑 auth-manager check + auth-check.sh，两者都会根据实时探活结果写回 pios.yaml。
// 用在 quota 提前恢复 / 外部登录后系统没察觉的场景。
ipcMain.handle('pios:runtime-refresh-auth', async (_, runtimeId) => {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const vault = VAULT_ROOT;
    const cmd = `bash "${vault}/Pi/Tools/auth-manager.sh" check 2>&1; bash "${vault}/Pi/Tools/auth-check.sh" 2>&1`;
    exec(cmd, { timeout: 30000, env: { ...process.env, PIOS_VAULT: vault } }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      // Re-read pios.yaml for the runtime's new status
      try {
        const yaml = require('js-yaml');
        const piosPath = path.join(vault, 'Pi', 'Config', 'pios.yaml');
        const pios = yaml.load(fs.readFileSync(piosPath, 'utf-8'));
        const rt = pios?.infra?.runtimes?.[runtimeId] || {};
        resolve({
          ok: rt.status === 'ok',
          status: rt.status || 'unknown',
          error: rt.error || null,
          output: output.trim().split('\n').slice(-6).join('\n'),
        });
      } catch (e) {
        resolve({ ok: false, error: e.message, output: output.trim() });
      }
    });
  });
});

app.on('window-all-closed', async () => {
  saveTabs(); // 保存标签以便下次恢复
  const client = getClient();
  await client.stop();
  const claudeClient = getClaudeClient();
  claudeClient.stop();
  if (httpServer) httpServer.close();
  app.quit();
});
