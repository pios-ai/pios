'use strict';
// ── Session Manager — 多 session 管理、Task run 物化、Sessions IPC ──
// 提取自 main.js tick 6 (2026-04-29)。
// register(ipcMain, { getSessionBus, getClaudeClient }) 注册所有 sessions:* IPC。
// loadSessions / saveSessions / findTaskRun / materializeTaskSessionFromRun /
// taskRunSessionId / _flushSessionsToDisk 供 main.js 其余位置调用。

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const sessionMessages = require('../backend/session-messages');
sessionMessages.configure(app.getPath('userData'));

const VAULT_ROOT = require('../backend/vault-root');
const pios = require('../backend/pios-engine');

// ── sessions.json 路径 + 内存缓存 ──────────────────────────────────────
const sessionsFile = path.join(app.getPath('userData'), 'sessions.json');

let _sessionsCache = null;
let _sessionsCacheMtime = 0;
// 每个 session 上次落盘的 messages.length。length 变化视作需要重写 JSONL；
// 同长不同内容（罕见 in-place 编辑）下次 loadSessions 的时候会从 JSONL 读回覆盖。
const _messagesLenOnDisk = new Map();

function _rehydrateMessages(data) {
  // 首次进入拆分后的状态：sessions.json 没有 messages → 从 JSONL 读回 in-memory。
  // 兼容旧格式：如果 session 自带 inline messages（未迁移），保留它，此次 flush 会
  // 触发拆分写 JSONL。
  if (!data || !Array.isArray(data.sessions)) return data;
  for (const s of data.sessions) {
    if (!s || !s.id) continue;
    if (Array.isArray(s.messages) && s.messages.length > 0) continue; // inline 存在，等待迁移
    const msgs = sessionMessages.loadMessages(s.id);
    s.messages = msgs;
    // 认可当前 JSONL 长度，避免 _doFlush 把刚读回的每个 session 无差别重写一次
    _messagesLenOnDisk.set(s.id, msgs.length);
  }
  return data;
}

function loadSessions() {
  if (_sessionsCache) {
    try {
      const mtime = fs.statSync(sessionsFile).mtimeMs;
      if (mtime <= _sessionsCacheMtime) return _sessionsCache;
    } catch {}
  }
  try {
    _sessionsCache = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    try { _sessionsCacheMtime = fs.statSync(sessionsFile).mtimeMs; } catch {}
  } catch {
    _sessionsCache = { sessions: [], activeId: null };
  }
  _rehydrateMessages(_sessionsCache);
  return _sessionsCache;
}

const MAIN_SESSION_ID = 'pi-main';

// 刀 2 step 5: `getRecentProactiveContext` 已搬到 backend/context-injector.js
// 的 _buildProactiveContext source。main.js 三处调用已改走
// `contextInjector.buildContext(MAIN_SESSION_ID, { sources: ['proactive'] })`。

// sessions.json 写入：延迟批量写盘 + 原子写入
let _sessDirtyTimer = null;
let _sessFlushInflight = null; // Promise — 防止并发 flush 互相覆盖
const SESS_FLUSH_DELAY = 800;

function saveSessions(data) {
  // 保护主会话不被截断；chat 和 task session 分别限额，互不挤占
  const before = new Set((data.sessions || []).map(s => s && s.id).filter(Boolean));
  const main = data.sessions.find(s => s.id === MAIN_SESSION_ID);
  const tasks = data.sessions.filter(s => s.id !== MAIN_SESSION_ID && s.origin === 'task').slice(-100);
  const chats = data.sessions.filter(s => s.id !== MAIN_SESSION_ID && s.origin !== 'task').slice(-200);
  data.sessions = [...(main ? [main] : []), ...chats, ...tasks];
  // 被 slice 踢出的 session → 删掉它的 JSONL 避免泄露
  const after = new Set(data.sessions.map(s => s && s.id).filter(Boolean));
  for (const sid of before) {
    if (!after.has(sid)) {
      sessionMessages.deleteMessages(sid);
      _messagesLenOnDisk.delete(sid);
    }
  }
  _sessionsCache = data;
  // 延迟写盘
  if (_sessDirtyTimer) clearTimeout(_sessDirtyTimer);
  _sessDirtyTimer = setTimeout(() => { _flushSessionsToDisk(); }, SESS_FLUSH_DELAY);
}

function _flushSessionsToDisk() {
  _sessDirtyTimer = null;
  if (!_sessionsCache) return Promise.resolve();
  // 如果上一轮 flush 还在跑，等它完再跑（避免并发 rename 冲突或 thin snapshot 竞态）
  if (_sessFlushInflight) {
    _sessFlushInflight = _sessFlushInflight.then(_doFlush);
  } else {
    _sessFlushInflight = _doFlush();
  }
  const cur = _sessFlushInflight;
  cur.finally(() => { if (_sessFlushInflight === cur) _sessFlushInflight = null; });
  return cur;
}

