// Notification + Pi event silent log extracted from main.js.
// 包含：
//   - sendNotification(title, text, source, { skipHistory })：5 路通知（历史/Home toast/macOS osascript/TTS/Electron Notification）
//   - handlePiEvent(event)：后台事件静默写主会话 + renderer 气泡
//   - register(ipcMain)：注册 'app:notify' IPC

const path = require('path');
const fs = require('fs');
const { Notification } = require('electron');

function create(state) {
  const {
    VAULT_ROOT,
    MAIN_SESSION_ID,
    loadSessions,
    saveSessions,
    sanitizeForTTS,
  } = state;
  const getMainWindow = () => state.mainWindow;

  function sendNotification(title, text, source = 'system', { skipHistory = false } = {}) {
    const escaped = (s) => s.replace(/"/g, '\\"');

    const settingsFile = path.join(VAULT_ROOT, 'Pi', 'Config', 'notify-settings.json');
    let settings = { voice: true, popup: true };
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch {}

    if (!skipHistory) {
      const histFile = path.join(VAULT_ROOT, 'Pi', 'Log', 'notify-history.jsonl');
      try {
        fs.appendFileSync(histFile, JSON.stringify({ time: new Date().toISOString(), title, text, source }) + '\n');
      } catch {}
    }

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pios:notification', { title, body: text, time: new Date().toISOString() });
    }

    if (settings.popup !== false) {
      const { execFile } = require('child_process');
      execFile('/usr/bin/osascript', ['-e', `display notification "${escaped(text)}" with title "${escaped(title)}"`], (err, stdout, stderr) => {
        if (err) console.error('[notify] osascript error:', err.message, stderr);
        else console.log('[notify] osascript ok');
      });
    }

    // TTS 语音（P7 fix v3 · 2026-04-19 晚）
    // 核心发现：对话 TTS 有声是因为 renderer 本地调 voiceTTS 拿 buffer → audioQueue，
    // 不跨 IPC 传 buffer。通知 TTS 以前走 main→IPC→renderer buffer 传输，
    // onTTSPlay 回调在 renderer 端 byteLength 检查 skip。
    // v3 正解：main 只发 text 给 renderer（notify:speak 事件），renderer 自己调 voiceTTS。
    if (settings.voice !== false && mainWindow && !mainWindow.isDestroyed()) {
      const ttsText = sanitizeForTTS(text || title);
      try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] main: send notify:speak text="${ttsText.slice(0, 40)}" mainWindow.isVisible=${mainWindow.isVisible()} webContents.isDestroyed=${mainWindow.webContents.isDestroyed()}\n`); } catch {}
      try { mainWindow.webContents.send('notify:speak', ttsText); } catch (e) { console.error('[notify:speak]', e.message); try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] main: send notify:speak FAILED: ${e.message}\n`); } catch {} }
      if (typeof global._npcSpeak === 'function') {
        try { global._npcSpeak(ttsText); } catch {}
      }
    } else {
      try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] main: SKIP notify:speak voice=${settings.voice} mainWindow=${!!mainWindow} destroyed=${mainWindow ? mainWindow.isDestroyed() : 'n/a'}\n`); } catch {}
    }

    console.log('[notify] isSupported:', Notification.isSupported(), 'popup:', settings.popup);
    if (settings.popup !== false && Notification.isSupported()) {
      const n = new Notification({ title, body: text, silent: true });
      n.on('show', () => console.log('[notify] Notification shown'));
      n.on('failed', (e, err) => console.error('[notify] Notification failed:', err));
      n.on('click', () => { const mw = getMainWindow(); if (mw) { mw.show(); mw.focus(); } });
      n.show();
    }
  }

  async function handlePiEvent(event) {
    const headParts = [event.agent, event.task].filter(Boolean);
    const head = headParts.length ? `[${headParts.join('/')}] ` : '';
    const primary = event.action || event.triage || event.archive || event.output || '后台任务完成';
    const piMessage = `${head}${String(primary).substring(0, 160)}`.trim();
    if (!piMessage) return;

    console.log('[pi-event] silent log:', piMessage.substring(0, 100));

    const data = loadSessions();
    const mainSession = data.sessions.find(s => s.id === MAIN_SESSION_ID);
    if (mainSession) {
      mainSession.messages.push({
        role: 'ai',
        content: piMessage,
        engine: 'silent',
        timestamp: new Date().toISOString(),
        proactive: true,
        silent: true,
      });
      mainSession.updated = new Date().toISOString();
      saveSessions(data);
    }

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pi:proactive', { text: piMessage, timestamp: new Date().toISOString(), silent: true });
    }
    // ⚠️ 刻意不调 sendNotification —— macOS 通知 + TTS 由 notify.sh 按级别统一处理
  }

  function register(ipcMain) {
    ipcMain.on('app:notify', (_, title, body) => {
      sendNotification(title, body, 'app');
    });
  }

  return { sendNotification, handlePiEvent, register };
}

module.exports = { create };
