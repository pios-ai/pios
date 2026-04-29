"use strict";
const path = require("path");
const fs = require("fs");

async function tryHandle(req, res, endpoint, ctx) {
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
        const profile = require('../backend/profile');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(profile.loadProfile()));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/profile/file') {
      try {
        const profile = require('../backend/profile');
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
        const sense = require('../backend/sense');
        const pios = require('../backend/pios-engine');
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
        const sense = require('../backend/sense');
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
        const pios = require('../backend/pios-engine');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(pios.getAgentLatestRuns()));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/token-stats') {
      // Overview 员工墙 + Pi 大秘卡用。{agentId: {today: N, avg7d: N}}
      try {
        const pios = require('../backend/pios-engine');
        res.writeHead(200, jsonHeaders); res.end(JSON.stringify(pios.getAgentTokenStats()));
      } catch (e) {
        res.writeHead(500, jsonHeaders); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (endpoint === '/pios/pi-overview') {
      // Home/Overview 的"Pi 大秘卡"数据源（当前戏服 + 当前节奏 + 正在做的卡 + 今日统计）
      try {
        const pios = require('../backend/pios-engine');
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
      // assets/ 在 repo root，本文件在 main/，所以加 ..
      const bundledSvg = path.join(__dirname, '..', 'assets', 'characters', fname);
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
      // renderer/ 在 repo root，本文件在 main/，所以 bundled 路径加 ..
      const candidates = [
        // npc-sprite pipeline 风格（pi / xiaojiang 等）
        path.join(VAULT_ROOT, 'Projects', 'pios', 'renderer', 'assets', skin, 'pi-idle.png'),
        path.join(__dirname, '..', 'renderer', 'assets', skin, 'pi-idle.png'),
        // 早期管线风格 <skin>-idle.png
        path.join(VAULT_ROOT, 'Projects', 'pios', 'renderer', 'assets', skin, `${skin}-idle.png`),
        path.join(__dirname, '..', 'renderer', 'assets', skin, `${skin}-idle.png`),
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
      // renderer/ 在 repo root，本文件在 main/，加 ..
      const piTabPath = require('fs').existsSync(vaultPiTab) ? vaultPiTab : require('path').join(__dirname, '..', 'renderer', 'pi-tab.html');
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
        const piTabIpc = require('../backend/pi-tab-ipc');
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
      if (s._compactInFlight.has(sid)) { res.writeHead(409, jsonHeaders); res.end(JSON.stringify({ ok: false, error: '该 session 正在压缩中' })); return; }
      s._compactInFlight.add(sid);
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
        s._compactInFlight.delete(sid);
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
        const scratch = require('../backend/scratch');
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
        const scratch = require('../backend/scratch');
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
        const scratch = require('../backend/scratch');
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
module.exports = { tryHandle };