async function _doFlush() {
  if (!_sessionsCache) return;
  try {
    // 1. 并行把有 messages 的 session 写 JSONL —— 仅长度变化的重写，避免每次
    //    flush 都 300 个文件。successIds 也包含已落盘的（prev===cur 视为"当前版本
    //    可从 JSONL 读到"），可以安全 strip。写失败保留 inline 作 fallback。
    const writeJobs = [];
    const successIds = new Set();
    for (const s of (_sessionsCache.sessions || [])) {
      if (!s || !s.id || !Array.isArray(s.messages)) continue;
      const sid = s.id;
      const len = s.messages.length;
      const prev = _messagesLenOnDisk.get(sid);
      if (prev !== undefined && prev === len) {
        successIds.add(sid);
        continue;
      }
      const msgs = s.messages;
      writeJobs.push(
        sessionMessages.writeMessagesAsync(sid, msgs)
          .then(() => { _messagesLenOnDisk.set(sid, len); successIds.add(sid); })
          .catch((e) => { console.error(`[sessions] msg flush ${sid} failed:`, e.message); })
      );
    }
    await Promise.all(writeJobs);

    // 2. 构造 thin 副本：JSONL 写成功的 session 去掉 messages；失败的保留 inline
    const thin = {
      ..._sessionsCache,
      sessions: (_sessionsCache.sessions || []).map(s => {
        if (s && s.id && successIds.has(s.id)) {
          const { messages, ...rest } = s;
          return rest;
        }
        return s;
      }),
    };

    // 3. 原子写 sessions.json（从 19MB 降到 ~200KB）
    const tmp = sessionsFile + '.tmp.' + process.pid;
    await require('fs').promises.writeFile(tmp, JSON.stringify(thin, null, 2));
    await require('fs').promises.rename(tmp, sessionsFile);
    try { _sessionsCacheMtime = fs.statSync(sessionsFile).mtimeMs; } catch {}
  } catch (e) { console.error('[sessions] flush error:', e.message); }
}

// Worker-log: record PiBrowser AI interactions (debounced per session, 5 min)
const _workerLogLastWrite = {}; // sessionId -> timestamp
function _writeWorkerLogEntry(session, msgCount) {
  try {
    const sid = session.id;
    const now = Date.now();
    if (_workerLogLastWrite[sid] && (now - _workerLogLastWrite[sid]) < 5 * 60 * 1000) return;
    _workerLogLastWrite[sid] = now;

    const { resolveHost } = require('../backend/host-helper');
    const hostShort = resolveHost();

    const vault = VAULT_ROOT;
    const logFile = path.join(vault, 'Pi', 'Log', `worker-log-${hostShort}.md`);
    const d = new Date();
    const ts = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const engine = session.engine || 'unknown';
    const title = (session.title || 'untitled').substring(0, 50);
    const turns = Math.floor(msgCount / 2);

    const entry = `\n### ${ts} [${hostShort}] | engine:${engine} | agent:pibrowser | task:interactive\n- 话题：${title} | ${turns} turns\n`;
    fs.appendFileSync(logFile, entry, 'utf-8');
  } catch (e) {
    // silent — don't break session save on log failure
  }
}

// ── Task run 发现层（tick 7）──────────────────────────────────────────
// 核心理念：chat 和 task session 在底层是同一种东西（都是一个 Claude CLI jsonl
// 加上"当前 turn 所有权"）。区别只在**发现路径**：chat 通过 sessions.json 发现，
// task 通过 Pi/State/runs/ 发现。tick 7 把两条发现路径在 sessions:list 里合流。
//
// materializeTaskSessionFromRun 把一个 run 展成完整 sessionObj（读 jsonl/log/
// remote log 构造 messages），/pios/open-session 和 sessions:load 都调它，
// 两条入口的行为从此完全一致。

