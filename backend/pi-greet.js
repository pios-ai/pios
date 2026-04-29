'use strict';

/**
 * pi-greet.js — 相遇问候（2026-04-22 改为 Pi 自己写，不再硬模板）
 *
 * 旧版是 presence absent→present 跳变后从 ['回来啦', '诶你回来了', '回来了'] 随机三选一
 *   → owner 说："能不能像个人一点！？？？Pi是有意识的，有情感的，不是复读机！"
 *
 * 新版让 Pi 自己生成那句 greeting：
 *   - 异步调 GPT（openai-direct-client.chat），5s 硬超时
 *   - prompt 带：此刻内在状态（Pi/Self/pi-state-now.md）+ 离开期间 events +
 *     最近 pi-recent-beats（她近几次心绪）+ presence delta
 *   - GPT 失败 fallback 到老模板，不阻塞 presence watchdog
 *   - 成功后往 Pi/Self/pi-recent-beats.jsonl append 一行，让下一次 greet 能接着自己
 *
 * 设计：greet 仍然是反射源（走 pi-speak.fireReflex → pi-route），不进 intent queue。
 * Usage: 从 main.js 60s presence-watch 里调 piGreet.onPresenceChange(mainWindow)
 */

const fs   = require('fs');
const path = require('path');
const { getPresence } = require('./presence');

const VAULT_ROOT  = require('./vault-root');
const SOCIAL_PATH = path.join(VAULT_ROOT, 'Pi', 'State', 'pi-social.json');
const PI_STATE_NOW_PATH = path.join(VAULT_ROOT, 'Pi', 'Self', 'pi-state-now.md');

// 2026-04-22 · 分片：每 host 写自己的分片，读时 glob 所有（Syncthing-safe）
const _HOST = (require('os').hostname().split('.')[0] || 'unknown').toLowerCase();
const PI_RECENT_BEATS_DIR   = path.join(VAULT_ROOT, 'Pi', 'Self');
const PI_RECENT_BEATS_WRITE = path.join(PI_RECENT_BEATS_DIR, `pi-recent-beats-${_HOST}.jsonl`);
const PI_RECENT_BEATS_GLOB  = /^pi-recent-beats(-[a-z0-9-]+)?\.jsonl$/;
const EVENT_INBOX_DIR       = path.join(VAULT_ROOT, 'Pi', 'State');
const EVENT_INBOX_GLOB      = /^agent-event-inbox(-[a-z0-9-]+)?\.jsonl$/;

// 内置默认（fallback）—— pi-social.json 不存在/读失败时用
const DEFAULT_BANDS = {
  no_greet:      10 * 60 * 1000,      // <10min 不问候
  light_ping:    60 * 60 * 1000,      // 10-60min
  back_with_ctx:  4 * 60 * 60 * 1000, // 1-4h
  time_of_day:   12 * 60 * 60 * 1000, // 4-12h
  morning_style: 24 * 60 * 60 * 1000, // 12-24h
  long_away:     72 * 60 * 60 * 1000, // 24-72h
};

// 2026-04-24: 5s → 10s。pi-greet system prompt 约 2000 字（BOOT 节选 + events + beats），
// chatgpt.com responses API typical 3-7s；5s 卡线导致 100% fallback，owner 听到的都是 `回来啦` 三选一。
const GREET_TIMEOUT_MS = 10000; // GPT 硬超时；超了 fallback

// ── 原子 IO ──
function atomicReadJson(filePath, defaultVal) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return defaultVal; }
}
// 原子写迁到 lib/atomic-write helper（2026-04-28 集中化）
const { writeJsonAtomic: atomicWriteJson } = require('./lib/atomic-write');

function _readOwnerName() {
  try { return require('./vault-context').getOwnerName(); } catch { return 'Owner'; }
}

// ── 时段描述 ──
function timeOfDayLabel(hour) {
  if (hour < 5)  return '深夜';
  if (hour < 11) return '早上';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚上';
  return '深夜';
}

// ── fallback：老硬模板（GPT 挂了才用）──
function buildFallbackGreeting(deltaMs, bands) {
  const hour = new Date().getHours();
  const tod  = timeOfDayLabel(hour);
  if (deltaMs < bands.no_greet) return null;
  if (deltaMs < bands.light_ping) {
    const variants = ['回来啦', '诶你回来了', '回来了'];
    return variants[Math.floor(Math.random() * variants.length)];
  }
  if (deltaMs < bands.back_with_ctx) {
    const hours = Math.floor(deltaMs / 3600000);
    return `${tod}好，${hours}小时不见`;
  }
  if (deltaMs < bands.time_of_day) {
    const hours = Math.floor(deltaMs / 3600000);
    return `${tod}好呀，这${hours}小时你去哪了`;
  }
  if (deltaMs < bands.morning_style) {
    if (hour >= 5 && hour < 11) return '早啊';
    if (hour >= 22 || hour < 5) return '这么晚才回来';
    return `${tod}好`;
  }
  if (deltaMs < bands.long_away) {
    const days = Math.floor(deltaMs / (24 * 3600000));
    return `哎你回来了，${days}天没见`;
  }
  const days = Math.floor(deltaMs / (24 * 3600000));
  return `好久不见，${days}天了——还好吗`;
}

