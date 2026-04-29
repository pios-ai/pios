'use strict';
// Task run 发现层 — 提取自 session-manager.js
// chat 和 task session 在底层是同一种东西（都是一个 Claude CLI jsonl 加上"当前 turn 所有权"）。
// 区别只在**发现路径**：chat 通过 sessions.json 发现，task 通过 Pi/State/runs/ 发现。
// materializeTaskSessionFromRun 把一个 run 展成完整 sessionObj（读 jsonl/log/remote log
// 构造 messages），/pios/open-session 和 sessions:load 都调它。

const path = require('path');
const fs = require('fs');

const VAULT_ROOT = require('../backend/vault-root');
const pios = require('../backend/pios-engine');

// Zombie 检测：status=running 但 heartbeat_at 已超 90s 未更新 = adapter 进程死了 trap 没触发。
// adapter 后台心跳每 30s 写一次（pios-adapter.sh）；3 次没更新视为僵尸。
const ZOMBIE_HEARTBEAT_TIMEOUT_MS = 90 * 1000;

function _annotateRunIfZombie(r) {
  if (r.status !== 'running') return r;
  const hb = r.heartbeat_at;
  if (!hb) return r;
  const ageMs = Date.now() - (Number(hb) * 1000);
  if (ageMs > ZOMBIE_HEARTBEAT_TIMEOUT_MS) {
    return { ...r, status: 'zombie', _zombieAgeMs: ageMs };
  }
  return r;
}

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

  // 策略2: 用 adapter 输出中的时间戳定位
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const tsMatch = lines[i].match(/### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    if (tsMatch) boundaries.push({ line: i, time: new Date(`${tsMatch[1]}T${tsMatch[2]}:00`) });
    const bracketMatch = lines[i].match(/^\[(\w+ \w+ \d+ [\d:]+ \w+ \d+)\]/);
    if (bracketMatch) boundaries.push({ line: i, time: new Date(bracketMatch[1]) });
  }

  let closestIdx = -1, closestDist = Infinity;
  for (let i = 0; i < boundaries.length; i++) {
    const dist = Math.abs(boundaries[i].time.getTime() - startTime.getTime());
    if (dist < closestDist && dist < 300000) {
      closestDist = dist;
      closestIdx = i;
    }
  }

  if (closestIdx >= 0) {
    const startLine = boundaries[closestIdx].line;
    let endLine = lines.length;
    for (let i = closestIdx + 1; i < boundaries.length; i++) {
      const gap = boundaries[i].time.getTime() - boundaries[closestIdx].time.getTime();
      if (gap > 60000) { endLine = boundaries[i].line; break; }
    }
    return lines.slice(startLine, endLine).join('\n');
  }

  // 策略3: 回退 — 返回最后 80 行
  if (lines.length > 80) return lines.slice(-80).join('\n');
  return logContent;
}

// 从 run record 构造完整 sessionObj（含 messages）。
// 数据源优先级：jsonl → log → remote ssh log → fallback stub。
// 不 side-effect（不写 sessions.json、不 broadcast、不设 singleton）。
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
          const lines = remoteContent.split('\n');
          let runOutput = '';
          let inRun = false;
          for (const line of lines) {
            if (!inRun && line.includes('START: ' + taskId) && line.includes(startStr)) {
              inRun = true; continue;
            }
            if (inRun && line.includes('END: ' + taskId)) break;
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
    claudeSessionId: run.session_id || null,
    fallbackReason: run.fallback_reason || null,
    triggerSource: run.trigger_source || null,
  };
}

module.exports = {
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
};
