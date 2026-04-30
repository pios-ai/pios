"use strict";
const path = require("path");
const fs = require("fs");
const authApi = require("./browser-control-api-auth");

async function tryHandle(req, res, endpoint, params, ctx) {
  const {
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
  } = ctx;
  const url = new URL(req.url, "http://localhost");
  const jsonHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  if (endpoint === '/afterward/open') {
    try {
      s.afterward.open();
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
      const profile = require('../backend/profile');
      let out;
      if (endpoint === '/pios/profile/approve') out = profile.approveDiff(params.id);
      else if (endpoint === '/pios/profile/reject') out = profile.rejectDiff(params.id);
      else if (endpoint === '/pios/profile/approve-all') out = profile.approveAll();
      else if (endpoint === '/pios/profile/save') out = profile.saveProfile(params.name, params.content);
      else {
        // refresh-now: trigger profile-refresh task via existing task/run mechanism
        const pios = require('../backend/pios-engine');
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
      const sense = require('../backend/sense');
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

  // claude-cli cron token sidecar: paste once, write local + scp to openclaw_remote
  if (endpoint === '/pios/claude-cron-token') {
    try {
      const token = (params.token || '').trim();
      if (!/^sk-ant-oat\d{2}-[A-Za-z0-9_\-]+$/.test(token)) {
        res.writeHead(400, jsonHeaders);
        res.end(JSON.stringify({ error: 'token format invalid (expected sk-ant-oat01-...)' }));
        return;
      }
      const sidecarPath = path.join(require('os').homedir(), '.claude-code-cron-token');
      fs.writeFileSync(sidecarPath, token, { mode: 0o600 });
      try { fs.chmodSync(sidecarPath, 0o600); } catch {}
      const cfg = (() => { try { return installer.loadConfig(); } catch { return {}; } })();
      const remote = (cfg && typeof cfg.openclaw_remote === 'string' && cfg.openclaw_remote.trim()) ? cfg.openclaw_remote.trim() : null;
      let scpOk = null, scpError = null;
      if (remote) {
        try {
          require('child_process').execFileSync('scp', [
            '-q', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
            sidecarPath, `${remote}:~/.claude-code-cron-token`,
          ], { timeout: 15000 });
          try {
            require('child_process').execFileSync('ssh', [
              '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
              remote, 'chmod 600 ~/.claude-code-cron-token',
            ], { timeout: 10000 });
          } catch {}
          scpOk = true;
        } catch (e) {
          scpOk = false;
          scpError = (e && e.message) ? e.message.split('\n')[0].slice(0, 200) : String(e).slice(0, 200);
        }
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ ok: true, local: true, remote, scp_ok: scpOk, scp_error: scpError, prefix: token.slice(0, 18) + '...' }));
    } catch (e) {
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  // Scratch Pad POST endpoints
  if (endpoint === '/pios/scratch/create' || endpoint === '/pios/scratch/update' ||
      endpoint === '/pios/scratch/delete' || endpoint === '/pios/scratch/attach') {
    try {
      const scratch = require('../backend/scratch');
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
      if (s.mainWindow && !s.mainWindow.isDestroyed()) {
        s.mainWindow.webContents.send('sessions:refresh');
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
    if (!s.sessionBus.getSession(sid)) {
      res.writeHead(404, jsonHeaders);
      res.end(JSON.stringify({ error: 'session not registered; call GET /session/{id}/attach with query params first' }));
      return;
    }
    try {
      const r = await s.sessionBus.send(sid, text, params.opts || {});
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
      const ok = await s.sessionBus.interrupt(sid);
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
      _atomicWrite(target, content);
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
      _atomicWrite(target, content);
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
      // 原子写
      const yml = yaml.dump(doc, { lineWidth: 120, noRefs: true });
      _atomicWrite(charsPath, yml);
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

  // ── POST: Auth endpoints → browser-control-api-auth.js ──
}
module.exports = { tryHandle };
