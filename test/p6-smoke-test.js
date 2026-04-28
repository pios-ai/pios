#!/usr/bin/env node
/**
 * P6 smoke test · 2026-04-19
 * 测试范围：
 *  - pi-greet.buildGreeting（纯函数）
 *  - pi-route.send（4 档路由）
 *  - pi-route.flushPending（回放 + **关键：通道是否 pios:talk（坑）还是 _npcSpeak（干净）**）
 *  - pi-chitchat.maybeChat 3 个新门控（quiet_until / last_interaction / last_greeting）
 *  - pi-chitchat 发声通道是否走 _npcSpeak（不走 pios:talk）
 *
 * 备份/恢复 pi-social.json 和 chitchat-log.json，保证不污染真实状态。
 */

'use strict';

// 2026-04-20 owner 看到 T3 "不会真打扰..." 测试文本真的在 Totoro 气泡里冒出来的教训：
// 活着的 PiOS 主进程 watchFile pi_notify.json，T3 真调 piRoute.send 触发 sendLocalNotify
// → notify.sh 写 pi_notify.json → 主进程气泡真说话。
// 设 PIOS_TEST_MODE=1 让 pi-route 在 sendLocalNotify/sendLocalBubble/sendWeChat 里短路，
// 只返回 {ok:true, dryRun:true, routed:...}，不触达任何真通道。
process.env.PIOS_TEST_MODE = '1';

const fs = require('fs');
const path = require('path');

const VAULT = process.env.PIOS_VAULT || path.join(require('os').homedir(), 'PiOS');
const PIOS = path.join(VAULT, 'Projects/pios');
const SOCIAL = path.join(VAULT, 'Pi/State/pi-social.json');
const MOOD = path.join(VAULT, 'Pi/State/pi-mood.json');
const CHITCHAT_LOG = path.join(VAULT, 'Pi/State/chitchat-log.json');
const PENDING = path.join(VAULT, 'Pi/State/pi-pending-messages.jsonl');

const results = [];
const pass = (name, msg) => { results.push(['PASS', name, msg]); console.log(`✅ ${name}: ${msg}`); };
const fail = (name, msg) => { results.push(['FAIL', name, msg]); console.log(`❌ ${name}: ${msg}`); };

function writeJson(p, o) {
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, p);
}
function readJson(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; }
}

// ── 备份 ──
const origSocial = fs.readFileSync(SOCIAL, 'utf8');
const origMoodExists = fs.existsSync(MOOD);
const origMood = origMoodExists ? fs.readFileSync(MOOD, 'utf8') : null;
const origChitchat = fs.readFileSync(CHITCHAT_LOG, 'utf8');
const origPendingExists = fs.existsSync(PENDING);
const origPending = origPendingExists ? fs.readFileSync(PENDING, 'utf8') : null;

// ── 恢复（finally） ──
function restore() {
  fs.writeFileSync(SOCIAL, origSocial);
  if (origMoodExists) fs.writeFileSync(MOOD, origMood);
  else if (fs.existsSync(MOOD)) { try { fs.unlinkSync(MOOD); } catch {} }
  fs.writeFileSync(CHITCHAT_LOG, origChitchat);
  if (origPendingExists) fs.writeFileSync(PENDING, origPending);
  else if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(1); });

