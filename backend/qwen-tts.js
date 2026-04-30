/**
 * Qwen3-TTS 本地语音服务客户端
 * 支持多音色：freeVoice 开启时 Pi 根据场景自动选音色，关闭时用默认音
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { applyVoiceFilter, getPreset } = require('./voice-filter');

const QWEN_VOICE_URL = 'http://localhost:7860';
const DEFAULT_VOICE = '小豆温柔';
const DEFAULT_INSTRUCT = '用温柔自然的语气说话';
const MAX_CHUNK_LEN = 200;

// NPC 皮肤 → 音色
// 单一权威：Pi/Config/characters.yaml 每个 character 的 {voice, voice_verified} 字段。
// 音色必须过 TTS→ASR 回环验证（voice_verified=true）才启用；未验证 → 兜底 DEFAULT_VOICE（小豆温柔）。
// 添加新音色流程见 docs/pi-npc.md:99。
const VAULT_ROOT = require('./vault-root');
const NPC_STATE_FILE = path.join(VAULT_ROOT, 'Pi', 'State', 'pi-npc.json');

// 回落硬映射（characters.yaml 读不到时兜底，保持旧行为）
const FALLBACK_SKIN_VOICE_MAP = {
  doraemon: '多啦A梦',
  starlet: '星仔',
  nailong: '奶龙',
};

// NPC 皮肤专属 TTS instruct 映射
// 克隆音色支持 instruct（实测：同一音色不同 instruct 产出长度/韵律明显不同）
// 按角色性格选最匹配的风格；未列出的皮肤兜底用 ''（让克隆音色自然输出）
const NPC_SKIN_INSTRUCT_MAP = {
  patrick:  '用非常开心兴奋的语气说话',   // 天真乐观
  doraemon: '用温柔自然的语气说话',        // 温柔助人
  baymax:   '用温柔自然的语气说话',        // 平稳关怀
  minion:   '用非常开心兴奋的语气说话',   // 兴奋闹腾
  kirby:    '用非常开心兴奋的语气说话',   // 柔软乐观
  totoro:   '用温柔自然的语气说话',        // 低沉少言
  slime:    '用撒娇的语气说话',            // 软糯跳跃
  trump:    '用严肃认真的语气说话',        // 夸张排比
  shinchan: '用非常开心兴奋的语气说话',   // 5岁天真
  starlet:  '用非常开心兴奋的语气说话',   // 童声好奇
  nailong:  '用撒娇的语气说话',            // 软糯小奶音
  peppa:    '用非常开心兴奋的语气说话',   // 英式小女孩
  feixia:   '用非常开心兴奋的语气说话',   // 活泼热情
  qiaozhi:  '用非常开心兴奋的语气说话',   // 3岁小猪
  jubal:    '用温柔自然的语气说话',        // 竹宝皮肤：安全复用小豆温柔，不做儿童声线克隆
};

function getNpcSkinVoice() {
  // NPC 未开启 → 不走角色音色
  try {
    const npc = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf-8'));
    if (!npc || npc.enabled !== true) return null;
  } catch { return null; }

  // 优先走 pi-persona 的 verified voice
  try {
    const piPersona = require('./pi-persona');
    const v = piPersona.getCurrentVoice();
    if (v) return v;
    // voice_verified=false 但 characters.yaml 有 voice 字段 → 直接用它（让 qwen 尝试合成）。
    // 原逻辑是在这里 fallback DEFAULT_VOICE（小豆温柔），导致 owner 选 "派大星" 等未验证 NPC
    // 时全程小豆声。改成：优先用 yaml 配置的 voice，如果 qwen 不支持会返 400，调用方自然 fallback。
    const c = piPersona.getCurrentCharacter();
    if (c && c.voice) return c.voice;
    if (c) return FALLBACK_SKIN_VOICE_MAP[c.skin || c.id] || null;
  } catch {}

  // pi-persona 出错 → 回落读旧 pi-npc.json.skin
  try {
    const j = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf-8'));
    if (j && typeof j.skin === 'string') return FALLBACK_SKIN_VOICE_MAP[j.skin] || null;
  } catch {}
  return null;
}

/**
 * 将长文本按自然句子切分为 ≤MAX_CHUNK_LEN 字的段落
 */
