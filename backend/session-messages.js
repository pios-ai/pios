/**
 * session-messages.js — Per-session message storage
 *
 * sessions.json 被 300+ session × 平均 60KB messages 膨胀到 19MB，每次 800ms 节流
 * flush 都在主进程 JSON.stringify + writeFileSync 整个 blob，打开 PiBrowser / 切 tab
 * 触发的 debounced save 让主进程冻若干百毫秒。
 *
 * 方案：把 `messages` 挪出 sessions.json，每个 session 一个 JSONL（一行一条消息）。
 * - sessions.json 只剩 metadata（title/engine/updated_at/...），总大小 ~200KB
 * - {userData}/session-messages/{id}.jsonl 各 session 独立文件，按需并行读写
 * - 首次启动迁移：把 sessions.json 里 inline 的 messages 拆到 JSONL，strip 原数组
 *
 * 向前兼容：load 时如果某 session 没有 JSONL 也没有 inline messages，返回 []。
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

let _baseDir = null;

function configure(userDataPath) {
  _baseDir = path.join(userDataPath, 'session-messages');
  try { fs.mkdirSync(_baseDir, { recursive: true }); } catch {}
}

function _pathFor(sid) {
  if (!_baseDir) throw new Error('session-messages not configured — call configure(userDataPath) at boot');
  // sid 来源可信（app 生成的 id / pi-main / run:xxx），但基本过滤 `/` 和 `..` 以防
  // 路径逃逸；保留冒号等 run: 前缀里的字符。
  const safe = String(sid).replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
  return path.join(_baseDir, `${safe}.jsonl`);
}

function loadMessages(sid) {
  const p = _pathFor(sid);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

async function writeMessagesAsync(sid, messages) {
  if (!Array.isArray(messages)) return;
  const p = _pathFor(sid);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const body = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
  await fsp.writeFile(tmp, body, 'utf-8');
  await fsp.rename(tmp, p);
}

function writeMessagesSync(sid, messages) {
  if (!Array.isArray(messages)) return;
  const p = _pathFor(sid);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const body = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, p);
}

function deleteMessages(sid) {
  try { fs.unlinkSync(_pathFor(sid)); } catch {}
}

module.exports = { configure, loadMessages, writeMessagesAsync, writeMessagesSync, deleteMessages };
