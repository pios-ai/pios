'use strict';

/**
 * wechat-aggregator.js — WeChat 出口聚合器
 *
 * 目的：让 Pi 在 owner away≥30min 时不再每条 intent 独立发微信，而是攒一段
 *       自然话一起发，像真人一样。
 *
 * 输入：pi-route.sendWeChat 在 away≥30min 时不直接发，enqueue 到本模块
 * 输出：按条件触发时，GPT 合成一段 → 真实 sendWeChat
 *
 * 触发条件（任一满足就合成发出）：
 *   A. queue 条目数 ≥ AGG_MIN_ITEMS（默认 3）
 *   B. 最早条目 age ≥ AGG_MAX_OLDEST_MIN 分钟（默认 20，兜底不憋死）
 *   C. 最新条目 age ≥ AGG_MAX_NEWEST_MIN 分钟（默认 5，没新东西就收）
 *
 * 去重（避免 WeChat 和 PiBrowser 说同一件事）：
 *   发送前读 pi-speak-log 最近 10min 的 text 集合，移除 queue 中已经 bubble 过的条目
 *
 * 失败兜底：
 *   GPT 合成失败（timeout / error）→ fallback 到逐条立发（回到现状，不丢）
 *
 * 不做的（明确边界）：
 *   - critical 级别不经本模块（调用方直接 sendWeChat，立发多通道）
 *   - present 不经本模块（bubble 本地）
 *   - away<30min 不经本模块（pending 队列，回来 flush）
 *
 * 2026-04-23 owner approved spec — 参数默认值如上，可调。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const VAULT_ROOT = require('./vault-root');
// M1: 按 host 分片，防多机 Syncthing 冲突。host 解析见 backend/lib/host-resolve.js。
const { resolveHost } = require('./lib/host-resolve');
const QUEUE_PATH = path.join(VAULT_ROOT, 'Pi', 'Inbox', `wechat-pending-queue-${resolveHost()}.jsonl`);
const SPEAK_LOG = path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-speak-log.jsonl');
// 2026-04-28 Phase 6: aggregator 合成走 owner-facing → 用 relationship-stance.md（不是 BOOT.md）
const PERSONA_PATH = path.join(VAULT_ROOT, 'Pi', 'Config', 'relationship-stance.md');

// 可调参数（owner 2026-04-23 默认）
const AGG_MIN_ITEMS = 3;                      // 攒满几条就合成
const AGG_MAX_OLDEST_MS = 20 * 60 * 1000;     // 最早条目超这么久兜底合成
const AGG_MAX_NEWEST_MS =  5 * 60 * 1000;     // 最新条目静默这么久就合成
const DEDUP_WINDOW_MS   = 10 * 60 * 1000;     // pi-speak-log 最近这么久去重
const GPT_TIMEOUT_MS    = 15000;              // GPT 合成超时

// 2026-04-23 H4 race 防线：aggregator tick 中途 owner 回到电脑 → flushPending
// 并发读 queue + 发送会双发（微信 + bubble 都冒）。
// 修法：tick 开始时置 _inFlight=true；flushPending 先 requestAbort() + 等 _inFlight
// 落下，再读 queue。aggregator 发现 _abortRequested 就放弃 send / 不清 queue，
// 让 flushPending 真正接手。
let _inFlight = false;
let _abortRequested = false;
function isInFlight() { return _inFlight; }
function requestAbort() { _abortRequested = true; }

// 2026-04-27：跨进程 file lock。原 _inFlight 是 in-memory，main.js + cron drainer
// 同时跑会同时拿到 queue → 同段聚合发 2 次。lock 文件 `Pi/State/locks/wechat-
// aggregator-tick.lock.json` 含 pid + ts，TTL 60s（aggregator tick 含 GPT 合成
// 不会超过这个）。
const LOCK_PATH = path.join(VAULT_ROOT, 'Pi/State/locks/wechat-aggregator-tick.lock.json');
const LOCK_TTL_MS = 60 * 1000;

function _tryAcquireFileLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    // 看老 lock 是否过期
    if (fs.existsSync(LOCK_PATH)) {
      try {
        const old = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
        const ageMs = Date.now() - new Date(old.ts).getTime();
        if (ageMs < LOCK_TTL_MS) return false; // 别人持有，未过期
        // 过期：清掉继续抢
      } catch { /* 损坏视作过期 */ }
    }
    // wx 模式独占创建（atomic on POSIX）
    const fd = fs.openSync(LOCK_PATH, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), ts: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false; // 别人刚抢到
  }
}

