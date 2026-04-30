/**
 * ContextInjector — 刀 2 step 3
 *
 * 把散落在 main.js 3 处的 `getRecentProactiveContext` 抽象成"上下文注入器"。
 *
 * 设计要点：
 *   - **不拼 prompt**：injector 的职责只是把 session 需要的上下文组装成一段
 *     plain text，返回给 adapter。adapter 自己决定怎么把它放进 prompt
 *     （system prompt / 拼在 user message 前 / 单独一个 message）。
 *   - **可插拔**：每种上下文是一个"source"，由 name 注册。未来可加：
 *     proactive (pi-main 的最近 ai 消息) / memory (长期记忆索引) /
 *     page (当前浏览器页面) / time (日程 / 节假日) / task (task 状态快照)
 *   - **session meta 驱动**：session 的 meta 里写 `{ contextSources: ['proactive'] }`，
 *     adapter send 前调 `buildContext(sessionId, meta)`，拿到 text 后自己决定怎么用。
 *   - **spike 阶段只实现 proactive**：把 main.js 的 getRecentProactiveContext 原封搬过来。
 *     刀 2 step 4/5 做 renderer/main.js 切换时再把 3 处调用改走 injector。
 *
 * 对应卡片：Cards/active/pibrowser-session-model-v2.md 刀 2
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const VAULT_ROOT = require('./vault-root');
// 2026-04-22 · 分片读：读所有 agent-event-inbox-{host}.jsonl 分片（Syncthing-safe）
// 写端（event-emit.sh / 未来 worker-host daemon）按自己的 host 写自己的分片。
const EVENT_INBOX_DIR   = path.join(VAULT_ROOT, 'Pi', 'State');
const EVENT_INBOX_GLOB  = /^agent-event-inbox(-[a-z0-9-]+)?\.jsonl$/; // 兼容旧无-host 的 legacy
const EVENT_ACK_PATH    = path.join(VAULT_ROOT, 'Pi', 'State', 'agent-event-ack.jsonl');
const DRY_RUN_SESSION_RE = /^(debug|preview|test)-/i;

function isDryRunSessionId(sessionId) {
  return typeof sessionId === 'string' && DRY_RUN_SESSION_RE.test(sessionId);
}

class ContextInjector {
  constructor({ loadSessions, mainSessionId } = {}) {
    if (typeof loadSessions !== 'function') {
      throw new Error('[context-injector] loadSessions function required');
    }
    this._loadSessions = loadSessions;
    this._mainSessionId = mainSessionId || 'pi-main';
    // name -> async (sessionId, options) => string
    this._sources = new Map();

    // 内置：proactive —— 从 pi-main 的最近 ai 消息拉上下文
    this.registerSource('proactive', this._buildProactiveContext.bind(this));
    // 内置：events —— 从 agent-event-inbox 拉未过期且本 session 未 ack 的后台事件
    // 统一感知层：让当前对话 Pi 知道后台刚发生了什么（Phase 2）
    this.registerSource('events', this._buildEventsContext.bind(this));
  }

  /**
   * 注册一种上下文来源。
   * @param {string} name
   * @param {(sessionId: string, options: object) => Promise<string> | string} fn
   */
  registerSource(name, fn) {
    if (!name || typeof fn !== 'function') return;
    this._sources.set(name, fn);
  }

  hasSource(name) { return this._sources.has(name); }

  /**
   * 按 sources 列表组装上下文。
   * @param {string} sessionId
   * @param {object} opts
   *   - sources: string[] — 要组装的 source 名称列表（如 ['proactive']）
   *   - perSourceOptions: { [name]: object } — 每个 source 的额外参数
   * @returns {Promise<string>} 组装好的 text，可能为空字符串
   */
  async buildContext(sessionId, { sources = [], perSourceOptions = {} } = {}) {
    if (!Array.isArray(sources) || sources.length === 0) return '';
    // 注意：sources 自己负责 leading/trailing 换行 —— 这是为了让
    // 替换老 `getRecentProactiveContext` 等函数时 drop-in 兼容（它们原样返回
    // 带首尾 \n 的块）。buildContext 只做拼接，不 trim，不加额外分隔符。
    const blocks = [];
    const dryRun = isDryRunSessionId(sessionId);
    for (const name of sources) {
      const fn = this._sources.get(name);
      if (!fn) continue;
      try {
        const text = await fn(sessionId, {
          ...(perSourceOptions[name] || {}),
          dryRun
        });
        if (text && typeof text === 'string') blocks.push(text);
      } catch (e) {
        console.warn(`[context-injector] source "${name}" failed:`, e.message);
      }
    }
    return blocks.join('');
  }

  // ── 内置 sources ──────────────────────────────────────────────────

  /**
   * proactive：主会话 (pi-main) 最近 N 条 ai 消息。
   * 原地搬 main.js `getRecentProactiveContext`，**保持 output 格式 1:1 不变**
   * （包含首尾 \n）—— 替换时 drop-in 兼容老 call site 的字符串拼接。
   */
  _buildProactiveContext(sessionId, { maxMessages = 5 } = {}) {
    try {
      const data = this._loadSessions();
      const main = data.sessions.find(s => s.id === this._mainSessionId);
      if (!main || !main.messages || !main.messages.length) return '';
      // 2026-04-22 修：_appendPiMainProactive 写入通知时用 role:'assistant'，
      // 而此处原过滤只认 'ai'——导致所有 Pi 主动通知对下一轮对话不可见。
      // 改为接受两种 role（兼容历史 'ai' + 通知 'assistant'）。
      // 详见 Phase 2b Step 0 / `feedback_role_ai_vs_assistant.md`
      const recent = main.messages.slice(-maxMessages * 2)
        .filter(m => m.role === 'ai' || m.role === 'assistant')
        .slice(-maxMessages);
      if (!recent.length) return '';
      const lines = recent.map(m => {
        // 老消息用 timestamp，_appendPiMainProactive 写的通知用 ts——两种都兼容
        const tsRaw = m.timestamp || m.ts;
        const time = tsRaw
          ? new Date(tsRaw).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
          : '';
        return `[${time}] ${String(m.content || '').substring(0, 300)}`;
      });
      return `\n## Pi 最近说过的话（主会话）\n${lines.join('\n')}\n`;
    } catch { return ''; }
  }

  /**
   * events：后台事件（worker 完成 / 系统告警 / proactive）的统一感知通道。
   *
   * 读 Pi/State/agent-event-inbox.jsonl 按以下规则过滤：
   *   1. 未过期（expires_at > now，若缺失则保守不发）
   *   2. 本 session 未 ack（agent-event-ack.jsonl 里没有 {event_id, sessionId} 记录）
   *   3. priority <= 3（P4 静默）
   *
   * 返回后立即为每个被注入的事件追加 ack，避免下一轮重复注入。
   * 这是本 session 视角的 ack —— 其他 session 独立追踪自己的 ack。
   *
   * 设计依据：Pi/Output/infra/unified-agent-awareness-design-2026-04-22.md (v2) §3.1–3.3
   */
  _buildEventsContext(sessionId, { maxItems = 5, includeReflexed = false, dryRun = false } = {}) {
    try {
      // 分片读：glob 所有 agent-event-inbox-{host}.jsonl + 兼容 legacy agent-event-inbox.jsonl
      let events = [];
      if (fs.existsSync(EVENT_INBOX_DIR)) {
        for (const name of fs.readdirSync(EVENT_INBOX_DIR)) {
          if (!EVENT_INBOX_GLOB.test(name)) continue;
          try {
            const raw = fs.readFileSync(path.join(EVENT_INBOX_DIR, name), 'utf-8');
            for (const line of raw.split('\n')) {
              if (!line) continue;
              try { events.push(JSON.parse(line)); } catch {}
            }
          } catch {}
        }
      }
      if (!events.length) return '';

      // 读本 session 已 ack 的 event_id 集合
      const acked = new Set();
      if (fs.existsSync(EVENT_ACK_PATH)) {
        const ackRaw = fs.readFileSync(EVENT_ACK_PATH, 'utf-8');
        for (const line of ackRaw.split('\n')) {
          if (!line) continue;
          try {
            const a = JSON.parse(line);
            if (a.session_id === sessionId && a.event_id) acked.add(a.event_id);
          } catch {}
        }
      }

      const now = Date.now();
      const filtered = events.filter(e => {
        if (!e.event_id) return false;
        if (acked.has(e.event_id)) return false;
        const exp = e.expires_at ? new Date(e.expires_at).getTime() : NaN;
        if (!isFinite(exp) || exp < now) return false;
        const pri = typeof e.priority === 'number' ? e.priority : 3;
        if (pri > 3) return false; // P4 静默
        return true;
      });
      if (!filtered.length) return '';

      // 按 priority 升序（P1 在前）+ ts 降序（新在前）
      filtered.sort((a, b) => {
        const pa = typeof a.priority === 'number' ? a.priority : 3;
        const pb = typeof b.priority === 'number' ? b.priority : 3;
        if (pa !== pb) return pa - pb;
        return (b.ts || '').localeCompare(a.ts || '');
      });
      const picked = filtered.slice(0, maxItems);

      // 已 reflex 过的事件用不同语气（避免重复吼）
      // reflex_sent_at 字段由 pi-speak 在 fireReflex 成功时回填（Phase 2b 扩展；
      // Phase 2 MVP 先不读该字段，所有 critical 统一用"刚才"表述）
      const lines = picked.map(e => {
        const level = (e.level || '').toUpperCase();
        const src = e.source ? `[${e.source}] ` : '';
        const head = level === 'CRITICAL'
          ? (e.reflex_sent_at ? '[刚才已气泡告知]' : '[紧急]')
          : level === 'REPORT'
          ? '[后台完成]'
          : '[事件]';
        const detail = e.detail ? ` — ${String(e.detail).slice(0, 160)}` : '';
        return `${head} ${src}${String(e.summary || '').slice(0, 200)}${detail}`;
      });

      // debug/preview/test session 只做预览，不消费事件 ack，避免自测污染真实会话。
      if (!dryRun) {
        try {
          fs.mkdirSync(path.dirname(EVENT_ACK_PATH), { recursive: true });
          const ts = new Date().toISOString();
          const ackLines = picked.map(e =>
            JSON.stringify({ event_id: e.event_id, session_id: sessionId, ts })
          ).join('\n') + '\n';
          fs.appendFileSync(EVENT_ACK_PATH, ackLines, 'utf-8');
        } catch (e) {
          console.warn('[context-injector] event ack write failed:', e.message);
        }
      }

      return `\n## 后台刚发生的事（你应该知道，可在回答里自然转述）\n${lines.join('\n')}\n`;
    } catch (e) {
      console.warn('[context-injector] events source failed:', e.message);
      return '';
    }
  }
}

module.exports = { ContextInjector };
