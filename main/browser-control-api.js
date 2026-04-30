'use strict';
const path = require('path');
const fs = require('fs');
const authApi = require('./browser-control-api-auth');

const getHandlers1 = require('./bca-get-1');
const getHandlers2 = require('./bca-get-2');
const postHandlers1 = require('./bca-post-1');
const postHandlers2 = require('./bca-post-2');
const browserCmds = require('./bca-browser-cmds');

/**
 * Browser Control HTTP API — extracted from main.js
 *
 * Call create(s) once at startup. The server starts immediately and listens on 127.0.0.1:17891.
 *
 * @param {object} s — state object from main.js. Mutable scalars are accessed via getters;
 *   stable refs (functions, service objects, constants) may be plain properties.
 * @returns {http.Server}
 *
 * Routing：本文件只做 shell + dispatch，handler 路由代码已拆到 bca-*.js 五个子模块。
 *   - GET  → bca-get-1.js (/pios/* dashboard) + bca-get-2.js (outputs/tasks/profile/scratch/...)
 *   - POST → bca-post-1.js (afterward/profile/sense/scratch/identity/users/run-terminal)
 *           + bca-post-2.js (manifest/notify/agent/PiOS-actions/task-mgmt/open-session/talk/call-pi)
 *   - 浏览器命令 switch → bca-browser-cmds.js（/navigate /new_tab /screenshot /click /fill ...）
 *
 * 子模块约定：每个 tryHandle(req, res, endpoint, [params,] ctx) 在 endpoint 命中后
 *   调用 res.end() 并 return；shell 通过 `res.writableEnded` 短路余下分派。
 */
function create(s) {
  // Stable references — safe to destructure once
  const {
    createTab, switchToTab, closeTab, sendNotification, handlePiEvent, switchToChatMode,
    forceRelayout, completeURL, deepMerge,
    loadSessions, saveSessions, findTaskRun, materializeTaskSessionFromRun,
    taskRunSessionId, tryCreateHomeTabs,
    _backupSessionJsonl, _compactSession, _fetchContextDetail, _restoreSessionFromBackup,
    getClaudeClient,
    pios, installer,
    _loginSessions, _compactInFlight,
    VAULT_ROOT, APP_VERSION,
  } = s;

  // ctx 包：传给所有子模块。`s` 自身放在 ctx.s 供 getter 访问（mainWindow/tabs/sessionBus 等）
  const ctx = {
    s,
    createTab, switchToTab, closeTab, sendNotification, handlePiEvent, switchToChatMode,
    forceRelayout, completeURL, deepMerge,
    loadSessions, saveSessions, findTaskRun, materializeTaskSessionFromRun,
    taskRunSessionId, tryCreateHomeTabs,
    _backupSessionJsonl, _compactSession, _fetchContextDetail, _restoreSessionFromBackup,
    getClaudeClient,
    pios, installer,
    _loginSessions, _compactInFlight,
    VAULT_ROOT, APP_VERSION,
  };

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
  if (endpoint.startsWith('/afterward/api/') && s.afterward && typeof s.afterward.handleApiRequest === 'function') {
    try {
      const handled = await s.afterward.handleApiRequest(req, res, endpoint, url);
      if (handled) return;
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // ── GET routes → bca-get-1.js / bca-get-2.js ──
  if (req.method === 'GET') {
    await getHandlers1.tryHandle(req, res, endpoint, ctx);
    if (res.writableEnded) return;
    await getHandlers2.tryHandle(req, res, endpoint, ctx);
    if (res.writableEnded) return;
    res.writeHead(404, jsonHeaders);
    res.end(JSON.stringify({ error: 'unknown GET endpoint', endpoint }));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body = '';
  for await (const chunk of req) body += chunk;
  let params = {};
  try { params = body ? JSON.parse(body) : {}; } catch {}

  // Afterward POST endpoint: open the Afterward window
  if (endpoint === '/afterward/open') {
    try {
      s.afterward.open();
      res.writeHead(200, jsonHeaders); res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST routes → bca-post-1.js / bca-post-2.js ──
  await postHandlers1.tryHandle(req, res, endpoint, params, ctx);
  if (res.writableEnded) return;
  await postHandlers2.tryHandle(req, res, endpoint, params, ctx);
  if (res.writableEnded) return;

  // ── Browser commands switch → bca-browser-cmds.js ──
  await browserCmds.tryHandle(req, res, endpoint, params, ctx);
  if (res.writableEnded) return;

  res.writeHead(404, jsonHeaders);
  res.end(JSON.stringify({ error: 'unknown POST endpoint', endpoint }));
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port 17891 in use, killing old process...');
    try { require('child_process').execSync('lsof -ti :17891 | xargs kill -9 2>/dev/null'); } catch {}
    setTimeout(() => httpServer.listen(17891, '127.0.0.1'), 1000);
  }
});

httpServer.listen(17891, '127.0.0.1', () => {
  if (s._apiReady) return; // 防止重试时重复触发
  console.log('[browser-api] listening on 127.0.0.1:17891');
  s._apiReady = true;
  tryCreateHomeTabs();
});

  return httpServer;
}

module.exports = { create };
