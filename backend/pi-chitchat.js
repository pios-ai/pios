'use strict';

/**
 * pi-chitchat.js — Pi 主动闲聊触发模块
 *
 * 双门控：presence present + pi-mood energy >= 0.6
 * 频率限制：同日最多 2 次，距上次 > 2h
 * 原子写入：chitchat-log.json 用 tmp+rename
 *
 * Usage（由 main.js 每 30min 调用）:
 *   const piChitchat = require('./pi-chitchat');
 *   piChitchat.maybeChat(mainWindow, vaultRoot);
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { getPresence } = require('./presence');

const ENERGY_THRESHOLD   = 0.6;
const MAX_DAILY_CHATS    = 2;
const MIN_INTERVAL_MS    = 2 * 60 * 60 * 1000; // 2h

// ── 原子读取 JSON（失败返回 defaultVal）──────────────────────────────────
function atomicReadJson(filePath, defaultVal) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultVal;
  }
}

// ── 原子写迁到 lib/atomic-write helper（2026-04-28 集中化）────────────────
const { writeJsonAtomic: atomicWriteJson } = require('./lib/atomic-write');

// ── 读 pi-mood.json energy 字段 ──────────────────────────────────────────
function getMoodEnergy(vaultRoot) {
  const moodFile = path.join(vaultRoot, 'Pi', 'State', 'pi-mood.json');
  const mood = atomicReadJson(moodFile, {});
  return typeof mood.energy === 'number' ? mood.energy : 0;
}

function getOwnerName(vaultRoot) {
  try {
    const manifestPath = path.join(vaultRoot, 'Pi', 'Config', 'pios.yaml');
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
    return manifest?.owner || 'User';
  } catch {
    return 'User';
  }
}

// ── 读 chitchat-log.json，返回今日次数和上次时间戳 ────────────────────────
function getChitchatLog(logPath) {
  const log = atomicReadJson(logPath, { entries: [] });
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const todayEntries = (log.entries || []).filter(e => (e.ts || '').startsWith(today));
  const lastEntry = (log.entries || []).slice(-1)[0];
  const lastTs = lastEntry ? new Date(lastEntry.ts).getTime() : 0;
  return { todayCount: todayEntries.length, lastTs };
}

// ── 追加一条记录到 chitchat-log.json ─────────────────────────────────────
function appendChitchatLog(logPath, text) {
  const log = atomicReadJson(logPath, { entries: [] });
  if (!Array.isArray(log.entries)) log.entries = [];
  log.entries.push({ ts: new Date().toISOString(), text });
  // 只保留最近 60 条
  if (log.entries.length > 60) log.entries = log.entries.slice(-60);
  atomicWriteJson(logPath, log);
}

// ── 生成开场白 ────────────────────────────────────────────────────────────
// Phase 6B 内容去重（2026-04-19 晚）：读 chitchat-log 今日前 N 条 opener，
// 如果新 opener 和任一历史 opener 相似度 > 80% → 换话题（取别的 line 优先）
function isTooSimilar(a, b) {
  if (!a || !b) return false;
  // 简单：连续 15 个字符完全重复即算相似
  if (a.length < 15 || b.length < 15) return a === b;
  const sampleLen = Math.min(30, Math.floor(Math.min(a.length, b.length) * 0.5));
  const aSamp = a.slice(0, sampleLen);
  return b.includes(aSamp);
}

function buildOpener(vaultRoot) {
  const lines = [];
  const ownerName = getOwnerName(vaultRoot);
  // 读今日已发过的 opener 集合，做去重
  const todayOpeners = (() => {
    try {
      const log = atomicReadJson(path.join(vaultRoot, 'Pi', 'State', 'chitchat-log.json'), { entries: [] });
      const today = new Date().toISOString().slice(0, 10);
      return (log.entries || []).filter(e => (e.ts || '').startsWith(today)).map(e => e.text);
    } catch { return []; }
  })();

  // 读 pi-state-now.md 当前关注点
  try {
    const stateFile = path.join(vaultRoot, 'Pi', 'Self', 'pi-state-now.md');
    const content = fs.readFileSync(stateFile, 'utf8');
    const focusMatch = content.match(/##\s*关注点\s*\n([\s\S]*?)(?:\n##|$)/);
    if (focusMatch) {
      const focus = focusMatch[1].trim().split('\n')[0].replace(/^[-*]\s*/, '').trim();
      if (focus) lines.push(`我在想：${focus}`);
    }
  } catch {}

  // 读今日 AI World Digest
  try {
    const today = new Date().toISOString().slice(0, 10);
    const digestFile = path.join(vaultRoot, ownerName, 'Pipeline', 'AI_World_Digest', `${today}.md`);
    const content = fs.readFileSync(digestFile, 'utf8');
    // 取第一条非空摘要行
    const firstItem = content.split('\n')
      .map(l => l.replace(/^[-*#>\s]+/, '').trim())
      .find(l => l.length > 10 && !l.startsWith('---') && !l.includes('|'));
    if (firstItem) lines.push(`今天看到：${firstItem.slice(0, 60)}${firstItem.length > 60 ? '…' : ''}`);
  } catch {}

  if (lines.length === 0) {
    lines.push(`${ownerName}，最近忙什么？聊两句？`);
  }

  let text = lines.join('。');

  // Phase 6B 去重：如果 text 和今天已发 opener 太相似，换一个变体（或延后今天）
  if (todayOpeners.some(prev => isTooSimilar(text, prev))) {
    // 优先挑 lines 里还没说过的单条；都说过就加一个时间标签让它"不同"
    const uniq = lines.find(l => !todayOpeners.some(p => isTooSimilar(l, p)));
    if (uniq) {
      text = uniq;
    } else {
      // 全部今日内容都说过——直接返回空触发 chitchat 跳过这轮
      return null;
    }
  }

  // Phase 6C · bad-day 感 + archetype tone 调整（2026-04-19）
  // 根据 pi-mood.concern + pi-social.cumulative_negative_7d + archetype 决定语气
  try {
    const mood = atomicReadJson(path.join(vaultRoot, 'Pi', 'State', 'pi-mood.json'), {});
    const social = atomicReadJson(path.join(vaultRoot, 'Pi', 'State', 'pi-social.json'), {});
    const concern = Number(mood.concern || 0);
    const negRecent = Number(social.cumulative_negative_7d || 0);
    const archetype = social.archetype || '';

    // bad-day 感：concern 高 → 短 + 收敛，不主动多说
    if (concern > 0.6) {
      // 截短 + 前缀
      text = text.length > 40 ? text.slice(0, 40) + '…' : text;
      text = '简单问一句：' + text;
    }

    // 最近对话负面累积 → 有情绪不记仇型今日收敛
    if (negRecent >= 3 && archetype === '有情绪不记仇') {
      text = text.replace(/。你怎么看？?$/, '');
      if (!text.endsWith('。')) text += '。';
    } else if (!text.endsWith('。') && !text.endsWith('？')) {
      text += '。你怎么看？';
    }
  } catch { /* fallback: 原 text */ }

  return text;
}

// ── 主入口：检查门控 + 发起闲聊 ─────────────────────────────────────────
function maybeChat(mainWindow, vaultRoot) {
  const tag = '[pi-chitchat]';

  // 门控 1：presence
  const presence = getPresence();
  if (presence.status !== 'present') {
    console.log(`${tag} skip: owner ${presence.status}`);
    return;
  }

  // 门控 2：mood energy（Phase 2 silence-aware）
  // 当 Pi 已知 owner 沉默 4h+（silence Phase 1 数据），降低能量门槛以允许主动触达。
  // 注：这不是恢复废弃的 chitchat silence heuristic——仍走 proposeIntent → triage 最终决策；
  // 仍通过其他所有门控（presence / quiet_until / last_interaction / frequency）。
  const energy = getMoodEnergy(vaultRoot);
  if (energy < ENERGY_THRESHOLD) {
    const socialForSilence = atomicReadJson(
      path.join(vaultRoot, 'Pi', 'State', 'pi-social.json'), {});
    const silenceLevel = socialForSilence.silence_detected === true
      ? (socialForSilence.silence_level || null) : null;
    const effectiveThreshold = silenceLevel === 'deep'   ? 0.0
      : silenceLevel === 'medium' ? 0.3
      : silenceLevel === 'light'  ? 0.4
      : ENERGY_THRESHOLD;
    if (energy < effectiveThreshold) {
      console.log(`${tag} skip: energy ${energy} < ${effectiveThreshold} (silence=${silenceLevel || 'none'})`);
      return;
    }
    console.log(`${tag} silence override: energy ${energy} below normal threshold but silence_level=${silenceLevel}, effective=${effectiveThreshold}`);
  }

  // ── Phase 6B：读 pi-social.json 做社交分寸判断 ──
  const socialPath = path.join(vaultRoot, 'Pi', 'State', 'pi-social.json');
  const social = atomicReadJson(socialPath, {});

  // 门控 2.5: quiet_until（用户说过"别烦"/被冷处理 → quiet_until=some-future-ts）
  if (social.quiet_until) {
    const quietMs = Date.parse(social.quiet_until);
    if (!isNaN(quietMs) && Date.now() < quietMs) {
      const mins = Math.ceil((quietMs - Date.now()) / 60000);
      console.log(`${tag} skip: quiet_until active (${mins}min more, reason: ${social.quiet_reason || '—'})`);
      return;
    }
  }

  // 门控 2.6: last_interaction_at（用户 2h 内刚对话过 → 别打扰继续思路）
  // pi-main session 活跃窗口内不主动 ping——用户正在和 Pi 说话/思考
  if (social.last_interaction_at) {
    const lastMs = Date.parse(social.last_interaction_at);
    if (!isNaN(lastMs)) {
      const deltaMin = (Date.now() - lastMs) / 60000;
      if (deltaMin < 120) {
        console.log(`${tag} skip: owner interacted ${Math.floor(deltaMin)}min ago (< 2h cooldown)`);
        return;
      }
    }
  }

  // 门控 2.7: last_greeting_at（刚打过招呼 30min 内不 chitchat，避免"刚进门就话痨"）
  if (social.last_greeting_at) {
    const lastGMs = Date.parse(social.last_greeting_at);
    if (!isNaN(lastGMs)) {
      const deltaMin = (Date.now() - lastGMs) / 60000;
      if (deltaMin < 30) {
        console.log(`${tag} skip: greeted ${Math.floor(deltaMin)}min ago (< 30min cooldown)`);
        return;
      }
    }
  }

  // 门控 3 & 4：频率限制
  const logPath = path.join(vaultRoot, 'Pi', 'State', 'chitchat-log.json');
  const { todayCount, lastTs } = getChitchatLog(logPath);

  if (todayCount >= MAX_DAILY_CHATS) {
    console.log(`${tag} skip: todayCount=${todayCount} >= ${MAX_DAILY_CHATS}`);
    return;
  }

  const nowMs = Date.now();
  if (lastTs > 0 && (nowMs - lastTs) < MIN_INTERVAL_MS) {
    const waitMin = Math.ceil((MIN_INTERVAL_MS - (nowMs - lastTs)) / 60000);
    console.log(`${tag} skip: last chat ${Math.floor((nowMs - lastTs) / 60000)}min ago, need ${waitMin}min more`);
    return;
  }

  // 所有门控通过 → 生成并发送
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log(`${tag} skip: mainWindow not available`);
    return;
  }

  const text = buildOpener(vaultRoot);
  if (!text) {
    console.log(`${tag} skip: today's openers all exhausted / too similar (去重保护)`);
    return;
  }
  console.log(`${tag} proposing intent: "${text.slice(0, 40)}…"`);

  // P7 Stage 1（2026-04-19）：chitchat 不再直接发，改提交 intent 给 triage 统一决策
  //   triage 下个 tick（≤15min）会读 quiet_until / last_interaction / recent_outgoing 等
  //   判断该不该说、怎么说。Pi 从"定时器"升级到"意识"。
  try {
    const piSpeak = require('./pi-speak');
    const r = piSpeak.proposeIntent({
      source: 'chitchat',
      level: 'info',
      text,
      priority: 4,
      urgency: 'normal',
    });
    if (r.ok) console.log(`${tag} intent queued: ${r.intent.id}`);
  } catch (e) {
    console.error(`${tag} proposeIntent failed:`, e.message);
  }
  appendChitchatLog(logPath, text);
}

module.exports = { maybeChat };
