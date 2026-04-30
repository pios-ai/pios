/**
 * RunSessionAdapter — 刀 3
 *
 * 把"后台正在跑的 task session"变成 SessionBus 的一等公民。
 *
 * 心智模型：一个 task session 的生命周期有三种状态，adapter 都能处理：
 *
 *   1. **watching**（task 正由 scheduler 跑着）
 *      - tail jsonl 文件（Claude 或 Codex），新行 → parse → publish BusEvent
 *      - 用户看到 tool / text 实时流入
 *      - interrupt: SIGINT scheduler 进程 + 等 run record status 变化
 *      - send: SIGINT + spawn 新的 `claude --resume <id>` / `codex exec resume <id>` 子进程
 *
 *   2. **interjecting**（用户发消息接管）
 *      - interrupt（见上）后 spawn resume 子进程
 *      - 注意：tail 在整个流程里**继续**跑 —— resume 子进程也在写同一个 jsonl，
 *        新行会被同一个 tail 捕获 publish 上来，UI 自然看到接管后的对话
 *      - send() 本身不 for-await 等进程，它 spawn 后立即返回（fire-and-forget），
 *        事件都从 tail 流进来
 *
 *   3. **replay**（task 已结束）
 *      - run record status !== 'running' → adapter 进入只读模式
 *      - attach 时一次性把已有 jsonl 内容 replay 成 BusEvent，不 tail
 *      - send 被 reject（"任务已结束，不能接管"）
 *      - interrupt no-op
 *
 * 跨机场景：run record `host !== localhost` → 只读模式 + banner 提示
 * "远程任务只读，用 SSH 手动接管"。send 被 reject。
 *
 * 对应卡片：Cards/active/pibrowser-session-model-v2.md 刀 3
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const claudeParser = require('./event-parsers/claude');
const codexParser = require('./event-parsers/codex');

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

const { resolveHost } = require('../host-helper');
function _localHost() { return resolveHost(); }

/**
 * 按 runtime 找 jsonl 文件路径。
 * - Claude: `~/.claude/projects/{cwd-encoded}/{sessionId}.jsonl`
 *   优先 vault 对应的项目目录，fallback 扫全部（adapter 用这个 fallback）。
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-{iso-ts}-{sessionId}.jsonl`
 *   需要 glob 因为路径有日期。
 */
