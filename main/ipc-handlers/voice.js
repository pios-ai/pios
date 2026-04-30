// main/ipc-handlers/voice.js — TTS / ASR / debug:trace IPC handlers
// 包含：voice:tts / voice:asr / debug:trace + 启动时 TTS/Whisper 预热
// 导出: register(ipcMain) — 注册全部 IPC 并启动预热 setTimeout

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const { execFile } = require('child_process');
const { getTTS } = require('../../backend/qwen-tts');
const VAULT_ROOT = require('../../backend/vault-root');

// ── Whisper 模型路径 ──
const WHISPER_MODEL_MEDIUM = '/opt/homebrew/share/whisper-cpp/ggml-medium.bin';
const WHISPER_MODEL_SMALL  = '/opt/homebrew/share/whisper-cpp/ggml-small.bin';
const WHISPER_MODEL = fs.existsSync(WHISPER_MODEL_MEDIUM) && fs.statSync(WHISPER_MODEL_MEDIUM).size > 500_000_000
  ? WHISPER_MODEL_MEDIUM : WHISPER_MODEL_SMALL;
const WHISPER_CLI = '/opt/homebrew/bin/whisper-cli';

// Whisper 幻觉过滤（静音/噪音时的经典误识别）
const WHISPER_HALLUCINATIONS = [
  '請不吝點贊訂閱轉發打賞支持明鏡與點點欄目',
  '请不吝点赞订阅转发打赏支持明镜与点点栏目',
  '字幕製作', '字幕制作', '字幕由', 'Amara.org',
  '按下按鈕', '按下按钮', '(音樂)', '(音乐)',
  'Thank you for watching', 'thanks for watching',
  'Subscribe', 'Please subscribe',
  '謝謝觀看', '谢谢观看', '感谢收看',
  'MING PAO', '明鏡', '明镜', '點點', '点点',
  '在对话中', '在對話中',
  'music', 'applause', '掌声', '笑声',
  '歡迎收看', '欢迎收看', '感謝收看',
  'The End', 'Bye', 'Goodbye',
  '志愿者', '李宗盛', '中文字幕', '英文字幕',
  '翻译', '校对', '审核', '时间轴',
  '字幕组', '字幕君', '翻譯', '校對',
];

function isWhisperHallucination(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 2) return true;  // 单字太短，必定是噪音
  if (t.length <= 3 && /^[a-zA-Z\u4e00-\u9fff]+$/.test(t)) return true; // <=3字符孤立词
  if (t.length > 50 && !t.includes(' ')) return true; // 超长无空格 = 乱码
  const lower = t.toLowerCase();
  for (const h of WHISPER_HALLUCINATIONS) {
    if (lower.includes(h.toLowerCase())) return true;
  }
  // 全是括号内容 = 注释幻觉
  if (/^\(.*\)$/.test(t) || /^（.*）$/.test(t) || /^\[.*\]$/.test(t)) return true;
  // 全大写英文 = 字幕/水印
  if (/^[A-Z\s|]+$/.test(t) && t.length > 5) return true;
  return false;
}

// TTS 串行 chain（voice:tts handler 内部状态）
let _voiceTTSChain = Promise.resolve();

