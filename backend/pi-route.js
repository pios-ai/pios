'use strict';

/**
 * pi-route.js — presence-aware 通知统一出口（Pi 觉醒 P6 Phase 6A）
 *
 * 所有"Pi 要发声"的代码都走这里。根据 presence 决定通道：
 *   present              → 本地（NPC bubble + notify.sh）；report 额外走 WeChat
 *   away <30min          → 憋住，进 pending 队列，回来时补发
 *   away ≥30min          → 走 WeChat（openclaw）
 *   unknown              → 退化本地 + 低打扰；report 走 WeChat
 *
 * priority=critical      → 忽略 presence，多通道同发（token 失控 / 服务宕机 / 健康警报）
 *
 * Usage:
 *   const piRoute = require('./pi-route');
 *   await piRoute.send({
 *     text: "Pi 的晚报...",
 *     level: "info",       // info | report | critical
 *     source: "evening-brief",
 *     audience: "owner",   // owner（默认）| self（只写日志不通知）
 *   });
 */

const fs   = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { getPresence } = require('./presence');

const VAULT_ROOT   = require('./vault-root');
const PENDING_PATH = path.join(VAULT_ROOT, 'Pi', 'State', 'pi-pending-messages.jsonl');
const NOTIFY_SH    = path.join(VAULT_ROOT, 'Pi', 'Tools', 'notify.sh');
const MANIFEST_PATH = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
const ROUTE_ARCHIVE_PATH = path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-route-archive.jsonl');

// M1: 按 host 分片，防止跨机 Syncthing 冲突。host 解析见 backend/lib/host-resolve.js。
const { resolveHost: _resolveHost } = require('./lib/host-resolve');
function _wechatQueuePath() {
  return path.join(VAULT_ROOT, 'Pi', 'Inbox', `wechat-pending-queue-${_resolveHost()}.jsonl`);
}

// 2026-04-22 · message TTL 架构（Afterward 事件根治，Phase 1 地基）：
//   每条 intent/send 必带 expires_at（或从 level 默认值推导），入口即检查是否过期。
//   过期只归档到 pi-route-archive.jsonl，不走任何通道（notify/bubble/wechat）。
const LEVEL_DEFAULT_TTL_MS = {
  critical: 10 * 60 * 1000,
  warning:  30 * 60 * 1000,
  reminder: 30 * 60 * 1000,
  report:    2 * 3600 * 1000,
  info:      4 * 3600 * 1000,
  silent:   10 * 60 * 1000,
};
function _computeExpiresAt({ expires_at, ts, level }) {
  if (expires_at) {
    const n = new Date(expires_at).getTime();
    if (!isNaN(n)) return n;
  }
  const baseTs = ts ? new Date(ts).getTime() : Date.now();
  const ttl = LEVEL_DEFAULT_TTL_MS[level] || LEVEL_DEFAULT_TTL_MS.reminder;
  return baseTs + ttl;
}

// 2026-04-20 Bug C 修复：openclaw 标 down 时直接写 outbox，跳过 5-10s ssh 死等。
// 读 pios.yaml infra.runtimes.openclaw.status。auth-health-check（0 * * * *）每小时刷。
// feedback_openclaw_binary_not_auth.md：binary 存在 ≠ channel 活。
//
// 2026-04-22 Bug D 修复：auth-health-check 不含 openclaw 探针，pios.yaml 里的
// openclaw.status 可能永远停在 'down'（本例：down_since 2026-04-14，8 天未刷新）。
// 修复：down_since > 2h → 状态过期，不信任，让 send() 实际尝试。
const _OPENCLAW_DOWN_TTL_MS = 2 * 3600 * 1000; // 2h stale threshold
function _isOpenclawDown() {
  try {
    const yaml = require('js-yaml');
    const manifest = yaml.load(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const runtime = manifest?.infra?.runtimes?.openclaw;
    if (!runtime || runtime.status !== 'down') return false;
    // Check staleness: if down_since is older than TTL, treat as unknown → try send
    const downSince = runtime.down_since;
    if (downSince) {
      const ageMs = Date.now() - new Date(downSince).getTime();
      if (ageMs > _OPENCLAW_DOWN_TTL_MS) return false; // stale, assume recovered
    }
    return true;
  } catch {
    return false; // 读失败当未知，按旧行为 try subprocess
  }
}

const AWAY_SHORT_MS    =  30 *  60 * 1000; // <30min: 憋住
// ≥30min: WeChat

// ── 原子 append（tmp 追加 + rename 是过度，jsonl 用 O_APPEND 也原子）──
function appendJsonl(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', { flag: 'a' });
  } catch (e) {
    console.error('[pi-route] appendJsonl failed:', e.message);
  }
}

