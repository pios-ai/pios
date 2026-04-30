"use strict";
const path = require("path");
const fs = require("fs");
const authApi = require("./browser-control-api-auth");

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

    if (endpoint === '/home') {
      // Prefer vault copy (live-editable) over bundled copy.
      // bundle 上 pios-home.html 在 repo root（即 __dirname/.. 因为本文件在 main/ 子目录）
      const vaultHome = path.join(VAULT_ROOT, 'Projects', 'pios', 'pios-home.html');
      const bundledHome = path.join(__dirname, '..', 'pios-home.html');
      const homePath = fs.existsSync(vaultHome) ? vaultHome : bundledHome;
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
      // 同 /home 路径修正：vendor/ 在 repo root，不是 main/ 子目录
      const bundledVendor = path.join(__dirname, '..', 'vendor', rel);
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
        try { return (require('../backend/host-helper').loadConfig().host_map) || {}; }
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
        try { return (require('../backend/host-helper').loadConfig().host_map) || {}; }
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
    // ── GET: Auth endpoints → browser-control-api-auth.js ──
    if (authApi.handleGet(endpoint, url, s, res, jsonHeaders)) return;
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

}
module.exports = { tryHandle };