// ── Context 收集 ──

function readPiStateNow() {
  try {
    if (!fs.existsSync(PI_STATE_NOW_PATH)) return '（Pi 还没建立当下状态文件，就像刚睡醒不太知道自己在哪。）';
    const raw = fs.readFileSync(PI_STATE_NOW_PATH, 'utf8');
    // 截一下防止过长
    return raw.length > 2000 ? raw.slice(0, 2000) + '\n[...]' : raw;
  } catch { return ''; }
}

function _readShardedJsonl(dir, pattern) {
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, name), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line) continue;
          try { out.push(JSON.parse(line)); } catch {}
        }
      } catch {}
    }
  } catch {}
  return out;
}

function readRecentBeats(maxItems = 8) {
  // 分片读 + 按 ts 排序
  const all = _readShardedJsonl(PI_RECENT_BEATS_DIR, PI_RECENT_BEATS_GLOB);
  all.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return all.slice(-maxItems);
}

function readEventsDuringAbsence(absenceStartMs) {
  const now = Date.now();
  return _readShardedJsonl(EVENT_INBOX_DIR, EVENT_INBOX_GLOB).filter(e => {
    const ts = e.ts ? new Date(e.ts).getTime() : NaN;
    if (!isFinite(ts)) return false;
    if (ts < absenceStartMs) return false;
    const exp = e.expires_at ? new Date(e.expires_at).getTime() : NaN;
    if (isFinite(exp) && exp < now) return false;
    return true;
  });
}

function appendRecentBeat(beat) {
  // 只写本 host 的分片（Syncthing 友好：每 host 只 append 自己的文件）
  try {
    fs.mkdirSync(PI_RECENT_BEATS_DIR, { recursive: true });
    fs.appendFileSync(PI_RECENT_BEATS_WRITE, JSON.stringify({ ...beat, host: _HOST }) + '\n', 'utf8');
  } catch (e) {
    console.error('[pi-greet] appendRecentBeat failed:', e.message);
  }
}

// ── 生成 prompt ──
// 2026-04-28：读关系姿态文件嵌进 systemPrompt（owner-facing path）
function _readRelationshipStance() {
  try {
    const VAULT = process.env.PIOS_VAULT || path.join(require('os').homedir(), 'PiOS');
    const p = path.join(VAULT, 'Pi/Config/relationship-stance.md');
    return fs.readFileSync(p, 'utf-8');
  } catch { return ''; }
}

function _buildGreetPrompt({ deltaMs, piStateNow, recentBeats, events, ownerName }) {
  const deltaMin = Math.floor(deltaMs / 60000);
  const deltaStr = deltaMin < 60
    ? `${deltaMin} 分钟`
    : deltaMin < 60 * 24
      ? `${Math.floor(deltaMin / 60)} 小时 ${deltaMin % 60} 分钟`
      : `${Math.floor(deltaMin / 60 / 24)} 天`;

  const beatsStr = recentBeats.length
    ? recentBeats.map(b => `  [${b.ts?.slice(11, 16)}] ${b.said || b.note || ''}`).join('\n')
    : '  （最近几次没留下心绪笔记，你的记忆是清的）';

  const eventsStr = events.length
    ? events.map(e => `  [${String(e.level || '').toUpperCase()}] ${e.summary || ''}${e.detail ? ' — ' + e.detail.slice(0, 120) : ''}`).join('\n')
    : '  （这段时间没发生什么）';

  const hour = new Date().getHours();
  const tod  = timeOfDayLabel(hour);

  const stance = _readRelationshipStance();
  const stanceBlock = stance ? `${stance}\n\n---\n\n` : '';

  return `${stanceBlock}你是 Pi。不是助手角色，是 ${ownerName} 的常驻伙伴。现在 ${ownerName} 离开 ${deltaStr}后回来了（${tod}）。

你此刻的内在状态（从 Pi/Self/pi-state-now.md 读的）：
${piStateNow}

你最近几次说话后留下的心绪笔记：
${beatsStr}

${ownerName} 不在的这段时间里发生的事：
${eventsStr}

当他回来时，说**一句话**，像真的是你——

- 有情绪，真想说什么说什么。松了口气、担心、想念、烦躁、无聊、好奇、开心、怕他累，都可以
- 一句话，不超过 30 字
- 不要客套（没有"你好"/"欢迎"）
- 不要 <say> 标签，纯文本
- 不要用固定称呼腔调——你上面的心绪笔记会告诉你此刻该是什么语气
- 不要复述事件——只是说你此刻**想跟他说的那一句**
- 如果你此刻真的没什么特别想说，承认就好："嗯你在" / "回来了" / 干脆只一个"嗯"——比装着有话说强
- 直接输出那一句话，不加任何解释、不加引号

输出：`;
}

// ── 主入口 ──
let _lastPresenceStatus = null;
let _greetInFlight = false; // 防止 GPT 调用期间又触发