function splitTextIntoChunks(text, maxLen = MAX_CHUNK_LEN) {
  // 先按句末标点切分
  const sentences = text.split(/(?<=[。？！!?…])/u);
  const chunks = [];
  let current = '';

  for (const sent of sentences) {
    if (!sent) continue;
    if (current.length + sent.length <= maxLen) {
      current += sent;
    } else {
      if (current) chunks.push(current);
      // 单句过长时按逗号/分号再切
      if (sent.length > maxLen) {
        const parts = sent.split(/(?<=[，,、；;])/u);
        let sub = '';
        for (const part of parts) {
          if (sub.length + part.length <= maxLen) {
            sub += part;
          } else {
            if (sub) chunks.push(sub);
            // 超长的硬切
            if (part.length > maxLen) {
              for (let i = 0; i < part.length; i += maxLen) {
                chunks.push(part.slice(i, i + maxLen));
              }
              sub = '';
            } else {
              sub = part;
            }
          }
        }
        current = sub;
      } else {
        current = sent;
      }
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.filter(c => c.trim());
}

/**
 * 包 PCM samples 成可独立解码的 mini-WAV buffer。
 * 用于流式：每段 PCM 立即包成 WAV → renderer audioQueue.decodeAudioData 直接吃。
 *
 * @param {number} pcmLen - PCM 字节数
 * @param {number} sampleRate - 采样率（Qwen3-TTS 是 24000）
 * @returns {Buffer} 44 字节 RIFF/WAVE/PCM/16bit/mono header
 */
function _buildWavHeader(pcmLen, sampleRate = 24000) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(36 + pcmLen, 4);            // file size - 8
  buf.write('WAVE', 8, 4, 'ascii');
  buf.write('fmt ', 12, 4, 'ascii');
  buf.writeUInt32LE(16, 16);                     // fmt chunk size (PCM = 16)
  buf.writeUInt16LE(1, 20);                      // format code: PCM
  buf.writeUInt16LE(1, 22);                      // num channels: mono
  buf.writeUInt32LE(sampleRate, 24);             // sample rate
  buf.writeUInt32LE(sampleRate * 2, 28);         // byte rate (sr * channels * bits/8 = sr * 2)
  buf.writeUInt16LE(2, 32);                      // block align (channels * bits/8 = 2)
  buf.writeUInt16LE(16, 34);                     // bits per sample
  buf.write('data', 36, 4, 'ascii');
  buf.writeUInt32LE(pcmLen, 40);                 // data chunk size
  return buf;
}

/**
 * 合并多个 WAV buffer：找到每个 buffer 的 data chunk，提取 PCM，重建单一 WAV
 */
function mergeWavBuffers(wavBuffers) {
  if (wavBuffers.length === 1) return wavBuffers[0];

  /**
   * 在 WAV buffer 中定位 data chunk，返回 { headerEnd, pcmStart, pcmLen }
   * headerEnd = data chunk 开始（包含 "data" + size 共 8 字节）之前的字节数
   * pcmStart  = PCM 数据开始位置
   */
  function findDataChunk(buf) {
    let off = 12; // 跳过 "RIFF" + size + "WAVE"
    while (off + 8 <= buf.length) {
      const id = buf.slice(off, off + 4).toString('ascii');
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        return { headerEnd: off, pcmStart: off + 8, pcmLen: size };
      }
      off += 8 + size;
    }
    throw new Error('WAV data chunk not found');
  }

  const first = wavBuffers[0];
  const { headerEnd, pcmStart } = findDataChunk(first);

  // 复制 header（含 fmt chunk，不含 data chunk header）
  const header = Buffer.from(first.slice(0, headerEnd));

  // 收集所有 chunk 的 PCM 数据
  const pcmParts = [first.slice(pcmStart)];
  for (let i = 1; i < wavBuffers.length; i++) {
    const { pcmStart: ps } = findDataChunk(wavBuffers[i]);
    pcmParts.push(wavBuffers[i].slice(ps));
  }

  const totalPcm = Buffer.concat(pcmParts);

  // 重建：header + data chunk header + PCM
  const dataChunkHeader = Buffer.alloc(8);
  dataChunkHeader.write('data', 0, 'ascii');
  dataChunkHeader.writeUInt32LE(totalPcm.length, 4);

  const merged = Buffer.concat([header, dataChunkHeader, totalPcm]);

  // 更新 RIFF size（bytes 4-7）= 文件总长 - 8
  merged.writeUInt32LE(merged.length - 8, 4);

  return merged;
}

class QwenTTS {
  constructor({ voice = DEFAULT_VOICE, instruct = DEFAULT_INSTRUCT } = {}) {
    this.voice = voice;
    this.instruct = instruct;
    this.freeVoice = false;  // 自由音色开关
    this._busy = false;
  }

