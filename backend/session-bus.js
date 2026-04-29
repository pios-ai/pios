/**
 * SessionBus — PiBrowser session model v2 (刀 1)
 *
 * 每一个 session 在 registry 里是一个一等对象。send/interrupt/attach 通过 engine
 * adapter 分派；事件带 {sessionId, requestId} 发布，renderer 按 id 路由，不再靠
 * "当前在哪个 session" 的闭包快照。
 *
 * 本文件只管骨架 — 具体 send/interrupt 语义由 adapter 决定。
 * 对应卡片：Cards/active/pibrowser-session-model-v2.md
 */

const EventEmitter = require('events');

function _genRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class SessionBus {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(200);
    this.sessions = new Map(); // sessionId -> { id, engine, adapter, state, meta }
    this.adapters = new Map(); // engineKey -> adapter
  }

  registerAdapter(engineKey, adapter) {
    if (!adapter || typeof adapter.send !== 'function') {
      throw new Error(`[session-bus] adapter for "${engineKey}" missing send()`);
    }
    this.adapters.set(engineKey, adapter);
    console.log(`[session-bus] adapter registered: ${engineKey}`);
  }

  hasAdapter(engineKey) { return this.adapters.has(engineKey); }

  /**
   * Ensure a session is registered. Idempotent — returns existing entry if id
   * already known (engine may not change on re-register).
   */
  registerSession(sessionId, engineKey, meta = {}) {
    if (!sessionId) throw new Error('[session-bus] sessionId required');
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const adapter = this.adapters.get(engineKey);
    if (!adapter) throw new Error(`[session-bus] no adapter for engine "${engineKey}"`);
    const session = {
      id: sessionId,
      engine: engineKey,
      adapter,
      state: 'idle',
      meta,
      pending: new Map(), // requestId -> { promise, startedAt }
    };
    this.sessions.set(sessionId, session);
    this._publishRaw(sessionId, { type: 'registered', engine: engineKey });
    return session;
  }

  getSession(sessionId) { return this.sessions.get(sessionId); }

  forgetSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try { session.adapter.forget && session.adapter.forget(sessionId); } catch {}
    this.sessions.delete(sessionId);
  }

  /** 订阅某个 session 的事件。返回 unsubscribe 函数。 */
  subscribe(sessionId, handler) {
    const ch = `session:${sessionId}`;
    this.emitter.on(ch, handler);
    return () => this.emitter.off(ch, handler);
  }

  /** 订阅所有 session 的事件（主进程转发给 renderer 用）。 */
  subscribeAll(handler) {
    this.emitter.on('session:any', handler);
    return () => this.emitter.off('session:any', handler);
  }

  /** 内部：发布事件到 session channel 和全局 channel。 */
  _publishRaw(sessionId, event) {
    const payload = { sessionId, ts: Date.now(), ...event };
    this.emitter.emit(`session:${sessionId}`, payload);
    this.emitter.emit('session:any', payload);
  }

  _setState(session, state) {
    if (session.state === state) return;
    session.state = state;
    this._publishRaw(session.id, { type: 'state', state });
  }

  _syncStateFromPending(session) {
    if (!session) return;
    if (session.pending.size === 0) {
      this._setState(session, 'idle');
      return;
    }
    const hasActive = Array.from(session.pending.values()).some((entry) => !entry.interrupted);
    this._setState(session, hasActive ? 'running' : 'interrupting');
  }

  /**
   * 发送消息到某个 session。adapter 通过回调把事件流 publish 到 bus。
   * 返回 { content, sessionId, requestId, ... }（adapter 自己的最终结果形状）。
   */
  async send(sessionId, text, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`[session-bus] unknown session ${sessionId}`);
    const requestId = opts.requestId || _genRequestId();
    const publish = (event) => this._publishRaw(sessionId, { requestId, ...event });

    const pending = { requestId, startedAt: Date.now(), interrupted: false };
    session.pending.set(requestId, pending);
    this._syncStateFromPending(session);
    publish({ type: 'request-start', text: text.slice(0, 200) });

    // ⚠ 2026-04-29 dispatch timeout 兜底 — 防 adapter hang 卡死前端 streaming state。
    // 根因：早先 send() 是裸 await adapter.send，adapter hang 多久 pending 就挂多久；
    // 前端 streaming pill 永不重置、stop 按钮也跟着失效（PiBrowser pi-main chat 1h 内卡 6 次的根本）。
    // 默认 180s 对 chat 足够；codex 长任务路径继续传 opts.timeoutMs 覆盖。
    // 不 cancel inner promise（Promise.race 限制）— 让 adapter 自然结束，但前端先解套。
    const TIMEOUT_MS = (opts && opts.timeoutMs) || 180_000;
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`session-bus dispatch timeout after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        session.adapter.send(sessionId, text, {
          ...opts,
          requestId,
          publish,
        }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutHandle);
      publish({ type: 'request-done', result: summarizeResult(result) });
      return { ...result, requestId };
    } catch (err) {
      clearTimeout(timeoutHandle);
      publish({ type: 'error', content: err && err.message || String(err) });
      throw err;
    } finally {
      session.pending.delete(requestId);
      this._syncStateFromPending(session);
    }
  }

  /**
   * 打断正在执行的 session（adapter 决定具体 kill 路径）。
   * tick 7：async —— task session 的 SIGINT 需要 wait jsonl 写完，最长 10s
   */
  async interrupt(sessionId, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!session.adapter.interrupt) return false;
    const targetIds = opts.requestId
      ? [opts.requestId].filter((id) => session.pending.has(id))
      : Array.from(session.pending.keys());
    if (targetIds.length === 0) return false;
    const ok = !!(await session.adapter.interrupt(sessionId, opts));
    if (ok) {
      for (const requestId of targetIds) {
        const pending = session.pending.get(requestId);
        if (pending) pending.interrupted = true;
        this._publishRaw(sessionId, { type: 'interrupted', requestId });
      }
      this._syncStateFromPending(session);
    }
    return ok;
  }

  /** 触发 adapter 的 attach 行为（初次打开已有 session 时用）。 */
  async attach(sessionId, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.adapter.attach) {
      await session.adapter.attach(sessionId, {
        ...opts,
        publish: (event) => this._publishRaw(sessionId, event),
      });
    }
    return true;
  }
}

function summarizeResult(r) {
  if (!r) return null;
  if (typeof r === 'string') return r.slice(0, 120);
  if (r.content) return { contentLength: r.content.length, sessionId: r.sessionId };
  return r;
}

let _bus = null;
function getSessionBus() {
  if (!_bus) _bus = new SessionBus();
  return _bus;
}

module.exports = { SessionBus, getSessionBus };