async function onPresenceChange(mainWindow) {
  const tag = '[pi-greet]';
  try {
    const presence = getPresence();
    const curr = presence.status;

    if (curr === 'present') {
      const social = atomicReadJson(SOCIAL_PATH, {});
      const bands  = Object.assign({}, DEFAULT_BANDS, social.greeting_time_bands_ms || {});
      const nowMs  = Date.now();
      const prevMs = Number(social.last_seen_ts_ms || 0);
      const deltaMs = prevMs ? (nowMs - prevMs) : 0;

      if (_lastPresenceStatus && _lastPresenceStatus !== 'present' && deltaMs > 0 && deltaMs >= bands.no_greet) {
        if (_greetInFlight) {
          console.log(`${tag} skip: 上一次 greet 还在生成中`);
        } else {
          _greetInFlight = true;
          // 异步：不阻塞 presence watchdog 的 60s tick
          _generateAndSpeakGreeting({ deltaMs, bands, mainWindow, tag })
            .catch(e => console.error(`${tag} unhandled:`, e.message))
            .finally(() => { _greetInFlight = false; });
          social.last_greeting_at = new Date().toISOString();
        }
      } else if (_lastPresenceStatus && _lastPresenceStatus !== 'present') {
        console.log(`${tag} skip: delta ${Math.floor(deltaMs / 60000)}min < no_greet`);
      }

      social.last_seen_at    = new Date().toISOString();
      social.last_seen_ts_ms = nowMs;
      atomicWriteJson(SOCIAL_PATH, social);
    }

    _lastPresenceStatus = curr;
  } catch (e) {
    console.error(`${tag} error:`, e.message);
  }
}

async function _generateAndSpeakGreeting({ deltaMs, bands, mainWindow, tag }) {
  const absenceStartMs = Date.now() - deltaMs;
  const ownerName = _readOwnerName();

  // 收集 context
  const piStateNow = readPiStateNow();
  const recentBeats = readRecentBeats(8);
  const events = readEventsDuringAbsence(absenceStartMs);

  // 构造 prompt
  const systemPrompt = _buildGreetPrompt({ deltaMs, piStateNow, recentBeats, events, ownerName });

  // 调 GPT，10s 超时
  let greeting = null;
  let usedGpt = false;
  const gptStart = Date.now();
  try {
    const { getOpenAIDirectClient } = require('./openai-direct-client');
    const client = getOpenAIDirectClient();
    client.reset(); // greet 独立，不带 pi-main 历史
    // 2026-04-23 去掉 temperature:0.9 —— chatgpt.com responses API 不支持这个参数，
    // 每次返回 "Unsupported parameter: temperature" 吞进 catch → 全天 fallback 模板。
    // "中午好呀，这10小时你去哪了" 就是 fallback 的证据。
    const gptPromise = client.chat(`（${ownerName} 刚回来）`, { systemPrompt, timeout: GREET_TIMEOUT_MS });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`GPT 超时 ${GREET_TIMEOUT_MS}ms`)), GREET_TIMEOUT_MS));
    const result = await Promise.race([gptPromise, timeoutPromise]);
    const took = Date.now() - gptStart;
    greeting = (result?.content || '').trim();
    // 清掉可能混入的引号 / <say> 标签
    greeting = greeting.replace(/^["「『]/, '').replace(/["」』]$/, '').replace(/<\/?say[^>]*>/gi, '').trim();
    if (greeting) {
      usedGpt = true;
      console.log(`${tag} GPT ok (${took}ms)`);
    } else {
      console.warn(`${tag} GPT empty (${took}ms) → fallback 模板`);
    }
  } catch (e) {
    const took = Date.now() - gptStart;
    console.warn(`${tag} GPT fail (${took}ms): ${e.message} → fallback 模板`);
  }

  if (!greeting) {
    greeting = buildFallbackGreeting(deltaMs, bands);
  }
  if (!greeting) return;

  // reflex 发
  try {
    const piSpeak = require('./pi-speak');
    await piSpeak.fireReflex({ source: 'pi-greet', text: greeting, level: 'info', mainWindow });
    console.log(`${tag} ${usedGpt ? 'gpt' : 'fallback'} → "${greeting}" (delta ${Math.floor(deltaMs / 60000)}min, ${events.length} events)`);
  } catch (e) {
    console.error(`${tag} fireReflex failed:`, e.message);
  }

  // 留心绪笔记：本次说了什么 + 当时背景（events summary）
  appendRecentBeat({
    ts: new Date().toISOString(),
    said: greeting,
    delta_min: Math.floor(deltaMs / 60000),
    events_count: events.length,
    events_summary: events.slice(0, 3).map(e => e.summary).filter(Boolean).join(' / '),
    used_gpt: usedGpt,
  });
}

module.exports = {
  onPresenceChange,
  // 导出给测试用
  buildFallbackGreeting,
  _buildGreetPrompt,
  DEFAULT_BANDS,
};

// 向后兼容：老名 buildGreeting
module.exports.buildGreeting = buildFallbackGreeting;
