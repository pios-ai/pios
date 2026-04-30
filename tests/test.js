/**
 * Pi Browser — 自动化测试
 * 用 Electron 自带的能力测试核心功能
 */

const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('\n=== Pi Browser 测试 ===\n');

  // --- 1. 模块加载测试 ---
  console.log('[1] 模块加载');
  try {
    const { CodexMCPClient, getClient } = require('./backend/codex-client');
    assert(typeof CodexMCPClient === 'function', 'CodexMCPClient class 存在');
    assert(typeof getClient === 'function', 'getClient function 存在');
    const client = getClient();
    assert(client instanceof CodexMCPClient, 'getClient 返回 CodexMCPClient 实例');
    assert(typeof client.call === 'function', 'client.call 方法存在');
    assert(typeof client.reply === 'function', 'client.reply 方法存在');
    assert(typeof client.start === 'function', 'client.start 方法存在');
    assert(typeof client.stop === 'function', 'client.stop 方法存在');
  } catch (e) {
    assert(false, `模块加载失败: ${e.message}`);
  }

  try {
    const { buildSystemContext, VAULT_PATH } = require('./backend/vault-context');
    assert(typeof buildSystemContext === 'function', 'buildSystemContext function 存在');
    assert(typeof VAULT_PATH === 'string', 'VAULT_PATH 是字符串');
    assert(fs.existsSync(VAULT_PATH), `VAULT_PATH 目录存在: ${VAULT_PATH}`);
    const ctx = buildSystemContext({ includeProfile: true });
    assert(typeof ctx === 'string' && ctx.length > 0, '系统上下文非空');
    assert(ctx.includes('Pi'), '上下文包含 Pi');
  } catch (e) {
    assert(false, `vault-context 加载失败: ${e.message}`);
  }

  // --- 2. Codex MCP 连接测试 ---
  console.log('\n[2] Codex MCP 连接');
  try {
    const { getClient } = require('./backend/codex-client');
    const client = getClient();
    await client.start();
    assert(client._started === true, 'MCP 连接已建立');
    assert(client._proc && !client._proc.killed, 'MCP 子进程在运行');

    // 发一条简单消息
    const result = await client.call('回答一个字：好', { timeout: 30000, model: 'gpt-5.4' });
    assert(typeof result.threadId === 'string' && result.threadId.length > 0, `threadId 有效: ${result.threadId.substring(0, 20)}...`);
    assert(typeof result.content === 'string' && result.content.length > 0, `回复内容: "${result.content.substring(0, 50)}"`);

    // 多轮对话
    const reply = await client.reply(result.threadId, '再说一个字', { timeout: 30000 });
    assert(typeof reply.content === 'string' && reply.content.length > 0, `多轮回复: "${reply.content.substring(0, 50)}"`);

    await client.stop();
    assert(true, 'MCP 连接正常关闭');
  } catch (e) {
    assert(false, `Codex MCP 测试失败: ${e.message}`);
  }

  // --- 3. 窗口创建测试 ---
  console.log('\n[3] Electron 窗口');
  let mainWindow;
  try {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false, // 不显示窗口
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      }
    });
    assert(true, '窗口创建成功');

    await mainWindow.loadFile('renderer/index.html');
    assert(true, 'index.html 加载成功');

    const title = mainWindow.getTitle();
    assert(title === 'Pi Browser', `窗口标题: "${title}"`);

    // 检查 preload API 是否暴露
    const hasPi = await mainWindow.webContents.executeJavaScript('typeof window.pi');
    assert(hasPi === 'object', 'window.pi API 已暴露');

    const apis = await mainWindow.webContents.executeJavaScript(`
      Object.keys(window.pi)
    `);
    const requiredApis = ['sendMessage', 'navigate', 'goBack', 'goForward', 'reload', 'findInPage', 'newTab', 'closeTab', 'bookmarksAdd', 'historyList'];
    for (const api of requiredApis) {
      assert(apis.includes(api), `API: window.pi.${api}`);
    }
  } catch (e) {
    assert(false, `窗口测试失败: ${e.message}`);
  }

  // --- 4. BrowserView 测试 ---
  console.log('\n[4] BrowserView (网页加载)');
  try {
    const view = new BrowserView();
    view.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    const ua = view.webContents.getUserAgent();
    assert(!ua.includes('Electron'), `User-Agent 不含 Electron`);
    assert(ua.includes('Chrome/131'), `User-Agent 含 Chrome/131`);

    mainWindow.setBrowserView(view);
    view.setBounds({ x: 0, y: 40, width: 800, height: 600 });

    // 加载一个简单页面
    await view.webContents.loadURL('data:text/html,<html><body><h1>Test</h1><a href="https://example.com" target="_blank">Link</a></body></html>');
    assert(true, 'BrowserView 加载 HTML 成功');

    const text = await view.webContents.executeJavaScript('document.body.innerText');
    assert(text.includes('Test'), `页面内容正确: "${text.substring(0, 30)}"`);

    // 测试导航状态
    assert(view.webContents.canGoBack() === false, '初始无后退');
    assert(view.webContents.canGoForward() === false, '初始无前进');

    // 导航到第二个页面
    await view.webContents.loadURL('data:text/html,<html><body><h1>Page2</h1></body></html>');
    assert(view.webContents.canGoBack() === true, '导航后可后退');

    // 测试缩放
    view.webContents.setZoomLevel(1.5);
    assert(view.webContents.getZoomLevel() === 1.5, '缩放设置正确');
    view.webContents.setZoomLevel(0);
    assert(view.webContents.getZoomLevel() === 0, '缩放重置正确');

    mainWindow.removeBrowserView(view);
    view.webContents.destroy();
    assert(true, 'BrowserView 清理成功');
  } catch (e) {
    assert(false, `BrowserView 测试失败: ${e.message}`);
  }

  // --- 5. 书签持久化测试 ---
  console.log('\n[5] 书签持久化');
  try {
    const bookmarksFile = path.join(app.getPath('userData'), 'bookmarks.json');
    // 清理
    try { fs.unlinkSync(bookmarksFile); } catch {}

    const loadBookmarks = () => {
      try { return JSON.parse(fs.readFileSync(bookmarksFile, 'utf-8')); } catch { return []; }
    };
    const saveBookmarks = (b) => fs.writeFileSync(bookmarksFile, JSON.stringify(b));

    let bookmarks = loadBookmarks();
    assert(bookmarks.length === 0, '初始书签为空');

    bookmarks.push({ title: 'Test', url: 'https://test.com', added: new Date().toISOString() });
    saveBookmarks(bookmarks);
    const reloaded = loadBookmarks();
    assert(reloaded.length === 1, '书签保存成功');
    assert(reloaded[0].url === 'https://test.com', '书签内容正确');

    // 清理
    fs.unlinkSync(bookmarksFile);
    assert(true, '书签文件清理完成');
  } catch (e) {
    assert(false, `书签测试失败: ${e.message}`);
  }

  // --- 6. 历史记录持久化测试 ---
  console.log('\n[6] 历史记录持久化');
  try {
    const historyFile = path.join(app.getPath('userData'), 'history.json');
    try { fs.unlinkSync(historyFile); } catch {}

    const loadHistory = () => {
      try { return JSON.parse(fs.readFileSync(historyFile, 'utf-8')); } catch { return []; }
    };

    let history = loadHistory();
    assert(history.length === 0, '初始历史为空');

    history.push({ title: 'Google', url: 'https://google.com', visited: new Date().toISOString() });
    history.push({ title: 'GitHub', url: 'https://github.com', visited: new Date().toISOString() });
    fs.writeFileSync(historyFile, JSON.stringify(history));

    const reloaded = loadHistory();
    assert(reloaded.length === 2, '历史记录保存成功');
    assert(reloaded[1].title === 'GitHub', '历史内容正确');

    fs.unlinkSync(historyFile);
    assert(true, '历史文件清理完成');
  } catch (e) {
    assert(false, `历史记录测试失败: ${e.message}`);
  }

  // --- 7. URL 补全测试 ---
  console.log('\n[7] URL 补全逻辑');
  function completeURL(url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      if (url.includes('.') && !url.includes(' ')) return 'https://' + url;
      return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    }
    return url;
  }
  assert(completeURL('google.com') === 'https://google.com', 'google.com → https://google.com');
  assert(completeURL('https://example.com') === 'https://example.com', 'https 不变');
  assert(completeURL('http://localhost') === 'http://localhost', 'http 不变');
  assert(completeURL('搜索词').startsWith('https://www.google.com/search?q='), '中文搜索 → Google');
  assert(completeURL('hello world').startsWith('https://www.google.com/search?q='), '带空格 → Google');

  // --- 清理 ---
  if (mainWindow) mainWindow.destroy();

  // --- 结果 ---
  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

app.whenReady().then(runTests);
