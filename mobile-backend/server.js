'use strict';
/**
 * PiOS Mobile Backend — M1 Walking Skeleton
 *
 * Native Node http server (no express — M1 纪律：少引依赖)
 * Port: 17892  (延续 :17891 命名风格)
 * Auth: Bearer token via env MOBILE_API_TOKEN
 *
 * M1 endpoints:
 *   GET  /                         — mobile-friendly hello-world HTML page (no auth, walking skeleton e2e)
 *   GET  /mobile/ping              — health check JSON (no auth)
 *   GET  /mobile/hello             — hello JSON (auth required)
 *   POST /mobile/register-push-token — register APNs/FCM token (auth required)
 *
 * Env:
 *   PORT             — default 17892
 *   MOBILE_API_TOKEN — bearer token; if empty, auth is skipped (dev mode)
 *   VAULT_PATH       — vault root (default: resolve from __dirname)
 *   LOG_PATH         — JSONL log file path
 */

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '17892', 10);
const MOBILE_API_TOKEN = process.env.MOBILE_API_TOKEN || '';

// Resolve vault path: __dirname is Projects/pios/mobile-backend
const DEFAULT_VAULT = path.resolve(__dirname, '../../..');
const VAULT_PATH = process.env.VAULT_PATH || DEFAULT_VAULT;
const LOG_PATH = process.env.LOG_PATH || path.join(VAULT_PATH, 'Pi/Log/pios-mobile-backend.log');

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonRes(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function log(level, msg, ctx = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, source: 'server', msg, ...ctx });
  process.stdout.write(entry + '\n');
  try { fs.appendFileSync(LOG_PATH, entry + '\n'); } catch { /* log dir may not exist in test env */ }
}

const PUBLIC_PATHS = new Set(['/', '/mobile/ping', '/m/', '/m', '/m/chat']);

// Lazy load chat routes so server starts even if shared backend module has issues
let _chatRoutes = null;
function getChatRoutes() {
  if (_chatRoutes !== null) return _chatRoutes;
  try { _chatRoutes = require('./routes/chat'); } catch (e) {
    log('warn', 'chat routes failed to load', { error: String(e && e.message || e) });
    _chatRoutes = false;
  }
  return _chatRoutes;
}

// Returns true if request is authorized, false (and sends 401) if not
function checkAuth(req, res) {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  if (PUBLIC_PATHS.has(pathname)) return true;
  // No token configured → dev mode, skip auth
  if (!MOBILE_API_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token === MOBILE_API_TOKEN) return true;
  jsonRes(res, 401, { error: 'Unauthorized' });
  return false;
}

// ── Route handlers ────────────────────────────────────────────────────────────

function handleRoot(req, res) {
  const ts = new Date().toISOString();
  // owner name from ~/.pios/config.json (fallback to env, then "User")
  let ownerName = 'User';
  try {
    const cfgPath = path.join(process.env.HOME || '', '.pios', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg && cfg.owner_name) ownerName = String(cfg.owner_name);
    }
  } catch {}
  if (process.env.PIOS_OWNER_NAME) ownerName = process.env.PIOS_OWNER_NAME;
  const hostLabel = process.env.PIOS_HOST || require('os').hostname().split('.')[0];
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pi · Hello</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
       background:#0a0a0a;color:#f5f5f5;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
       min-height:100vh}
  .glyph{font-size:96px;line-height:1;color:#fff;margin-bottom:32px;
         text-shadow:0 0 40px rgba(255,255,255,.3)}
  h1{font-size:32px;font-weight:300;margin-bottom:12px;letter-spacing:.5px}
  .sub{font-size:15px;color:#888;margin-bottom:48px}
  .meta{font-size:12px;color:#555;font-family:ui-monospace,Menlo,monospace;
        text-align:center;line-height:1.8;background:#161616;
        padding:16px 24px;border-radius:12px;border:1px solid #222}
  .meta b{color:#9cdcfe;font-weight:500}
  .live{color:#7ee787}
  .live::before{content:"●";margin-right:6px;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style>
</head>
<body>
  <div class="glyph">✦</div>
  <h1>Hello, ${ownerName}</h1>
  <p class="sub">PiOS Mobile · Walking Skeleton</p>
  <div class="meta">
    <div class="live">connected to pios-mobile-backend</div>
    <div>service · <b>pios-mobile-backend</b></div>
    <div>version · <b>0.1.0-m1</b></div>
    <div>host · <b>${hostLabel}</b> (port ${PORT})</div>
    <div>ts · <b>${ts}</b></div>
  </div>
</body>
</html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function handlePing(req, res) {
  jsonRes(res, 200, { ok: true, ts: Date.now(), service: 'pios-mobile-backend', version: '0.1.0-m1' });
}

function handleHello(req, res) {
  jsonRes(res, 200, { ok: true, message: 'Hello from PiOS mobile-backend', version: '0.1.0-m1' });
}

function handleRegisterPushToken(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch {
      return jsonRes(res, 400, { error: 'Invalid JSON' });
    }
    const { device_type, token: pushToken, device_id } = parsed;
    if (!device_type || !pushToken) {
      return jsonRes(res, 400, { error: 'device_type and token required' });
    }
    log('info', 'push token registered', { device_type, device_id });
    // M1: record received (M4 will wire to APNs/FCM sender)
    // Token storage in Pi/State/mobile-push-tokens.json deferred to M2
    jsonRes(res, 200, { ok: true });
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS — Tailscale internal network; permissive headers for dev convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (!checkAuth(req, res)) return;

  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (pathname === '/' && req.method === 'GET') return handleRoot(req, res);
  // /m/* — mobile chat routes (M2)
  if (pathname === '/m' || pathname === '/m/' || pathname.startsWith('/m/')) {
    const chat = getChatRoutes();
    if (chat) {
      const handled = chat.dispatch(req, res, { pathname });
      if (handled !== false) return;
    }
  }
  if (pathname === '/mobile/ping' && req.method === 'GET') return handlePing(req, res);
  if (pathname === '/mobile/hello' && req.method === 'GET') return handleHello(req, res);
  if (pathname === '/mobile/register-push-token' && req.method === 'POST') return handleRegisterPushToken(req, res);

  jsonRes(res, 404, { error: 'Not found', path: pathname });
});

if (require.main === module) {
  server.listen(PORT, () => log('info', `pios-mobile-backend listening on :${PORT}`));
}

module.exports = { server };