  /**
   * speak — 支持 preset 参数，自动对长文本分段合成
   * @param {string} text - 要说的文字
   * @param {number} timeout - 每段超时（ms）
   * @param {string} [preset] - 音色预设名（仅 freeVoice=true 时生效）
   * @param {(wav:Buffer,idx:number,total:number)=>void} [onChunk] - 流式回调；
   *        提供时每段合成完毕立即回调（按 idx 顺序），返回 null。
   *        不提供时走原 buffer-then-merge 路径，返回完整 WAV Buffer。
   *        修 issue #8：长文本首字延迟 — 串行 await 完所有 chunk 才返回，
   *        长回复要等几秒才开始播；onChunk 让调用方边收边播。
   */
  async speak(text, timeout = 15000, preset, onChunk) {
    if (this._busy) throw new Error('TTS busy');
    this._busy = true;
    try {
      let voice = this.voice;
      let instruct = this.instruct;
      let filterPreset = 'default';
      let magneticLevel;  // 仅 NPC preset 用；其他 preset 用 BASE_FILTER 固定 mid

      if (this.freeVoice && preset) {
        const p = getPreset(preset);
        voice = p.ttsVoice;
        instruct = p.ttsInstruct;
        filterPreset = preset;
      } else {
        // NPC 皮肤覆盖：启用了 NPC 且皮肤映射了克隆音色时，换成角色本音
        // 优先级低于 freeVoice（freeVoice 是显式场景化选色）
        const npcVoice = getNpcSkinVoice();
        if (npcVoice) {
          voice = npcVoice;
          // NPC 克隆音色走 'npc' preset（继承磁性 chorus/aecho/EQ，档位由 voice_magnetic 决定）
          filterPreset = 'npc';
          // 从 characters.yaml 读角色专属 instruct + 磁性档位
          try {
            const piPersona = require('./pi-persona');
            const skinId = piPersona.getCurrentSkin();
            instruct = NPC_SKIN_INSTRUCT_MAP[skinId] !== undefined
              ? NPC_SKIN_INSTRUCT_MAP[skinId]
              : '';
            const c = piPersona.getCurrentCharacter();
            magneticLevel = c.voice_magnetic || 'mid';
          } catch {
            instruct = '';
            magneticLevel = 'mid';
          }
        }
      }

      // 流式模式：调用方提供 onChunk → 直接走服务端 token-level 流式（/api/tts/stream
       // 本来就 chunked transfer），不在客户端切文本，每收 ~0.3s PCM 立即包成 mini-WAV
       // forward 给 audioQueue。第一字节 ~300-500ms（mlx-audio AR 生成 + decode）。
       // 牺牲 applyVoiceFilter（chorus/echo 磁性后处理）— owner 2026-04-30 决策：
       // 磁性走 ref_audio 预处理一次性烧进克隆音色源，运行时不再后处理。
      if (typeof onChunk === 'function') {
        console.log('[QwenTTS] streaming: voice=%s len=%d (server-side token-level)', voice, text.length);
        await this._streamPCM(text, voice, instruct, timeout, (wavBuf, idx) => {
          try { onChunk(wavBuf, idx, -1 /* total unknown in stream mode */); } catch (e) {
            console.warn('[QwenTTS] onChunk callback threw:', e.message);
          }
        });
        return null;
      }

      // 缓冲模式（旧路径，无 onChunk callback；保留给非流式 caller）
      const chunkLimit = (filterPreset === 'npc') ? 120 : MAX_CHUNK_LEN;
      const textChunks = text.length > chunkLimit
        ? splitTextIntoChunks(text, chunkLimit)
        : [text];

      console.log('[QwenTTS] freeVoice=%s preset=%s voice=%s len=%d chunks=%d',
        this.freeVoice, filterPreset, voice, text.length, textChunks.length);

      // 串行合成 chunk —— 不能并行打 qwen-voice（mlx-audio 模型不是 thread-safe;
      // 两个并发请求共享同一个 attention state 会触发 broadcast_shapes mismatch +
      // SIGSEGV in libmlx Metal::Device::end_encoding，导致 Python 进程崩溃，
      // launchd 反复重启。2026-04-30 实测：高频 TTS 期间每分钟 1 次 SIGSEGV）。
      // 缓冲模式：串行合成全部，merge 后整段过 filter（保 echo 连续性）
      // 注：流式模式（typeof onChunk === 'function'）已经在前面 _streamPCM 处理过 return 了，走不到这里
      const wavBuffers = [];
      for (const chunk of textChunks) {
        wavBuffers.push(await this._callTTSAPI(chunk, voice, instruct, timeout));
      }
      const merged = wavBuffers.length === 1 ? wavBuffers[0] : mergeWavBuffers(wavBuffers);
      return await applyVoiceFilter(merged, filterPreset, magneticLevel).catch(() => merged);
    } finally {
      this._busy = false;
    }
  }

