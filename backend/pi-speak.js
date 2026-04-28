'use strict';

/**
 * pi-speak.js — Pi 说话意识的统一入口 (P7 Stage 1 · 2026-04-19)
 *
 * 三类 API：
 *   1. proposeIntent()   —— 意识源（triage 自报 / sense-maker / evening-brief / chitchat / life）
 *                          提交 "我想说 X"，不直接发。triage 下个 tick（≤15min）统一决策。
 *   2. fireReflex()       —— 反射源（critical 警报 / greet 相遇 / 实时对话回复）
 *                          立即发，跳过决策层。
 *   3. triage Step 8 配套：
 *      - loadPendingIntents()    triage 读队列
 *      - writeDecision()         triage 写决策
 *      - executeDecision()       执行手臂按决策实际发送
 *      - clearConsumedIntents()  triage 处理完清理队列
 *
 * 所有发出的话统一 append 到：
 *   - Pi/Log/pi-speak-log.jsonl       （P7 新日志，Home Notifications 未来入口）
 *   - Pi/Log/notify-history.jsonl     （老日志，兼容 Home Operation Notifications 面板 —— Stage 2 phase out）
 *
 * 架构图：
 *
 *   反射源 ───────────────────────> fireReflex() ──> pi-route.send() ──> 出口
 *                                          └──────> pi-speak-log.jsonl
 *                                          └──────> notify-history.jsonl
 *
 *   意识源 ─> proposeIntent() ─> pi-speak-intents.jsonl
 *                                          │
 *                                          ▼
 *                                  triage.md Step 8（LLM）
 *                                          │
 *                                          ▼
 *                              pi-speak-decisions.jsonl
 *                                          │
 *                                          ▼
 *                                 executeDecision() ──> pi-route.send() ──> 出口
 *                                          └──────> pi-speak-log.jsonl
 *                                          └──────> notify-history.jsonl
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const VAULT_ROOT = require('./vault-root');
const INTENTS_PATH   = path.join(VAULT_ROOT, 'Pi/State/pi-speak-intents.jsonl');
const DECISIONS_PATH = path.join(VAULT_ROOT, 'Pi/State/pi-speak-decisions.jsonl');
const SPEAK_LOG      = path.join(VAULT_ROOT, 'Pi/Log/pi-speak-log.jsonl');
const NOTIFY_HISTORY = path.join(VAULT_ROOT, 'Pi/Log/notify-history.jsonl');
const EVENT_INBOX_DIR  = path.join(VAULT_ROOT, 'Pi', 'State');
const EVENT_INBOX_GLOB = /^agent-event-inbox(-[a-z0-9-]+)?\.jsonl$/;

function appendJsonl(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
  } catch (e) { console.error('[pi-speak] append failed:', filePath, e.message); }
}

function appendNotifyHistory(level, source, msg) {
  // 兼容 Home · Notifications 老面板的 schema: {ts, level, host, msg}
  try {
    const host = (require('os').hostname().split('.')[0] || 'unknown').toLowerCase();
    const ts = new Date().toISOString();
    appendJsonl(NOTIFY_HISTORY, { ts, level, host, msg, source });
  } catch {}
}

function markReflexSent(eventId, reflexSentAt) {
  if (!eventId || !fs.existsSync(EVENT_INBOX_DIR)) return false;
  let updated = false;
  try {
    for (const name of fs.readdirSync(EVENT_INBOX_DIR)) {
      if (!EVENT_INBOX_GLOB.test(name)) continue;
      const filePath = path.join(EVENT_INBOX_DIR, name);
      let changed = false;
      const lines = [];
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        for (const line of raw.split('\n')) {
          if (!line) continue;
          let entry = null;
          try { entry = JSON.parse(line); } catch {}
          if (entry && entry.event_id === eventId && !entry.reflex_sent_at) {
            entry.reflex_sent_at = reflexSentAt;
            changed = true;
            updated = true;
          }
          lines.push(entry ? JSON.stringify(entry) : line);
        }
      } catch (e) {
        console.error('[pi-speak] markReflexSent read failed:', filePath, e.message);
        continue;
      }
      if (!changed) continue;
      try {
        const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
        fs.renameSync(tmp, filePath);
      } catch (e) {
        console.error('[pi-speak] markReflexSent write failed:', filePath, e.message);
      }
    }
  } catch (e) {
    console.error('[pi-speak] markReflexSent failed:', e.message);
  }
  return updated;
}

// ── Pi 主动话回写 pi-main session（2026-04-20 裂缝修复）───────────────────
// 让 Talk to Pi 看到 Pi 主动说过什么。
// ⚠️ 2026-04-22 跨进程补丁：
//   pi-speak.js 有两种 caller：(A) PiOS Electron 主进程（global._appendPiMainProactive
//   已注册），(B) claude-cli 子进程（triage/work/sense-maker/evening-brief 以 node -e
//   方式 require pi-speak 调 fireReflex/executeDecision）。子进程里没有 global，
//   原先 if 条件直接 no-op → 这些 agent 触发的通知全部不进 pi-main，Pi 下轮对话
//   完全看不到自己说过什么（22:04 evening-brief 那条丢的根因）。
//
//   修法：检测到 global 不在时 append 到 Pi/Inbox/pi-main-proactive-queue.jsonl，
//   主进程 watchFile 拉到后统一走 _appendPiMainProactive。和 pi-speak-queue.jsonl
//   同样的 cross-process pattern。
// M1: 按 host 分片，防多机 Syncthing 冲突（曾遇 pi-main-proactive-queue
// .sync-conflict 实例）。host 解析见 backend/lib/host-resolve.js。
const { resolveHost: _resolveHost } = require('./lib/host-resolve');
const PI_MAIN_PROACTIVE_QUEUE = path.join(VAULT_ROOT, 'Pi', 'Inbox', `pi-main-proactive-queue-${_resolveHost()}.jsonl`);
function _appendToMainSession(text, source, routed) {
  if (!routed) return;
  if (routed === 'self-only') return;
  if (routed.startsWith('pending-')) return;
  if (typeof global._appendPiMainProactive === 'function') {
    // A. 主进程：直接调
    try { global._appendPiMainProactive(text, source); } catch {}
  } else {
    // B. 子进程：append queue，主进程 watcher 读后补写 pi-main
    try {
      appendJsonl(PI_MAIN_PROACTIVE_QUEUE, {
        ts: new Date().toISOString(),
        text, source,
        routed,
      });
    } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1. 意识源：提交 intent
// ══════════════════════════════════════════════════════════════════════

function proposeIntent({ source, level = 'info', text, priority = 3, data = null, urgency = 'normal', expires_at = null } = {}) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'empty text' };
  const intent = {
    id: `intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    source, level, text, priority, data, urgency,
    expires_at,
    status: 'pending',
  };
  appendJsonl(INTENTS_PATH, intent);
  return { ok: true, intent };
}

// ══════════════════════════════════════════════════════════════════════
// 1.5 Triage 发声硬 gate（2026-04-24 重构 · pi-architect 扫完后）
// ══════════════════════════════════════════════════════════════════════
// 之前我贴了两层 regex 签名 gate（dump 字面模板 + card_id 30min subset），
// owner 狠狠打脸："你追皮永远追不完"——LLM 每次换措辞这两层就穿。根因是我没
// 走 pi-architect 扫系统。扫完发现 `Pi/Tools/pi-owner-attention-guard.py`
// **已经在按 {card_id}:{needs_owner_type} 的集合计 SHA256 signature**，
// 三命令 snapshot / should-notify / mark-sent；state 持久化在
// `Pi/Log/triage-owner-attention-state-{host}.json`；
// **owner 的 ack 回路也已通**——卡 frontmatter 的 owner_response 字段有值，
// guard 自动把该卡从 attention set 中剔除 → signature 变 → 下轮放行一次。
//
// 以前的问题：triage.md prompt 里**建议** LLM 自己调 guard，LLM 没听。
// 现在的正解：把 guard 挪到 pi-speak 代码层硬 gate。source=triage+level=
// report 时 fireReflex 自己调 Python guard，exit 1/json.should_notify=false
// → 静默归档，不走 owner 通道。LLM 怎么换皮都绕不过。
//
// 失败姿态：guard 缺失 / Python 崩 / 超时 → **fail-open**（照常放行）。
// 宁可多一条噪音，不能因为 infra 故障吞掉 legit report。
//
// 删了的旧东西：_isTriageSnapshotNoise（签名 dump 判定）+
// _triageReportDedup（30min card_id regex 对账）+ _extractCardIds
// （card_id 集合提取）。guard 精准覆盖，不需要了。

const { execFileSync } = require('child_process');
const TRIAGE_ATTENTION_ARCHIVE = path.join(VAULT_ROOT, 'Pi/Log/triage-attention-gate-archive.jsonl');
const OWNER_ATTENTION_GUARD = path.join(VAULT_ROOT, 'Pi/Tools/pi-owner-attention-guard.py');

function _parseGuardJson(buf) {
  try {
    const parsed = JSON.parse(buf.toString('utf-8'));
    return {
      shouldNotify: !!parsed.should_notify,
      reason: parsed.reason || '',
      signature: parsed.signature || '',
      attention_count: parsed.attention_count ?? 0,
      critical_count: parsed.critical_count ?? 0,
      added: parsed.added || [],
      removed: parsed.removed || [],
    };
  } catch { return null; }
}

function _triageAttentionGuardCheck() {
  // 返回 { shouldNotify, reason, signature, attention_count, ... } 或
  // { error, shouldNotify: true }（fail-open）。
  try {
    if (!fs.existsSync(OWNER_ATTENTION_GUARD)) {
      return { error: 'guard_missing', shouldNotify: true };
    }
    const host = _canonicalHost();
    const out = execFileSync('python3', [OWNER_ATTENTION_GUARD, 'should-notify', '--host', host], {
      timeout: 5000,
    });
    const parsed = _parseGuardJson(out);
    if (parsed) return parsed;
    return { error: 'guard_parse_failed', shouldNotify: true };
  } catch (e) {
    // exit code 1 = shouldNotify false（guard 正常返回）。execFileSync 抛异常但 stdout 仍有 JSON
    if (e.stdout) {
      const parsed = _parseGuardJson(e.stdout);
      if (parsed) return parsed;
    }
    return { error: e.message || 'guard_exec_failed', shouldNotify: true };
  }
}

function _triageAttentionGuardMarkSent() {
  try {
    const host = _canonicalHost();
    execFileSync('python3', [OWNER_ATTENTION_GUARD, 'mark-sent', '--host', host], { timeout: 5000 });
    return true;
  } catch (e) {
    console.warn('[pi-speak] guard mark-sent failed:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1.6 Triage 文本合成（2026-04-24 晚 · owner 继续打脸后）
// ══════════════════════════════════════════════════════════════════════
// gate 放行 ≠ 内容合格。gate 只看 card 集合 signature，LLM 放行后照样能吐
// "微信摄入 72 条 / orphan 升级 / blocked 10 张" 这种工作日志（owner 17:16
// 被砸的原因）。
//
// 正解：gate 放行后 **丢弃 LLM 的 text 参数**，pi-speak 代码层读 guard
// 返回的 added cards list，直接从卡 frontmatter 合成一句人话：
//   "有件事要你看：{needs_owner_brief / decision_brief / title}"
// LLM 不参与文本生成。triage.md prompt 爱咋写咋写，反正 text 会被覆写。
//
// added 为空（signature 变只因 removed / type 变化）→ 不发声，静默
// mark-sent（没有新事要告诉 owner）。

function _readCardFrontmatter(folder, slug) {
  try {
    const p = path.join(VAULT_ROOT, 'Cards', folder, `${slug}.md`);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    const fm = {};
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (!mm) continue;
      let v = mm[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fm[mm[1]] = v;
    }
    return fm;
  } catch { return null; }
}

function _synthesizeTriageText(guard) {
  const added = Array.isArray(guard.added) ? guard.added : [];
  if (added.length === 0) return null; // 只有 removed / type 变 → 不打扰
  const cards = [];
  for (const key of added) {
    // key 格式："active:card-slug:type" 或 "inbox:card-slug:type"
    const parts = String(key).split(':');
    if (parts.length < 2) continue;
    const folder = parts[0];
    const slug = parts[1];
    const fm = _readCardFrontmatter(folder, slug);
    if (!fm) continue;
    let brief = fm.needs_owner_brief || fm.decision_brief || fm.title || slug.replace(/-/g, ' ');
    brief = String(brief).replace(/^["'「『]/, '').replace(/["'」』]$/, '').trim();
    // 截短防长 brief
    if (brief.length > 100) brief = brief.slice(0, 100) + '…';
    const priority = parseInt(fm.priority, 10) || 9;
    cards.push({ slug, brief, priority });
  }
  if (cards.length === 0) return null;
  cards.sort((a, b) => a.priority - b.priority);
  const top = cards[0];
  // 一句人话 —— 不带 markdown、不带 emoji、不提 card_id、不提 "还有 N 件"
  return `有件事要你看：${top.brief}`;
}

// ══════════════════════════════════════════════════════════════════════
// 2. 反射源：跳过决策立即发（critical / greet / 实时回复）
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// Phase 1 (2026-04-27) · Voice-as-Subject 第一刀：fireReflex 入口分流
// ══════════════════════════════════════════════════════════════════════
// 根问题：fireReflex 设计为"立发跳过 judge"，但被滥用到所有 report——多 source
// 同时间各自调 fireReflex，judge 看不到全局 → owner 04-26 短 2.5h 8 条独立微信、
// pi-greet 5 次"悬了"同 tone。
//
// 翻转：fireReflex 只服务**真时效敏感**的少数：
//   - critical (系统宕机/token 死线/健康警报) — 时效不可接受
//   - reminder (健康/补剂/睡眠) — 误时即失效
//   - pi-greet (相遇问候) — 延迟 = 失约
//   - pi-main / pi-main-* (实时对话回复) — 用户在等
// 其他全部 → proposeIntent → triage Step 8 judge → executeDecision。这样 judge
// 看全局 pending pool，统一决策"现在哪条该说 / 合并 / 推迟 / 改写 / 丢弃"。
//
// 例外：source=triage + level=report 还是先经 owner-attention-guard 兜底（保留
// 既有逻辑 - guard 拦"已说过的 needs_owner 集合"，比 triage Step 8 更便宜更先）。
const REFLEX_TIMELY_LEVELS = new Set(['critical', 'reminder']);
const REFLEX_TIMELY_SOURCES = new Set(['pi-greet', 'pi-main', 'pi-small-promise']);
function _shouldBypassJudge({ source, level }) {
  if (REFLEX_TIMELY_LEVELS.has(level)) return true;
  if (REFLEX_TIMELY_SOURCES.has(source)) return true;
  // pi-main-* 这种 prefix（未来扩展）
  if (typeof source === 'string' && source.startsWith('pi-main-')) return true;
  return false;
}

async function fireReflex({ source, text, level = 'info', mainWindow = null, expires_at = null, ts = null, eventId = null } = {}) {
  if (!text) return { ok: false, error: 'empty text' };

  // ── Triage report 优先走 owner-attention-guard（最便宜的拦截）──
  // signature 未变 → 静默归档不进 pool（不污染 judge 视野）。
  // signature 变 + 有 added → 用 brief 合成 text，**然后** redirect 到 pool 让 judge 决策时机。
  if (source === 'triage' && level === 'report') {
    const g = _triageAttentionGuardCheck();
    if (!g.error && !g.shouldNotify) {
      // bootstrap 额外 mark-sent 建基线
      if (g.reason === 'bootstrap_missing_state') _triageAttentionGuardMarkSent();
      try {
        appendJsonl(TRIAGE_ATTENTION_ARCHIVE, {
          ts: new Date().toISOString(),
          suppressed_as: 'owner-attention-gate',
          source, level,
          text_len: String(text).length,
          text_preview: String(text).slice(0, 300),
          guard: g,
        });
      } catch {}
      return { ok: true, routed: 'suppressed-attention-gate', suppressed: true, guard: g };
    }
    if (!g.error && g.shouldNotify) {
      // gate 放行 → **丢弃 LLM 的 text，代码层从 added cards 合成一句人话**。
      // LLM 已经反复证明 gate 放行后会吐工作日志垃圾（17:16 "微信 72 条 /
      // orphan 升级"），所以 text 参数根本不信。
      const synthesized = _synthesizeTriageText(g);
      if (!synthesized) {
        // signature 变但 added 空（只 removed / type 变）→ 无新事要告，静默 mark-sent
        _triageAttentionGuardMarkSent();
        try {
          appendJsonl(TRIAGE_ATTENTION_ARCHIVE, {
            ts: new Date().toISOString(),
            suppressed_as: 'owner-attention-gate-no-added',
            source, level,
            text_len: String(text).length,
            text_preview: String(text).slice(0, 300),
            guard: g,
          });
        } catch {}
        return { ok: true, routed: 'suppressed-attention-no-added', suppressed: true, guard: g };
      }
      // 覆写 text + mark-sent
      text = synthesized;
      _triageAttentionGuardMarkSent();
    }
  }

  // ── Phase 1 voice-as-subject 分流 ──
  // attention-guard 放行后 / 非 triage 类的 source：除时效敏感外，全部 redirect
  // 到 intent pool，由 triage Step 8 看全局 + owner context 决策何时说、合并、改写、推迟。
  if (!_shouldBypassJudge({ source, level })) {
    const r = proposeIntent({ source, level, text, expires_at, urgency: 'normal' });
    return {
      ok: true,
      routed: 'reflex-redirected-to-pool',
      intent_id: r.intent?.id,
      note: 'voice-as-subject Phase 1: 等 triage Step 8 judge 全局决策',
    };
  }

  // ── 真时效敏感：critical / reminder / pi-greet / pi-main / pi-small-promise ──
  // 立发，不进 pool（延迟不可接受）。Phase 2 会进一步限制 pi-greet 同 tone 重复。
  const piRoute = require('./pi-route');
  const r = await piRoute.send({ text, level, source, audience: 'owner', mainWindow, expires_at, ts });
  // 过期归档分支：不写 speak-log / notify-history / main-session，避免"过期消息假装被说过"
  if (r && r.archived) return r;
  const reflexSentAt = new Date().toISOString();
  if (eventId) markReflexSent(eventId, reflexSentAt);
  appendJsonl(SPEAK_LOG, {
    ts: reflexSentAt, source, level, text, expires_at, event_id: eventId || undefined,
    type: 'reflex', routed: r.routed, result: r.result,
  });
  appendNotifyHistory(level, source, text);
  _appendToMainSession(text, source, r.routed);
  return r;
}

// ══════════════════════════════════════════════════════════════════════
// 3. triage Step 8 配套
// ══════════════════════════════════════════════════════════════════════

function loadPendingIntents() {
  if (!fs.existsSync(INTENTS_PATH)) return [];
  try {
    return fs.readFileSync(INTENTS_PATH, 'utf-8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeDecision(decision) {
  // decision: { intent_id, action: 'speak'|'defer'|'merge'|'drop', channel?, text?, level?, source?, reason? }
  appendJsonl(DECISIONS_PATH, { ...decision, ts: new Date().toISOString() });
}

async function executeDecision(decision, mainWindow = null) {
  // ── Phase 2 (2026-04-27) · judge 输出多维 ──
  // decision schema 扩展：
  //   action:         'speak' | 'defer' | 'merge' | 'drop'
  //   text:           原文（兜底）
  //   rewrite_text:   judge 改写后的 text（优先于 text）
  //   tone:           判定 tone 标签（warm/neutral/concerned/playful/serious/short）
  //   tone_note:      给后续 generate 看的提示（如"owner 刚说累，短一点别表演"）
  //   merge_with:     合并到另一 intent_id（content 由 judge 已写在 rewrite_text）
  //   defer_until:    ISO 时间，到期由 triage 重判
  //   reason:         决策理由（短语）
  // pi-speak 这里只负责执行 + 持久化；judge 的智能在 triage Step 8 prompt 内。
  const piRoute = require('./pi-route');
  const finalText = decision.rewrite_text || decision.text;
  const entry = {
    ts: new Date().toISOString(),
    intent_id: decision.intent_id,
    source: decision.source || 'pi-speak',
    text: finalText,
    original_text: decision.text && decision.rewrite_text && decision.text !== decision.rewrite_text ? decision.text : undefined,
    level: decision.level || 'info',
    action: decision.action,
    reason: decision.reason,
    tone: decision.tone || undefined,
    tone_note: decision.tone_note || undefined,
    merge_with: decision.merge_with || undefined,
    defer_until: decision.defer_until || undefined,
  };

  if (decision.action !== 'speak') {
    entry.executed = false;
    appendJsonl(SPEAK_LOG, entry);
    return { ok: true, executed: false, action: decision.action, tone: decision.tone };
  }

  // Triage report 硬 gate：executeDecision 路径也必须走和 fireReflex 相同的
  // owner-attention guard。旧的 text-dedup 函数已移除，不能在这里继续调用。
  let text = finalText;  // Phase 2: 用 rewrite_text 优先
  if ((decision.source || 'pi-speak') === 'triage' && (decision.level || 'info') === 'report') {
    const g = _triageAttentionGuardCheck();
    if (!g.error && !g.shouldNotify) {
      if (g.reason === 'bootstrap_missing_state') _triageAttentionGuardMarkSent();
      appendJsonl(TRIAGE_ATTENTION_ARCHIVE, {
        ts: new Date().toISOString(),
        suppressed_as: 'owner-attention-gate',
        source: decision.source || 'pi-speak',
        level: decision.level || 'info',
        text_len: String(text || '').length,
        text_preview: String(text || '').slice(0, 300),
        guard: g,
      });
      entry.executed = false;
      entry.suppressed = 'owner-attention-gate';
      appendJsonl(SPEAK_LOG, entry);
      return { ok: true, executed: false, suppressed: true, action: 'speak-suppressed-attention-gate', guard: g };
    }
    if (!g.error && g.shouldNotify) {
      const synthesized = _synthesizeTriageText(g);
      if (!synthesized) {
        _triageAttentionGuardMarkSent();
        appendJsonl(TRIAGE_ATTENTION_ARCHIVE, {
          ts: new Date().toISOString(),
          suppressed_as: 'owner-attention-gate-no-added',
          source: decision.source || 'pi-speak',
          level: decision.level || 'info',
          text_len: String(text || '').length,
          text_preview: String(text || '').slice(0, 300),
          guard: g,
        });
        entry.executed = false;
        entry.suppressed = 'owner-attention-no-added';
        appendJsonl(SPEAK_LOG, entry);
        return { ok: true, executed: false, suppressed: true, action: 'speak-suppressed-attention-no-added', guard: g };
      }
      text = synthesized;
      _triageAttentionGuardMarkSent();
    }
  }

  const r = await piRoute.send({
    text, level: decision.level || 'info',
    source: decision.source || 'pi-speak', audience: 'owner', mainWindow,
    expires_at: decision.expires_at || null,
    ts: decision.ts || null,
  });
  if (r && r.archived) {
    entry.executed = false;
    entry.archived = true;
    entry.archived_reason = 'expired_at_send_entry';
    appendJsonl(SPEAK_LOG, entry);
    return r;
  }
  entry.executed = true;
  entry.routed = r.routed;
  entry.result = r.result;
  entry.type = 'conscious';
  entry.text = text;
  // tone/tone_note/merge_with/defer_until 已经在 entry 顶部初始化时带上
  appendJsonl(SPEAK_LOG, entry);
  appendNotifyHistory(decision.level || 'info', decision.source || 'pi-speak', text);
  _appendToMainSession(text, decision.source || 'pi-speak', r.routed);
  return r;
}

function clearConsumedIntents(consumedIds) {
  if (!fs.existsSync(INTENTS_PATH)) return;
  if (!Array.isArray(consumedIds) || consumedIds.length === 0) return;
  try {
    const all = loadPendingIntents();
    const kept = all.filter(i => !consumedIds.includes(i.id));
    const tmp = INTENTS_PATH + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, kept.map(i => JSON.stringify(i)).join('\n') + (kept.length ? '\n' : ''));
    fs.renameSync(tmp, INTENTS_PATH);
  } catch (e) { console.error('[pi-speak] clearConsumedIntents failed:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════
// 4. 便捷入口：recent_outgoing（triage Step 8 决策需要的 context）
// ══════════════════════════════════════════════════════════════════════

function loadRecentOutgoing(maxEntries = 30, maxAgeMs = 24 * 3600 * 1000) {
  if (!fs.existsSync(SPEAK_LOG)) return [];
  try {
    const lines = fs.readFileSync(SPEAK_LOG, 'utf-8').split('\n').filter(Boolean);
    const cutoff = Date.now() - maxAgeMs;
    return lines.slice(-maxEntries * 2)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.ts && new Date(e.ts).getTime() >= cutoff && e.executed !== false)
      .slice(-maxEntries);
  } catch { return []; }
}

module.exports = {
  proposeIntent, fireReflex,
  loadPendingIntents, writeDecision, executeDecision, clearConsumedIntents,
  loadRecentOutgoing,
  // paths (tests / scripts)
  INTENTS_PATH, DECISIONS_PATH, SPEAK_LOG, NOTIFY_HISTORY,
};