function register(ipcMain) {
  // TTS（Codex 模式 + run-session task voice 用）— 完整 buffer
  // 串行 chain：避免并发请求撞 QwenTTS 单例的 _busy 锁被 throw 吃掉（造成静默丢词）。
  // 一次只跑一个 speak，后面的排队等着——对用户来说就是每句按顺序念完，不会丢句子。
  ipcMain.handle('voice:tts', async (evt, text, preset) => {
    const task = _voiceTTSChain.then(async () => {
      try {
        const tts = getTTS();
        // 流式：每段合成完立即推到 renderer 的 audioQueue（修 issue #8 长文本首字延迟）
        // onChunk 按 idx 顺序回调，AudioQueue 按 enqueue 顺序播 — 保证句序不乱
        let lastChunkAB = null;
        await tts.speak(text, 15000, preset, (wavBuf, idx, total) => {
          if (!wavBuf || wavBuf.length < 100) return;
          const ab = wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.byteLength);
          lastChunkAB = ab;
          try { evt.sender.send('voice:tts:chunk', ab); } catch {}
        });
        try { global._npcSpeak && global._npcSpeak(text); } catch {}
        // 兼容旧调用方（playTTS 现在不再 enqueue 返回值，但其它内部 caller 可能用过）：
        // 短文本（1 chunk）返回那段 buffer；长文本流式返回 null。
        return lastChunkAB;
      } catch (err) {
        // 不再 fallback 到 macOS `say`——那会绕过 AudioQueue 造成双声（Qwen 返回的迟到音频
        // 和 say 同时响），也是 qwen-voice(MLX Python) 崩溃时"TTS 变 macOS 声音"的根因。
        // 宁可这一句静默，等下句（Qwen 恢复后）正常。
        console.error('[TTS]', err.message);
        return null;
      }
    });
    // 把 chain 的尾巴挪到这个任务之后（即使它 reject 也不能断链）
    _voiceTTSChain = task.catch(() => {});
    return task;
  });

  // DEBUG 埋点：renderer 把诊断信息发回 main，main 写文件（renderer 没有 fs 权限）
  ipcMain.handle('debug:trace', (_, tag, info) => {
    try { fs.appendFileSync('/tmp/pios-notify-debug.log', `[${new Date().toISOString()}] ${tag}: ${info}\n`); } catch {}
  });

  // ── Voice: Local ASR (Qwen/whisper-large-v3-turbo) ──
  ipcMain.handle('voice:asr', async (_, audioBuffer) => {
    const tmpWebm = path.join(os.tmpdir(), `pi-asr-${Date.now()}.webm`);
    const tmpWav = tmpWebm.replace('.webm', '.wav');
    fs.writeFileSync(tmpWebm, Buffer.from(audioBuffer));

    try {
      // Convert webm → wav 16kHz mono
      const ffmpegBin = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
      await new Promise((resolve, reject) => {
        execFile(ffmpegBin, ['-y', '-i', tmpWebm, '-ar', '16000', '-ac', '1', tmpWav],
          { timeout: 5000 }, (err) => err ? reject(err) : resolve());
      });

      // 检查音频时长（< 0.6s 直接丢弃）
      const wavStat = fs.statSync(tmpWav);
      const durationSec = (wavStat.size - 44) / (16000 * 2); // 16kHz 16bit mono
      if (durationSec < 0.6) {
        console.log('[ASR] too short:', durationSec.toFixed(2), 's, skipping');
        return { text: '', error: 'too_short' };
      }

      // 检查音频能量（RMS 太低 = 静音）
      const wavData = fs.readFileSync(tmpWav);
      const samples = new Int16Array(wavData.buffer, 44); // skip WAV header
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i] / 32768;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      // 0.008：owner 报"语音识别不了"时实测 rms=0.01072 被 0.02 门限挡掉
      // 再降到 0.005 真会捕到背景底噪，0.008 是实测能说"你好"的最低值
      if (rms < 0.008) {
        console.log('[ASR] too quiet: rms =', rms.toFixed(5), ', skipping');
        return { text: '', error: '声音太小，靠近点再说' };
      }

      // Qwen ASR（本地 whisper-large-v3-turbo，比 whisper-cli medium 更准）
      const text = await new Promise((resolve, reject) => {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', fs.createReadStream(tmpWav), { filename: 'audio.wav', contentType: 'audio/wav' });
        const reqOpts = {
          method: 'POST',
          hostname: 'localhost',
          port: 7860,
          path: '/api/asr',
          headers: form.getHeaders(),
          timeout: 15000,
        };
        const req = http.request(reqOpts, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(body);
              resolve((result.text || '').trim());
            } catch { resolve(''); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('ASR timeout')); });
        form.pipe(req);
      });

      // 幻觉过滤
      if (isWhisperHallucination(text)) {
        console.log('[ASR] hallucination filtered:', text);
        return { text: '', error: 'hallucination' };
      }

      console.log('[ASR] recognized:', text, `(${durationSec.toFixed(1)}s, rms=${rms.toFixed(3)})`);
      return { text };
    } catch (err) {
      console.error('[ASR error]', err.message);
      return { text: '', error: err.message };
    } finally {
      try { fs.unlinkSync(tmpWebm); } catch {}
      try { fs.unlinkSync(tmpWav); } catch {}
    }
  });

  // ── TTS 预热（等 qwen-voice 启动后读取 freeVoice 配置）──
  setTimeout(() => {
    try {
      const tts = getTTS();
      try {
        const sf = path.join(VAULT_ROOT, 'Pi', 'Config', 'notify-settings.json');
        const ns = JSON.parse(fs.readFileSync(sf, 'utf8'));
        tts.freeVoice = ns.freeVoice === true;
      } catch {}
      console.log('[TTS] connection pre-warmed, freeVoice=%s', tts.freeVoice);
    } catch {}
  }, 5000);

  // ── Whisper 模型预热（load into OS page cache）──
  setTimeout(() => {
    const silenceWav = path.join(os.tmpdir(), 'pi-warmup.wav');
    execFile('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.1', silenceWav],
      { timeout: 3000 }, (err) => {
        if (err) return;
        execFile(WHISPER_CLI, ['-m', WHISPER_MODEL, '-l', 'zh', '-f', silenceWav, '--no-timestamps', '-nt'],
          { timeout: 10000 }, () => {
            try { fs.unlinkSync(silenceWav); } catch {}
            console.log('[whisper] model pre-warmed');
          });
      });
  }, 3000);
}

module.exports = { register, getTTS, isWhisperHallucination };
