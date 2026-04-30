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

  if (authApi.handlePost(endpoint, params, s, res, jsonHeaders)) return;

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
        host: require('../backend/host-helper').resolveHost(),
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
}
module.exports = { tryHandle };
