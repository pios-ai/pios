/**
 * ClaudeInteractiveAdapter — 刀 1 + tick 7
 *
 * 包 ClaudeCodeClient，让每个 SessionBus session 拥有自己的独立 ClaudeCodeClient
 * 实例（不再共享 singleton），解决并发 Claude 请求的根因。
 *
 * tick 7 的心智模型升级：chat 和 task session 在底层是同一种东西（都是一个 Claude
 * CLI jsonl 加上"当前 turn 所有权"）。区别只在当前 turn 的 owner pid 怎么找到：
 *   - chat：owner 是本地 `_proc`，`client.stop()` 直接 kill
 *   - task：owner 是 scheduler 起的 pios-adapter.sh 子进程，需要 ps grep + SIGINT
 *
 * interrupt() 是 polymorphic 的：依据 session 的 meta.origin 决定走哪条 kill 路径，
 * 但语义上是同一个"优雅打断当前 turn，等 jsonl 写完，让后续 resume 接得上"。
 *
 * - send():     执行一次 claude run，事件流通过 opts.publish 打到 bus
 * - interrupt(): polymorphic，chat→client.stop，task→SIGINT 外部进程 + wait jsonl
 * - attach():   记录 per-session meta（claudeSessionId/origin/taskId），让 resume 和
 *               interrupt 都能用
 * - forget():   卸载 session 的 client 实例，释放
 *
 * 对应卡片：Cards/active/pibrowser-session-model-v2.md
 */

const { ClaudeCodeClient } = require('../claude-client');

class ClaudeInteractiveAdapter {
  constructor({ getTTS, onAudio } = {}) {
    this.clients = new Map(); // sessionId -> ClaudeCodeClient
    // tick 9: per-session in-flight token —— rolling interjection 的核心。
    // 新 send 进来时把 prev token 标 cancelled，prev 的 for-await 检测到就 break。
    this._inflight = new Map(); // sessionId -> { cancelled: bool, promise: Promise }
    this._getTTS = getTTS || null;
    this._onAudio = onAudio || null; // (sessionId, ArrayBuffer) -> void
    // 刀 3: `_meta / _vaultRoot / _interruptTaskSession` 全删 —— task session 走 RunSessionAdapter
  }

  _getClient(sessionId) {
    let c = this.clients.get(sessionId);
    if (!c) {
      c = new ClaudeCodeClient();
      this.clients.set(sessionId, c);
    }
    return c;
  }