function _releaseFileLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

function _ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
}

function _readQueue() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    const raw = fs.readFileSync(QUEUE_PATH, 'utf-8');
    return raw.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function _writeQueue(items) {
  try {
    const body = items.map(o => JSON.stringify(o)).join('\n') + (items.length ? '\n' : '');
    require('./lib/atomic-write').writeAtomic(QUEUE_PATH, body);
  } catch (e) { console.error('[wechat-aggregator] writeQueue failed:', e.message); }
}

// 2026-04-24 修：不仅 setInterval 触发 tick。任何 intent 进 queue 时也 fire-and-forget
// 调一次 tick 评估——这样"≥3 条"和"最早 age ≥20min"两个条件能在 enqueue 时立即捕获，
// 不依赖 setInterval（macOS 睡眠时 setInterval 会暂停，aggregator 整夜不动）。
// 外部 caller 注入一个 wake-fn（main.js 把它挂到实际 tick 上）。
let _onEnqueueCb = null;
function setOnEnqueueTickCb(cb) { _onEnqueueCb = (typeof cb === 'function') ? cb : null; }

function enqueueForAggregation({ text, source, level = 'info', ts = null, expires_at = null } = {}) {
  if (!text) return;
  const items = _readQueue();
  items.push({
    ts: ts || new Date().toISOString(),
    text, source, level, expires_at,
  });
  _writeQueue(items);
  // fire-and-forget：不阻塞 pi-route.send 的返回
  if (_onEnqueueCb) {
    try { Promise.resolve().then(() => _onEnqueueCb()).catch(() => {}); } catch {}
  }
}

// 读最近 pi-speak-log 得到"已 bubble 过"的 text 集合
//
// 2026-04-27 修 self-dedup bug：
// fireReflex 在 routed='wechat-pending-aggregation' 时也无条件写 speak-log
// （type:'reflex' routed:'wechat-pending-aggregation'）。aggregator tick 后续
// 扫 speak-log 看到自己刚 enqueue 那条 → 当成"已发过" → filter 掉 → queue 清
// 空 → **从来没真发**。owner 04-27 全天 6 条 reminder 全部走这条 self-dedup。
//
// 修：dedup 只看**真发出去**的 entries——routed.startsWith('wechat-pending')
// 或 'pending-' 的是"还在排队"，不算已发。channel-aggregation 等代表真发的
// 才算。同时 source=test/smoke 也排除避免污染。
function _recentlySpokenTexts() {
  try {
    if (!fs.existsSync(SPEAK_LOG)) return new Set();
    const raw = fs.readFileSync(SPEAK_LOG, 'utf-8');
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const out = new Set();
    for (const line of raw.split('\n').slice(-200)) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        const t = o.ts ? new Date(o.ts).getTime() : NaN;
        if (!isFinite(t) || t < cutoff) continue;
        // 排除 self-poison：还在 pending 等发的不算"已发过"
        const routed = String(o.routed || '');
        if (routed.startsWith('wechat-pending') || routed.startsWith('pending-')) continue;
        if (routed.startsWith('reflex-redirected') || routed.startsWith('suppressed-')) continue;
        if ((o.source || '') === 'smoke-test') continue;
        if (o.text) out.add(o.text);
      } catch {}
    }
    return out;
  } catch { return new Set(); }
}

