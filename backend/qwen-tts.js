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

      // 长文本分段：克隆音色 120 字（原 60 太碎，owner 2026-04-25 反馈每句 2-3 chunk 串行等很慢）
      // attention 漂移风险用 120 字以内仍可控；超过再加大会明显掉音色。
      const chunkLimit = (filterPreset === 'npc') ? 120 : MAX_CHUNK_LEN;
      const textChunks = text.length > chunkLimit
        ? splitTextIntoChunks(text, chunkLimit)
        : [text];

      console.log('[QwenTTS] freeVoice=%s preset=%s voice=%s len=%d chunks=%d',
        this.freeVoice, filterPreset, voice, text.length, textChunks.length);

      // 并行合成所有 chunk（各 chunk 独立 ref_audio 锚，互不依赖）
      // 串行 = N*4s；并行 = max(4s)（qwen 端 MLX 能否并行看模型，最差也是 N 个 req 同时打 qwen 进程排队，
      // 但 HTTP 层立即接收，_callTTSAPI 回调并发返回，总时长显著降）
      const rawSynths = textChunks.map(chunk => this._callTTSAPI(chunk, voice, instruct, timeout));

      // 流式模式：onChunk 提供时按 idx 顺序逐段回调（chunk N 合成完且 chunk 0..N-1 都已回调
      // 才回调 chunk N — 渲染端 AudioQueue 是按 enqueue 顺序播的，乱序会让句子颠倒）。
      // 合成本身仍并行；首字延迟从 N*chunk 降到 1*chunk。
      // 流式模式必须 per-chunk applyVoiceFilter（不能等 merge 再 filter，那就退回非流式了）。
      // 副作用：跨 chunk 边界的 echo/chorus 不连续；可接受 — 长回复中断时听感优于"等几秒才出声"。
      if (typeof onChunk === 'function') {
        for (let i = 0; i < rawSynths.length; i++) {
          const raw = await rawSynths[i];
          const filtered = await applyVoiceFilter(raw, filterPreset, magneticLevel).catch(() => raw);
          try { onChunk(filtered, i, rawSynths.length); } catch (e) {
            console.warn('[QwenTTS] onChunk callback threw:', e.message);
          }
        }
        return null;
      }

      // 缓冲模式（旧路径保留）：merge 后整段过 filter（保 echo 连续性）
      const wavBuffers = await Promise.all(rawSynths);
      const merged = wavBuffers.length === 1 ? wavBuffers[0] : mergeWavBuffers(wavBuffers);
      return await applyVoiceFilter(merged, filterPreset, magneticLevel).catch(() => merged);
    } finally {
      this._busy = false;
    }
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
