/**
 * CodexInteractiveAdapter — 刀 2 step 2
 *
 * 包 `backend/codex-client.js` (CodexMCPClient)，让每个 SessionBus session
 * 对应一个 Codex threadId。
 *
 * 心智模型：
 *   - Codex MCP 是 stdio 长连接，singleton MCP server 进程在后台跑
 *   - 每个 session 的对话 = 一个 threadId；第一条消息 `call(prompt)`
 *     返回新的 threadId，后续 `reply(threadId, prompt)` 继续
 *   - v2 里 PiBrowser session id 和 Codex threadId 做 1:1 映射（adapter 内部表）
 *   - 不是 stream：call/reply 返回完整文本，没有中间 delta（MCP 协议限制）
 *     —— adapter 只发 `tool`/`text`/`done` 三种事件，没有 `delta`
 *
 * interrupt 语义：Codex MCP 没有"中途打断"的干净原语。我们这里的实现：
 *   - mark cancelled：当前 send 的 promise 结算后，不把结果发布到 bus
 *   - pending promise 标 cancelled —— 但 MCP server 还在跑完那一轮
 *   - 这和 Claude SIGINT 不对等，但对 Codex 是合理上限
 *   - 如果以后 Codex CLI 支持 `codex exec --signal-interrupt`，再 upgrade
 *
 * rolling interjection：和 Claude/GPT adapter 对称 —— cancellation token。
 *
 * 刀 2 spike 阶段（2026-04-15 夜）：文件落地 + 注册到 bus，renderer 还没切过来。
 *
 * 对应卡片：Cards/active/pibrowser-session-model-v2.md 刀 2
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { getClient: getCodexMCPClient } = require('../codex-client');
const codexParser = require('./event-parsers/codex');
const DEFAULT_CODEX_TIMEOUT_MS = 300000;

class CodexInteractiveAdapter {
  constructor({ prepareRequest } = {}) {
    // sessionId -> codex threadId（首次 send 后填上）
    this._threadIds = new Map();
    // per-session meta —— origin (chat/task)、taskId (task session 用)
    this._meta = new Map();
    // per-session in-flight（rolling interjection 用）
    this._inflight = new Map();
    // sessionId -> live rollout tail state
    this._tails = new Map();
    // 注入式 prompt 构造：main.js 提供 prepareCodexRequest，让 adapter 不用知道
    // buildSystemContext / voice prompt / 续聊提醒等细节。
    this._prepareRequest = prepareRequest || null;
  }

  _getMeta(sessionId) {
    let m = this._meta.get(sessionId);
    if (!m) {
      m = { origin: 'chat', taskId: null };
      this._meta.set(sessionId, m);
    }
    return m;
  }

  /**
   * @param {string} sessionId
   * @param {string} text
   * @param {object} opts
   *   - publish(event): bus 发布回调
   *   - requestId: bus 分配的 id
   *   - model: string
   *   - cwd: string - Codex 的工作目录
   *   - timeout: number - call/reply 超时，默认 5 分钟
   */
  async send(sessionId, text, { publish, model, cwd, timeout, clean, permissionLevel } = {}) {
    const myEntry = { cancelled: false, promise: null };
    const prevEntry = this._inflight.get(sessionId);
    if (prevEntry) prevEntry.cancelled = true;

    // 和 Claude/GPT adapter 对称，无条件调 interrupt
    try { await this.interrupt(sessionId); } catch (e) { console.warn('[codex-adapter] interrupt before send failed:', e.message); }

    if (prevEntry) {
      try { await prevEntry.promise; } catch {}
    }

    const current = this._inflight.get(sessionId);
    if (current && current !== prevEntry && current !== myEntry) {
      return { content: '', sessionId, aborted: true };
    }

    const doRun = async () => {
      const client = getCodexMCPClient();
      const threadId = this._threadIds.get(sessionId);
      const sendStartedAt = Date.now();
      const publishProfile = (phase, extra = {}) => {
        publish && publish({
          type: 'profile',
          scope: 'codex',
          phase,
          elapsedMs: Date.now() - sendStartedAt,
          ...extra,
        });
      };
      let finalMessage = text;
      const releaseTail = threadId
        ? this._ensureTailForThread(sessionId, threadId, publish, {
            fromStart: false,
            startedAt: sendStartedAt,
            publishProfile,
          })
        : this._ensureTailForNewSession(sessionId, publish, {
            cwd,
            startedAt: sendStartedAt,
            publishProfile,
          });

      try {
        if (this._prepareRequest) {
          const prepareStartedAt = Date.now();
          try {
            const prepared = await this._prepareRequest(text, {
              sessionId,
              clean: !!clean,
              continued: !!threadId,
            });
            if (prepared && prepared.fullMessage) {
              finalMessage = prepared.fullMessage;
            }
            publishProfile('prepare-complete', {
              durationMs: Date.now() - prepareStartedAt,
              fullMessageLength: finalMessage.length,
              continued: !!threadId,
            });
          } catch (e) {
            publishProfile('prepare-failed', {
              durationMs: Date.now() - prepareStartedAt,
              error: e.message,
            });
            console.warn('[codex-adapter] prepareRequest failed:', e.message);
          }
        }

        const _fa = permissionLevel === 'safe';
        let result;
        if (threadId) {
          try {
            publishProfile('mcp-reply-start', { threadId });
            const replyStartedAt = Date.now();
            result = await client.reply(threadId, finalMessage, { timeout: timeout || DEFAULT_CODEX_TIMEOUT_MS, fullAuto: _fa });
            publishProfile('mcp-reply-complete', {
              threadId,
              durationMs: Date.now() - replyStartedAt,
            });
          } catch (replyErr) {
            // codex MCP 重启 / rollout 过期 → thread 失效。清掉 threadId 新起一个 session，不让 owner 看到废话
            if (/Session not found for thread_id/i.test(replyErr.message || '')) {
              console.warn('[codex-adapter] stale threadId, starting fresh:', threadId);
              this._threadIds.delete(sessionId);
              publishProfile('thread-stale-retry', { threadId });
              const callStartedAt = Date.now();
              result = await client.call(finalMessage, { timeout: timeout || DEFAULT_CODEX_TIMEOUT_MS, model, cwd, fullAuto: _fa });
              publishProfile('mcp-call-complete', {
                durationMs: Date.now() - callStartedAt,
                retryFromStaleThread: true,
              });
              if (result && result.threadId) {
                this._threadIds.set(sessionId, result.threadId);
              }
            } else {
              throw replyErr;
            }
          }
        } else {
          publishProfile('mcp-call-start', { cwd });
          const callStartedAt = Date.now();
          result = await client.call(finalMessage, { timeout: timeout || DEFAULT_CODEX_TIMEOUT_MS, model, cwd, fullAuto: permissionLevel === 'safe' });
          publishProfile('mcp-call-complete', {
            durationMs: Date.now() - callStartedAt,
          });
          if (result && result.threadId) {
            this._threadIds.set(sessionId, result.threadId);
          }
        }

        if (myEntry.cancelled) {
          return { content: '', sessionId, aborted: true };
        }

        const content = (result && result.content) || '';

        // Completion ownership gate: the rollout tail is the authoritative source for
        // text/done events (it emits agent_message → text, task_complete → done).
        // Only publish from the MCP return path when no tail is active (i.e., tail
        // attachment timed out or rollout file was never found). Publishing from both
        // paths causes duplicate assistant messages, duplicate done signals, and
        // duplicate finish UI in renderer.
        const hasTail = this._tails.has(sessionId);
        if (hasTail) {
          // Tail is live — it already published (or will publish within 400ms) the
          // authoritative text+done from the rollout file. Suppress MCP path.
          publishProfile('mcp-return-gated', { hasTail: true });
        } else {
          // No tail: MCP return is the sole completion source. Keep the same
          // turn structure as rollout tails so chat/task UI both show a divider.
          publish && publish({ type: 'text', content });
          publish && publish({ type: 'turn-end', content: '' });
          publish && publish({ type: 'done', content });
          publishProfile('mcp-return-fallback', { hasTail: false });
        }

        return {
          content,
          sessionId,
          codexThreadId: this._threadIds.get(sessionId),
          aborted: false,
        };
      } catch (err) {
        if (myEntry.cancelled) {
          return { content: '', sessionId, aborted: true };
        }
        publish && publish({ type: 'error', content: err.message });
        throw err;
      } finally {
        try { await releaseTail; } catch {}
        setTimeout(() => this._stopTail(sessionId), 1200);
      }
    };

    // 先登记 inflight，再启动 doRun。否则 new-session tail attach 的第一轮
    // tryAttach 会看到 "没有 inflight" 并立即退出，导致 rollout 步骤完全接不上。
    this._inflight.set(sessionId, myEntry);
    myEntry.promise = doRun();
    try {
      return await myEntry.promise;
    } finally {
      if (this._inflight.get(sessionId) === myEntry) {
        this._inflight.delete(sessionId);
      }
    }
  }

  /**
   * interrupt —— mark cancelled。MCP 协议没有 per-call cancel，
   * 所以后台的那一轮还会跑完（结果被 adapter 丢弃）。
   * 严格说这不"真打断"，但是对上层（bus / renderer）语义一致：
   * cancelled 后发的新 send 一定 overtake。
   */
  async interrupt(sessionId) {
    const entry = this._inflight.get(sessionId);
    if (!entry) return false;
    entry.cancelled = true;
    return true;
  }

  /**
   * attach —— 记录 per-session 的 threadId / origin / taskId。
   * task session 初次打开时从 run record 拿 codex_session_id（刀 3 会补）。
   */
  attach(sessionId, { codexThreadId, origin, taskId, publish } = {}) {
    if (codexThreadId && !this._threadIds.get(sessionId)) {
      this._threadIds.set(sessionId, codexThreadId);
    }
    const meta = this._getMeta(sessionId);
    if (origin) meta.origin = origin;
    if (taskId) meta.taskId = taskId;
    return true;
  }

  forget(sessionId) {
    const entry = this._inflight.get(sessionId);
    if (entry) entry.cancelled = true;
    this._inflight.delete(sessionId);
    this._threadIds.delete(sessionId);
    this._meta.delete(sessionId);
    this._stopTail(sessionId);
  }

  _findJsonlPathByThreadId(threadId) {
    if (!threadId) return null;
    const base = path.join(process.env.HOME || '', '.codex', 'sessions');
    if (!fs.existsSync(base)) return null;
    try {
      const found = execSync(`find '${base}' -name 'rollout-*-${threadId}.jsonl' -print 2>/dev/null | head -1`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      return found || null;
    } catch {
      return null;
    }
  }

  _findNewestRolloutAfter(startedAt, cwd) {
    const base = path.join(process.env.HOME || '', '.codex', 'sessions');
    if (!fs.existsSync(base)) return null;
    try {
      const startedSec = Math.max(0, Math.floor(startedAt / 1000) - 2);
      const out = execSync(
        `find '${base}' -name 'rollout-*.jsonl' -print0 2>/dev/null | xargs -0 -I{} stat -f "%m %N" {} 2>/dev/null | sort -rn | head -20`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();
      if (!out) return null;
      for (const line of out.split('\n')) {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const mtimeSec = Number(match[1] || 0);
        const candidate = (match[2] || '').trim();
        if (!candidate || !fs.existsSync(candidate)) continue;
        if (mtimeSec < startedSec) continue;
        if (!cwd) return candidate;
        try {
          const firstLine = fs.readFileSync(candidate, 'utf-8').split('\n')[0] || '';
          const first = JSON.parse(firstLine);
          if (first?.type === 'session_meta' && first?.payload?.cwd === cwd) {
            return candidate;
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  _ensureTailForThread(sessionId, threadId, publish, { fromStart = false, startedAt, publishProfile } = {}) {
    const pathForThread = this._findJsonlPathByThreadId(threadId);
    if (!pathForThread) return Promise.resolve();
    publishProfile && publishProfile('tail-attached', {
      mode: 'thread',
      fromStart,
      attachDelayMs: startedAt ? Date.now() - startedAt : undefined,
      rolloutFile: path.basename(pathForThread),
    });
    this._startTail(sessionId, pathForThread, publish, { fromStart, startedAt, publishProfile });
    return Promise.resolve();
  }

  _ensureTailForNewSession(sessionId, publish, { cwd, startedAt, publishProfile } = {}) {
    return new Promise((resolve) => {
      const deadline = Date.now() + 15000;
      const tryAttach = () => {
        if (!this._inflight.get(sessionId)) {
          resolve();
          return;
        }
        const found = this._findNewestRolloutAfter(startedAt, cwd);
        if (found) {
          publishProfile && publishProfile('tail-attached', {
            mode: 'new-session',
            fromStart: true,
            attachDelayMs: startedAt ? Date.now() - startedAt : undefined,
            rolloutFile: path.basename(found),
          });
          this._startTail(sessionId, found, publish, {
            fromStart: true,
            startedAt,
            publishProfile,
          });
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          publishProfile && publishProfile('tail-attach-timeout', {
            timeoutMs: 15000,
          });
          resolve();
          return;
        }
        setTimeout(tryAttach, 400);
      };
      tryAttach();
    });
  }

  _startTail(sessionId, jsonlPath, publish, { fromStart = false, startedAt, publishProfile } = {}) {
    this._stopTail(sessionId);

    const entry = {
      sessionId,
      jsonlPath,
      publish,
      publishProfile,
      startedAt,
      watcher: null,
      pollTimer: null,
      tailPos: 0,
      lineBuf: '',
      firstEventSeen: false,
    };

    try {
      const stat = fs.statSync(jsonlPath);
      entry.tailPos = fromStart ? 0 : stat.size;
    } catch {
      entry.tailPos = 0;
    }

    const poll = () => {
      if (!this._tails.has(sessionId)) return;
      try {
        const stat = fs.statSync(jsonlPath);
        if (stat.size <= entry.tailPos) return;
        const fd = fs.openSync(jsonlPath, 'r');
        const len = stat.size - entry.tailPos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, entry.tailPos);
        fs.closeSync(fd);
        entry.tailPos = stat.size;
        entry.lineBuf += buf.toString('utf-8');
        const lines = entry.lineBuf.split('\n');
        entry.lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const evs = codexParser.parseLine(line);
          for (const ev of evs) {
            if (!entry.firstEventSeen) {
              entry.firstEventSeen = true;
              entry.publishProfile && entry.publishProfile('first-tail-event', {
                eventType: ev.type,
                firstEventDelayMs: entry.startedAt ? Date.now() - entry.startedAt : undefined,
              });
            }
            entry.publish && entry.publish(ev);
          }
        }
      } catch {}
    };

    entry.pollTimer = setInterval(poll, 400);
    try {
      entry.watcher = fs.watch(jsonlPath, { persistent: true }, (eventType) => {
        if (eventType === 'change') poll();
      });
    } catch {}
    this._tails.set(sessionId, entry);
    poll();
  }

  _stopTail(sessionId) {
    const entry = this._tails.get(sessionId);
    if (!entry) return;
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    if (entry.watcher) {
      try { entry.watcher.close(); } catch {}
    }
    this._tails.delete(sessionId);
  }
}

module.exports = { CodexInteractiveAdapter };