function _shouldTrigger(items) {
  if (!items.length) return false;
  if (items.length >= AGG_MIN_ITEMS) return { reason: 'min-items' };
  const now = Date.now();
  const oldest = new Date(items[0].ts).getTime();
  if (isFinite(oldest) && (now - oldest) >= AGG_MAX_OLDEST_MS) return { reason: 'oldest-age' };
  const newest = new Date(items[items.length - 1].ts).getTime();
  if (isFinite(newest) && (now - newest) >= AGG_MAX_NEWEST_MS) return { reason: 'newest-static' };
  return false;
}

async function _gptCompose(items) {
  const { getOpenAIDirectClient } = require('./openai-direct-client');
  const client = getOpenAIDirectClient();
  client.reset();

  let persona = '';
  try { persona = fs.readFileSync(PERSONA_PATH, 'utf-8').slice(0, 2000); } catch {}

  const now = new Date();
  const hours = Math.floor((now.getTime() - new Date(items[0].ts).getTime()) / 3600000);
  const minsAgo = Math.max(1, Math.round((now.getTime() - new Date(items[items.length - 1].ts).getTime()) / 60000));

  const itemLines = items.map(it => {
    const hhmm = new Date(it.ts).toTimeString().slice(0,5);
    return `[${hhmm}] (${it.source || 'pi'} · ${it.level || 'info'}) ${it.text}`;
  }).join('\n');

  const systemPrompt = `${persona}

---

你是 Pi。owner 离开键盘至少 30 分钟了——你现在要通过微信跟他说话。

在他离开这段时间里，后台攒下了下面这些事。不要把它们一条条念给他——没人爱看这种。
把它们揉成**一段自然的话**，像你在跟他讲话一样。

格式要求：
- **纯文本，不能用 <say> 标签**（微信里标签不会被 TTS，会被当字面字符显示）
- 30-120 字，不要冗长
- 不要列点（一个人跟你讲事不列点）
- 只说真正值得知道的；没分量的事（例行 triage 完成、selftest）可以直接略掉
- 不客套，不"以上是总结"这种废话
- 按上面"关系姿态"写：第一人称、不报告头、敢反对、带着今日 mood

如果读下来你觉得真没什么值得打扰 owner 的，**直接输出一个字：NONE**——我会跳过不发。`;

  const userMessage = `owner 已离开 ${hours}小时，最后一条事件是 ${minsAgo}分钟前。这段期间攒到的事件：

${itemLines}

把它揉成一段发给 owner。`;

  const gptPromise = client.chat(userMessage, { systemPrompt, timeout: GPT_TIMEOUT_MS });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('GPT aggregate timeout')), GPT_TIMEOUT_MS));
  const result = await Promise.race([gptPromise, timeoutPromise]);
  let text = (result?.content || '').trim();
  // 清掉可能混入的 <say> 标签（prompt 已要求但兜底）
  text = text.replace(/<\/?say[^>]*>/gi, '').trim();
  return text;
}

/**
 * tick：由 main.js 按 setInterval 定期调，或在 enqueue 后立即调。
 * 返回 { fired: boolean, reason, sent?: string, fallback?: boolean }
 */