  /**
   * tick 9: rolling interjection
   *
   * 每次 send 拿到自己的 cancellation token。新 send 进来时：
   *   1. 把 prev token 标 cancelled
   *   2. 调 polymorphic interrupt（chat→client.stop / task→SIGINT 外部 + wait）
   *   3. 等 prev 的 for-await 循环退出（看到 cancelled 就 break）
   *   4. 自己开始 spawn 新的 claude subprocess
   *
   * 如果在 spawn 之前又被更新的 send 抢占了，自己也直接返回 aborted。
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {object} opts
   *   - publish(event): bus 发布回调
   *   - requestId: bus 分配的 id
   *   - skipPermissions: boolean
   *   - cwd: 可选工作目录
   */
  async send(sessionId, text, { publish, skipPermissions, permissionLevel, cwd, model } = {}) {
    // tick 9: cancellation token 派发
    const myEntry = { cancelled: false, promise: null };
    const prevEntry = this._inflight.get(sessionId);
    if (prevEntry) prevEntry.cancelled = true;

    // tick 11: 无条件调 interrupt —— 关键修复
    // 之前只在 prevEntry 存在时才调，task session 首次插话（prevEntry 为 undefined）
    // 根本没 SIGINT 外部 scheduler 进程，导致 task 继续跑。
    // 对 chat session 无 _proc 时 polymorphic interrupt 是安全 no-op。
    // 对 task session 触发 _interruptTaskSession → SIGINT 外部进程 + 等 jsonl flush。
    try { await this.interrupt(sessionId); } catch (e) { console.warn('[adapter] interrupt before send failed:', e.message); }

    if (prevEntry) {
      // 等 prev 的 promise 结算（它的 for-await 会因 cancelled 而 break）
      try { await prevEntry.promise; } catch {}
    }

    // 检查我们是不是还是最新的（极少数情况下，prev await 期间又来了一个）
    if (this._inflight.get(sessionId) && this._inflight.get(sessionId) !== prevEntry && this._inflight.get(sessionId) !== myEntry) {
      // 有更新的 send 正在进来，让它接手；我们直接返回 aborted
      return { content: '', sessionId, aborted: true };
    }

    // 占据 in-flight 槽位
    const doRun = async () => {
      const client = this._getClient(sessionId);
      let finalText = '';
      try {
        for await (const ev of client.run(text, { skipPermissions, permissionLevel, cwd, model })) {
          // tick 9: 每个事件之前检查 cancelled，被抢占就立刻退出
          if (myEntry.cancelled) break;
          if (ev.type === 'voice') {
            publish && publish({ type: 'voice', content: ev.content });
            if (this._getTTS && this._onAudio) {
              this._speakAndForward(sessionId, ev.content).catch((e) => {
                console.warn('[claude-adapter] TTS failed:', e.message);
              });
            }
          } else {
            // usage 事件需要保留 raw 字段（含 input_tokens/output_tokens）
            if (ev.type === 'usage') {
              publish && publish({ type: 'usage', content: ev.content, raw: ev.raw });
            } else {
              publish && publish({ type: ev.type, content: ev.content });
            }
            if (ev.type === 'done') finalText = ev.content;
          }
        }
      } catch (err) {
        if (myEntry.cancelled) {
          // 被抢占引起的 throw，不当真错误抛出
          return { content: '', sessionId, aborted: true };
        }
        throw err;
      }
      return {
        content: finalText,
        sessionId,
        claudeSessionId: client.sessionId,
        aborted: myEntry.cancelled,
      };
    };

    myEntry.promise = doRun();
    this._inflight.set(sessionId, myEntry);
    try {
      return await myEntry.promise;
    } finally {
      // 只有当我们仍然是最新 entry 时才清掉，避免擦掉接班的更新 entry
      if (this._inflight.get(sessionId) === myEntry) {
        this._inflight.delete(sessionId);
      }
    }
  }

  async _speakAndForward(sessionId, voiceText) {
    const tts = this._getTTS && this._getTTS();
    if (!tts) return;
    try {
      const audio = await tts.speak(voiceText, 15000);
      if (audio && audio.length > 100 && this._onAudio) {
        const buf = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
        this._onAudio(sessionId, buf);
        try { global._npcSpeak && global._npcSpeak(voiceText); } catch {}
      }
    } catch (e) {
      // TTS 失败只 log，不再 fallback 到 macOS `say`（那个绕过 audioQueue 导致双声）
      console.warn('[claude-adapter] TTS speak failed, skipping:', e.message);
    }
  }

  /**
   * interrupt —— chat session only。
   * 刀 3: task session 的 interrupt 已移到 RunSessionAdapter（engine 'run'），
   * ClaudeInteractiveAdapter 只处理 chat origin。tick 11 的 pgrep+SIGINT+SIGKILL+
   * run record handed_off 全套逻辑被 port 到 backend/adapters/run-session.js。
   */
  async interrupt(sessionId) {
    const client = this.clients.get(sessionId);
    if (!client) return false;
    client.stop();
    return true;
  }

  /**
   * attach —— 绑 claudeSessionId 让 send 时 client.run() 能 `--resume <uuid>`。
   * 刀 3: chat session 专用。task session 走 RunSessionAdapter。
   * origin / taskId 字段保留兼容（旧 main.js 调用可能带，接受但忽略）。
   */
  attach(sessionId, { claudeSessionId } = {}) {
    const client = this._getClient(sessionId);
    if (claudeSessionId && !client._sessionId) {
      client._sessionId = claudeSessionId;
    }
    return true;
  }

  forget(sessionId) {
    const client = this.clients.get(sessionId);
    if (client) {
      try { client.stop(); } catch {}
    }
    this.clients.delete(sessionId);
  }
}

module.exports = { ClaudeInteractiveAdapter };