// ── 本地 notify.sh ──
// P7 Stage 2 · 2026-04-19：notify.sh 变成 pi-speak 的 shell wrapper。
// 我们要做的只是"写 pi_notify.json 做本地 macOS toast"，不是走完整 pi-speak 流程。
// 设 PIOS_NOTIFY_FROM_ROUTE=1 让 notify.sh 走 legacy 分支（避免 pi-route ↔ pi-speak ↔ notify.sh 递归）。
function sendLocalNotify(level, text, expiresAtIso = null) {
  if (process.env.PIOS_TEST_MODE === '1') return { ok: true, channel: 'notify', dryRun: true };
  try {
    const env = { ...process.env, PIOS_NOTIFY_FROM_ROUTE: '1' };
    if (expiresAtIso) env.PIOS_NOTIFY_EXPIRES_AT = expiresAtIso;
    execSync(`bash "${NOTIFY_SH}" ${level} ${JSON.stringify(text)}`, {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { ok: true, channel: 'notify' };
  } catch (e) {
    console.error('[pi-route] notify.sh failed:', e.message);
    return { ok: false, channel: 'notify', error: e.message };
  }
}

// ── 本地 bubble（只显 NPC 气泡，不进 pi-main session 不触发 Claude 回复）──
// 2026-04-19 晚修复：原本用 mainWindow.webContents.send('pios:talk', text)，
// 但那个通道是"用户输入"通道（renderer 把 text 当 user turn 塞 pi-main session）→
// Claude 会把 Pi 主动发的话当成用户说话然后真的回复 → 自问自答 bug。
// 改走 global._npcSpeak → bubble:pulse speak 通道，只显 NPC TTL 气泡。
// 见 feedback_pi_speaks_not_pios_talk.md。
function sendLocalBubble(mainWindow, text) {
  // 注意：TEST_MODE 下不 short-circuit，因为 smoke test 把 global._npcSpeak 换成
  // mock capturer（不会真冒气泡），而 T4.c 要校验 `_npcSpeak` 被调到。
  try {
    // 首选 global._npcSpeak（main.js 定义，走 bubbleWin + bubble:pulse speak）
    if (typeof global._npcSpeak === 'function') {
      global._npcSpeak(text);
      return { ok: true, channel: 'bubble', via: '_npcSpeak' };
    }
    // Fallback: 直接 bubble:pulse speak（mainWindow 作为广播源，renderer/bubble 都会收到）
    if (mainWindow && !mainWindow.isDestroyed?.()) {
      mainWindow.webContents.send('bubble:pulse', { type: 'speak', text });
      return { ok: true, channel: 'bubble', via: 'bubble:pulse-fallback' };
    }
  } catch (e) {
    console.error('[pi-route] bubble send failed:', e.message);
  }
  return { ok: false, channel: 'bubble', error: 'no _npcSpeak and no mainWindow' };
}

// ── WeChat via notify-wechat.sh（已封装 openclaw ssh 逻辑）──
// 本机有 openclaw 直接发，否则自动 ssh worker-host 发。
// 2026-04-19 验证 openclaw codex 通道已通（"hi" → "hi，派总在"）。
const NOTIFY_WECHAT_SH = path.join(VAULT_ROOT, 'Pi', 'Tools', 'notify-wechat.sh');

// 2026-04-24 晚：owner 微信被 ai-ecommerce P0 critical 连轰 6 条（pi-speak-log
// 和 notify-history 都只 1 条，说明 openclaw gateway / notify-wechat 下游重放，
// 不是 Pi 层问题）。Pi 层 defensive 加 idempotency：同 level+text hash 10 分钟内
// 只走一次 sendWeChat。openclaw 真根因另排查。
const crypto = require('crypto');
const WECHAT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const NOTIFY_HISTORY = path.join(VAULT_ROOT, 'Pi/Log/notify-history.jsonl');

function _wechatDedupHash(level, text) {
  return crypto.createHash('sha1').update(String(level) + '\n' + String(text)).digest('hex').slice(0, 16);
}

function _recentWeChatSent(level, text) {
  try {
    if (!fs.existsSync(NOTIFY_HISTORY)) return null;
    const raw = fs.readFileSync(NOTIFY_HISTORY, 'utf-8');
    const cutoff = Date.now() - WECHAT_DEDUP_WINDOW_MS;
    const targetHash = _wechatDedupHash(level, text);
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 300; i--) {
      if (!lines[i]) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (!o.ts) continue;
      const t = new Date(o.ts).getTime();
      if (!isFinite(t) || t < cutoff) break;
      if (_wechatDedupHash(o.level || '', o.msg || '') === targetHash) return o;
    }
  } catch {}
  return null;
}

function _extractMessageId(raw) {
  try {
    const seen = new Set();
    const stack = [JSON.parse(raw)];
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      for (const [key, value] of Object.entries(item)) {
        if (/message_?id/i.test(key) && value) return String(value);
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  } catch {}
  return null;
}

function sendWeChat(text, source, expiresAtIso = null, level = 'info') {
  if (process.env.PIOS_TEST_MODE === '1') return { ok: true, channel: 'wechat', dryRun: true };
  const outboxPath = path.join(VAULT_ROOT, 'Pi', 'Inbox', 'openclaw-outbox.jsonl');

  // Idempotency：同 level+text 10min 内已发过 → 静默 skip（防 openclaw gateway
  // 或 downstream 重放把 Pi 也连带进去）
  const prior = _recentWeChatSent(level, text);
  if (prior) {
    return {
      ok: true, channel: 'wechat', skipped: 'dedup-10min',
      prior_ts: prior.ts, prior_host: prior.host || null,
    };
  }

  // Pre-gate：已知 down 就别试，直接写 outbox。省 5-10s ssh 死等 + 不骗自己"发成功"。
  // 2026-04-22：outbox entry 必带 expires_at（或缺省由 outbox-drain 按 ts+level 默认 TTL 推导）
  if (_isOpenclawDown()) {
    appendJsonl(outboxPath, {
      ts: new Date().toISOString(),
      to: 'owner', channel: 'wechat', source: source || 'pi-route', text,
      expires_at: expiresAtIso || undefined,
      skipped: 'openclaw-down-per-manifest',
    });
    return { ok: false, channel: 'wechat', skipped: 'openclaw-down', note: '已写入 outbox 等 retry' };
  }

  try {
    // notify-wechat.sh 接一个位置参数；shell-escape by JSON.stringify 避免特殊字符
    // 2026-04-27：timeout 10s → 30s。openclaw via ssh 实测 8-12s 常见，10s 卡线
    // 经常假超时（spawnSync ETIMEDOUT 但 openclaw 实际已发出）→ 进 outbox →
    // outbox-drain retry → owner 收 2-3 条 + mirror 重 inject。30s 给充足余量。
    const out = execSync(`bash "${NOTIFY_WECHAT_SH}" ${JSON.stringify(text)}`, {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, channel: 'wechat', messageId: _extractMessageId(out), output: (out || '').slice(0, 1000) };
  } catch (e) {
    // 失败 fallback：写入 outbox 作为异步重发备胎
    appendJsonl(outboxPath, {
      ts: new Date().toISOString(),
      to: 'owner', channel: 'wechat', source: source || 'pi-route', text,
      expires_at: expiresAtIso || undefined,
      failed_sync: e.message,
    });
    return { ok: false, channel: 'wechat', error: e.message, note: '已写入 outbox 等 retry' };
  }
}

// ── 主函数 ──
async function send({ text, level = 'info', source = 'unknown', audience = 'owner', mainWindow = null, expires_at = null, ts = null } = {}) {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: 'empty text' };
  }

  // ── TTL 入口检查（2026-04-22 Afterward 事件根治）──
  const effectiveTs = ts || new Date().toISOString();
  const effectiveExpMs = _computeExpiresAt({ expires_at, ts: effectiveTs, level });
  if (effectiveExpMs < Date.now()) {
    appendJsonl(ROUTE_ARCHIVE_PATH, {
      ts: effectiveTs, text, level, source, audience,
      expires_at: new Date(effectiveExpMs).toISOString(),
      archived_reason: 'expired_at_send_entry',
    });
    return { ok: true, routed: 'archived-expired', archived: true };
  }
  const effectiveExpIso = new Date(effectiveExpMs).toISOString();

  // 日志留档
  const logEntry = { ts: effectiveTs, text, level, source, audience, expires_at: effectiveExpIso };

  // audience=self 只写日志不通知
  if (audience === 'self') {
    appendJsonl(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-route-log.jsonl'), { ...logEntry, routed: 'self-only' });
    return { ok: true, routed: 'self-only' };
  }

  // critical 忽略 presence，多通道同发
  if (level === 'critical') {
    const r1 = sendLocalNotify('critical', text, effectiveExpIso);
    const r2 = mainWindow ? sendLocalBubble(mainWindow, text) : { channel: 'bubble', ok: false, skip: 'no mainWindow' };
    const r3 = sendWeChat(text, source, effectiveExpIso, level);
    appendJsonl(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-route-log.jsonl'),
      { ...logEntry, routed: 'critical-multichannel', results: [r1, r2, r3] });
    return { ok: true, routed: 'critical-multichannel', results: [r1, r2, r3] };
  }

  // 常规：按 presence 分档
  const presence = getPresence();
  const idleMs = (presence.idle_s || 0) * 1000;

  let routed, result;

  if (presence.status === 'present') {
    const r1 = sendLocalNotify(level, text, effectiveExpIso);
    const r2 = mainWindow ? sendLocalBubble(mainWindow, text) : null;
    if (level === 'report') {
      const r3 = sendWeChat(text, source, effectiveExpIso, level);
      routed = 'report-wechat-present';
      result = { notify: r1, bubble: r2, wechat: r3 };
    } else {
      routed = 'local-present';
      result = { notify: r1, bubble: r2 };
    }
  } else if (presence.status === 'unknown') {
    // 不知道 → report 按规范走 WeChat；其他级别退化本地（低打扰，info→silent）
    const r1 = sendLocalNotify(level === 'info' ? 'silent' : level, text, effectiveExpIso);
    if (level === 'report') {
      const r2 = sendWeChat(text, source, effectiveExpIso, level);
      routed = 'report-wechat-unknown';
      result = { notify: r1, wechat: r2 };
    } else {
      routed = 'local-unknown-fallback';
      result = { notify: r1 };
    }
  } else {
    // away
    if (idleMs < AWAY_SHORT_MS) {
      // <30min 憋住，进 pending 队列，回来时 flushPending 合成一段 bubble
      appendJsonl(PENDING_PATH, logEntry);
      // 2026-04-28 Gap1 修复：reminder/report 同时走 wechat-aggregator，保证手机收到
      // 若 owner 在 aggregator drain 前回来 → flushPending 合并两个队列清空，不双发
      // 若 owner 未回来（aggregator drain 后）→ 微信已发，pending 回来时 GPT 自然合成
      if (level === 'reminder' || level === 'report') {
        try {
          const agg = require('./wechat-aggregator');
          agg.enqueueForAggregation({ text, source, level, ts: effectiveTs, expires_at: effectiveExpIso });
          routed = 'pending-short-wechat';
          result = { pending: true, wechat_queued: true };
        } catch (e) {
          console.warn('[pi-route] wechat enqueue failed in pending-short:', e.message);
          routed = 'pending-short';
          result = { pending: true };
        }
      } else {
        routed = 'pending-short';
        result = { pending: true };
      }
    } else {
      // ≥30min：不再立发 WeChat，进 aggregator 队列攒几条再合成一段发
      // critical 仍走立发（上面 critical 分支已处理，不到这里）。
      // 2026-04-23 owner approved spec: wechat-aggregator 统一揉成一段人话再发
      //
      // 2026-04-27：恢复全量 aggregator 路径。原 04-26 加的 report/reminder-
      // wechat-away-direct 旁路（cron/CLI 后台 !mainWindow → 直发）废掉了节流。
      // 04-26 一晚 owner 被 7 条独立 wechat 砸（4 条走旁路 + 3 条聚合）。
      // 现在 cron 路径仍 enqueue，由独立 drainer cron 调 tick()。aggregator 加
      // 跨进程 file lock 防 main.js + cron 同跑 race。
      try {
        const agg = require('./wechat-aggregator');
        agg.enqueueForAggregation({ text, source, level, ts: effectiveTs, expires_at: effectiveExpIso });
        routed = 'wechat-pending-aggregation';
        result = { wechat_queued: true };
      } catch (e) {
        // aggregator 失败则 fallback 立发（回到老行为，消息不丢）
        console.warn('[pi-route] aggregator failed, fallback direct send:', e.message);
        const r1 = sendWeChat(text, source, effectiveExpIso, level);
        routed = 'wechat-long-away-fallback';
        result = { wechat: r1 };
      }
    }
  }

  appendJsonl(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-route-log.jsonl'),
    { ...logEntry, routed, idle_s: presence.idle_s, presence_status: presence.status, result });

  return { ok: true, routed, presence: presence.status, idle_s: presence.idle_s, result };
}

// ── 回放 pending 队列（当 presence 从 away→present 时调用）──
// 2026-04-23 改：不再按 source 分组发多个 bubble，改用 GPT 合成"一段人话"。
// owner 说 "像一个人一样" —— 一个人朋友回来会讲一段，不会给你 3 个气泡。
// 同时：若 wechat-aggregator 还有 queue 未发，也合进这一段（去重 4：既然你
// 回到电脑前了，微信就不再说同样的事）。
async function flushPending(mainWindow) {
  // 2026-04-23 H4: 先让 aggregator tick 放弃本轮 send。
  // aggregator 可能正在 GPT compose 中（15s），requestAbort 置 flag，tick 发现就放弃。
  // 等最多 16s 让 in-flight tick 自然落下。
  try {
    const agg = require('./wechat-aggregator');
    if (typeof agg.requestAbort === 'function') agg.requestAbort();
    if (typeof agg.isInFlight === 'function') {
      const deadline = Date.now() + 16000;
      while (agg.isInFlight() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch {}

  // 读 local pending
  let items = [];
  try {
    if (fs.existsSync(PENDING_PATH)) {
      items = fs.readFileSync(PENDING_PATH, 'utf-8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch {}

  // 合并 wechat-aggregator 未发的 queue（那些本来要发微信的，现在你回来了不发了）
  let wechatQueued = [];
  try {
    const wqPath = _wechatQueuePath();
    if (fs.existsSync(wqPath)) {
      wechatQueued = fs.readFileSync(wqPath, 'utf-8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch {}

  const merged = [...items, ...wechatQueued].sort((a, b) =>
    String(a.ts || '').localeCompare(String(b.ts || '')));

  if (!merged.length) return { flushed: 0 };

  // 尝试 GPT 合成一段
  let bubbleText = null;
  let usedGpt = false;
  try {
    const { getOpenAIDirectClient } = require('./openai-direct-client');
    const client = getOpenAIDirectClient();
    client.reset();

    // 2026-04-28 Phase 6: 读关系姿态（owner-facing path）。BOOT.md 现在只是指针。
    let persona = '';
    try {
      persona = fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'relationship-stance.md'), 'utf-8').slice(0, 3000);
    } catch {}

    const itemLines = merged.map(it => {
      const hhmm = it.ts ? new Date(it.ts).toTimeString().slice(0,5) : '';
      return `[${hhmm}] (${it.source || 'pi'}) ${it.text}`;
    }).join('\n');

    const systemPrompt = `${persona}

---

你是 Pi。owner 刚回到电脑前。他不在的这段时间里，后台攒了下面这些事。

把它们揉成**一段自然的话**给他——就像一个朋友回来你凑过去讲几件事。

格式要求：
- 纯文本，不要 markdown 列表 / <say> 标签
- 30-120 字，不要冗长
- 只说真正值得知道的；没分量的事（例行 triage 完成、selftest、已过期的提醒）可以直接略
- 不客套，不"以上是总结"这种废话
- 按上面"关系姿态"写：第一人称真用 / 不报告头 / 敢反对 / 带着今日 mood

如果读下来真没什么值得打扰 owner 的，直接输出一个字：NONE —— 我会跳过。`;

    const userMessage = `owner 刚回到电脑。这段期间攒到的事件：\n\n${itemLines}\n\n揉成一段讲给他。`;

    const gptP = client.chat(userMessage, { systemPrompt, timeout: 15000 });
    const toP = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('flush GPT timeout')), 15000));
    const result = await Promise.race([gptP, toP]);
    let text = (result?.content || '').trim().replace(/<\/?say[^>]*>/gi, '').trim();
    if (text && text !== 'NONE') {
      bubbleText = text;
      usedGpt = true;
    } else if (text === 'NONE') {
      bubbleText = null; // 真没值得说 → 安静
    }
  } catch (e) {
    console.warn('[pi-route] flushPending GPT failed, fallback to simple merge:', e.message);
  }

  // Fallback: 老的 by-source 分组（不损失消息）
  if (bubbleText === null && !usedGpt) {
    const bySource = {};
    for (const obj of merged) {
      const k = obj.source || 'unknown';
      if (!bySource[k]) bySource[k] = [];
      bySource[k].push(obj);
    }
    const pieces = [];
    for (const [src, its] of Object.entries(bySource)) {
      if (its.length === 1) pieces.push(`[${src}] ${its[0].text}`);
      else pieces.push(`[${src}] 攒了 ${its.length} 条：\n` +
        its.map((it, i) => `${i + 1}. ${(it.text || '').slice(0, 100)}`).join('\n'));
    }
    bubbleText = pieces.join('\n\n');
  }

  // 发 bubble（如果有文本）+ TTS + 回写 pi-main
  // 2026-04-23 修 3 个漏：
  //  1) 之前只 sendLocalBubble → 气泡弹了但没念（sendLocalBubble 不走 TTS，TTS 走
  //     sendLocalNotify 通过 pi_notify.json watcher）
  //  2) 没调 _appendPiMainProactive → Pi 下一轮回忆"我刚说啥"会空
  //  3) source=flush-pending 让 sessions.json meta.source 能标识来源
  if (bubbleText) {
    try { sendLocalBubble(mainWindow, bubbleText); } catch (e) {
      console.warn('[flushPending] bubble failed:', e.message);
    }
    try { sendLocalNotify('report', bubbleText); } catch (e) {
      console.warn('[flushPending] notify/TTS failed:', e.message);
    }
    // 回写 pi-main：主进程里 global._appendPiMainProactive 可用
    if (typeof global._appendPiMainProactive === 'function') {
      try { global._appendPiMainProactive(bubbleText, 'flush-pending'); } catch (e) {
        console.warn('[flushPending] proactive append failed:', e.message);
      }
    }
  }

  // 清空两个队列（你回来了，这段攒的就算结了）
  try { fs.writeFileSync(PENDING_PATH, ''); } catch {}
  try {
    const wqPath = _wechatQueuePath();
    if (fs.existsSync(wqPath)) fs.writeFileSync(wqPath, '');
  } catch {}

  appendJsonl(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-route-log.jsonl'),
    { ts: new Date().toISOString(), routed: 'flush-pending',
      flushed: merged.length, used_gpt: usedGpt,
      suppressed: bubbleText === null,
      pending_items: items.length, wechat_queued: wechatQueued.length });

  return { flushed: merged.length, used_gpt: usedGpt, suppressed: bubbleText === null };
}

module.exports = { send, flushPending, sendWeChat };