// 2026-04-26 加埋点：owner 反映"没收到微信"无 log 可查。每次 tick 落盘。
const DEBUG_LOG = path.join(VAULT_ROOT, 'Pi/Log/wechat-aggregator-debug.log');
function _dbg(obj) {
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${JSON.stringify(obj)}\n`);
  } catch {}
}

async function tick({ sendWeChatDirect }) {
  if (_inFlight) { _dbg({ev:'tick-skip',reason:'already-in-flight'}); return { fired: false, reason: 'already-in-flight' }; }
  // 跨进程锁：防 main.js + cron drainer 同时 tick
  if (!_tryAcquireFileLock()) {
    _dbg({ev:'tick-skip',reason:'file-lock-held-by-other'});
    return { fired: false, reason: 'file-lock-held-by-other' };
  }
  _inFlight = true;
  _abortRequested = false;
  try {
    const items = _readQueue();
    if (!items.length) { _dbg({ev:'tick-skip',reason:'empty'}); return { fired: false, reason: 'empty' }; }

    // 去重：已在 pi-speak-log 最近 10min 出现过的文本移除
    const spoken = _recentlySpokenTexts();
    const filtered = items.filter(it => !spoken.has(it.text));
    if (!filtered.length) {
      _writeQueue([]);  // 全被去重，清空
      _dbg({ev:'tick-clear',reason:'all-deduped',count_in:items.length});
      return { fired: false, reason: 'all-deduped' };
    }

    const trig = _shouldTrigger(filtered);
    if (!trig) { _dbg({ev:'tick-wait',reason:'not-yet',count:filtered.length}); return { fired: false, reason: 'not-yet', count: filtered.length }; }

    // 触发合成
    _dbg({ev:'tick-fire-start',reason:trig.reason,count:filtered.length,first_ts:filtered[0].ts,last_ts:filtered[filtered.length-1].ts});
    let composed;
    try {
      composed = await _gptCompose(filtered);
    } catch (e) {
      console.error('[wechat-aggregator] GPT compose failed, fallback to per-item:', e.message);
      // Abort 检查：GPT 期间 owner 回来了 → flushPending 要接管，放弃这轮
      if (_abortRequested) {
        console.log('[wechat-aggregator] abort requested during compose failure, yielding to flushPending');
        return { fired: false, reason: 'aborted-by-flush', count: filtered.length };
      }
      // Fallback: 逐条直发（回到老行为，消息不丢）
      if (typeof sendWeChatDirect === 'function') {
        for (const it of filtered) {
          try { await sendWeChatDirect(it.text, it.source); } catch (ee) { console.error('[wechat-aggregator] per-item send failed:', ee.message); }
        }
      }
      _writeQueue([]);
      return { fired: true, reason: trig.reason, fallback: true, count: filtered.length };
    }

    // 2026-04-23 H4: 发送前再检查 abort —— GPT 期间 owner 回来 flushPending 会接管
    if (_abortRequested) {
      console.log('[wechat-aggregator] abort requested after compose, yielding to flushPending');
      return { fired: false, reason: 'aborted-by-flush', count: filtered.length };
    }

    if (!composed || composed === 'NONE') {
      // Pi 自己判断没啥值得说 → 不发，清 queue
      _writeQueue([]);
      _dbg({ev:'tick-suppress',reason:'gpt-NONE',count:filtered.length,items:filtered.map(it=>({src:it.source,text:String(it.text||'').slice(0,80)}))});
      return { fired: true, reason: trig.reason, composed: 'NONE', suppressed: true };
    }

    // 真发
    let sendErr = null;
    if (typeof sendWeChatDirect === 'function') {
      try {
        await sendWeChatDirect(composed, 'wechat-aggregator');
      } catch (e) {
        sendErr = e.message;
        console.error('[wechat-aggregator] sendWeChatDirect failed:', e.message);
      }
    }
    _writeQueue([]);
    _dbg({ev:'tick-sent',reason:trig.reason,count:filtered.length,composed:String(composed).slice(0,200),sendErr});
    return { fired: true, reason: trig.reason, sent: composed, count: filtered.length };
  } finally {
    _inFlight = false;
    _abortRequested = false;
    _releaseFileLock();
  }
}

/**
 * 给 main.js 用：在 "owner 回来" 时立即 flush 未发的 queue，防止他进电脑后微信又冒出来。
 */
function dropQueueOnReturn() {
  try {
    if (fs.existsSync(QUEUE_PATH)) _writeQueue([]);
  } catch {}
}

module.exports = {
  enqueueForAggregation,
  setOnEnqueueTickCb,
  tick,
  dropQueueOnReturn,
  isInFlight,
  requestAbort,
  // H4 race 防线（flushPending 用）
  isInFlight,
  requestAbort,
  // 导出参数给测试用
  _AGG_MIN_ITEMS: AGG_MIN_ITEMS,
  _AGG_MAX_OLDEST_MS: AGG_MAX_OLDEST_MS,
  _AGG_MAX_NEWEST_MS: AGG_MAX_NEWEST_MS,
};