function findJsonlPath(runtime, sessionId) {
  const home = process.env.HOME || '';
  if (runtime === 'codex-cli' || runtime === 'codex') {
    // Codex rollout 路径含日期 + 时间戳 + sessionId，glob 匹配
    const base = path.join(home, '.codex', 'sessions');
    if (!fs.existsSync(base)) return null;
    try {
      // 递归找 rollout-*-{sessionId}.jsonl
      const found = execSync(`find '${base}' -name 'rollout-*-${sessionId}.jsonl' -print 2>/dev/null | head -1`, { encoding: 'utf-8', timeout: 3000 }).trim();
      return found || null;
    } catch { return null; }
  }
  // Default: Claude CLI
  const base = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  // 常见路径：当前 vault 的 Claude CLI 项目目录
  // Claude CLI 用 [^a-zA-Z0-9] → '-' 编码（包括下划线），不只是斜杠
  // 2026-04-22 commit 8dc036db 修过 claude-client.js，run-session.js 这条遗漏了
  const vaultRoot = require('../vault-root');
  const vaultEncoded = vaultRoot.replace(/[^a-zA-Z0-9]/g, '-');
  const common = [
    path.join(base, vaultEncoded, `${sessionId}.jsonl`),
    path.join(base, '-', `${sessionId}.jsonl`),
  ];
  for (const p of common) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: 扫全部项目目录
  try {
    for (const dir of fs.readdirSync(base)) {
      const p = path.join(base, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/**
 * 按 runtime 挑 parser。
 */
function pickParser(runtime) {
  if (runtime === 'codex-cli' || runtime === 'codex') return codexParser;
  return claudeParser;
}

class RunSessionAdapter {
  /**
   * @param {object} deps
   *   - vaultRoot: string (required) —— 读 Pi/State/runs/ 需要
   */
  constructor({ vaultRoot } = {}) {
    if (!vaultRoot) throw new Error('[run-session] vaultRoot required');
    this._vaultRoot = vaultRoot;

    // sessionId -> { state, runtime, sessionId (same as key), jsonlPath, taskId, runId,
    //                host, runRecordPath, publish, watcher?, tailPos, lastRunStatus,
    //                inflight: { cancelled, promise } }
    this._sessions = new Map();
  }

  _getEntry(sessionId) {
    return this._sessions.get(sessionId);
  }

  /**
   * 读 run record 拿 status/host/session_id/runtime。
   * run record 的 sessionId 对应 PiBrowser session 的 sessionId（即 run.session_id，
   * Claude CLI UUID 或 Codex thread_id）。
   */
  _readRunRecord(runId) {
    if (!runId) return null;
    try {
      const file = path.join(this._vaultRoot, 'Pi', 'State', 'runs', `${runId}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { return null; }
  }

  /**
   * attach —— 打开 session 时调一次。
   * @param {string} sessionId
   * @param {object} opts
   *   - runtime: 'claude-cli' | 'codex-cli'
   *   - taskId: string
   *   - runId: string (可选，run record 在 Pi/State/runs/{runId}.json)
   *   - host: string (run record 里的 host，非本机 → 只读)
   *   - publish(event): bus 发布回调（由 SessionBus 注入）
   */
  async attach(sessionId, { runtime, taskId, runId, host, publish, jsonlSessionId } = {}) {
    // 清理旧 entry 的 watcher，防止重复 attach 导致多个 tail 并行 publish 同一事件
    const old = this._sessions.get(sessionId);
    if (old) this._stopTail(old);

    const entry = {
      sessionId,
      runtime: runtime || 'claude-cli',
      taskId: taskId || null,
      runId: runId || null,
      host: host || _localHost(),
      publish: publish || (() => {}),
      jsonlPath: null,
      // 找 jsonl 用的真 ID（Claude session uuid / Codex thread id）
      // 与 sessionObj.id（'run:xxx' 唯一形式）解耦
      jsonlSessionId: jsonlSessionId || sessionId,
      watcher: null,       // fs.watch handle
      pollTimer: null,     // setInterval for run record status watch
      tailPos: 0,          // bytes read so far
      lineBuf: '',         // partial line buffer
      state: 'init',       // 'init' | 'watching' | 'replay' | 'remote' | 'idle'
      lastRunStatus: null,
      inflight: null,
    };
    this._sessions.set(sessionId, entry);

    // 跨机 task（worker-host 等）—— readonly 但读本地 Syncthing 同步的 cron log，
    // 给用户实时看到执行情况（不走 jsonl 因为跨机没有；不走 SSH 因为复杂且慢）。
    if (entry.host && entry.host !== _localHost()) {
      entry.state = 'remote';
      entry.publish({ type: 'readonly', reason: 'remote', host: entry.host,
        content: `远程任务（${entry.host}）只读 —— 以下是本地同步的执行日志` });
      // 定位 Syncthing 同步的 cron log
      this._attachRemoteCronLog(entry);
      return true;
    }

    // 找 jsonl —— 用 jsonlSessionId（真 uuid/thread）找文件，不是 sessionObj.id
    entry.jsonlPath = findJsonlPath(entry.runtime, entry.jsonlSessionId);
    if (!entry.jsonlPath) {
      // 常见场景：Codex task 刚启动，thread_id 还没被 adapter watcher 提取到 run record。
      // 如果 task 还在跑，启动 late-attach poll：每 2s re-read run record 看 session_id 有了没，
      // 有就重试 findJsonlPath 开始 tail。这样用户点开详情页能看到跑着跑着文本流出来。
      const runForLate = this._readRunRecord(entry.runId);
      if (runForLate && runForLate.status === 'running') {
        entry.state = 'waiting-jsonl';
        entry.publish({ type: 'text', content: '（等待 Codex 写 rollout session...）', replay: true });
        entry.lateAttachTimer = setInterval(async () => {
          if (!this._sessions.has(entry.sessionId)) return;
          const r = this._readRunRecord(entry.runId);
          if (!r) return;
          if (r.status !== 'running') {
            // task 已结束但还没有 session_id → 最终走 no-jsonl
            clearInterval(entry.lateAttachTimer);
            entry.lateAttachTimer = null;
            entry.publish({ type: 'readonly', reason: 'no-jsonl',
              content: '任务已结束但未捕获到 session jsonl' });
            entry.state = 'idle';
            return;
          }
          if (r.session_id) {
            entry.jsonlSessionId = r.session_id;
            const p = findJsonlPath(entry.runtime, r.session_id);
            if (p) {
              clearInterval(entry.lateAttachTimer);
              entry.lateAttachTimer = null;
              entry.jsonlPath = p;
              await this._replayExisting(entry);
              entry.state = 'watching';
              this._startTail(entry);
              this._startRunRecordPoll(entry);
            }
          }
        }, 2000);
        return true;
      }
      // task 不在跑且无 jsonl → 老 run 或 adapter 挂了，只读
      entry.state = 'idle';
      entry.publish({ type: 'readonly', reason: 'no-jsonl',
        content: '找不到 session jsonl 文件（可能是老 run 或 runtime 不支持）' });
      return true;
    }

    // 读 run record 决定 watching / replay
    const run = this._readRunRecord(entry.runId);
    const isRunning = run && run.status === 'running';
    entry.lastRunStatus = run ? run.status : null;

    // 先一次性读已有内容 replay 到 bus
    await this._replayExisting(entry);

    if (isRunning) {
      entry.state = 'watching';
      this._startTail(entry);
      this._startRunRecordPoll(entry);
    } else {
      entry.state = 'replay';
    }

    return true;
  }

  /**
   * 把 jsonl 现有内容全部读一遍 publish。这是"打开 session 时看到历史"的路径。
   * replay 完之后，tail 从当前文件末尾开始追加。
   *
   * 用流式 readline 逐行 publish —— 大 JSONL（19MB+ sessions）不会一次性把整
   * 个文件读进内存；每行 parse 后 publish 给事件循环留出喘息间隙，避免 UI 卡顿。
   */
  async _replayExisting(entry) {
    const parser = pickParser(entry.runtime);
    let size = 0;
    try {
      size = fs.statSync(entry.jsonlPath).size;
    } catch (e) {
      console.warn(`[run-session] replay stat failed for ${entry.sessionId}:`, e.message);
      return;
    }
    return new Promise((resolve) => {
      const stream = fs.createReadStream(entry.jsonlPath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const evs = parser.parseLine(line);
          for (const e of evs) entry.publish({ ...e, replay: true });
        } catch {}
      });
      rl.on('close', () => {
        entry.tailPos = size;
        entry.lineBuf = '';
        resolve();
      });
      rl.on('error', (e) => {
        console.warn(`[run-session] replay failed for ${entry.sessionId}:`, e.message);
        resolve();
      });
    });
  }

  /**
   * 启动 fs.watch tail —— 当 jsonl 文件变化时，读增量字节、解析新行、publish。
   *
   * 注意：macOS 的 `fs.watch` 对文件事件不太可靠，这里叠加一个 500ms 定时 poll
   * 作为兜底。实际 touch-coalescing 让两者不会重复 publish（用 tailPos 去重）。
   */
  _startTail(entry) {
    if (entry.watcher || entry.pollTimer) return;

    const poll = () => {
      if (!this._sessions.has(entry.sessionId)) return;
      try {
        const stat = fs.statSync(entry.jsonlPath);
        if (stat.size > entry.tailPos) {
          // 读增量
          const fd = fs.openSync(entry.jsonlPath, 'r');
          const len = stat.size - entry.tailPos;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, entry.tailPos);
          fs.closeSync(fd);
          entry.tailPos = stat.size;
          const chunk = buf.toString('utf-8');
          entry.lineBuf += chunk;
          const lines = entry.lineBuf.split('\n');
          entry.lineBuf = lines.pop() || ''; // 最后一段可能是未完成的行
          const parser = pickParser(entry.runtime);
          for (const line of lines) {
            if (!line.trim()) continue;
            const evs = parser.parseLine(line);
            for (const e of evs) entry.publish(e);
          }
        }
      } catch (e) {
        // 文件可能被 move / delete，安静跳过
      }
    };

    // 500ms 兜底轮询
    entry.pollTimer = setInterval(poll, 500);

    // fs.watch 快速响应（大部分 case 下比 poll 更快触发一次 poll）
    try {
      entry.watcher = fs.watch(entry.jsonlPath, { persistent: true }, (eventType) => {
        if (eventType === 'change') poll();
      });
    } catch (e) {
      // 忽略，靠 poll 就够
    }
  }

  /**
   * 定时读 run record，检测两件事：
   *  1. status 从 running → finished → 发 done event 停 tail
   *  2. runtime/session_id 在 fallback 时被 pios-adapter.sh 改写（codex-cli rate-limit
   *     → claude-cli），attach 时绑的 JSONL 已不再是真身；必须切文件重新 attach，
   *     否则 UI 永远等一个不再增长的 rollout。
   */
  _startRunRecordPoll(entry) {
    if (entry.pollTimerRec || !entry.runId) return;
    entry.pollTimerRec = setInterval(() => {
      if (!this._sessions.has(entry.sessionId)) return;
      const run = this._readRunRecord(entry.runId);
      if (!run) return;

      // Fallback drift 检测：runtime 或 session_id 变了 → 重挂 JSONL
      const driftedRuntime = run.runtime && run.runtime !== entry.runtime;
      const driftedSessionId = run.session_id && run.session_id !== entry.jsonlSessionId;
      if (driftedRuntime || driftedSessionId) {
        const newPath = run.session_id ? findJsonlPath(run.runtime || entry.runtime, run.session_id) : null;
        if (newPath && newPath !== entry.jsonlPath) {
          const reason = driftedRuntime
            ? `${entry.runtime} → ${run.runtime} (${run.fallback_reason || 'fallback'})`
            : 'session_id drift';
          entry.publish({ type: 'text', content: `（运行时切换：${reason}）`, replay: false });
          // 旧 tail stop，换新文件重挂
          this._stopTail(entry);
          entry.runtime = run.runtime || entry.runtime;
          entry.jsonlSessionId = run.session_id;
          entry.jsonlPath = newPath;
          entry.tailPos = 0;
          entry.lineBuf = '';
          // replay 新文件 + 重启 tail（async；不 await 轮询回调）
          this._replayExisting(entry).then(() => {
            if (!this._sessions.has(entry.sessionId)) return;
            entry.state = 'watching';
            this._startTail(entry);
          }).catch(() => {});
        }
      }

      const st = run.status;
      if (st && st !== entry.lastRunStatus) {
        entry.lastRunStatus = st;
        if (st !== 'running') {
          // task 结束了 —— stop tail 让最后一批 lines flush 出来
          setTimeout(() => {
            const e = this._sessions.get(entry.sessionId);
            if (!e) return;
            e.publish({ type: 'done', content: `run ${st}` });
            e.publish({ type: 'state', state: 'idle' });
            e.state = 'replay';
            this._stopTail(e);
          }, 600); // 留 600ms 让最后几行从 jsonl 读完
        }
      }
    }, 2000);
  }

  _stopTail(entry) {
    if (entry.pollTimer) { clearInterval(entry.pollTimer); entry.pollTimer = null; }
    if (entry.pollTimerRec) { clearInterval(entry.pollTimerRec); entry.pollTimerRec = null; }
    if (entry.lateAttachTimer) { clearInterval(entry.lateAttachTimer); entry.lateAttachTimer = null; }
    if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = null; }
  }

  /**
   * 跨机 task 的 cron log tail —— Syncthing 已把 worker-host 的 Pi/Log/cron/ 同步到本地，
   * 所以直接读本地文件，不走 SSH。定时 poll 检测文件变化增量 publish text 事件。
   * 跟 Claude jsonl tail 不一样：raw 文本没有结构，直接 publish text（用 adapter 事件格式）。
   *
   * 首次读用流式 readline —— cron log 常 400KB+，同步 readFileSync 打开跨机
   * session 时整个主进程冻住；流式逐行扫 START/END 边界、按批 publish，主进程
   * 有喘息间隙，UI "开跨机历史会话慢" 的观感消失。
   */
  _attachRemoteCronLog(entry) {
    if (!entry.runId) return;
    const run = this._readRunRecord(entry.runId);
    if (!run || !run.plugin_name) return;
    const startedAt = run.started_at ? new Date(run.started_at) : new Date();
    const y = startedAt.getFullYear();
    const m = String(startedAt.getMonth() + 1).padStart(2, '0');
    const d = String(startedAt.getDate()).padStart(2, '0');
    const logFile = path.join(this._vaultRoot, 'Pi', 'Log', 'cron',
      `${run.plugin_name}-${y}-${m}-${d}-${entry.host}.log`);
    if (!fs.existsSync(logFile)) {
      entry.publish({ type: 'text', content: `（本地未找到 ${entry.host} 的同步日志：${logFile}）`, replay: true });
      return;
    }
    entry.remoteLogPath = logFile;
    const startedTime = startedAt.toTimeString().slice(0, 5);  // HH:MM
    const startMarker = 'START: ' + run.plugin_name;
    const endMarker = 'END: ' + run.plugin_name;

    // 流式扫：逐行找 START / END，在区段内按 ~200 行一批 publish，避免单块过大。
    let fileSize = 0;
    try { fileSize = fs.statSync(logFile).size; } catch {}
    const stream = fs.createReadStream(logFile, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let inRun = false;
    let buf = [];
    const flush = () => {
      if (buf.length === 0) return;
      entry.publish({ type: 'text', content: buf.join('\n'), replay: true });
      buf = [];
    };
    rl.on('line', (line) => {
      if (!inRun && line.includes(startMarker) && line.includes(startedTime)) {
        inRun = true;
        return;
      }
      if (inRun && line.includes(endMarker)) {
        flush();
        inRun = false;
        rl.close();
        return;
      }
      if (inRun) {
        buf.push(line);
        if (buf.length >= 200) flush();
      }
    });
    rl.on('close', () => { flush(); });
    rl.on('error', (e) => {
      entry.publish({ type: 'text', content: `读本地同步日志失败: ${e.message}`, replay: true });
    });
    entry.remoteTailPos = fileSize;

    // poll 文件大小：Syncthing 每次同步会 rewrite 整个文件（mtime 变），tail 增量 publish
    entry.pollTimer = setInterval(() => {
      if (!this._sessions.has(entry.sessionId)) return;
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > (entry.remoteTailPos || 0)) {
          const fd = fs.openSync(logFile, 'r');
          const len = stat.size - entry.remoteTailPos;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, entry.remoteTailPos);
          fs.closeSync(fd);
          entry.remoteTailPos = stat.size;
          const chunk = buf.toString('utf-8').trim();
          if (chunk) entry.publish({ type: 'text', content: chunk });
          // 检测 END: 表示 task 结束
          if (chunk.includes('END: ' + run.plugin_name)) {
            entry.publish({ type: 'done', content: 'remote task ended' });
            this._stopTail(entry);
          }
        }
      } catch {}
    }, 2000);  // 2s poll（比 local jsonl 的 500ms 慢——Syncthing 同步本来就有延迟）
  }

  /**
   * interrupt —— SIGINT 跑着的 scheduler 进程 + 等 run record flip。
   * 和 ClaudeInteractiveAdapter._interruptTaskSession 几乎相同逻辑，这里复用一份。
   */
  async interrupt(sessionId) {
    const entry = this._getEntry(sessionId);
    if (!entry) return false;

    // 远程 / replay 状态不能 interrupt
    if (entry.state === 'remote') {
      entry.publish({ type: 'error', content: '远程任务只读，不能从本机打断' });
      return false;
    }
    if (entry.state === 'replay' || entry.state === 'idle') {
      return true; // no-op，任务已经结束
    }

    if (!entry.taskId) {
      entry.publish({ type: 'error', content: '没有 taskId，无法定位进程' });
      return false;
    }

    const taskId = entry.taskId;
    const pids = [];
    const addPid = (pid) => { if (pid && !pids.includes(pid)) pids.push(pid); };

    // pgrep pios-adapter.sh by taskId
    try {
      const out = execSync(`pgrep -f "pios-adapter.*--task ${taskId}"`, { encoding: 'utf-8', timeout: 3000 }).trim();
      for (const l of out.split('\n').filter(Boolean)) addPid(parseInt(l));
    } catch {}

    // 每个 bash 的 child（claude / codex 子进程）
    const bashPids = [...pids];
    for (const bp of bashPids) {
      try {
        const out = execSync(`pgrep -P ${bp}`, { encoding: 'utf-8', timeout: 1000 }).trim();
        for (const l of out.split('\n').filter(Boolean)) addPid(parseInt(l));
      } catch {}
    }

    // 按 sessionId 补一遍（adapter 自己可能 spawn 过 resume 子进程）
    try {
      const patt = entry.runtime === 'codex-cli' ? `codex.*${sessionId}` : `claude.*${sessionId}`;
      const out = execSync(`pgrep -f "${patt}"`, { encoding: 'utf-8', timeout: 3000 }).trim();
      for (const l of out.split('\n').filter(Boolean)) addPid(parseInt(l));
    } catch {}

    if (pids.length === 0) return true; // nothing to kill

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGINT');
        console.log(`[run-session] SIGINT → pid ${pid} (task ${taskId})`);
      } catch {}
    }

    // 等进程退出（或 10s timeout）
    const pidsAlive = () => pids.filter(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (pidsAlive().length === 0) break;
      await _sleep(500);
    }
    const stuck = pidsAlive();
    for (const pid of stuck) {
      try { process.kill(pid, 'SIGKILL'); console.warn(`[run-session] SIGKILL → pid ${pid}`); } catch {}
    }

    // 写 run record handed_off（对照 ClaudeInteractiveAdapter 的逻辑）
    try {
      const runsDir = path.join(this._vaultRoot, 'Pi', 'State', 'runs');
      const files = fs.readdirSync(runsDir)
        .filter(f => f.startsWith(taskId + '-') && f.endsWith('.json') && !f.endsWith('.stats.json') && !f.endsWith('.jsonl'))
        .sort().reverse();
      for (const f of files) {
        const runFile = path.join(runsDir, f);
        try {
          const run = JSON.parse(fs.readFileSync(runFile, 'utf-8'));
          if (!run.handed_off_at) {
            run.status = 'handed_off';
            run.handed_off_at = new Date().toISOString();
            run.handed_off_by = 'pibrowser';
            run.finished_at = run.handed_off_at;
            fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
            console.log(`[run-session] run record handed_off: ${f}`);
            break;
          }
        } catch {}
      }
    } catch (e) { console.warn('[run-session] run record update failed:', e.message); }

    return true;
  }

  /**
   * send —— 用户给正在跑的 task 发消息。
   * 流程：
   *   1. interrupt（如果还在跑）
   *   2. spawn `claude --resume <sid> -p <text>` 或 `codex exec resume <sid> <text>`
   *   3. 立即返回（fire-and-forget）—— 事件从 tail 流进来
   *   4. resume 子进程会往同一个 jsonl append，tail 自然捕获
   *
   * 注意：tail 在整个流程里继续跑，所以 resume 的新内容会在 UI 实时显示。
   * 为了让 UI 知道"正在跑"，adapter 先发一个 `state: running` event。
   */
  async send(sessionId, text, { publish } = {}) {
    const entry = this._getEntry(sessionId);
    if (!entry) return { content: '', sessionId, error: 'session not attached' };

    if (entry.state === 'remote') {
      return { content: '', sessionId, error: '远程任务只读，不能插话' };
    }

    // Guard: 任务早死（api-timeout 没创 JSONL）→ resume 死 session 会 spawn + silent exit，
    // UI 只看到 "✓ 完成" 没气泡。直接 reject 并把失败原因喂到对话里。
    if (!entry.jsonlPath || !fs.existsSync(entry.jsonlPath)) {
      const run = this._readRunRecord(entry.runId);
      const why = run && run.status === 'failed'
        ? `原任务失败（exit ${run.exit_code ?? '?'} / ${run.fallback_reason || run.status}），CLI 未创建 session 文件，无法接管。`
        : '任务未产生可恢复的 session 文件，无法接管。新建一个 Pi 聊天问它这个任务吧。';
      entry.publish({ type: 'user-echo', content: text });
      entry.publish({ type: 'text', content: why });
      entry.publish({ type: 'done', content: 'no-jsonl' });
      entry.publish({ type: 'state', state: 'idle' });
      return { content: why, sessionId, error: 'no-jsonl' };
    }

    // 先打断旧进程（如果在跑）
    if (entry.state === 'watching') {
      await this.interrupt(sessionId);
    }

    // state 切 running
    entry.state = 'watching';
    entry.publish({ type: 'state', state: 'running' });
    entry.publish({ type: 'user-echo', content: text });

    // replay → watching 时启动 tail：attach 时 task 已结束，tail 没跑，resume 子进程
    // 写入 jsonl 没人读 → UI 只看到 "完成"。_startTail 内部幂等，重复调用安全。
    this._startTail(entry);

    // spawn resume 子进程
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/opt/node/bin', '/usr/local/bin'];
    const envPath = (process.env.PATH || '/usr/bin:/bin');
    const fullPath = [...extraPaths, ...envPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');
    const env = { ...process.env, PATH: fullPath };
    if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;

    let bin, args, cwd;
    if (entry.runtime === 'codex-cli' || entry.runtime === 'codex') {
      bin = 'codex';
      args = ['exec', 'resume', sessionId, text, '-C', this._vaultRoot, '--full-auto'];
      cwd = this._vaultRoot;
    } else {
      bin = 'claude';
      args = ['-p', text, '--resume', sessionId, '--dangerously-skip-permissions'];
      cwd = this._vaultRoot;
    }

    try {
      // 记 send 前 JSONL 大小；resume 正常写新行后 tailPos 会涨，没涨 = 没产出
      const sizeBefore = (() => { try { return fs.statSync(entry.jsonlPath).size; } catch { return entry.tailPos; } })();
      const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
      // 主线：stdout/stderr 不消费 —— 事件从 jsonl tail 流进来
      // 兜底：收 stderr 便于 resume 失败时把原因喂给用户（API timeout / session-not-found 等）
      let stderrBuf = '';
      if (proc.stderr) proc.stderr.on('data', (d) => { if (stderrBuf.length < 4000) stderrBuf += d.toString('utf-8'); });
      proc.on('exit', (code) => {
        const e = this._sessions.get(sessionId);
        if (!e) return;
        let sizeAfter = sizeBefore;
        try { sizeAfter = fs.statSync(e.jsonlPath).size; } catch {}
        const wroteNothing = sizeAfter <= sizeBefore;
        // 失败 / 空产出 → 发可见的 text，免得 UI 只剩 "✓ 完成" 空气泡
        if (code !== 0 || wroteNothing) {
          const reason = stderrBuf.trim().split('\n').slice(-3).join('\n').trim();
          const why = code !== 0
            ? `resume 进程失败（exit ${code}）${reason ? `：${reason.slice(0,400)}` : ''}`
            : `resume 成功但 CLI 没写入任何新内容；可能原会话被 API 错误污染无法接管。${reason ? `\nstderr: ${reason.slice(0,300)}` : ''}`;
          e.publish({ type: 'text', content: why });
        }
        e.publish({ type: 'state', state: 'idle' });
        e.publish({ type: 'done', content: `resume exit ${code}` });
        e.state = 'replay';
      });
      proc.on('error', (err) => {
        const e = this._sessions.get(sessionId);
        if (!e) return;
        e.publish({ type: 'text', content: `resume spawn 失败：${err.message}` });
        e.publish({ type: 'error', content: `spawn failed: ${err.message}` });
      });
      // 不 await 进程 —— 立即返回，UI 靠 tail 更新
    } catch (err) {
      entry.publish({ type: 'error', content: `resume spawn failed: ${err.message}` });
      return { content: '', sessionId, error: err.message };
    }

    return { content: '', sessionId, spawned: true };
  }

  forget(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return;
    this._stopTail(entry);
    this._sessions.delete(sessionId);
  }
}

module.exports = { RunSessionAdapter, findJsonlPath, pickParser };