// 列出最近的 task runs（用于 sessions:list 合流）
function listRecentTaskRuns({ limit = 50, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const runsDir = path.join(VAULT_ROOT, 'Pi', 'State', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const cutoff = Date.now() - maxAgeMs;
  const out = [];
  try {
    const files = fs.readdirSync(runsDir).filter(f => {
      if (!f.endsWith('.json')) return false;
      if (f.endsWith('.stats') || f.endsWith('.jsonl')) return false;
      return true;
    });
    for (const f of files) {
      try {
        const full = path.join(runsDir, f);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) continue;
        const r = JSON.parse(fs.readFileSync(full, 'utf-8'));
        if (!r.run_id || !r.agent) continue;
        out.push({ run: _annotateRunIfZombie(r), mtime: stat.mtimeMs });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map(e => e.run);
}

// Zombie 检测：status=running 但 heartbeat_at 已超 90s 未更新 = adapter 进程死了 trap 没触发。
// adapter 后台心跳每 30s 写一次（pios-adapter.sh）；3 次没更新视为僵尸。
const ZOMBIE_HEARTBEAT_TIMEOUT_MS = 90 * 1000;
function _annotateRunIfZombie(r) {
  if (r.status !== 'running') return r;
  const hb = r.heartbeat_at;
  if (!hb) return r;  // 老 run record 没 heartbeat_at 字段，保留 running 状态不动
  const ageMs = Date.now() - (Number(hb) * 1000);
  if (ageMs > ZOMBIE_HEARTBEAT_TIMEOUT_MS) {
    return { ...r, status: 'zombie', _zombieAgeMs: ageMs };
  }
  return r;
}

// 按 runId / sessionId 查找单个 run record
function findTaskRun({ runId, sessionId } = {}) {
  const runsDir = path.join(VAULT_ROOT, 'Pi', 'State', 'runs');
  if (!fs.existsSync(runsDir)) return null;
  try {
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json') && !f.endsWith('.stats') && !f.endsWith('.jsonl'));
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf-8'));
        if (runId && r.run_id === runId) return _annotateRunIfZombie(r);
        if (sessionId && r.session_id === sessionId) return _annotateRunIfZombie(r);
      } catch {}
    }
  } catch {}
  return null;
}

// 一个 run 对应的 session.id：永远用 `run:<run_id>` 保证唯一。
// 2026-04-23 修：以前用 run.session_id 当 id 会导致 Claude session 复用时
// 多个 run 物化成同一个 sessionObj.id，互相覆盖 sessions.json，造成"点 A 看 B"。
// Claude resume 需要的真 uuid 单独保存在 sessionObj.claudeSessionId 字段。
function taskRunSessionId(run) {
  return 'run:' + run.run_id;
}

function formatLocalDateYmd(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function looksLikeRawTaskTranscript(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /(^|\n)(\[adapter\]|diff --git|@@ -\d|tokens used|apply patch|patch: completed|exec\n|codex\n)/i.test(t) ||
         /You've hit your limit|Failed to authenticate|authentication_error|Unable to connect to API|ECONNRESET/i.test(t) ||
         /^\[[^\]]+\]\s+\[[^\]]+\]\s+START: /m.test(t);
}

function prettifyTaskRunContent(run, text) {
  if (!text) return text;
  const raw = String(text).replace(/\r\n/g, '\n').trim();
  let out = raw;
  const marker = out.match(/(?:^|\n)tokens used\s*\n[^\n]*\n([\s\S]*)$/i);
  if (marker && marker[1] && marker[1].trim()) {
    out = marker[1].trim();
  }

  out = out
    .replace(/\[adapter\]\s+claude-cli configs-mode:[^\n]*/g, '')
    .replace(/\[adapter\]\s+codex-cli configs-mode:[^\n]*/g, '')
    .replace(/\[adapter\]\s+CLAUDE-FAIL:[^\n]*/g, '')
    .replace(/\[adapter\]\s+ENGINE-FALLBACK:[^\n]*/g, '')
    .replace(/You've hit your limit\s*·\s*resets [^\n]*/g, '');

  out = out
    .split('\n')
    .filter(line => {
      if (/^\[[^\]]+\]\s+\[[^\]]+\]\s+START: /.test(line)) return false;
      if (/^\[[^\]]+\]\s+\[[^\]]+\]\s+END: /.test(line)) return false;
      if (/^\[adapter\]\s+(CLAUDE-FAIL|ENGINE-FALLBACK|claude-cli configs-mode:|codex-cli configs-mode:)/.test(line)) return false;
      return true;
    })
    .join('\n')
    .trim();

  if (!out && run?.status === 'running') {
    return '任务正在运行 — 正在接入实时日志流（几秒后自动显示执行过程）';
  }

  if (run?.status === 'running' && looksLikeRawTaskTranscript(raw) && !marker) {
    return '任务正在运行 — 正在接入实时日志流（几秒后自动显示执行过程）';
  }

  if (!out) {
    if (/Failed to authenticate|authentication_error|API Error:\s*401/i.test(raw)) {
      return '任务启动失败：Claude 认证失效，未产生有效会话内容。';
    }
    if (/You\'ve hit your limit/i.test(raw)) {
      return '任务未执行完成：Claude 达到使用上限，未产生有效会话内容。';
    }
    if (/Unable to connect to API|ECONNRESET/i.test(raw)) {
      return '任务执行中断：连接上游 API 失败，未产生完整会话内容。';
    }
  }

  return out;
}

function taskRunOutcomeNote(run) {
  if (!run) return '';
  if (run.status === 'running') return '';
  if (run.status === 'failed' || (run.exit_code != null && Number(run.exit_code) !== 0)) {
    const bits = [];
    bits.push(`任务最终失败`);
    if (run.exit_code != null) bits.push(`退出码 ${run.exit_code}`);
    if (run.finished_at) bits.push(`结束于 ${run.finished_at}`);
    return `${bits.join('，')}。以下内容是失败前最后一次可恢复输出，不代表任务已完整成功。`;
  }
  if (run.status === 'degraded' && run.fallback_from) {
    return `任务已通过 fallback 完成：${run.fallback_from} -> ${run.runtime || 'unknown'}`;
  }
  return '';
}

