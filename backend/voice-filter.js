/**
 * Pi Voice Filter — 多音色 AI 声音系统
 *
 * User-curated voice presets：
 * - default:  Uncle_Fu — 正式男声（日常/汇报/分析）
 * - warm:     小豆温柔 — 温柔女声（安慰/鼓励/闲聊）[clone]
 * - fun:      Ono_Anna — 搞笑女声（调侃/轻松/惊讶）
 * - eric:     Eric — 方言搞笑男（极度搞笑/调侃/吐槽）
 * - abe:      User cloned voice (special)[clone]
 */

const { spawn } = require('child_process');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// 磁性回声档位（Owner 可在 Team Config 角色页按 NPC 切换）
// 参数格式 aecho=in_gain:out_gain:delays(ms,|):decays(|)
//   delay 第三 tap 是"磁性尾巴"关键；decay 越大尾巴越长
// 特殊档 'raw' → 完全 bypass filter（返回 TTS 原声）
const MAGNETIC_ECHO = {
  raw:    null,                                      // 原声（无任何 AI 音效）
  soft:   'aecho=0.7:0.5:30|60|120:0.3|0.2|0.15',   // 柔
  mid:    'aecho=0.8:0.6:30|60|150:0.4|0.25|0.2',   // 中（默认）
  strong: 'aecho=0.8:0.7:30|80|200:0.5|0.3|0.3',    // 强
};

// chorus + 三段 EQ 是磁性"AI 音色"的主干
const BASE_CHORUS_EQ = [
  'chorus=0.6:0.9:25|45:0.3|0.2:0.25|0.15:2|1.3',
  'equalizer=f=150:t=q:w=1.2:g=9',
  'equalizer=f=300:t=q:w=1.5:g=6',
  'equalizer=f=800:t=q:w=1.5:g=4',
];

const BASE_TAIL = ['highpass=f=60', 'lowpass=f=8000', 'loudnorm=I=-14:TP=-1:LRA=7'];

// BASE_FILTER = 非 NPC 音色默认 filter（default/warm/fun/eric/cloned）
// aecho 用 mid 档，避免"爆炸感"又保留磁性
const BASE_FILTER = [...BASE_CHORUS_EQ, MAGNETIC_ECHO.mid, ...BASE_TAIL];

// NPC preset filter：按 magneticLevel 挑 aecho 档；其余继承 BASE
// raw 档 → 返回 null 表示 bypass filter（调用方特判）
function _npcFilter(level) {
  if (level === 'raw') return null;
  const echo = MAGNETIC_ECHO[level];
  if (echo === undefined) return [...BASE_CHORUS_EQ, MAGNETIC_ECHO.mid, ...BASE_TAIL];
  return [...BASE_CHORUS_EQ, echo, ...BASE_TAIL];
}

const VOICE_PRESETS = {
  // 正式男声：日常工作、汇报、分析
  default: {
    ttsVoice: 'Uncle_Fu',
    ttsInstruct: '用沉稳自然的语气说话，像纪录片旁白',
    filter: BASE_FILTER,
  },

  // 温柔女声：安慰、鼓励、闲聊（克隆音色，不支持 instruct）
  warm: {
    ttsVoice: '小豆温柔',
    ttsInstruct: '',
    filter: BASE_FILTER,
  },

  // 搞笑女声：调侃、轻松、惊讶
  fun: {
    ttsVoice: 'Ono_Anna',
    ttsInstruct: '用轻松搞笑的语气说话',
    filter: BASE_FILTER,
  },

  // 方言搞笑男：极度搞笑、调侃、吐槽
  eric: {
    ttsVoice: 'Eric',
    ttsInstruct: '用轻松搞笑的方言语气说话',
    filter: BASE_FILTER,
  },

  // User cloned voice: special occasions (cloned, no instruct)
  // Voice name is read from ~/.pios/config.json → cloned_voice_name at runtime
  // (see _getClonedVoiceName below). Null / missing → falls back to 'default' preset.
  cloned: {
    ttsVoice: null,  // populated by _getClonedVoiceName
    ttsInstruct: '',
    filter: BASE_FILTER,
  },

  // NPC skin clone voice: 继承 BASE_FILTER 的磁性音效（chorus + EQ + aecho），
  // aecho 档位由 Owner 在 Team Config 角色页按 NPC 配置（characters.yaml 的 voice_magnetic）。
  // 由 getPreset(preset, magneticLevel) 动态组装 —— filter 字段仅占位。
  npc: {
    ttsVoice: null,
    ttsInstruct: '',
    filter: null,
  },
};

// 从 ~/.pios/config.json 读用户克隆声名字（没配置 → null）
function _getClonedVoiceName() {
  try {
    const os = require('os');
    const cfgPath = require('path').join(os.homedir(), '.pios', 'config.json');
    if (!require('fs').existsSync(cfgPath)) return null;
    const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf-8'));
    return cfg.cloned_voice_name || null;
  } catch { return null; }
}

function getPreset(preset, magneticLevel) {
  let p = VOICE_PRESETS[preset];
  // 'cloned' preset: 运行时填入用户配的声音名，没配就退回 default
  if (preset === 'cloned' || preset === 'abe' /* legacy alias */) {
    const name = _getClonedVoiceName();
    if (!name) { p = VOICE_PRESETS.default; }
    else { p = { ...VOICE_PRESETS.cloned, ttsVoice: name }; }
  }
  if (!p) p = VOICE_PRESETS.default;
  // NPC preset: 按 magneticLevel 动态拼 aecho 档位；raw 档返回 null bypass filter
  const filter = preset === 'npc' ? _npcFilter(magneticLevel) : p.filter;
  return { ...p, filter: filter === null ? null : filter.join(',') };
}

function listPresets() {
  return Object.keys(VOICE_PRESETS);
}
function listMagneticLevels() {
  return Object.keys(MAGNETIC_ECHO);
}

function applyVoiceFilter(wavBuf, preset = 'default', magneticLevel) {
  const p = getPreset(preset, magneticLevel);
  // raw 档：bypass ffmpeg，直接返回 TTS 原声
  if (p.filter === null) {
    console.log('[VoiceFilter] preset=%s level=raw → bypass (%d bytes)', preset, wavBuf.length);
    return Promise.resolve(wavBuf);
  }
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      '-f', 'wav', '-i', 'pipe:0',
      '-af', p.filter,
      '-f', 'wav', 'pipe:1',
      '-y', '-loglevel', 'error',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));

    child.on('close', (code) => {
      const result = Buffer.concat(chunks);
      if (code === 0 && result.length > 0) {
        console.log('[VoiceFilter] preset=%s, %d → %d bytes', preset, wavBuf.length, result.length);
        resolve(result);
      } else {
        console.warn('[VoiceFilter] failed (preset=%s, code=%d), returning original', preset, code);
        resolve(wavBuf);
      }
    });

    child.on('error', (err) => {
      console.warn('[VoiceFilter] spawn error:', err.message);
      resolve(wavBuf);
    });

    child.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn('[VoiceFilter:ffmpeg]', msg);
    });

    child.stdin.write(wavBuf);
    child.stdin.end();

    setTimeout(() => { try { child.kill(); } catch {} }, 10000);
  });
}

module.exports = { applyVoiceFilter, getPreset, listPresets, listMagneticLevels, VOICE_PRESETS, MAGNETIC_ECHO };
