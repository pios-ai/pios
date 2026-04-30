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

// ── Task run 发现层 → main/task-run.js ──
const _taskRun = require('./task-run');
const {
  listRecentTaskRuns,
  findTaskRun,
  taskRunSessionId,
  formatLocalDateYmd,
  looksLikeRawTaskTranscript,
  prettifyTaskRunContent,
  taskRunOutcomeNote,
  shouldRefreshMaterializedTaskSession,
  taskRunListEntry,
  materializeTaskSessionFromRun,
  extractRunFromLog,
} = _taskRun;


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

  ipcMain.handle('sessions:load', async (_, id, opts = {}) => {
    const setActive = !!opts.setActive;
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
            if (setActive) data.activeId = merged.id;
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
      if (setActive) data2.activeId = sessionObj.id;
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

  ipcMain.handle('sessions:save', (_, session, opts = {}) => {
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
    // Background metadata saves can be based on a stale sessionLoad() snapshot.
    // Without this guard, a late meta patch can replace the current message
    // list with an older, shorter list and make chat turns disappear.
    // Explicit history-clearing paths opt in with allowMessageTruncate.
    if (prev && Array.isArray(prev.messages) && Array.isArray(session.messages)
        && session.messages.length < prev.messages.length && !opts.allowMessageTruncate) {
      merged.messages = prev.messages;
    }
    if (idx >= 0) data.sessions[idx] = merged;
    else data.sessions.push(merged);
    if (opts.setActive) data.activeId = merged.id;
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
    if (data.activeId === id) {
      const active = data.sessions.filter(s => !s.archived);
      data.activeId = active[active.length - 1]?.id || null;
    }
    sessionMessages.deleteMessages(id);
    saveSessions(data);
    return data.activeId;
  });

  ipcMain.handle('sessions:getActive', () => {
    const data = loadSessions();
    if (data.activeId && data.sessions.some(s => s.id === data.activeId && !s.archived)) {
      return data.activeId;
    }
    const main = data.sessions.find(s => s.id === MAIN_SESSION_ID && !s.archived);
    const active = data.sessions.filter(s => !s.archived);
    data.activeId = main ? MAIN_SESSION_ID : (active[active.length - 1]?.id || null);
    saveSessions(data);
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
