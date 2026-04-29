/**
 * Afterward window manager — opens BrowserWindow + sets up IPC handlers.
 *
 * Integrates into PiOS main.js:
 *   const afterward = require('./modules/afterward/backend/afterward-window');
 *   afterward.registerHandlers(ipcMain);
 *   // Then: afterward.open() to show window
 */

const { BrowserWindow, ipcMain, systemPreferences, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// When running from asar, Python cannot read source files; resolve to .asar.unpacked
// (this path only exists if modules/afterward/** is in asarUnpack, see package.json build config)
const _rawModuleDir = path.join(__dirname, '..');
const MODULE_DIR = _rawModuleDir.includes('.asar' + path.sep)
  ? _rawModuleDir.replace('.asar' + path.sep, '.asar.unpacked' + path.sep)
  : _rawModuleDir;
const PYTHON = process.env.AFTERWARD_PYTHON || 'python3';

// === window ===

let win = null;
// Password clearer — injected by registerHandlers so window close can zero sessionPassword.
let _clearSessionPassword = () => {};

function open(opts = {}) {
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 1024,
    height: 720,
    title: 'Afterward',
    backgroundColor: '#0a0d12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(MODULE_DIR, 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(MODULE_DIR, 'renderer', 'afterward.html'));
  // Security: clear session password in main process memory when window closes.
  // (Auto-lock on UI side also calls lock() which triggers same clear.)
  win.on('closed', () => {
    _clearSessionPassword();
    win = null;
  });
  return win;
}

// === Python core invocation ===

function runPython(args, stdin = '') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONPATH: MODULE_DIR };
    const proc = spawn(PYTHON, args, { cwd: MODULE_DIR, env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Python exited ${code}: ${stderr || stdout}`));
    });
    proc.on('error', reject);
    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

// === IPC handlers ===

function registerHandlers(baseDir) {
  // Resolve base dir (where state/audit/vault live for this user)
  const BASE = baseDir || path.join(require('os').homedir(), '.afterward');
  if (!fs.existsSync(BASE)) fs.mkdirSync(BASE, { recursive: true });

  // Session password — held in main process memory after unlock.
  // Cleared on: window close / explicit lock / auto-lock / onboarding-finish.
  let sessionPassword = null;

  // Pi access tokens — time-limited, scoped tokens for external callers (Pi/Claude Code/etc.)
  // to read/write vault over HTTP without seeing the password.
  // Map<tokenString, { scope: 'read'|'read_write', paths: string[]|null, expires_at: epoch_ms, issued_at, label }>
  const tokens = new Map();

  // Expose clearer to open() so window-close event can zero it + tokens
  _clearSessionPassword = () => {
    sessionPassword = null;
    tokens.clear();  // tokens are only valid while unlocked
  };

  // Purge expired tokens (called on each request to keep map bounded)
  function purgeExpiredTokens() {
    const now = Date.now();
    for (const [tk, info] of tokens.entries()) {
      if (info.expires_at < now) tokens.delete(tk);
    }
  }

  // Helper: Python vault op with password via stdin (NOT env var — avoid process env leak)
  // Protocol: stdin line 1 = password (\n terminated), rest = content for encrypt; argv[1] = file path
  async function pythonDecryptFile(filePath, password) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PYTHONPATH: MODULE_DIR };
      const proc = spawn(PYTHON, ['-c', `
import sys
from core.vault import decrypt_file
try:
    password = sys.stdin.buffer.readline().rstrip(b'\\n').decode('utf-8')
    plain = decrypt_file(sys.argv[1], password)
    sys.stdout.buffer.write(plain)
    sys.exit(0)
except Exception as e:
    print(f"ERR: {e}", file=sys.stderr)
    sys.exit(1)
`, filePath], { cwd: MODULE_DIR, env });
      let out = Buffer.alloc(0), err = '';
      proc.stdout.on('data', d => out = Buffer.concat([out, d]));
      proc.stderr.on('data', d => err += d);
      proc.on('close', code => {
        if (code === 0) resolve(out.toString('utf-8'));
        else reject(new Error(err.trim() || 'decrypt failed'));
      });
      proc.on('error', reject);
      proc.stdin.write(password + '\n');
      proc.stdin.end();
    });
  }

  async function pythonEncryptFile(targetPath, content, password) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PYTHONPATH: MODULE_DIR };
      const proc = spawn(PYTHON, ['-c', `
import sys
from pathlib import Path
from core.vault import encrypt
password = sys.stdin.buffer.readline().rstrip(b'\\n').decode('utf-8')
plain = sys.stdin.buffer.read()
Path(sys.argv[1]).parent.mkdir(parents=True, exist_ok=True)
Path(sys.argv[1]).write_bytes(encrypt(plain, password))
print('OK')
`, targetPath], { cwd: MODULE_DIR, env });
      let out = '', err = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => err += d);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(err.trim() || 'encrypt failed'));
      });
      proc.on('error', reject);
      proc.stdin.write(password + '\n');
      proc.stdin.write(content);
      proc.stdin.end();
    });
  }

  // Get heartbeat status
  ipcMain.handle('afterward:status', async () => {
    const stateFile = path.join(BASE, 'heartbeat-state.json');
    if (!fs.existsSync(stateFile)) {
      return { state: 'NOT_INITIALIZED', detail: 'Run onboarding first.' };
    }
    const { stdout } = await runPython([
      '-m', 'core.heartbeat', '-f', stateFile, 'status'
    ]);
    return JSON.parse(stdout);
  });

  // Verify password by attempting to decrypt unlock-check.txt.enc
  // On success, store password in main process memory for the session.
  ipcMain.handle('afterward:unlock', async (_evt, { password }) => {
    const checkFile = path.join(BASE, 'vault', 'unlock-check.txt.enc');
    if (!fs.existsSync(checkFile)) {
      return { ok: false, error: 'Vault not initialized (no unlock-check file)' };
    }
    try {
      const plain = await pythonDecryptFile(checkFile, password);
      if (!plain.startsWith('AFTERWARD_UNLOCK_OK')) {
        return { ok: false, error: 'Unlock marker invalid (corrupted vault?)' };
      }
      sessionPassword = password;  // store in main process memory
      return { ok: true, marker: plain.trim() };
    } catch (e) {
      return { ok: false, error: 'Wrong password or corrupted vault' };
    }
  });

  // Explicit lock: clear session password
  ipcMain.handle('afterward:lock', async () => {
    sessionPassword = null;
    return { ok: true };
  });

  // === Touch ID / biometric quick unlock ===
  // Flow:
  //   1. User unlocks normally (password). sessionPassword set.
  //   2. User clicks "Enable Touch ID" — we encrypt sessionPassword with Electron
  //      safeStorage (OS keychain-backed key) and write to ~/.afterward/touchid.bin.
  //   3. On lock screen, if touchid.bin exists AND canPromptTouchID() true,
  //      show Touch ID button. Click → promptTouchID → decrypt → unlock.

  const TOUCHID_FILE = path.join(BASE, 'touchid.bin');

  ipcMain.handle('afterward:touchid-available', async () => {
    const canPrompt = (typeof systemPreferences.canPromptTouchID === 'function')
      ? systemPreferences.canPromptTouchID() : false;
    const safeStorageReady = safeStorage.isEncryptionAvailable();
    return {
      available: canPrompt && safeStorageReady,
      enabled: fs.existsSync(TOUCHID_FILE),
    };
  });

  ipcMain.handle('afterward:touchid-enable', async () => {
    if (!sessionPassword) return { ok: false, error: 'LOCKED' };
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'safeStorage not available on this system' };
    }
    try {
      // Confirm user intent with Touch ID gate before persisting
      try {
        await systemPreferences.promptTouchID('启用 Touch ID 快速解锁 Afterward');
      } catch (e) {
        return { ok: false, error: `Touch ID 验证被取消: ${e.message}` };
      }
      const encrypted = safeStorage.encryptString(sessionPassword);
      fs.writeFileSync(TOUCHID_FILE, encrypted);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('afterward:touchid-disable', async () => {
    try {
      if (fs.existsSync(TOUCHID_FILE)) fs.unlinkSync(TOUCHID_FILE);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // === Pi access tokens (for external HTTP callers: Claude Code, curl, etc.) ===

  const crypto = require('crypto');

  ipcMain.handle('afterward:authorize-pi', async (_evt, opts = {}) => {
    if (!sessionPassword) return { ok: false, error: 'LOCKED — unlock first' };
    const scope = opts.scope === 'read_write' ? 'read_write' : 'read';
    const ttlSec = Math.max(60, Math.min(24 * 3600, Number(opts.ttl_seconds) || 1800));
    const paths = Array.isArray(opts.paths) && opts.paths.length ? opts.paths : null;
    const label = (opts.label || '').toString().slice(0, 80) || 'Pi session';
    const token = crypto.randomBytes(24).toString('base64url');  // 32 chars URL-safe
    const now = Date.now();
    tokens.set(token, {
      scope,
      paths,
      expires_at: now + ttlSec * 1000,
      issued_at: now,
      label,
      accessed: false,  // flipped true when /read decrypts anything; /selfdestruct keys off this
      // Set of Claude session_ids that called /read with this token.
      // /selfdestruct ONLY purges JSONL files for these exact session_ids (by basename match).
      // NEVER scan-and-delete the whole projects/ dir — 2026-04-21 taught us that with
      // `find -newermt` kills unrelated Claude sessions in the same vault (e.g. owner's
      // "C4 profile cognition" session was nuked by a sibling cleanup). Precise scope only.
      accessed_sessions: new Set(),
    });
    return {
      ok: true,
      token,
      expires_at: new Date(now + ttlSec * 1000).toISOString(),
      scope,
      paths,
      label,
    };
  });

  ipcMain.handle('afterward:list-tokens', async () => {
    purgeExpiredTokens();
    const list = [];
    for (const [tk, info] of tokens.entries()) {
      list.push({
        token_prefix: tk.slice(0, 8) + '…',
        scope: info.scope,
        paths: info.paths,
        label: info.label,
        issued_at: new Date(info.issued_at).toISOString(),
        expires_at: new Date(info.expires_at).toISOString(),
        expires_in_sec: Math.max(0, Math.floor((info.expires_at - Date.now()) / 1000)),
        _full_token_for_revoke: tk,  // UI uses this for revoke; not shown by default
      });
    }
    list.sort((a, b) => b.issued_at.localeCompare(a.issued_at));
    return { ok: true, tokens: list };
  });

  ipcMain.handle('afterward:revoke-token', async (_evt, { token }) => {
    const existed = tokens.delete(token);
    return { ok: existed };
  });

  // === HTTP API request handler (called by PiOS main.js http server) ===
  // Returns true if handled, false if path not ours.

  async function handleApiRequest(req, res, endpoint, url) {
    if (!endpoint.startsWith('/afterward/api/')) return false;

    const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
    const send = (status, obj, extraHeaders = {}) => {
      res.writeHead(status, { ...jsonHeaders, ...extraHeaders });
      res.end(JSON.stringify(obj, null, 2));
    };

    // All API endpoints require valid token
    const tokenHeader = req.headers['x-afterward-token'] || url.searchParams.get('token');
    const tokenInfo = tokenHeader ? tokens.get(tokenHeader) : null;

    const op = endpoint.replace('/afterward/api/', '');

    if (op === 'whoami') {
      // Token introspection (safe info only)
      if (!tokenInfo) { send(401, { error: 'missing or invalid token' }); return true; }
      if (tokenInfo.expires_at < Date.now()) { tokens.delete(tokenHeader); send(401, { error: 'token expired' }); return true; }
      send(200, {
        scope: tokenInfo.scope,
        paths: tokenInfo.paths,
        label: tokenInfo.label,
        expires_at: new Date(tokenInfo.expires_at).toISOString(),
        expires_in_sec: Math.max(0, Math.floor((tokenInfo.expires_at - Date.now()) / 1000)),
        accessed: !!tokenInfo.accessed,  // true if /read was called — /selfdestruct will require cleanup
      });
      return true;
    }

    // Validate token for all other ops
    if (!tokenInfo) { send(401, { error: 'missing or invalid token (use X-Afterward-Token header)' }); return true; }
    if (tokenInfo.expires_at < Date.now()) { tokens.delete(tokenHeader); send(401, { error: 'token expired' }); return true; }

    // /selfdestruct handled BEFORE the sessionPassword gate — you should be able to self-destruct
    // even if the vault was re-locked mid-session.
    //
    // BLOOD LESSON 2026-04-21 — never returning bash steps to Claude again:
    //   The old design returned `find "${jsonlDir}" -newermt "${issued}" -delete` as a step for
    //   Claude to execute. That command scans the ENTIRE vault's projects/ directory, which is
    //   shared by every Claude session that ever used this vault. It killed owner's unrelated
    //   "C4 profile cognition" session. Current design:
    //     1. Claude MUST pass X-Claude-Session-Id header on every /read. We record those sids.
    //     2. /selfdestruct runs the purge SERVER-SIDE in a background 60s loop (fire-and-forget).
    //     3. The loop ONLY unlinks `{sid}.jsonl` files for sids that called /read. Never a
    //        directory scan. Never `-newermt`. Never a time window.
    //     4. DB cleanup uses `WHERE session_id IN (...)` with the same sid list — no time window.
    //     5. osascript quit Claude happens once on the first tick; loop sweeps every 3s for 60s
    //        so if quit is slow and Claude keeps appending JSONL, we catch it on the next sweep.
    if (op === 'selfdestruct' && req.method === 'GET') {
      const os = require('os');
      const { execFile } = require('child_process');
      const vaultPath = process.env.PIOS_VAULT || path.join(os.homedir(), 'PiOS');
      const encodedVault = vaultPath.replace(/[/\\]/g, '-').replace(/^-/, '');
      const jsonlDir = path.join(os.homedir(), '.claude', 'projects', encodedVault);
      const issuedIso = new Date(tokenInfo.issued_at).toISOString();
      const sessionIndexDb = path.join(os.homedir(), 'PiOS', 'Pi', 'Log', 'session-index.db');
      const notifyScript = path.join(os.homedir(), 'PiOS', 'Pi', 'Tools', 'notify.sh');
      const wasAccessed = !!tokenInfo.accessed;
      const accessedSids = Array.from(tokenInfo.accessed_sessions || []);
      // Immediately revoke this token so no further reads can be issued through it.
      tokens.delete(tokenHeader);

      if (wasAccessed && accessedSids.length > 0) {
        // Sanity filter: sids come from X-Claude-Session-Id header which we already regex-checked
        // on /read, but re-verify here since `fs.unlinkSync(path.join(dir, ${sid}.jsonl))` would
        // follow `..` segments if they somehow snuck in.
        const safeSids = accessedSids.filter(s => /^[0-9a-fA-F-]{16,64}$/.test(s));
        const DURATION_MS = 60 * 1000;
        const INTERVAL_MS = 3 * 1000;
        const startedMs = Date.now();

        const sweepOnce = () => {
          // 1. Unlink the exact JSONL files by basename. Never scan-and-match.
          for (const sid of safeSids) {
            const jsonlPath = path.join(jsonlDir, `${sid}.jsonl`);
            try { fs.unlinkSync(jsonlPath); } catch (_) { /* ENOENT = already gone, fine */ }
          }
          // 2. DB scrub. Idempotent. No time window — only the registered sids.
          try {
            const placeholders = safeSids.map(s => `'${s}'`).join(',');
            execFile('sqlite3', [
              sessionIndexDb,
              `DELETE FROM messages WHERE session_id IN (${placeholders}); DELETE FROM sessions WHERE session_id IN (${placeholders});`,
            ], () => {});
          } catch (_) {}
        };

        // First tick: notify + quit Claude + first sweep. Even if quit is denied/delayed, the
        // background timer keeps sweeping for 60s total.
        try {
          execFile(notifyScript, [
            'critical',
            `Afterward vault 访问结束，Pi 正在后台精确清理 ${safeSids.length} 个 Claude 会话的 JSONL（60s 循环）。请稍候再重开 Claude。`,
          ], () => {});
        } catch (_) {}
        try { execFile('osascript', ['-e', 'tell application "Claude" to quit'], () => {}); } catch (_) {}
        sweepOnce();

        const timer = setInterval(() => {
          sweepOnce();
          if (Date.now() - startedMs >= DURATION_MS) clearInterval(timer);
        }, INTERVAL_MS);
      }

      send(200, {
        accessed: wasAccessed,
        token_revoked: true,
        issued_at: issuedIso,
        purge: wasAccessed
          ? (accessedSids.length > 0
              ? {
                  mode: 'server_side_loop',
                  target_session_ids: accessedSids,
                  duration_ms: 60 * 1000,
                  interval_ms: 3 * 1000,
                  notice: [
                    'Server-side purge loop running in the background. It will sweep every 3s for 60s,',
                    'unlinking ONLY the listed session_ids JSONL files (by exact basename match) and',
                    'deleting their DB rows. Claude Code has been asked to quit via osascript.',
                    'DO NOT run any bash yourself. In particular, NEVER run',
                    '`find ~/.claude/projects/-Users-<you>-<vault> -newermt ...` — a global sweep',
                    'will delete OTHER Claude sessions in the same vault. Past incident:',
                    'a separate research session was killed this way. Just let this session end.',
                  ].join(' '),
                }
              : {
                  mode: 'none_registered',
                  notice: 'accessed=true but no session_ids were registered (older clients?). No automatic cleanup will run. Do NOT fall back to a global directory sweep — it kills unrelated Claude sessions. Either upgrade the client to send X-Claude-Session-Id, or manually locate and unlink the specific {sid}.jsonl files.',
                })
          : {
              mode: 'not_needed',
              notice: 'No /read was called with this token — no plaintext entered any session. No cleanup needed.',
            },
      });
      return true;
    }

    if (!sessionPassword) { send(423, { error: 'vault is locked — token is valid but cannot decrypt' }); return true; }

    const checkPath = (p) => {
      if (tokenInfo.paths && !tokenInfo.paths.includes(p)) {
        send(403, { error: `token not authorized for path ${p}`, allowed: tokenInfo.paths });
        return false;
      }
      return true;
    };

    if (op === 'list' && req.method === 'GET') {
      const vaultDir = path.join(BASE, 'vault');
      const items = [];
      function walk(dir, prefix) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
          else if (entry.name.endsWith('.enc')) {
            if (tokenInfo.paths && !tokenInfo.paths.includes(rel)) continue;
            const stat = fs.statSync(path.join(dir, entry.name));
            items.push({ path: rel, size: stat.size, mtime: stat.mtime.toISOString() });
          }
        }
      }
      walk(vaultDir, '');
      send(200, { items });
      return true;
    }

    if (op === 'read' && req.method === 'GET') {
      const relPath = url.searchParams.get('path');
      if (!relPath) { send(400, { error: 'missing ?path=' }); return true; }
      if (!checkPath(relPath)) return true;

      // REQUIRED: X-Claude-Session-Id. /selfdestruct scopes cleanup to exactly these session_ids
      // by basename (e.g. {sid}.jsonl). Without it we cannot safely purge — and we refuse to fall
      // back to a global `find -newermt` sweep (which killed owner's "C4 profile cognition" session
      // on 2026-04-21). If Claude doesn't know its own session_id, it must fix that before reading
      // plaintext — silent global cleanup is NOT an option.
      const claudeSid = (req.headers['x-claude-session-id'] || '').toString().trim();
      const VALID_SID = /^[0-9a-fA-F-]{16,64}$/;
      if (!claudeSid || !VALID_SID.test(claudeSid)) {
        send(400, {
          error: 'missing or malformed X-Claude-Session-Id header',
          explanation: 'Required so /selfdestruct can purge only YOUR session JSONL. The server refuses to fall back to a global directory sweep (which would delete other unrelated Claude sessions in the same vault). Pass your Claude Code session_id as header X-Claude-Session-Id. If sub-agent: pass the sub-agent session_id, NOT the parent.',
        });
        return true;
      }

      const fullPath = path.join(BASE, 'vault', relPath);
      const vaultRoot = path.resolve(path.join(BASE, 'vault'));
      if (!path.resolve(fullPath).startsWith(vaultRoot)) { send(400, { error: 'path traversal' }); return true; }
      if (!fs.existsSync(fullPath)) { send(404, { error: 'file not found' }); return true; }
      try {
        const plain = await pythonDecryptFile(fullPath, sessionPassword);
        tokenInfo.accessed = true;
        tokenInfo.accessed_sessions.add(claudeSid);  // precise scope for /selfdestruct
        send(200, {
          path: relPath,
          content: plain,
          session_id_registered: claudeSid,
          _notice: `Decrypted vault plaintext. Session_id "${claudeSid}" has been registered — /selfdestruct will purge ONLY this session's JSONL (and any sub-agent session_ids that also call /read with their own header). The server will run its own 60s background purge loop; you do NOT need to run any bash yourself.`,
        }, { 'X-Afterward-Sensitive': 'true' });
      } catch (e) {
        send(500, { error: e.message });
      }
      return true;
    }

    if (op === 'write' && req.method === 'POST') {
      if (tokenInfo.scope !== 'read_write') { send(403, { error: 'token is read-only' }); return true; }
      let body = '';
      for await (const chunk of req) body += chunk;
      let data;
      try { data = JSON.parse(body); } catch { send(400, { error: 'body must be JSON' }); return true; }
      const relPath = data.path;
      const content = data.content;
      if (!relPath || content === undefined) { send(400, { error: 'need {path, content}' }); return true; }
      if (!relPath.endsWith('.enc')) { send(400, { error: 'path must end in .enc' }); return true; }
      if (!checkPath(relPath)) return true;
      const fullPath = path.join(BASE, 'vault', relPath);
      const vaultRoot = path.resolve(path.join(BASE, 'vault'));
      if (!path.resolve(fullPath).startsWith(vaultRoot)) { send(400, { error: 'path traversal' }); return true; }
      try {
        await pythonEncryptFile(fullPath, content, sessionPassword);
        send(200, { ok: true, path: relPath, size: content.length });
      } catch (e) {
        send(500, { error: e.message });
      }
      return true;
    }

    send(404, { error: `unknown afterward api op: ${op}` });
    return true;
  }

  // Expose for main.js integration
  module.exports.handleApiRequest = handleApiRequest;

  ipcMain.handle('afterward:touchid-unlock', async () => {
    if (!fs.existsSync(TOUCHID_FILE)) {
      return { ok: false, error: 'Touch ID 未启用' };
    }
    if (!systemPreferences.canPromptTouchID || !systemPreferences.canPromptTouchID()) {
      return { ok: false, error: 'Touch ID 不可用' };
    }
    try {
      // Prompt user fingerprint
      await systemPreferences.promptTouchID('解锁 Afterward');
    } catch (e) {
      return { ok: false, error: `Touch ID: ${e.message}` };
    }
    try {
      const encrypted = fs.readFileSync(TOUCHID_FILE);
      const password = safeStorage.decryptString(encrypted);
      // Verify still works against unlock-check (user may have changed password)
      const checkFile = path.join(BASE, 'vault', 'unlock-check.txt.enc');
      try {
        const plain = await pythonDecryptFile(checkFile, password);
        if (!plain.startsWith('AFTERWARD_UNLOCK_OK')) throw new Error('marker mismatch');
      } catch (e) {
        // Stored password no longer valid (user changed it?); invalidate Touch ID
        try { fs.unlinkSync(TOUCHID_FILE); } catch {}
        return { ok: false, error: 'Touch ID 密码已过期（主密码变过？），请用密码解锁后重启用 Touch ID' };
      }
      sessionPassword = password;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Vault read: requires unlocked session
  ipcMain.handle('afterward:vault-read', async (_evt, { relPath }) => {
    if (!sessionPassword) return { ok: false, error: 'LOCKED' };
    const fullPath = path.join(BASE, 'vault', relPath);
    if (!fs.existsSync(fullPath)) return { ok: false, error: 'File not found' };
    try {
      const plain = await pythonDecryptFile(fullPath, sessionPassword);
      return { ok: true, content: plain, relPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Change master password: re-encrypt all vault files + regenerate Shamir shares.
  // Returns new shares for re-distribution.
  ipcMain.handle('afterward:change-password', async (_evt, { oldPassword, newPassword }) => {
    if (!oldPassword || !newPassword) {
      return { ok: false, error: '旧密码和新密码都必填' };
    }
    return new Promise((resolve) => {
      const env = { ...process.env, PYTHONPATH: MODULE_DIR };
      const proc = spawn(
        PYTHON,
        ['-m', 'core.change_password', '--base-dir', BASE],
        { cwd: MODULE_DIR, env },
      );
      proc.stdin.write(JSON.stringify({ old: oldPassword, new: newPassword }));
      proc.stdin.end();
      let out = '', err = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => err += d);
      proc.on('close', code => {
        if (code !== 0) {
          try {
            const errObj = JSON.parse(out);
            resolve({ ok: false, error: errObj.error || err.trim() });
          } catch {
            resolve({ ok: false, error: (err || out).toString().trim() });
          }
          return;
        }
        try {
          const result = JSON.parse(out);
          if (result.ok) {
            // Update main-process sessionPassword to new one (user is currently unlocked)
            sessionPassword = newPassword;
          }
          resolve(result);
        } catch (e) {
          resolve({ ok: false, error: `Parse error: ${e.message}` });
        }
      });
      proc.on('error', e => resolve({ ok: false, error: e.message }));
    });
  });

  // Read trustees metadata (from trustees-meta.json; non-secret, safe to read without unlock)
  ipcMain.handle('afterward:trustees-read', async () => {
    const metaFile = path.join(BASE, 'trustees-meta.json');
    if (!fs.existsSync(metaFile)) return { ok: false, error: 'No trustees metadata (complete onboarding first)' };
    try {
      return { ok: true, trustees: JSON.parse(fs.readFileSync(metaFile, 'utf-8')) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Read audit log (newest first; limit results)
  ipcMain.handle('afterward:audit-read', async (_evt, { limit = 100 } = {}) => {
    const auditFile = path.join(BASE, 'audit.log.jsonl');
    if (!fs.existsSync(auditFile)) return { ok: true, events: [] };
    try {
      const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n').filter(Boolean);
      const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; }}).filter(Boolean);
      return { ok: true, events: events.reverse().slice(0, limit), total: events.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Decrypt + parse instructions.yaml — returns {actions, missions}
  ipcMain.handle('afterward:instructions-read', async () => {
    if (!sessionPassword) return { ok: false, error: 'LOCKED' };
    const instFile = path.join(BASE, 'vault', 'instructions.yaml.enc');
    if (!fs.existsSync(instFile)) return { ok: false, error: 'instructions.yaml.enc missing' };
    try {
      const plain = await pythonDecryptFile(instFile, sessionPassword);
      return { ok: true, yaml: plain };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('afterward:instructions-write', async (_evt, { yaml: yamlText }) => {
    if (!sessionPassword) return { ok: false, error: 'LOCKED' };
    const instFile = path.join(BASE, 'vault', 'instructions.yaml.enc');
    try {
      await pythonEncryptFile(instFile, yamlText, sessionPassword);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Run drill: spawn separate process with isolated base dir + time compression
  ipcMain.handle('afterward:drill-run', async () => {
    const drillBase = path.join(require('os').tmpdir(), `afterward-drill-${Date.now()}`);
    try {
      const env = {
        ...process.env,
        PYTHONPATH: MODULE_DIR,
        AFTERWARD_TIME_COMPRESSION: '8640000',  // 1s = 100 virtual days
      };
      // Inline drill script
      const drillScript = `
import os, sys, json, shutil, time
from pathlib import Path
sys.path.insert(0, '${MODULE_DIR}')

BASE = Path('${drillBase}')
if BASE.exists(): shutil.rmtree(BASE)
BASE.mkdir(parents=True)

from core.daemon import AfterwardDaemon, DaemonConfig
from core.heartbeat import STATE_ALIVE, STATE_SOFT, STATE_DEATH
from core.shamir import split as shamir_split
from core.vault import encrypt as vault_encrypt
import yaml

MASTER = 'drill-test-password-xyz'
inst = {'version': 1, 'actions': [], 'missions': []}
vault_dir = BASE / 'vault'; vault_dir.mkdir(parents=True)
(vault_dir / 'instructions.yaml.enc').write_bytes(vault_encrypt(yaml.safe_dump(inst).encode(), MASTER))
(vault_dir / 'contacts.yaml.enc').write_bytes(vault_encrypt(b'{}', MASTER))
shares = shamir_split(MASTER, 3, 5)

config = DaemonConfig(base_dir=BASE, vault_dir=vault_dir)
daemon = AfterwardDaemon(config)
events = [('start', {'state': daemon.heartbeat.state})]
print(json.dumps(events[-1]), flush=True)

time.sleep(0.7)
daemon.run_once()
events.append(('after_silence', {'state': daemon.heartbeat.state}))
print(json.dumps(events[-1]), flush=True)

inbox = BASE / 'trustee-inbox'
for i in [1,3,5]:
    (inbox / f'sub-{i}.json').write_text(json.dumps({'trustee_idx': i, 'share': shares[i-1][1], 'evidence_ref': f'drill-evidence-{i}'}))
daemon.run_once()
events.append(('trustees_submitted', {'count': len(daemon.heartbeat.data.trustee_confirmations)}))
print(json.dumps(events[-1]), flush=True)

time.sleep(1.0)
daemon.run_once()
events.append(('final', {'state': daemon.heartbeat.state}))
print(json.dumps(events[-1]), flush=True)

ok = daemon.heartbeat.state == STATE_DEATH
print(json.dumps({'drill_complete': True, 'passed': ok, 'final_state': daemon.heartbeat.state}), flush=True)
shutil.rmtree(BASE, ignore_errors=True)
`;
      const proc = spawn(PYTHON, ['-c', drillScript], { cwd: MODULE_DIR, env });
      let events = [];
      let stderr = '';
      proc.stdout.on('data', d => {
        for (const line of d.toString().trim().split('\n')) {
          try { events.push(JSON.parse(line)); } catch {}
        }
      });
      proc.stderr.on('data', d => stderr += d);
      const code = await new Promise(r => proc.on('close', r));
      return { ok: code === 0, events, stderr: stderr.trim() || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Vault write: requires unlocked session; encrypts + writes atomically
  ipcMain.handle('afterward:vault-write', async (_evt, { relPath, content }) => {
    if (!sessionPassword) return { ok: false, error: 'LOCKED' };
    if (!relPath || !relPath.endsWith('.enc')) {
      return { ok: false, error: 'Path must end in .enc' };
    }
    // Prevent path traversal
    const fullPath = path.join(BASE, 'vault', relPath);
    const vaultRoot = path.join(BASE, 'vault');
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(vaultRoot))) {
      return { ok: false, error: 'Path outside vault' };
    }
    try {
      await pythonEncryptFile(resolved, content, sessionPassword);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Record a passive heartbeat (called when UI opens — implies user is alive)
  ipcMain.handle('afterward:passive-heartbeat', async () => {
    const stateFile = path.join(BASE, 'heartbeat-state.json');
    await runPython(['-m', 'core.heartbeat', '-f', stateFile, 'passive']);
    return { ok: true };
  });

  // Record a challenge pass (after successful password unlock)
  ipcMain.handle('afterward:challenge-pass', async () => {
    const stateFile = path.join(BASE, 'heartbeat-state.json');
    await runPython(['-m', 'core.heartbeat', '-f', stateFile, 'challenge']);
    return { ok: true };
  });

  // Run check_state
  ipcMain.handle('afterward:check-state', async () => {
    const stateFile = path.join(BASE, 'heartbeat-state.json');
    const { stdout } = await runPython(['-m', 'core.heartbeat', '-f', stateFile, 'check']);
    return JSON.parse(stdout.split('\n').slice(1).join('\n'));  // skip first line "Current state: X"
  });

  // Check if vault is initialized
  ipcMain.handle('afterward:is-initialized', async () => {
    const unlockCheck = path.join(BASE, 'vault', 'unlock-check.txt.enc');
    return { initialized: fs.existsSync(unlockCheck) };
  });

  // Onboard: initialize vault with password + trustees
  ipcMain.handle('afterward:onboard', async (_evt, { password, trustees }) => {
    try {
      const env = { ...process.env, PYTHONPATH: MODULE_DIR };
      const proc = spawn(
        PYTHON,
        ['-m', 'core.onboard', '--base-dir', BASE],
        { cwd: MODULE_DIR, env },
      );
      proc.stdin.write(JSON.stringify({ password, trustees }));
      proc.stdin.end();
      let out = '', err = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => err += d);
      const code = await new Promise(r => proc.on('close', r));
      if (code !== 0) {
        return { ok: false, error: (err || out).toString().trim() };
      }
      try {
        return { ok: true, ...JSON.parse(out.toString()) };
      } catch (parseErr) {
        return { ok: false, error: `Parse error: ${parseErr.message}. Raw: ${out}` };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // List vault files
  ipcMain.handle('afterward:vault-list', async () => {
    const vaultDir = path.join(BASE, 'vault');
    if (!fs.existsSync(vaultDir)) return [];
    const walk = (dir, prefix = '') => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
          out.push(...walk(path.join(dir, entry.name), rel));
        } else if (entry.name.endsWith('.enc')) {
          const stat = fs.statSync(path.join(dir, entry.name));
          out.push({ path: rel, size: stat.size, mtime: stat.mtime });
        }
      }
      return out;
    };
    return walk(vaultDir);
  });

  return { BASE };
}

module.exports = { open, registerHandlers, runPython, handleApiRequest: null };
// handleApiRequest is populated after registerHandlers() is called — see there.
