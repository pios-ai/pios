'use strict';
/**
 * /m/* — Mobile chat routes (M2 walking-skeleton)
 *
 * Path B 模块共享：从 ../backend/ require Pi 共享逻辑。
 *
 * Endpoints:
 *   GET  /m/         — mobile chat UI (HTML)
 *   POST /m/chat     — body { message }, streams SSE events from ClaudeCodeClient.run()
 *                      events: voice|text|tool|done|error
 *
 * M2 阶段单进程单 session（无持久化），ClaudeCodeClient 实例保持 sessionId 跨轮。
 * sessions list / 持久化 storage 是 M2 第二步。
 */

const fs = require('fs');
const path = require('path');

// Lazy require — keep server start fast even if backend module has slow init
let _client = null;
function getClient() {
  if (_client) return _client;
  const { getClaudeClient } = require('../../backend/claude-client');
  _client = getClaudeClient();
  return _client;
}

function sendChatHTML(req, res) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'chat.html'), 'utf-8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleChatPost(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  await new Promise(resolve => req.on('end', resolve));

  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  const message = (parsed.message || '').trim();
  if (!message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'message required' }));
    return;
  }

  // SSE response headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = getClient();

  // Resolve cwd to vault root so claude CLI sees Pi/, Cards/, etc.
  const VAULT = process.env.VAULT_PATH || path.resolve(__dirname, '..', '..', '..', '..');

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    for await (const ev of client.run(message, { cwd: VAULT, permissionLevel: 'full' })) {
      if (aborted) break;
      sseWrite(res, ev.type, { content: ev.content || '' });
      if (ev.type === 'done' || ev.type === 'error') break;
    }
  } catch (err) {
    sseWrite(res, 'error', { content: String(err && err.message || err) });
  } finally {
    try { res.end(); } catch {}
  }
}

function dispatch(req, res, parsedUrl) {
  const { pathname } = parsedUrl;
  if (pathname === '/m/' || pathname === '/m') {
    if (req.method === 'GET') return sendChatHTML(req, res);
  }
  if (pathname === '/m/chat' && req.method === 'POST') return handleChatPost(req, res);
  return false; // not handled
}

module.exports = { dispatch };
