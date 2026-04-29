'use strict';
const path = require('path');
const fs = require('fs');

/**
 * Browser Control HTTP API — extracted from main.js
 *
 * Call create(s) once at startup. The server starts immediately and listens on 127.0.0.1:17891.
 *
 * @param {object} s — state object from main.js. Mutable scalars are accessed via getters;
 *   stable refs (functions, service objects, constants) may be plain properties.
 * @returns {http.Server}
 */
function create(s) {
  // Stable references — safe to destructure once (all initialized before create() is called)
  const {
    createTab, switchToTab, closeTab, sendNotification, switchToChatMode,
    forceRelayout, completeURL, deepMerge,
    loadSessions, saveSessions, findTaskRun, materializeTaskSessionFromRun,
    taskRunSessionId, tryCreateHomeTabs,
    _backupSessionJsonl, _compactSession, _fetchContextDetail, _restoreSessionFromBackup,
    getClaudeClient,
    pios, installer,
    _loginSessions, _compactInFlight,
    VAULT_ROOT, APP_VERSION,
  } = s;
  // sessionBus: accessed as s.sessionBus (initialized after create() at line ~6502 in main.js)

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
  if (endpoint.startsWith('/afterward/api/') && s.afterward && typeof s.afterward.handleApiRequest === 'function') {
    try {
      const handled = await s.afterward.handleApiRequest(req, res, endpoint, url);
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
      if (!s.sessionBus.getSession(sid)) {
        const engine = url.searchParams.get('engine') || 'run';
        try {
          s.sessionBus.registerSession(sid, engine, {
            origin: url.searchParams.get('origin') || 'task',
            taskId: url.searchParams.get('taskId') || null,
            runtime: url.searchParams.get('runtime') || 'claude-cli',
            runId: url.searchParams.get('runId') || null,
            host: url.searchParams.get('host') || null,
          });
          await s.sessionBus.attach(sid, {
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
      const unsub = s.sessionBus.subscribe(sid, (ev) => {
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
      const session = s._loginSessions.get(sessionId);
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
      s._loginSessions.set(sessionId, session);
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
    const session = s._loginSessions.get(sessionId);
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
      _atomicWrite(manifestPath, yaml.dump(merged, { lineWidth: 120, noRefs: true }));
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
    if ((runRecord.session_id || runRecord.status === 'running') && s.sessionBus.hasAdapter('run')) {
      try {
        const _jsonlSid = runRecord.session_id || null;
        s.sessionBus.registerSession(sessionId, 'run', {
          origin: 'task',
          taskId,
          runtime: runRecord.runtime,
          runId: runRecord.run_id,
          host: runRecord.host,
        });
        await s.sessionBus.attach(sessionId, {
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
    if (s.mainWindow && !s.mainWindow.isDestroyed()) {
      s.sidebarCollapsed = false;
      forceRelayout();
      s.mainWindow.webContents.send('session:open', sessionId, engine);
      if (!s.mainWindow.isVisible()) s.mainWindow.show();
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
    s.mainWindow.webContents.send('pios:talk', text);
    // P6 · 用户（Home Talk to Pi 或 HTTP 外部调用）等 Claude → thinking pose
    try { s.pulse && s.pulse.setThinking(true); } catch {}
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
    s.mainWindow.webContents.send('pios:call-pi', { text, title, engine });
    try { s.pulse && s.pulse.setThinking(true); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  try {
    // 选择目标 tab：优先 params.tab_id，其次 activeTab
    function pickTab() {
      if (params.tab_id != null) {
        const t = s.tabs.find(x => x.id === params.tab_id);
        return t || null;
      }
      return s.tabs.find(t => t.id === s.activeTabId) || null;
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
        const newTab = s.tabs.find(t => t.id === newId);
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
        s.mainWindow.show();
        s.mainWindow.focus();
        const text = params.text || '';
        if (text && s.mainWindow) {
          s.mainWindow.webContents.executeJavaScript(`window._quickSend && window._quickSend(${JSON.stringify(text)})`);
        }
        result = { ok: true };
        break;
      }
      case '/exec_js': {
        const target = params.target === 'main' ? s.mainWindow.webContents : wc;
        if (!target) { result = { error: 'no target' }; break; }
        const jsResult = await target.executeJavaScript(params.code);
        result = { result: String(jsResult).substring(0, 10000) };
        break;
      }
      case '/tabs': {
        result = { tabs: s.tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.id === s.activeTabId })) };
        break;
      }
      case '/switch_tab': {
        const target = s.tabs.find(t => t.id === params.id);
        if (target) { switchToTab(params.id); result = { result: 'ok', url: target.url }; }
        else { result = { error: `tab ${params.id} not found` }; }
        break;
      }
      case '/mute_tab': {
        const mtId = params.tab_id != null ? params.tab_id : (params.id != null ? params.id : s.activeTabId);
        const mt = s.tabs.find(t => t.id === mtId);
        if (!mt) { result = { error: `tab ${mtId} not found` }; break; }
        const muted = params.muted !== undefined ? !!params.muted : true;
        mt.view.webContents.audioMuted = muted;
        result = { result: 'ok', tab_id: mtId, muted };
        break;
      }
      case '/close_tab': {
        const id = params.tab_id != null ? params.tab_id : params.id;
        if (id == null) { result = { error: 'missing tab_id' }; break; }
        if (id === s.homeTabId) { result = { error: 'cannot close Home tab' }; break; }
        const existed = s.tabs.some(t => t.id === id);
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
  if (s._apiReady) return; // 防止重试时重复触发
  console.log('[browser-api] listening on 127.0.0.1:17891');
  s._apiReady = true;
  tryCreateHomeTabs();
});

  return httpServer;
}

module.exports = { create };
