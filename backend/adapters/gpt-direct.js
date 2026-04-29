/**
 * GPTDirectAdapter — 刀 2 step 1
 *
 * 包 `backend/openai-direct-client.js`，让每个 SessionBus session 拥有自己
 * 独立的 `_conversationHistory`（不再共享 singleton），解决并发 GPT 请求的根因。
 *
 * 心智模型：
 *   - GPT (ChatGPT backend /responses) 是 stateless —— 每次 send 都把完整
 *     history 重新 POST 过去。`_conversationHistory` 是纯客户端的镜像，
 *     作为 "第 N 轮对话的上下文"。
 *   - 这意味着：adapter 可以在 send 前把 Session.messages 强制 mirror 进
 *     client._conversationHistory，完全避免状态漂移（这是 v2 的 invariant）。
 *   - 没有"resume"概念，也没有"真打断正在跑的 task"概念 ——
 *     interrupt = abort 当前 in-flight curl 进程。
 *
 * rolling interjection：和 Claude adapter 一样的 cancellation token 模式。
 *   1. 新 send 进来，给上一个 entry 标 cancelled + abort curl
 *   2. 等 prev promise 结算
 *   3. 自己 spawn 新的 curl
 *
 * 刀 2 spike 阶段（2026-04-15 夜）：文件落地 + 注册到 bus，但 renderer
 * 还没切过来，老路径 `sendGPT` 继续跑。明天早上做 renderer 切换。
 *
 * 对应卡片：Cards/active/pibrowser-session-model-v2.md 刀 2
 */

const { OpenAIDirectClient } = require('../openai-direct-client');

class GPTDirectAdapter {
  constructor({ prepareRequest } = {}) {
    // per-session client —— 每个 session 一个 _conversationHistory
    this.clients = new Map(); // sessionId -> OpenAIDirectClient
    // per-session meta —— origin (chat/task)，future: taskId、threadId 等
    this._meta = new Map(); // sessionId -> { origin }
    // per-session in-flight —— rolling interjection 用
    // { cancelled: bool, promise: Promise, abort?: () => void }
    this._inflight = new Map();
    // 注入式 prompt 构造：main.js 提供 `prepareGPTRequest`，让 adapter 不用知道
    // buildSystemContext / webSearch / voice prompt template / contextInjector 等。
    // 传 (userMessage, { sessionId, clean, auto }) 返回 { systemPrompt, fullMessage, searchResults }。
    this._prepareRequest = prepareRequest || null;
  }

  _getClient(sessionId) {
    let c = this.clients.get(sessionId);
    if (!c) {
      c = new OpenAIDirectClient();
      this.clients.set(sessionId, c);
    }
    return c;
  }

  _getMeta(sessionId) {
    let m = this._meta.get(sessionId);
    if (!m) {
      m = { origin: 'chat' };
      this._meta.set(sessionId, m);
    }
    return m;
  }

