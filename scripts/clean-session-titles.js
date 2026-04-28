#!/usr/bin/env node
// 清洗 ~/Library/Application Support/PiOS/sessions.json 里的脏 title。
// 两类脏数据来自历史代码：
//   A) 以 "以下是最近的对话上下文：" 开头（旧版 Auto→Claude 把 claudeMsg 前缀塞进了 title）
//   B) 尾巴带 "（记住用 <say> 标签...）" 或 "（记住：语音用 🗣...）"（旧版 fullPrompt wrapper 写进了 title）
// 只改 title 字段，不碰 messages。跑完让 owner 重启 PiOS 看 sidebar 是否干净。
//
// 用法: node scripts/clean-session-titles.js [--dry]

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'PiOS', 'sessions.json');
const DRY = process.argv.includes('--dry');

const CTX_PREFIX = '以下是最近的对话上下文：';
const REQ_MARKER = '用户最新请求：';
const ABE_PREFIX = (process.env.PIOS_OWNER ? process.env.PIOS_OWNER + ': ' : 'owner: ');
const TAIL_RE = /\s*（记住用\s*<say>[^）]*）\s*$|\s*（记住：语音用\s*🗣[^）]*）\s*$/;
// multi-round tail（messages[0].content 里可能同一 session 多次被包过 wrapper，取到最早的）
const TAIL_RE_G = /\s*（记住用\s*<say>[^）]*）|\s*（记住：语音用\s*🗣[^）]*）/g;

function stripTail(s) {
  let prev;
  do { prev = s; s = s.replace(TAIL_RE, ''); } while (s !== prev);
  return s;
}

function firstLine30(s) {
  const firstLine = (s.split('\n')[0] || '').trim();
  return firstLine.substring(0, 30);
}

function rebuildFromMsg0(content) {
  let c = content;
  if (c.startsWith(ABE_PREFIX)) c = c.slice(ABE_PREFIX.length);
  // 如果 msg0 本身也是 claudeMsg，只取 "用户最新请求：" 后面的
  const idx = c.indexOf(REQ_MARKER);
  if (idx >= 0) c = c.slice(idx + REQ_MARKER.length);
  // 剥 tail wrapper（可能出现多次）
  c = c.replace(TAIL_RE_G, '');
  return c.trim();
}

function cleanTitle(title, messages) {
  if (typeof title !== 'string') return { title, changed: false };
  const orig = title;

  // 策略 1: 从 title 里找 "用户最新请求：" 后面
  let out = title;
  const idx = out.indexOf(REQ_MARKER);
  if (idx >= 0) out = out.slice(idx + REQ_MARKER.length);

  // 策略 2: 剥尾巴 wrapper
  out = stripTail(out);

  // 策略 3: 还以 "以下是最近的对话上下文：" 开头 → 从 messages[0] 重建
  if (out.startsWith(CTX_PREFIX)) {
    const m0 = (messages && messages[0] && typeof messages[0].content === 'string') ? messages[0].content : '';
    if (m0) out = rebuildFromMsg0(m0);
  }

  out = firstLine30(out.trim()) || firstLine30(orig); // 兜底：如果清洗后空了，保留原始首行
  if (!out) return { title: orig, changed: false };
  return { title: out, changed: out !== orig };
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function main() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    console.error('sessions.json not found:', SESSIONS_FILE);
    process.exit(1);
  }

  const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
  const data = JSON.parse(raw);
  const sessions = data.sessions || [];

  if (!DRY) {
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}`;
    const backup = `${SESSIONS_FILE}.bak-${stamp}`;
    fs.copyFileSync(SESSIONS_FILE, backup);
    console.log('[backup]', backup);
  }

  let changed = 0;
  const samples = [];
  for (const s of sessions) {
    const r = cleanTitle(s.title, s.messages);
    if (r.changed) {
      if (samples.length < 10) samples.push({ id: s.id, from: s.title, to: r.title });
      s.title = r.title;
      changed++;
    }
  }

  console.log(`[scan] total=${sessions.length}, cleaned=${changed}`);
  for (const x of samples) {
    console.log(`  ${x.id}`);
    console.log(`    from: ${JSON.stringify(x.from).slice(0, 120)}`);
    console.log(`    to:   ${JSON.stringify(x.to)}`);
  }

  if (DRY) { console.log('[dry] no write'); return; }
  if (!changed) { console.log('[done] no changes, skip write'); return; }

  atomicWrite(SESSIONS_FILE, JSON.stringify(data, null, 2));
  console.log('[done] atomic write OK ->', SESSIONS_FILE);
}

main();