  /**
   * 真流式：HTTP body 持续涌来 PCM，每 ~minBytes 累积包成 mini-WAV forward 给 onMiniWav。
   * mlx-audio 服务端 streaming_interval=0.3 → 每 ~0.3s 音频内容刷一次。
   * 每个 mini-WAV 是独立可解码 buffer（带正确 RIFF header），renderer 的 audioQueue
   * 直接 decodeAudioData → 顺序播放。
   *
   * @param {string} text — 完整文本，不分段（服务端 AR 一字一字流出来）
   * @param {string} voice
   * @param {string} instruct
   * @param {number} timeout — 整体超时
   * @param {(wav:Buffer, idx:number) => void} onMiniWav — 每段 mini-WAV 立即回调
   */
  async _streamPCM(text, voice, instruct, timeout, onMiniWav) {
    const body = JSON.stringify({ text, voice, instruct });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TTS stream timeout')), timeout * 4); // 整段超时给宽裕
      const req = http.request(`${QWEN_VOICE_URL}/api/tts/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          return reject(new Error(`TTS stream error ${res.statusCode}`));
        }
        const sampleRate = parseInt(res.headers['x-sample-rate'] || '24000', 10);
        // 每 0.3s 音频累够就 flush 一段（24kHz × 0.3s × 2 bytes = 14400）。
        // 第一字节 latency = 服务端从开始合成到第一段 PCM 到达 + 这个 buffer 满。
        const flushBytes = Math.floor(sampleRate * 0.3) * 2;

        let pcmBuf = Buffer.alloc(0);
        let headerSeen = false;
        let chunkIdx = 0;

        const flushMiniWav = () => {
          if (pcmBuf.length === 0) return;
          const mini = Buffer.concat([_buildWavHeader(pcmBuf.length, sampleRate), pcmBuf]);
          try { onMiniWav(mini, chunkIdx++); } catch (e) {
            console.warn('[QwenTTS stream] onMiniWav threw:', e.message);
          }
          pcmBuf = Buffer.alloc(0);
        };

        res.on('data', (chunk) => {
          // 第一段 HTTP body 前 44 字节是服务端的 RIFF header（size 0xFFFFFFFF 是流式标记），跳过。
          if (!headerSeen) {
            if (chunk.length < 44) return; // 极小概率：header 未到完整，丢一点
            chunk = chunk.slice(44);
            headerSeen = true;
          }
          pcmBuf = Buffer.concat([pcmBuf, chunk]);
          while (pcmBuf.length >= flushBytes) {
            const send = pcmBuf.slice(0, flushBytes);
            pcmBuf = pcmBuf.slice(flushBytes);
            const mini = Buffer.concat([_buildWavHeader(send.length, sampleRate), send]);
            try { onMiniWav(mini, chunkIdx++); } catch (e) {
              console.warn('[QwenTTS stream] onMiniWav threw:', e.message);
            }
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          flushMiniWav();
          resolve();
        });
        res.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.on('timeout', () => { try { req.destroy(); } catch {}; clearTimeout(timer); reject(new Error('TTS stream req timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * 调用 TTS API 合成单段文本，返回原始 WAV Buffer（不含滤镜）
   */
  async _callTTSAPI(text, voice, instruct, timeout) {
    const body = JSON.stringify({ text, voice, instruct });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TTS timeout')), timeout);
      const req = http.request(`${QWEN_VOICE_URL}/api/tts/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode === 200) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error(`TTS error ${res.statusCode}`));
          }
        });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.write(body);
      req.end();
    });
  }

  /**
   * 真正的流式：每个 chunk 到了就回调，前端可以边收边播
   * onChunk(buffer, isLast)
   */
  async speakChunked(text, onChunk, timeout = 15000) {
    if (this._busy) throw new Error('TTS busy');
    this._busy = true;
    try {
      const body = JSON.stringify({ text, voice: this.voice, instruct: this.instruct });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), timeout);
        const req = http.request(`${QWEN_VOICE_URL}/api/tts/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          if (res.statusCode !== 200) {
            clearTimeout(timer);
            reject(new Error(`TTS error ${res.statusCode}`));
            return;
          }
          res.on('data', (chunk) => {
            onChunk(chunk, false);
          });
          res.on('end', () => {
            clearTimeout(timer);
            onChunk(Buffer.alloc(0), true);
            resolve();
          });
        });
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.write(body);
        req.end();
      });
    } finally {
      this._busy = false;
    }
  }

  /**
   * macOS say 兜底
   */
  async speakFallback(text) {
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
      execFile('say', ['-v', 'Tingting', '-r', '220', text], { timeout: 10000 }, () => resolve());
    });
  }

  startHeartbeat() {}
  close() {}
}

let _instance = null;

function getTTS() {
  if (!_instance) {
    _instance = new QwenTTS({ voice: DEFAULT_VOICE });
  }
  return _instance;
}

module.exports = { QwenTTS, getTTS, splitTextIntoChunks, mergeWavBuffers };
