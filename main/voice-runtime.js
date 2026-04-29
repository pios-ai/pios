// ── voice-runtime.js ──
// qwen-voice TTS/ASR 服务生命周期管理
// 导出 register(app, ipcMain) 供 main.js 调用

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const _home = os.homedir();
// __dirname 是 pios/main/，pios 根目录在上一层
const _piosRoot = path.join(__dirname, '..');

let qwenVoiceProc = null;

function _resolveQwenVoiceRoot() {
  // 候选顺序：分包模式（~/.pios/voice/）→ 开发机 ~ → 合包 Resources/ → dev .
  const candidates = [
    path.join(_home, '.pios', 'voice', 'qwen-voice'),     // 分包模式 — PiOS 升级不动
    path.join(_home, 'qwen-voice'),                        // 开发机
    path.join(process.resourcesPath || '', 'qwen-voice'),  // 合包模式（兼容）
    path.join(_piosRoot, 'qwen-voice'),                    // dev electron .
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'bin', 'python3')) && fs.existsSync(path.join(c, 'app.py'))) {
      return c;
    }
  }
  return null;
}

const QWEN_VOICE_ROOT = _resolveQwenVoiceRoot();
const QWEN_VOICE_PY = QWEN_VOICE_ROOT ? path.join(QWEN_VOICE_ROOT, 'bin', 'python3') : null;
const QWEN_VOICE_APP = QWEN_VOICE_ROOT ? path.join(QWEN_VOICE_ROOT, 'app.py') : null;

/**
 * 启动 qwen-voice service（可重复调用，idempotent）
 * 失败原因常见：venv 的 bin/python3.12 symlink 指向 /opt/homebrew/opt/python@3.12 不存在
 * （用户还没 brew install python@3.12 时）。用户装完 Python 后 renderer 可以调
 * pios:qwen-ensure-started IPC 触发重试。
 */
function startQwenVoiceService() {
  if (qwenVoiceProc) return { ok: true, reason: 'already-running-by-pios' };
  if (!QWEN_VOICE_ROOT || !fs.existsSync(QWEN_VOICE_PY) || !fs.existsSync(QWEN_VOICE_APP)) {
    return { ok: false, reason: 'qwen-voice root not found' };
  }
  // venv 的 python symlink 必须能 resolve 到真实 Python（否则 spawn 立即 ENOENT）
  try { fs.realpathSync(QWEN_VOICE_PY); }
  catch (e) { return { ok: false, reason: `venv python symlink broken: ${e.message} (need: brew install python@3.12)` }; }
  console.log('[qwen-voice] starting…');
  // bundle 里塞了预下载的 MLX 模型（4.7GB），HF_HOME 指向 bundle 让 huggingface_hub
  // 库直接 hit 本地 cache，新用户首启零下载就 ready
  const BUNDLED_MODELS = path.join(QWEN_VOICE_ROOT, '..', 'qwen-voice-models');
  const useBundledModels = fs.existsSync(path.join(BUNDLED_MODELS, 'hub'));
  try {
    qwenVoiceProc = spawn(QWEN_VOICE_PY, [QWEN_VOICE_APP], {
      cwd: QWEN_VOICE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`,
        ...(useBundledModels ? { HF_HOME: BUNDLED_MODELS, HF_HUB_OFFLINE: '1' } : {}),
      },
    });
    if (useBundledModels) console.log('[qwen-voice] using bundled models at', BUNDLED_MODELS);
  } catch (e) {
    return { ok: false, reason: `spawn failed: ${e.message}` };
  }
  qwenVoiceProc.stdout.on('data', (d) => { const s = d.toString().trim(); if (s) console.log('[qwen-voice]', s); });
  qwenVoiceProc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.log('[qwen-voice]', s); });
  qwenVoiceProc.on('exit', (code) => { console.log('[qwen-voice] exited with', code); qwenVoiceProc = null; });
  return { ok: true, reason: 'spawned' };
}

/** 先查 7860 是否已经活（可能是外部装的）；没活就尝试 spawn */
function ensureQwenStarted() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 7860, path: '/api/status', method: 'GET', timeout: 1500 }, () => {
      resolve({ ok: true, reason: 'already-running' });
    });
    req.on('error', () => resolve(startQwenVoiceService()));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(startQwenVoiceService()); });
    req.end();
  });
}

/**
 * 注册所有 qwen-voice 相关 IPC + app 事件。
 * 在 app.whenReady() 之后调用（app 和 ipcMain 都就绪）。
 */
function register(app, ipcMain) {
  if (QWEN_VOICE_ROOT) {
    console.log('[qwen-voice] root resolved to:', QWEN_VOICE_ROOT);
    // 首次启动试一次 — 如果用户没装 Python，renderer 装完 deps 后会再调 ensureQwenStarted
    ensureQwenStarted().then(r => console.log('[qwen-voice] startup probe:', r));

    // PiBrowser 退出时清理 qwen-voice 子进程（_tickTimer 清理由 main.js 自己的 will-quit handler 负责）
    app.on('will-quit', () => {
      if (qwenVoiceProc) { try { qwenVoiceProc.kill(); } catch {} }
    });
  } else {
    console.log('[qwen-voice] not found in any candidate path — NPC voice disabled. Install: see INSTALL.md §Voice Engine');
  }

  ipcMain.handle('pios:qwen-ensure-started', async () => ensureQwenStarted());

  // 孵化前需要确认 qwen-voice 服务 (localhost:7860) 已 ready，否则只能用 mac say 兜底——
  // 这俩 IPC 让 renderer 在装完 deps + 起 qwen 后能轮询 + 直接调 qwen TTS（不用走 webkit speechSynthesis）
  ipcMain.handle('pios:qwen-status', async () => {
    return await new Promise((resolve) => {
      const req = http.get('http://localhost:7860/api/status', { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try { const j = JSON.parse(data); resolve({ ready: !!j.ready, raw: j }); }
          catch { resolve({ ready: false }); }
        });
      });
      req.on('error', () => resolve({ ready: false }));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ready: false }); });
    });
  });

  ipcMain.handle('pios:qwen-tts-wav', async (_, opts = {}) => {
    let { text, voice, npcId, instruct = '用温柔自然的语气说话' } = opts;
    if (!text) return { ok: false, err: 'empty text' };
    // 传 npcId 时从 characters.yaml 查该 NPC 的 voice（单一权威）
    // 保证孵化预览的声音和 Home 里 Pi 说话用同一套音色
    if (!voice && npcId) {
      try {
        const pp = require('../backend/pi-persona');
        const c = pp.listCharacters().find(x => (x.skin || x.id) === npcId);
        if (c && c.voice) voice = c.voice;
      } catch {}
    }
    if (!voice) voice = 'Serena'; // 兜底
    return await new Promise((resolve) => {
      const body = JSON.stringify({ text, voice, instruct });
      const req = http.request('http://localhost:7860/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 20000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ ok: true, audio_b64: Buffer.concat(chunks).toString('base64') });
          } else {
            resolve({ ok: false, err: `qwen status ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}` });
          }
        });
      });
      req.on('error', (e) => resolve({ ok: false, err: e.message }));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, err: 'qwen tts timeout' }); });
      req.write(body); req.end();
    });
  });
}

module.exports = { register, ensureQwenStarted, startQwenVoiceService, QWEN_VOICE_ROOT };