function shouldRefreshMaterializedTaskSession(existing) {
  if (!existing || existing.origin !== 'task') return false;
  const messages = Array.isArray(existing.messages) ? existing.messages : [];
  if (messages.length === 0) return true;
  if (messages.some(m => m && m.role === 'user')) return false;
  if (messages.length === 1) return true;
  return messages.some(m => m && m.role !== 'user' && looksLikeRawTaskTranscript(m.content || ''));
}

// sessions:list 用的轻量 entry（没 messages，messageCount = 0）
// tick 8: 加 running 字段 —— renderer 会用它同步进 store，这样没点过的 task
// 在列表里也能看到 running pill。run record 是单一真相源。
function taskRunListEntry(run) {
  const ts = run.started_at ? new Date(run.started_at) : new Date();
  const tsLabel = `${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
  const engine = (run.runtime || '').includes('codex') ? 'codex' : 'claude';
  const taskTitle = run.plugin_name || run.run_id?.replace(/-\d{8}-\d{6}$/, '') || run.agent;
  const updated = run.finished_at || run.started_at || new Date().toISOString();
  return {
    id: taskRunSessionId(run),
    title: `${taskTitle} ${tsLabel}`,
    engine,
    updated,
    messageCount: 0,
    groupId: null,
    origin: 'task',
    taskId: run.plugin_name || run.run_id?.replace(/-\d{8}-\d{6}$/, '') || run.agent,
    runId: run.run_id,
    running: run.status === 'running',
    runStatus: run.status || null,
    exitCode: run.exit_code ?? null,
    finishedAt: run.finished_at || null,
    fallbackFrom: run.fallback_from || null,
    fallbackReason: run.fallback_reason || null,
    runtime: run.runtime || null,
    triggerSource: run.trigger_source || null,
  };
}

// 从 run record 构造完整 sessionObj（含 messages）。
// 数据源优先级：jsonl → log → remote ssh log → fallback stub。
// 这是 `/pios/open-session` 老代码抽出来的通用版本，不 side-effect（不写 sessions.json、
// 不 broadcast、不设 singleton），调用方自己决定如何持久化和通知。
function materializeTaskSessionFromRun(run) {
  const runtime = run.runtime || 'claude-cli';
  const taskId = run.plugin_name || run.run_id?.replace(/-\d{8}-\d{6}$/, '') || run.agent || 'task';
  const runId = run.run_id;
  const sessionId = taskRunSessionId(run);
  const hasFallback = !!run.fallback_from;
  const isCodex = runtime.includes('codex');
  const engine = isCodex ? 'codex' : 'claude';

  let conv = { messages: [], found: false };
  const useJsonl = !isCodex && !hasFallback && run.session_id;

  if (useJsonl) {
    conv = pios.getSessionConversation(run.session_id);
    if (conv.found && conv.messages && conv.messages.length > 0 && conv.messages.length <= 3) {
      const allText = conv.messages.map(m => m.content || '').join('\n');
      if (/You've hit your limit|Not logged in|Failed to authenticate|API Error: 40[13]/.test(allText) ||
          looksLikeRawTaskTranscript(allText)) {
        conv = { messages: [], found: false };
      }
    }
  }

  const localHost = require('../backend/host-helper').resolveHost();
  const runHost = run.host || localHost;
  if (!conv.found || (conv.messages || []).length === 0) {
    if (runHost !== localHost) {
      let _instances = {};
      try {
        const _yaml = require('js-yaml');
        const _m = _yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
        if (_m && _m.infra && _m.infra.instances) _instances = _m.infra.instances;
      } catch (e) { console.error('[materialize] yaml error:', e.message); }
      const _inst = _instances[runHost] || {};
      const remote = _inst.ssh ? { ssh: _inst.ssh, vault: _inst.vault || '/data/AI_Vault' } : null;
      if (remote) {
        const startedAt = run.started_at ? new Date(run.started_at) : new Date();
        const logDate = formatLocalDateYmd(startedAt);
        const remoteLog = `${remote.vault}/Pi/Log/cron/${taskId}-${logDate}-${runHost}.log`;
        try {
          const { execSync } = require('child_process');
          const remoteContent = execSync(`ssh ${remote.ssh} "cat '${remoteLog}' 2>/dev/null"`, { timeout: 10000, encoding: 'utf-8' });
          const startStr = startedAt.toTimeString().slice(0, 5);
          // Parse log: find content between START and END markers matching this run's time
          const lines = remoteContent.split('\n');
          let runOutput = '';
          let inRun = false;
          for (const line of lines) {
            if (!inRun && line.includes('START: ' + taskId) && line.includes(startStr)) {
              inRun = true;
              continue; // skip the START marker line itself
            }
            if (inRun && line.includes('END: ' + taskId)) {
              break; // done
            }
            if (inRun) runOutput += line + '\n';
          }
          if (!runOutput.trim()) runOutput = remoteContent.slice(-2000);
          conv.messages = [{ role: 'assistant', content: `[${runHost}] ${runOutput.trim().substring(0, 3000)}` }];
          conv.found = true;
        } catch (sshErr) {
          conv.messages = [{ role: 'assistant', content: `此任务在 ${runHost} 上执行。\n\n退出码: ${run.exit_code ?? '—'}\n时间: ${run.started_at || '?'}\n状态: ${run.status || '?'}\n\nSSH 错误: ${sshErr.message?.substring(0, 200)}` }];
          conv.found = true;
        }
      } else {
        conv.messages = [{ role: 'assistant', content: `此任务在 ${runHost} 上执行。\n退出码: ${run.exit_code ?? '—'}\n时间: ${run.started_at || '?'}` }];
        conv.found = true;
      }
    } else {
      const logDir = path.join(VAULT_ROOT, 'Pi', 'Log', 'cron');
      const startedAt = run.started_at ? new Date(run.started_at) : null;
      const logDate = startedAt ? formatLocalDateYmd(startedAt) : formatLocalDateYmd(new Date());
      const logFile = path.join(logDir, `${taskId}-${logDate}-${localHost}.log`);
      const logFileAlt = path.join(logDir, `${taskId}-${logDate}.log`);
      const actualLog = fs.existsSync(logFile) ? logFile : fs.existsSync(logFileAlt) ? logFileAlt : null;
      if (actualLog) {
        try {
          const logContent = fs.readFileSync(actualLog, 'utf-8');
          let runOutput = logContent;
          if (run.started_at) runOutput = extractRunFromLog(logContent, run);
          if (runOutput.trim()) {
            conv.messages = [{ role: 'assistant', content: runOutput.trim() }];
            conv.found = true;
          }
        } catch {}
      }
    }
  }

  const messages = (conv.messages || []).map(m => ({
    role: m.role === 'user' ? 'user' : 'ai',
    content: m.role === 'user' ? (m.content || '') : prettifyTaskRunContent(run, m.content || ''),
    engine,
  }));
  const outcomeNote = taskRunOutcomeNote(run);
  if (outcomeNote) {
    messages.push({ role: 'ai', content: outcomeNote, engine });
  }
  const tsSource = run.started_at ? new Date(run.started_at) : new Date();
  const tsLabel = `${String(tsSource.getMonth()+1).padStart(2,'0')}-${String(tsSource.getDate()).padStart(2,'0')} ${String(tsSource.getHours()).padStart(2,'0')}:${String(tsSource.getMinutes()).padStart(2,'0')}`;
  const createdAt = run.started_at || new Date().toISOString();
  const updatedAt = run.finished_at || run.started_at || new Date().toISOString();

  return {
    id: sessionId,
    title: `${taskId} ${tsLabel}`,
    engine,
    messages,
    created: createdAt,
    updated: updatedAt,
    origin: 'task',
    taskId,
    runId: runId || null,
    runStatus: run.status || null,
    exitCode: run.exit_code ?? null,
    finishedAt: run.finished_at || null,
    fallbackFrom: run.fallback_from || null,
    claudeSessionId: run.session_id || null,  // Claude resume 用，与 sessionObj.id 解耦
    // Codex rollout 用的真 thread_id；adapter 提取后写到 run.session_id（同一字段）
    fallbackReason: run.fallback_reason || null,
    triggerSource: run.trigger_source || null,
  };
}

// 从日志文件中提取指定 run 的输出片段
// 日志结构：pios-tick 写 [date] [host] START/END 标记，adapter 在中间 append tail -80 行输出
// 有些 run 缺少 START/END 标记，只有 adapter 输出直接 append
function extractRunFromLog(logContent, runRecord) {
  const lines = logContent.split('\n');
  const taskName = runRecord.plugin_name ||
                   runRecord.taskId ||
                   (runRecord.run_id ? String(runRecord.run_id).replace(/-\d{8}-\d{6}$/, '') : '') ||
                   runRecord.agent || '';
  const startTime = new Date(runRecord.started_at);
  const startHm = runRecord.started_at ? String(runRecord.started_at).slice(11, 16) : '';

  // 策略1: START/END 标记匹配（最可靠）
  const startMarker = `START: ${taskName}`;
  const endMarker = `END: ${taskName}`;
  let bestStart = -1, bestEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startMarker)) {
      if (!startHm || lines[i].includes(startHm)) {
        bestStart = i;
      }
    }
    if (bestStart >= 0 && lines[i].includes(endMarker) && i > bestStart) {
      bestEnd = i;
      break;
    }
  }

  if (bestStart >= 0) {
    let end = bestEnd >= 0 ? bestEnd + 1 : -1;
    if (end < 0) {
      for (let i = bestStart + 1; i < lines.length; i++) {
        if (lines[i].includes(startMarker)) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) end = Math.min(bestStart + 400, lines.length);
    return lines.slice(bestStart, end).join('\n');
  }

  // 策略2: 用 adapter 输出中的时间戳定位（### YYYY-MM-DD HH:MM 格式的段落标题）
  // 找所有有时间戳的行作为边界
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const tsMatch = lines[i].match(/### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    if (tsMatch) {
      boundaries.push({ line: i, time: new Date(`${tsMatch[1]}T${tsMatch[2]}:00`) });
    }
    // 也检查 [date] 格式
    const bracketMatch = lines[i].match(/^\[(\w+ \w+ \d+ [\d:]+ \w+ \d+)\]/);
    if (bracketMatch) {
      boundaries.push({ line: i, time: new Date(bracketMatch[1]) });
    }
  }

  // 找最接近 run started_at 的边界
  let closestIdx = -1, closestDist = Infinity;
  for (let i = 0; i < boundaries.length; i++) {
    const dist = Math.abs(boundaries[i].time.getTime() - startTime.getTime());
    if (dist < closestDist && dist < 300000) { // 5 分钟容差
      closestDist = dist;
      closestIdx = i;
    }
  }

  if (closestIdx >= 0) {
    const startLine = boundaries[closestIdx].line;
    // 找下一个边界（属于不同 run 的）
    let endLine = lines.length;
    for (let i = closestIdx + 1; i < boundaries.length; i++) {
      const gap = boundaries[i].time.getTime() - boundaries[closestIdx].time.getTime();
      if (gap > 60000) { // 下一个边界超过 1 分钟后 = 不同 run
        endLine = boundaries[i].line;
        break;
      }
    }
    return lines.slice(startLine, endLine).join('\n');
  }

  // 策略3: 回退 — 返回最后 80 行（adapter 默认 tail 长度）
  if (lines.length > 80) {
    return lines.slice(-80).join('\n');
  }
  return logContent;
}

// ── IPC 注册 ────────────────────────────────────────────────────────────
// register(ipcMain, { getSessionBus, getClaudeClient })
// getSessionBus: () => sessionBus  (sessionBus 在 main.js 晚于 module require 初始化)
// getClaudeClient: () => claude client instance
function register(ipcMain, { getSessionBus, getClaudeClient }) {
  ipcMain.handle('sessions:list', () => {
    const data = loadSessions();

    // tick 8: 提前读 runs/ —— materialized 的 task session 也用 run record 决定 running，
    // 避免 sessions.json 里 stale 的 status 漏掉刚 handed_off 的 session
    const recent = (() => {
      try { return listRecentTaskRuns({ limit: 50, maxAgeMs: 24 * 3600 * 1000 }); }
      catch (e) { console.warn('[sessions:list] runs read failed:', e.message); return []; }
    })();
    const runsByRunId = new Map(recent.map(r => [r.run_id, r]));
    const runsBySessionId = new Map(recent.filter(r => r.session_id).map(r => [r.session_id, r]));

    const chatEntries = data.sessions.filter(s => !s.archived).map(s => {
      // 如果是 task origin 且能在 runs/ 找到对应的 run，用它的 status 决定 running
      const run = (s.runId && runsByRunId.get(s.runId)) || runsBySessionId.get(s.id);
      const running = run ? run.status === 'running' : false;
      return {
        id: s.id, title: s.title, engine: s.engine,
        updated: run ? (run.finished_at || run.started_at || s.updated) : s.updated, messageCount: s.messages.length,
        groupId: s.groupId || null,
        origin: s.origin || null,
        taskId: s.taskId || null,
        runId: s.runId || null,
        running,
        runStatus: run ? (run.status || null) : (s.runStatus || null),
        exitCode: run ? (run.exit_code ?? null) : (s.exitCode ?? null),
        finishedAt: run ? (run.finished_at || null) : (s.finishedAt || null),
        fallbackFrom: run ? (run.fallback_from || null) : (s.fallbackFrom || null),
        fallbackReason: run ? (run.fallback_reason || null) : (s.fallbackReason || null),
        runtime: run ? (run.runtime || null) : (s.engine || null),
        triggerSource: run ? (run.trigger_source || null) : (s.triggerSource || null),
      };
    });

    // tick 7a: 合流 runs/ 里最近的 task runs 作为虚拟 list entries。
    // dedupe: 已经在 sessions.json 里的 task session（按 runId 或 session.id）不重复添加
    const seenRunIds = new Set(chatEntries.map(e => e.runId).filter(Boolean));
    const seenIds = new Set(chatEntries.map(e => e.id));
    const virtualTaskEntries = [];
    for (const run of recent) {
      if (seenRunIds.has(run.run_id)) continue;
      const entry = taskRunListEntry(run);
      if (seenIds.has(entry.id)) continue;
      virtualTaskEntries.push(entry);
      seenIds.add(entry.id);
      seenRunIds.add(run.run_id);
    }

    return [...chatEntries, ...virtualTaskEntries];
  });

  ipcMain.handle('sessions:list-archived', () => {
    const data = loadSessions();
    return data.sessions.filter(s => s.archived).map(s => ({
      id: s.id, title: s.title, engine: s.engine,
      updated: s.updated, messageCount: s.messages.length
    }));
  });

  ipcMain.handle('sessions:load', async (_, id) => {
    const sessionBus = getSessionBus();
    const data = loadSessions();
    const existing = data.sessions.find(s => s.id === id);
    if (existing) {
      if (shouldRefreshMaterializedTaskSession(existing)) {
        try {
          const run = findTaskRun({ sessionId: id }) ||
                      (existing.runId ? findTaskRun({ runId: existing.runId }) : null);
          if (run) {
            const refreshed = materializeTaskSessionFromRun(run);
            const idx = data.sessions.findIndex(s => s.id === existing.id);
            const merged = {
              ...existing,
              ...refreshed,
              id: existing.id,
              runId: existing.runId || refreshed.runId || null,
            };
            if (idx >= 0) data.sessions[idx] = merged;
            else data.sessions.push(merged);
            data.activeId = merged.id;
            saveSessions(data);
            if (sessionBus.hasAdapter('run') && (run.session_id || run.status === 'running')) {
              try {
                const _jsonlSid = run.session_id || null;
                sessionBus.registerSession(merged.id, 'run', {
                  origin: 'task',
                  taskId: merged.taskId,
                  runtime: run.runtime,
                  runId: run.run_id,
                  host: run.host,
                });
                await sessionBus.attach(merged.id, {
                  runtime: run.runtime,
                  taskId: merged.taskId,
                  runId: run.run_id,
                  host: run.host,
                  jsonlSessionId: _jsonlSid,
                });
              } catch (e) { console.warn('[sessions:load] refreshed task attach failed:', e.message); }
            }
            return merged;
          }
        } catch (e) {
          console.warn('[sessions:load] refresh materialized task failed:', e.message);
        }
      }
      // tick 11b + 刀 3: 已物化的 task session — 重新 attach 到 RunSessionAdapter
      // （PiBrowser 重启后 adapter 的 per-session state 清空，需要从 run record 恢复）
      if (existing.origin === 'task' && sessionBus.hasAdapter('run')) {
        try {
          const run = (existing.runId ? findTaskRun({ runId: existing.runId }) : null) ||
                      findTaskRun({ sessionId: id });
          if (run && (run.session_id || run.status === 'running')) {
            const _jsonlSid = run.session_id || null;
            sessionBus.registerSession(id, 'run', {
              origin: 'task',
              taskId: existing.taskId,
              runtime: run.runtime,
              runId: run.run_id,
              host: run.host,
            });
            await sessionBus.attach(id, {
              runtime: run.runtime,
              taskId: existing.taskId,
              runId: run.run_id,
              host: run.host,
              jsonlSessionId: _jsonlSid,
            });
          }
        } catch (e) { console.warn('[sessions:load] task re-attach (run) failed:', e.message); }
      }
      return existing;
    }

    // tick 7a: lazy 物化 —— sessions:list 返回的虚拟 task entry 点击时会走到这里。
    // 从 runs/ 里找到对应 run record，用 materializeTaskSessionFromRun 构造完整
    // sessionObj，写回 sessions.json，让后续的 save/load 都走 chat session 同一路径。
    try {
      let run = null;
      if (id.startsWith('run:')) {
        run = findTaskRun({ runId: id.slice(4) });
      } else {
        // id 可能是 Claude CLI session uuid（老路径 /pios/open-session 写的那种）
        run = findTaskRun({ sessionId: id });
      }
      if (!run) return null;

      const sessionObj = materializeTaskSessionFromRun(run);
      // 用 sessionObj.id（不是传入的 id），因为 materialize 内部会重新计算
      // 对于 Claude 有 session_id 的 run，两者等价；对于 run:xxx 前缀的也等价
      const data2 = loadSessions();
      const idx = data2.sessions.findIndex(s => s.id === sessionObj.id);
      if (idx >= 0) data2.sessions[idx] = sessionObj;
      else data2.sessions.push(sessionObj);
      data2.activeId = sessionObj.id;
      saveSessions(data2);

      // 刀 3: task session 路由到 RunSessionAdapter（run engine key）
      // jsonlSessionId 传 Claude/Codex 的真 ID 给 adapter 找 jsonl，sessionObj.id 自身保持唯一
      // 2026-04-23: 跑中的 task 即使还没 session_id 也要 attach —— 让 late-attach poll
      //   去 poll run record，watcher 写上 session_id 后立刻接管 tail
      const _shouldAttach = run.session_id || run.status === 'running';
      if (_shouldAttach && sessionBus.hasAdapter('run')) {
        try {
          const _jsonlSid = run.session_id || null;
          sessionBus.registerSession(sessionObj.id, 'run', {
            origin: 'task',
            taskId: sessionObj.taskId,
            runtime: run.runtime,
            runId: run.run_id,
            host: run.host,
          });
          await sessionBus.attach(sessionObj.id, {
            runtime: run.runtime,
            taskId: sessionObj.taskId,
            runId: run.run_id,
            host: run.host,
            jsonlSessionId: _jsonlSid,
          });
        } catch (e) { console.warn('[sessions:load] bus attach (run) failed:', e.message); }
      }
      // Legacy singleton for agent mode path
      if (sessionObj.engine === 'claude' && run.session_id) {
        try { getClaudeClient()._sessionId = run.session_id; } catch {}
      }
      return sessionObj;
    } catch (e) {
      console.warn('[sessions:load] materialize failed:', e.message);
      return null;
    }
  });

  ipcMain.handle('sessions:save', (_, session) => {
    const data = loadSessions();
    const idx = data.sessions.findIndex(s => s.id === session.id);
    const prev = idx >= 0 ? data.sessions[idx] : null;
    const prevMsgCount = prev?.messages?.length || 0;
    // tick 5: 保留 task 来源字段 —— renderer 发回的 session 对象可能没有 origin/
    // taskId/runId（它只读不写这些字段），full-replace 会抹掉。merge 一下保住。
    // 2026-04-22 加 groupId：sessionSetGroup 写完 groupId 后，renderer 紧接着跑
    // sendMessage → saveCurrentSession 全量覆盖，会把 groupId 抹掉（Call Pi 新会话
    // 落不进 "Things Need You" 分组的根因）。groupId 必须和 task 字段一样 merge 保住。
    const merged = prev
      ? {
          ...session,
          origin: session.origin ?? prev.origin,
          taskId: session.taskId ?? prev.taskId,
          runId: session.runId ?? prev.runId,
          groupId: session.groupId ?? prev.groupId,
        }
      : session;
    if (idx >= 0) data.sessions[idx] = merged;
    else data.sessions.push(merged);
    data.activeId = merged.id;
    saveSessions(data);

    // Worker-log hook: write entry when AI replies
    const newMsgCount = merged.messages?.length || 0;
    const lastMsg = merged.messages?.[newMsgCount - 1];
    if (newMsgCount > prevMsgCount && lastMsg?.role === 'ai') {
      _writeWorkerLogEntry(merged, newMsgCount);
    }
  });

  ipcMain.handle('sessions:archive', (_, id) => {
    if (id === MAIN_SESSION_ID) return null; // 主会话不可归档
    const data = loadSessions();
    const s = data.sessions.find(s => s.id === id);
    if (s) s.archived = true;
    if (data.activeId === id) {
      const active = data.sessions.filter(s => !s.archived);
      data.activeId = active[active.length - 1]?.id || null;
    }
    saveSessions(data);
    return data.activeId;
  });

  ipcMain.handle('sessions:unarchive', (_, id) => {
    const data = loadSessions();
    const s = data.sessions.find(s => s.id === id);
    if (s) delete s.archived;
    saveSessions(data);
  });

  ipcMain.handle('sessions:delete-archived', () => {
    const data = loadSessions();
    const archived = data.sessions.filter(s => s.archived).map(s => s.id);
    data.sessions = data.sessions.filter(s => !s.archived);
    for (const sid of archived) sessionMessages.deleteMessages(sid);
    saveSessions(data);
  });

  ipcMain.handle('sessions:rename', (_, id, title) => {
    const data = loadSessions();
    const s = data.sessions.find(s => s.id === id);
    if (s) { s.title = title; saveSessions(data); }
  });

  ipcMain.handle('sessions:delete', (_, id) => {
    const data = loadSessions();
    data.sessions = data.sessions.filter(s => s.id !== id);
    if (data.activeId === id) data.activeId = data.sessions[data.sessions.length - 1]?.id || null;
    sessionMessages.deleteMessages(id);
    saveSessions(data);
    return data.activeId;
  });

  ipcMain.handle('sessions:getActive', () => {
    const data = loadSessions();
    return data.activeId;
  });

  // ── 自定义分组 ──
  ipcMain.handle('sessions:groups-list', () => {
    const data = loadSessions();
    return data.groups || [];
  });

  ipcMain.handle('sessions:group-create', (_, name) => {
    const data = loadSessions();
    if (!data.groups) data.groups = [];
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const order = data.groups.length;
    data.groups.push({ id, name, order });
    saveSessions(data);
    return { id, name, order };
  });

  ipcMain.handle('sessions:group-rename', (_, id, name) => {
    const data = loadSessions();
    const g = (data.groups || []).find(g => g.id === id);
    if (g) { g.name = name; saveSessions(data); }
  });

  ipcMain.handle('sessions:group-delete', (_, id) => {
    const data = loadSessions();
    data.groups = (data.groups || []).filter(g => g.id !== id);
    // 移除会话的 groupId
    for (const s of data.sessions) {
      if (s.groupId === id) delete s.groupId;
    }
    saveSessions(data);
  });

  ipcMain.handle('sessions:set-group', (_, sessionId, groupId) => {
    const data = loadSessions();
    const s = data.sessions.find(s => s.id === sessionId);
    if (s) {
      if (groupId) s.groupId = groupId;
      else delete s.groupId;
      saveSessions(data);
    }
  });

  // 保留旧 API 兼容（不再写文件）
  ipcMain.handle('conversation:save', (_, engine, role, content) => {});
  ipcMain.handle('conversation:load', () => []);
  ipcMain.handle('conversation:clear', () => {});
}

module.exports = {
  MAIN_SESSION_ID,
  loadSessions,
  saveSessions,
  findTaskRun,
  materializeTaskSessionFromRun,
  taskRunSessionId,
  extractRunFromLog,
  _flushSessionsToDisk,
  register,
};