  /**
   * Mirror Session.messages 进 client._conversationHistory。
   * 每次 send 前强制跑一次，承担 O(n) 开销，不走捷径。
   * 这是 v2 invariant：Session.messages 是 source of truth。
   *
   * **去重**：renderer 会在 send 之前把 user 新消息 push 进 currentSession.messages，
   * 然后把 currentSession.messages 整个作为 `history` 传进来。OpenAIDirectClient
   * 自己在 chatStream 开头也会 push 新 user 消息，所以如果 history 的最后一条
   * 是 user 且内容等于 currentText，我们把它从 history 里弹掉，交由 chatStream
   * 来 push，保证 _conversationHistory 不重复。
   *
   * @param {OpenAIDirectClient} client
   * @param {Array<{role, content}>} messages - 按时间顺序，role: 'user' | 'ai' | 'assistant'
   * @param {string} currentText - 本次 send 的 user 文本（用来去重）
   */
  _syncHistory(client, messages, currentText) {
    if (!Array.isArray(messages)) {
      console.warn('[gpt-adapter] _syncHistory: messages is not array:', typeof messages);
      return;
    }
    const history = messages
      .filter(m => m && typeof m.content === 'string' && m.content.length > 0)
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }));
    // 去重：如果 history 尾部是本次的 user 新消息，弹掉让 chatStream 去 push。
    // 用 startsWith 而非严格相等 —— renderer 传的 currentText 可能是 fullMessage
    // （含页面上下文/搜索结果），而 session.messages 里存的是原始 text。
    if (history.length > 0) {
      const tail = history[history.length - 1];
      if (tail.role === 'user' && (tail.content === currentText || currentText.startsWith(tail.content) || currentText.endsWith(tail.content))) {
        history.pop();
      }
    }
    console.log(`[gpt-adapter] _syncHistory: ${messages.length} session msgs → ${history.length} history entries (max ${client._maxHistory})`);
    client._conversationHistory = history.slice(-client._maxHistory);
  }

  /**
   * @param {string} sessionId
   * @param {string} text - 用户新消息
   * @param {object} opts
   *   - publish(event): bus 发布回调
   *   - requestId: bus 分配的 id
   *   - history: Array<{role, content}> - 可选，Session.messages 的镜像
   *   - systemPrompt: string - 可选；若不传且 prepareRequest 可用，会自动构造
   *   - clean: bool - 匿名模式，跳过系统上下文 + voice prompt
   *   - auto: bool - Auto 模式（包含路由规则段的 voice prompt）
   *   - model: string (default 'gpt-5.5')
   *   - temperature: number
   *   - images: Array<{base64, mimeType}> 或 Array<string>（b64）
   */
  async send(sessionId, text, { publish, history, systemPrompt, clean, auto, model, temperature, images } = {}) {
    const myEntry = { cancelled: false, promise: null, abort: null };
    const prevEntry = this._inflight.get(sessionId);
    if (prevEntry) {
      prevEntry.cancelled = true;
      try { prevEntry.abort && prevEntry.abort(); } catch {}
    }

    // 和 Claude adapter 对称：无条件调 interrupt（对 GPT 是 no-op if no in-flight）
    try { await this.interrupt(sessionId); } catch (e) { console.warn('[gpt-adapter] interrupt before send failed:', e.message); }

    if (prevEntry) {
      try { await prevEntry.promise; } catch {}
    }

    // 如果在 prev await 期间又被更新的 send 抢占，直接返回 aborted
    const current = this._inflight.get(sessionId);
    if (current && current !== prevEntry && current !== myEntry) {
      return { content: '', sessionId, aborted: true };
    }

    const doRun = async () => {
      const client = this._getClient(sessionId);

      // v2 invariant：每次 send 前把 Session.messages mirror 进 history
      if (history !== undefined) {
        this._syncHistory(client, history, text);
      } else {
        console.warn(`[gpt-adapter] send(${sessionId}): history is undefined! client._conversationHistory has ${client._conversationHistory.length} entries`);
      }

      // Prompt 构造：如果没显式传 systemPrompt 且 main.js 注入了 prepareRequest，
      // 调用它拿到 { systemPrompt, fullMessage, searchResults }
      let finalSystemPrompt = systemPrompt || '';
      let finalMessage = text;
      let searchResults = null;
      if (!systemPrompt && this._prepareRequest) {
        try {
          const prepared = await this._prepareRequest(text, { sessionId, clean: !!clean, auto: !!auto });
          if (prepared) {
            finalSystemPrompt = prepared.systemPrompt || '';
            finalMessage = prepared.fullMessage || text;
            searchResults = prepared.searchResults || null;
          }
        } catch (e) {
          console.warn('[gpt-adapter] prepareRequest failed:', e.message);
        }
      }

      // images 可以是 base64 string 数组（renderer 传的）或 {base64, mimeType} 数组
      const normalizedImages = (images || []).map(img =>
        typeof img === 'string' ? { base64: img, mimeType: 'image/png' } : img
      );

      try {
        // OpenAIDirectClient 的 chatStream 返回一个 promise，带 .abort()
        const streamPromise = client.chatStream(finalMessage, {
          systemPrompt: finalSystemPrompt,
          model,
          temperature,
          images: normalizedImages,
        }, (delta) => {
          if (myEntry.cancelled) return;
          publish && publish({ type: 'delta', content: delta });
        });

        // 把 abort 挂到 myEntry 上，让 interrupt() 能拿到
        myEntry.abort = streamPromise.abort;

        const result = await streamPromise;

        if (myEntry.cancelled) {
          return { content: '', sessionId, aborted: true };
        }

        publish && publish({ type: 'done', content: result.content });
        return {
          content: result.content,
          sessionId,
          usage: result.usage,
          searchResults,
          aborted: false,
        };
      } catch (err) {
        if (myEntry.cancelled) {
          return { content: '', sessionId, aborted: true };
        }
        publish && publish({ type: 'error', content: err.message });
        throw err;
      }
    };

    myEntry.promise = doRun();
    this._inflight.set(sessionId, myEntry);
    try {
      return await myEntry.promise;
    } finally {
      // 只有仍然是最新 entry 才清掉
      if (this._inflight.get(sessionId) === myEntry) {
        this._inflight.delete(sessionId);
      }
    }
  }

  /**
   * interrupt —— abort 当前 in-flight curl 进程。
   * GPT 没有"resume"概念，也没有"外部 task 进程"概念，所以语义比 Claude 简单。
   */
  async interrupt(sessionId) {
    const entry = this._inflight.get(sessionId);
    if (!entry) return false;
    entry.cancelled = true;
    try { entry.abort && entry.abort(); } catch {}
    return true;
  }

  /**
   * attach —— 记录 per-session meta。
   * GPT 没有 resume uuid 要记，只存 origin（chat/task）。
   */
  attach(sessionId, { origin, publish } = {}) {
    const meta = this._getMeta(sessionId);
    if (origin) meta.origin = origin;
    return true;
  }

  forget(sessionId) {
    const entry = this._inflight.get(sessionId);
    if (entry) {
      entry.cancelled = true;
      try { entry.abort && entry.abort(); } catch {}
    }
    this._inflight.delete(sessionId);
    this.clients.delete(sessionId);
    this._meta.delete(sessionId);
  }
}

module.exports = { GPTDirectAdapter };
