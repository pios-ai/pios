// Pi/Inbox/* 文件监听 + 主动说话队列 + pi-main 回写
// 把以下三段从 main.js 提出来：
//   - pi_notify.json watcher（notify.sh 写 → toast + TTS）
//   - pi-speak-queue.jsonl watcher（外部写队列 → fireReflex/proposeIntent）
//   - global._appendPiMainProactive + pi-main-proactive-queue-{host}.jsonl watcher
// 三个 watcher 全有 setInterval backup polling（fs.watchFile 在 Electron main 已知不可靠）
// + powerMonitor resume kick（macOS 睡眠恢复后立即 drain）

const path = require('path');
const fs = require('fs');

function start(deps) {
  const {
    VAULT_ROOT,
    MAIN_SESSION_ID,
    loadSessions,
    saveSessions,
    sendNotification,
    getMainWindow,
  } = deps;

  // ── pi_notify.json ──
  // ⚠️ 2026-04-29：fs.watchFile 在 Electron main 已知不可靠（laptop-host 7345 字节积压
  // 21min watchFile 从没 fire 的证据）。setInterval 1s 兜底，不可去掉。
  (() => {
    const notifyFile = path.join(VAULT_ROOT, 'Pi', 'Inbox', 'pi_notify.json');
    let lastText = '';
    let lastTime = 0;
    const tryFire = () => {
      let raw;
      try { raw = fs.readFileSync(notifyFile, 'utf-8'); } catch { return; }
      let text;
      try { text = JSON.parse(raw).text; } catch { return; }
      if (!text) return;
      const now = Date.now();
      if (text === lastText && now - lastTime < 60000) {
        try { fs.unlinkSync(notifyFile); } catch {}
        return;
      }
      lastText = text;
      lastTime = now;
      try { fs.unlinkSync(notifyFile); } catch {}
      console.log('[pi-notify] file trigger:', text);
      sendNotification('Pi', text, 'pibrowser', { skipHistory: true });
    };
    fs.watchFile(notifyFile, { interval: 1000 }, tryFire);
    setInterval(tryFire, 1000);
    console.log('[pi-notify] watching', notifyFile, '(fs.watchFile + setInterval backup)');
  })();

  // ── pi-speak-queue.jsonl ──
  // 2026-04-20 修复 Bug A/B：原 notify.sh 用 `node -e fireReflex ... &` 起子进程
  //   - 子进程里 global._npcSpeak 不存在 → bubble 永远 null
  //   - cron 环境 PATH 没带 /opt/homebrew/bin → fireReflex 静默失败
  // 改法：notify.sh 只写 JSON 行到 queue，主进程按 cursor 读增量在进程内 dispatch
  (() => {
    const queueFile = path.join(VAULT_ROOT, 'Pi', 'Inbox', 'pi-speak-queue.jsonl');
    const queueDir = path.dirname(queueFile);
    try { fs.mkdirSync(queueDir, { recursive: true }); } catch {}

    let cursor = 0;
    try { if (fs.existsSync(queueFile)) cursor = fs.statSync(queueFile).size; } catch {}

    let processing = false;
    async function drain() {
      if (processing) return;
      processing = true;
      try {
        let size;
        try { size = fs.statSync(queueFile).size; } catch { processing = false; return; }
        if (size < cursor) { cursor = 0; }
        if (size <= cursor) { processing = false; return; }
        let buf;
        try {
          const fd = fs.openSync(queueFile, 'r');
          buf = Buffer.alloc(size - cursor);
          fs.readSync(fd, buf, 0, buf.length, cursor);
          fs.closeSync(fd);
        } catch (e) {
          console.error('[pi-speak-queue] read:', e.message);
          processing = false; return;
        }
        cursor = size;

        const lines = buf.toString('utf-8').split('\n').filter(Boolean);
        const piSpeak = require('../backend/pi-speak');
        for (const line of lines) {
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (!obj || !obj.text) continue;
          try {
            if (obj.type === 'intent') {
              piSpeak.proposeIntent({
                source: obj.source || 'queue',
                level: obj.level || 'info',
                text: obj.text,
                priority: obj.priority || 3,
                expires_at: obj.expires_at || null,
              });
            } else {
              await piSpeak.fireReflex({
                source: obj.source || 'queue',
                level: obj.level || 'info',
                text: obj.text,
                mainWindow: getMainWindow(),
                expires_at: obj.expires_at || null,
                ts: obj.ts || null,
                eventId: obj.event_id || null,
              });
            }
          } catch (e) {
            console.error('[pi-speak-queue] dispatch failed:', e.message);
          }
        }
      } finally {
        processing = false;
      }
    }

    fs.watchFile(queueFile, { interval: 1000 }, () => { drain().catch(() => {}); });
    console.log('[pi-speak-queue] watching', queueFile);
  })();

  // ── global._appendPiMainProactive ──
  // pi-speak.js 调这个把 Pi 主动话回写 pi-main，让 Talk to Pi / Home tab 历史看到。
  global._appendPiMainProactive = function (text, source) {
    try {
      const data = loadSessions();
      if (!data || !Array.isArray(data.sessions)) return;
      let main = data.sessions.find(s => s.id === MAIN_SESSION_ID);
      if (!main) return;
      if (!Array.isArray(main.messages)) main.messages = [];
      main.messages.push({
        role: 'assistant',
        content: text,
        ts: new Date().toISOString(),
        meta: { kind: 'proactive', source: source || 'pi' },
      });
      main.updated_at = new Date().toISOString();
      saveSessions(data);
    } catch (e) {
      console.error('[pi-main proactive append] failed:', e.message);
    }
  };

  // ── pi-main-proactive-queue-{host}.jsonl watcher ──
  // 2026-04-24 module-top-level marker
  try {
    fs.appendFileSync(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-main-queue-drain-debug.log'),
      `${new Date().toISOString()} [MODULE-LOAD] reached IIFE definition\n`);
  } catch {}
  (() => {
    try {
      fs.appendFileSync(path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-main-queue-drain-debug.log'),
        `${new Date().toISOString()} [IIFE-START] entering IIFE body\n`);
    } catch {}
    // M1: 只监听本机分片（pi-speak.js 按 host 写）。跨机事件走
    // agent-event-inbox-{host}.jsonl 老通路。host canonical 通过 host-resolve 统一。
    const { resolveHost } = require('../backend/lib/host-resolve');
    const _hostShard = resolveHost();
    const qFile = path.join(VAULT_ROOT, 'Pi', 'Inbox', `pi-main-proactive-queue-${_hostShard}.jsonl`);
    try { fs.mkdirSync(path.dirname(qFile), { recursive: true }); } catch {}
    const _drainLog = path.join(VAULT_ROOT, 'Pi', 'Log', 'pi-main-queue-drain-debug.log');
    const _logDrain = (msg) => {
      try { fs.appendFileSync(_drainLog, `${new Date().toISOString()} ${msg}\n`); } catch {}
    };
    let cursor = 0;
    try { if (fs.existsSync(qFile)) cursor = fs.statSync(qFile).size; } catch {}
    _logDrain(`[init] qFile=${qFile} initial cursor=${cursor} file_exists=${fs.existsSync(qFile)}`);
    let draining = false;
    let _tickCount = 0;
    async function drain() {
      _tickCount++;
      if (draining) { _logDrain(`[tick#${_tickCount}] skip: draining=true`); return; }
      draining = true;
      try {
        let size;
        try { size = fs.statSync(qFile).size; } catch (e) { _logDrain(`[tick#${_tickCount}] statSync fail: ${e.message}`); draining = false; return; }
        if (_tickCount <= 3 || _tickCount % 60 === 0) _logDrain(`[tick#${_tickCount}] size=${size} cursor=${cursor}`);
        if (size < cursor) { _logDrain(`[tick#${_tickCount}] file truncated size<cursor, reset cursor=0`); cursor = 0; }
        if (size <= cursor) { draining = false; return; }
        let buf;
        try {
          const fd = fs.openSync(qFile, 'r');
          buf = Buffer.alloc(size - cursor);
          fs.readSync(fd, buf, 0, buf.length, cursor);
          fs.closeSync(fd);
        } catch (e) {
          _logDrain(`[tick#${_tickCount}] read err: ${e.message}`);
          draining = false; return;
        }
        cursor = size;
        const lines = buf.toString('utf-8').split('\n').filter(Boolean);
        _logDrain(`[tick#${_tickCount}] processing ${lines.length} lines, global._appendPiMainProactive typeof=${typeof global._appendPiMainProactive}`);
        for (const line of lines) {
          let obj;
          try { obj = JSON.parse(line); } catch { _logDrain(`  parse fail: ${line.slice(0,60)}`); continue; }
          if (!obj || !obj.text) { _logDrain('  skip no text'); continue; }
          try {
            global._appendPiMainProactive(obj.text, obj.source || 'pi');
            _logDrain(`  ✓ dispatched: ${String(obj.text).slice(0,60)}`);
          } catch (e) {
            _logDrain(`  ✗ dispatch err: ${e.message}`);
          }
        }
      } finally {
        draining = false;
      }
    }
    fs.watchFile(qFile, { interval: 1000 }, () => { drain().catch(() => {}); });
    setInterval(() => { drain().catch(() => {}); }, 1000);
    try {
      const { powerMonitor } = require('electron');
      powerMonitor.on('resume', () => {
        console.log('[pi-main-proactive-queue] powerMonitor resume → immediate drain');
        drain().catch(() => {});
      });
    } catch {}
    console.log('[pi-main-proactive-queue] watching', qFile, '(fs.watchFile + setInterval backup)');
  })();
}

module.exports = { start };