async function runTests() {
  // Load modules (after backup)
  const piGreet = require(path.join(PIOS, 'backend/pi-greet'));
  const piRoute = require(path.join(PIOS, 'backend/pi-route'));
  const piChitchat = require(path.join(PIOS, 'backend/pi-chitchat'));

  // Capture _npcSpeak
  let npcSpeakCalls = [];
  global._npcSpeak = (text) => { npcSpeakCalls.push(text); };

  // Mock mainWindow that captures pios:talk + bubble:pulse calls
  let mainSendCalls = [];
  const mockWin = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => { mainSendCalls.push([channel, payload]); }
    }
  };

  // ─────────────────────────────────────────────────────
  // T1: pi-greet.buildGreeting 各档
  // ─────────────────────────────────────────────────────
  const samples = [
    [5*60e3, 'null'],           // <10min 不打
    [15*60e3, 'string'],        // light_ping
    [120*60e3, 'string'],       // back_with_ctx
    [720*60e3, 'string'],       // morning_style
    [48*60*60e3, 'string'],     // long_away
  ];
  let t1ok = true, t1details = [];
  for (const [ms, expect] of samples) {
    const g = piGreet.buildGreeting(ms, piGreet.DEFAULT_BANDS, '有情绪不记仇');
    const got = g === null ? 'null' : typeof g;
    if (got !== expect) { t1ok = false; t1details.push(`${ms/60e3}min got ${got} expect ${expect}`); break; }
    t1details.push(`${(ms/60e3).toFixed(0)}min → ${g === null ? '(no greet)' : '"' + g + '"'}`);
  }
  t1ok ? pass('T1 buildGreeting', t1details.join(' / ')) : fail('T1 buildGreeting', t1details.join(' / '));

  // ─────────────────────────────────────────────────────
  // T2: pi-route self-only (不打扰 owner)
  // ─────────────────────────────────────────────────────
  const r2 = await piRoute.send({ text: 'T2', level: 'info', source: 't2', audience: 'self' });
  r2.ok && r2.routed === 'self-only'
    ? pass('T2 route self-only', `routed=${r2.routed}`)
    : fail('T2 route self-only', JSON.stringify(r2));

  // ─────────────────────────────────────────────────────
  // T3: pi-route audience=owner level=info, presence=present → local-present
  //      (owner 在 Mac 前 idle=0 → present)
  // ─────────────────────────────────────────────────────
  mainSendCalls = [];
  const r3 = await piRoute.send({ text: 'T3 local-present (不会真打扰，mainWindow=null 所以只走 notify)', level: 'info', source: 't3', audience: 'owner' });
  if (r3.routed === 'local-present') pass('T3 route present', `routed=${r3.routed}`);
  else fail('T3 route present', `expected local-present, got ${r3.routed}`);

  // ─────────────────────────────────────────────────────
  // T4: flushPending - **关键坑测试**
  //    - 写 2 条假 pending
  //    - 调 flushPending(mockWin)
  //    - 检查：
  //      (a) 消息是否被发出（flushed == 2）
  //      (b) 队列文件是否清空
  //      (c) 通道是 pios:talk（坑）还是 _npcSpeak（干净）?
  // ─────────────────────────────────────────────────────
  fs.writeFileSync(PENDING,
    JSON.stringify({ts:new Date().toISOString(), text:'T4-msg-1', source:'t4', level:'info'}) + '\n' +
    JSON.stringify({ts:new Date().toISOString(), text:'T4-msg-2', source:'t4', level:'info'}) + '\n'
  );
  mainSendCalls = []; npcSpeakCalls = [];
  const r4 = await piRoute.flushPending(mockWin);
  if (r4.flushed === 2) pass('T4.a flushPending flushed count', `flushed=${r4.flushed}`);
  else fail('T4.a flushPending flushed count', `expected 2, got ${r4.flushed}`);

  const pendingAfter = fs.existsSync(PENDING) ? fs.readFileSync(PENDING, 'utf8').trim() : '';
  pendingAfter === ''
    ? pass('T4.b flushPending clears queue', 'queue file empty after flush')
    : fail('T4.b flushPending clears queue', `still has: ${pendingAfter.slice(0, 100)}`);

  // **关键**：检查 flushPending 用了哪个 channel
  const usedPiosTalk = mainSendCalls.some(c => c[0] === 'pios:talk');
  const usedBubblePulse = mainSendCalls.some(c => c[0] === 'bubble:pulse');
  const usedNpcSpeak = npcSpeakCalls.length > 0;

  if (usedPiosTalk) {
    fail('T4.c flushPending channel SAFETY', `❗ 用了 pios:talk（user 输入通道）！会被 Claude 当成 owner 说话后回复 → 和 chitchat 同一个自问自答坑`);
  } else if (usedBubblePulse || usedNpcSpeak) {
    pass('T4.c flushPending channel SAFETY', `用了 ${usedBubblePulse ? 'bubble:pulse' : '_npcSpeak'}（NPC 气泡专用）`);
  } else {
    fail('T4.c flushPending channel SAFETY', `没有任何 send 调用（mainSendCalls=${mainSendCalls.length}, npcSpeak=${npcSpeakCalls.length}）`);
  }

  // ─────────────────────────────────────────────────────
  // T5: chitchat quiet_until 门
  // ─────────────────────────────────────────────────────
  writeJson(CHITCHAT_LOG, { entries: [] });
  // 测试时强制高 energy，防止被 energy 门先挡住导致后面 quiet_until/last_interaction/last_greeting 门没机会检查
  // pi-chitchat 读的是 pi-mood.json 的 energy，不是 pi-social.json
  const moodBase = origMoodExists ? JSON.parse(origMood) : {};
  writeJson(MOOD, { ...moodBase, energy: 0.9 });
  const socialBase = JSON.parse(origSocial);
  writeJson(SOCIAL, { ...socialBase, quiet_until: new Date(Date.now() + 3600e3).toISOString() });

  let logs = [];
  const origConsoleLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); origConsoleLog(...args); };

  npcSpeakCalls = []; mainSendCalls = [];
  piChitchat.maybeChat(mockWin, VAULT);

  console.log = origConsoleLog;

  if (logs.some(l => l.includes('quiet_until'))) pass('T5 chitchat quiet_until gate', 'skipped');
  else fail('T5 chitchat quiet_until gate', `no skip log. logs: ${logs.filter(l => l.includes('[pi-chitchat]')).join(' | ')}`);

  // ─────────────────────────────────────────────────────
  // T6: chitchat last_interaction_at 门 (2h cooldown)
  // ─────────────────────────────────────────────────────
  writeJson(SOCIAL, { ...socialBase, quiet_until: null, last_interaction_at: new Date(Date.now() - 30*60e3).toISOString() });
  logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); origConsoleLog(...args); };
  npcSpeakCalls = []; mainSendCalls = [];
  piChitchat.maybeChat(mockWin, VAULT);
  console.log = origConsoleLog;
  if (logs.some(l => l.includes('owner interacted'))) pass('T6 chitchat last_interaction gate', 'skipped');
  else fail('T6 chitchat last_interaction gate', `no skip log. logs: ${logs.filter(l => l.includes('[pi-chitchat]')).join(' | ')}`);

  // ─────────────────────────────────────────────────────
  // T7: chitchat last_greeting_at 门 (30min cooldown)
  // ─────────────────────────────────────────────────────
  writeJson(SOCIAL, { ...socialBase, quiet_until: null, last_interaction_at: null, last_greeting_at: new Date(Date.now() - 10*60e3).toISOString() });
  logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); origConsoleLog(...args); };
  npcSpeakCalls = []; mainSendCalls = [];
  piChitchat.maybeChat(mockWin, VAULT);
  console.log = origConsoleLog;
  if (logs.some(l => l.includes('greeted'))) pass('T7 chitchat last_greeting gate', 'skipped');
  else fail('T7 chitchat last_greeting gate', `no skip log. logs: ${logs.filter(l => l.includes('[pi-chitchat]')).join(' | ')}`);

  // ─────────────────────────────────────────────────────
  // T8: chitchat 所有门打开时走 proposeIntent（P7 · 2026-04-19 架构改）
  //     原 _npcSpeak 直发 → 现改 propose intent 给 triage 统一决策
  // ─────────────────────────────────────────────────────
  const INTENTS_PATH = path.join(VAULT, 'Pi/State/pi-speak-intents.jsonl');
  const origIntents = fs.existsSync(INTENTS_PATH) ? fs.readFileSync(INTENTS_PATH, 'utf8') : null;
  try { if (fs.existsSync(INTENTS_PATH)) fs.writeFileSync(INTENTS_PATH, ''); } catch {}

  writeJson(SOCIAL, { ...socialBase, quiet_until: null, last_interaction_at: null, last_greeting_at: null });
  writeJson(CHITCHAT_LOG, { entries: [] });
  logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); origConsoleLog(...args); };
  npcSpeakCalls = []; mainSendCalls = [];
  piChitchat.maybeChat(mockWin, VAULT);
  console.log = origConsoleLog;

  const chitchatUsedPiosTalk = mainSendCalls.some(c => c[0] === 'pios:talk');
  const chitchatUsedNpcSpeak = npcSpeakCalls.length > 0;
  const intentsNow = fs.existsSync(INTENTS_PATH) ? fs.readFileSync(INTENTS_PATH, 'utf8').trim() : '';
  const proposedIntent = intentsNow.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(i => i && i.source === 'chitchat').pop();

  if (chitchatUsedPiosTalk) {
    fail('T8 chitchat P7 propose', `❗ 还用 pios:talk（user 输入通道）= 自问自答坑`);
  } else if (chitchatUsedNpcSpeak) {
    fail('T8 chitchat P7 propose', `❗ 还走 _npcSpeak 直发 = P7 改革没落地（应 proposeIntent）`);
  } else if (proposedIntent) {
    pass('T8 chitchat P7 propose', `proposed intent id=${proposedIntent.id}, text="${proposedIntent.text.slice(0,40)}..."`);
  } else {
    fail('T8 chitchat P7 propose', `门控通过但既没 propose 也没直发。logs: ${logs.filter(l => l.includes('[pi-chitchat]')).join(' | ')}`);
  }

  // 恢复 intents
  if (origIntents !== null) fs.writeFileSync(INTENTS_PATH, origIntents);
  else if (fs.existsSync(INTENTS_PATH)) { try { fs.unlinkSync(INTENTS_PATH); } catch {} }

  // ─────────────────────────────────────────────────────
  // T9: pi-greet onPresenceChange 不会触发（当前 _lastPresenceStatus=null，present 保持）
  //     边界场景：如果有残存 last_seen_ts_ms 很老，但 _lastPresenceStatus 是 null 不该触发问候
  // ─────────────────────────────────────────────────────
  writeJson(SOCIAL, { ...socialBase, last_seen_ts_ms: Date.now() - 3600e3 /* 1h 前 */ });
  npcSpeakCalls = []; mainSendCalls = [];
  piGreet.onPresenceChange(mockWin);
  if (npcSpeakCalls.length === 0) {
    pass('T9 greet init-no-trigger', 'first call (lastStatus=null) correctly no greet');
  } else {
    fail('T9 greet init-no-trigger', `❗ 首次调用不该触发，但发了 "${npcSpeakCalls[0]}"`);
  }

  // ─────────────────────────────────────────────────────
  // P7 Stage 1: pi-speak 架构
  // ─────────────────────────────────────────────────────
  const piSpeak = require(path.join(PIOS, 'backend/pi-speak'));
  const INTENTS2 = path.join(VAULT, 'Pi/State/pi-speak-intents.jsonl');
  const origIntents2 = fs.existsSync(INTENTS2) ? fs.readFileSync(INTENTS2, 'utf8') : null;

  // T10 proposeIntent
  const pr = piSpeak.proposeIntent({ source: 'smoke-test', level: 'info', text: 'T10 hello' });
  if (pr.ok && pr.intent.id?.startsWith('intent-')) pass('T10 pi-speak proposeIntent', `id=${pr.intent.id}`);
  else fail('T10 pi-speak proposeIntent', JSON.stringify(pr));

  // T11 loadPendingIntents
  const loaded = piSpeak.loadPendingIntents();
  if (loaded.some(i => i.id === pr.intent.id)) pass('T11 pi-speak loadPending', `queue has ${loaded.length} pending`);
  else fail('T11 pi-speak loadPending', `intent not found`);

  // T12 executeDecision drop (no real send)
  piSpeak.writeDecision({ intent_id: pr.intent.id, action: 'drop', source: 'smoke-test', reason: 'test' });
  const execResult = await piSpeak.executeDecision({ intent_id: pr.intent.id, action: 'drop', source: 'smoke-test' });
  if (execResult.executed === false) pass('T12 pi-speak executeDecision drop', 'no send as expected');
  else fail('T12 pi-speak executeDecision drop', JSON.stringify(execResult));

  // T13 clearConsumedIntents
  piSpeak.clearConsumedIntents([pr.intent.id]);
  const afterClear = piSpeak.loadPendingIntents();
  if (!afterClear.find(i => i.id === pr.intent.id)) pass('T13 pi-speak clearConsumed', 'intent removed');
  else fail('T13 pi-speak clearConsumed', 'intent still present');

  // 恢复 intents
  if (origIntents2 !== null) fs.writeFileSync(INTENTS2, origIntents2);
  else if (fs.existsSync(INTENTS2)) { try { fs.unlinkSync(INTENTS2); } catch {} }

  // ─────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────
  console.log('\n══ Summary ══');
  const p = results.filter(r => r[0] === 'PASS').length;
  const f = results.filter(r => r[0] === 'FAIL').length;
  console.log(`Total: ${p} PASS, ${f} FAIL`);
  if (f > 0) {
    console.log('\n失败详情:');
    results.filter(r => r[0] === 'FAIL').forEach(r => console.log(`  ❌ ${r[1]}: ${r[2]}`));
    process.exit(1);
  }
}

runTests().catch(e => { console.error('测试异常:', e.message, e.stack); process.exit(2); });
