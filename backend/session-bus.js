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

    const pending = { requestId, startedAt: Date.now(), interrupted: false };
    session.pending.set(requestId, pending);
    this._syncStateFromPending(session);

    // Idle watchdog, not a wall-clock deadline.
    //
    // Codex/Claude can legitimately run for many minutes while emitting tool,
    // usage, profile, or text events. A fixed Promise.race(180s) marked those
    // healthy runs as failed and made the eventual completion look like a ghost
    // result. The watchdog is reset by every published event, so only a truly
    // silent adapter is treated as stuck.
    const IDLE_TIMEOUT_MS = Number(opts.idleTimeoutMs || opts.timeoutMs || 10 * 60_000);
    let lastActivityAt = Date.now();
    let timeoutHandle;
    let timeoutReject;
    let watchdogActive = true;
    const resetIdleTimer = () => {
      if (!watchdogActive) return;
      if (!IDLE_TIMEOUT_MS || IDLE_TIMEOUT_MS <= 0) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        const idleFor = Date.now() - lastActivityAt;
        const msg = `session-bus idle timeout after ${idleFor}ms without events`;
        timeoutReject && timeoutReject(new Error(msg));
      }, IDLE_TIMEOUT_MS);
    };
    const stopIdleTimer = () => {
      watchdogActive = false;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = null;
    };
    const publish = (event) => {
      lastActivityAt = Date.now();
      resetIdleTimer();
      this._publishRaw(sessionId, { requestId, ...event });
    };
    const timeoutPromise = new Promise((_, reject) => {
      timeoutReject = reject;
      resetIdleTimer();
    });

    publish({ type: 'request-start', text: text.slice(0, 200) });

    try {
      const result = await Promise.race([
        session.adapter.send(sessionId, text, {
          ...opts,
          requestId,
          publish,
        }),
        timeoutPromise,
      ]);
      stopIdleTimer();
      publish({ type: 'request-done', result: summarizeResult(result) });
      return { ...result, requestId };
    } catch (err) {
      stopIdleTimer();
      publish({ type: 'error', content: err && err.message || String(err) });
      throw err;
    } finally {
      stopIdleTimer();
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
