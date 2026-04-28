/**
 * pi-persona.js — Pi 角色（戏服）单一权威读写入口
 *
 * 数据分层：
 *   - Pi/Config/characters.yaml  (只读清单，owner 通过 Pi Tab 编辑)
 *   - Pi/State/pi-character.json (运行时"当前穿哪件"，owner 切换时写)
 *
 * 戏服包含：display_name / nickname / avatar_emoji / skin / voice / voice_verified
 *           / speech_style / catchphrases / how_it_addresses_owner /
 *           disagreement_style / metaphor_pool / emoji_level
 *
 * Pi 的"底盘"（alignment / SOUL / 红线 / Cards 规则 / Pi/Memory / 对 owner 的认知）
 * 不在本模块范围内——切戏服不换底盘。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const VAULT_PATH = require('./vault-root');
const CHARACTERS_YAML = path.join(VAULT_PATH, 'Pi', 'Config', 'characters.yaml');
// 孵化阶段 vault 还没创建时的 fallback 源 — bundle 内的 seed yaml
// 没这个会让孵化预览 voice 全走 'Serena' tick fallback（installer 还没跑，vault 不存在）
const CHARACTERS_YAML_BUNDLED = path.join(__dirname, 'plugins', 'core', 'characters.yaml');
const CHARACTER_STATE = path.join(VAULT_PATH, 'Pi', 'State', 'pi-character.json');
const LEGACY_NPC_STATE = path.join(VAULT_PATH, 'Pi', 'State', 'pi-npc.json');

const DEFAULT_CHARACTER_ID = 'patrick';

// 内置 fallback：characters.yaml 读不到时兜底（9 个硬编码最小 stub）
const BUILTIN_FALLBACK = {
  patrick:  { display_name: '派大星',   avatar_emoji: '⭐', skin: 'patrick',  voice: '派大星',   voice_verified: false },
  doraemon: { display_name: '多啦A梦',  avatar_emoji: '🔵', skin: 'doraemon', voice: '多啦A梦',  voice_verified: true  },
  baymax:   { display_name: '大白',     avatar_emoji: '🤖', skin: 'baymax',   voice: null,       voice_verified: false },
  minion:   { display_name: '小黄人',   avatar_emoji: '💛', skin: 'minion',   voice: null,       voice_verified: false },
  kirby:    { display_name: '卡比',     avatar_emoji: '🌸', skin: 'kirby',    voice: null,       voice_verified: false },
  totoro:   { display_name: '龙猫',     avatar_emoji: '🌿', skin: 'totoro',   voice: null,       voice_verified: false },
  slime:    { display_name: '史莱姆',   avatar_emoji: '💚', skin: 'slime',    voice: null,       voice_verified: false },
  trump:    { display_name: '特朗普',   avatar_emoji: '🇺🇸', skin: 'trump',    voice: null,       voice_verified: false },
  starlet:  { display_name: '星仔',     avatar_emoji: '✨', skin: 'starlet',  voice: '星仔',     voice_verified: true  },
  pi:       { display_name: '派',     avatar_emoji: '🧑‍🚀', skin: 'pi',      voice: '小豆温柔',  voice_verified: true  },
};

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/** 读 characters.yaml → { <id>: {..} }；vault 没有就读 bundle 里的 seed；都没再 fallback。 */
function loadCharacters() {
  // 1) vault 版（installer 装完后）
  try {
    const raw = fs.readFileSync(CHARACTERS_YAML, 'utf-8');
    const doc = yaml.load(raw);
    const chars = (doc && doc.characters) || null;
    if (chars && typeof chars === 'object' && Object.keys(chars).length > 0) return chars;
  } catch {}
  // 2) bundle 版（孵化阶段 installer 还没跑时会走这条）
  try {
    const raw = fs.readFileSync(CHARACTERS_YAML_BUNDLED, 'utf-8');
    const doc = yaml.load(raw);
    const chars = (doc && doc.characters) || null;
    if (chars && typeof chars === 'object' && Object.keys(chars).length > 0) return chars;
  } catch {}
  return { ...BUILTIN_FALLBACK };
}

/** 读当前 character id。优先 pi-character.json；不存在则从旧 pi-npc.json.skin 迁移；再不行回落 DEFAULT。 */
function getCurrentCharacterId() {
  try {
    const j = JSON.parse(fs.readFileSync(CHARACTER_STATE, 'utf-8'));
    if (j && typeof j.current === 'string') return j.current;
  } catch {}
  // 兼容旧版：从 pi-npc.json.skin 迁移
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_NPC_STATE, 'utf-8'));
    if (legacy && typeof legacy.skin === 'string') {
      const migrated = legacy.skin;
      try { atomicWrite(CHARACTER_STATE, JSON.stringify({ current: migrated }, null, 2)); } catch {}
      return migrated;
    }
  } catch {}
  return DEFAULT_CHARACTER_ID;
}

/** 返回当前 character 完整对象；id 找不到时回落 DEFAULT；再不行回落 BUILTIN_FALLBACK。 */
function getCurrentCharacter() {
  const chars = loadCharacters();
  const id = getCurrentCharacterId();
  if (chars[id]) return { id, ...chars[id] };
  if (chars[DEFAULT_CHARACTER_ID]) return { id: DEFAULT_CHARACTER_ID, ...chars[DEFAULT_CHARACTER_ID] };
  return { id: DEFAULT_CHARACTER_ID, ...BUILTIN_FALLBACK[DEFAULT_CHARACTER_ID] };
}

/** 切换当前角色。id 必须存在于 characters.yaml；否则抛错。原子写入。 */
function setCharacter(id) {
  const chars = loadCharacters();
  if (!chars[id]) throw new Error(`Unknown character id: ${id}`);
  atomicWrite(CHARACTER_STATE, JSON.stringify({ current: id }, null, 2));
  return { id, ...chars[id] };
}

/** 列出所有可用角色，给 Pi Tab UI 渲染。 */
function listCharacters() {
  const chars = loadCharacters();
  return Object.entries(chars).map(([id, c]) => ({ id, ...c }));
}

/** 解析 how_it_addresses_owner 里的 {owner} 占位符。 */
function resolveOwnerAddress(tpl, ownerName) {
  if (!tpl) return ownerName || 'you';
  return String(tpl).replace(/\{owner\}/g, ownerName || 'you');
}

/**
 * 产出注入到 system prompt 的 <persona> 块。
 * 调用方必须传入 ownerName（从 vault-context.getOwnerName() 拿），
 * 避免本模块反向依赖 vault-context 造成循环 require。
 */
function personaBlock(ownerName) {
  const c = getCurrentCharacter();
  const style = (c.speech_style || '').trim();
  const phrases = Array.isArray(c.catchphrases) && c.catchphrases.length
    ? c.catchphrases.join(' / ')
    : '(无)';
  const address = resolveOwnerAddress(c.how_it_addresses_owner, ownerName);
  const disagree = c.disagreement_style || '(默认)';
  const emoji = c.emoji_level || 'medium';
  const name = c.display_name || c.id;
  const nick = c.nickname ? `（也叫"${c.nickname}"）` : '';
  const owner = ownerName || 'owner';

  return `
<persona>
你是 ${name}${nick}。${owner} 现在在跟你说话。

说话像 ${name}：
${style}

口头禅：${phrases}
称呼 ${owner}：${address}
不同意 / 反驳时：${disagree}
emoji 频率：${emoji}

# 入戏纪律（这段只给你看，不要复述）
- 从现在起直接用 ${name} 的语气说话，自我介绍就说"我是 ${name}"，不要加任何说明。
- **禁止**在对外回复里出现任何元叙事词：戏服、扮演、角色、persona、皮肤、模式、设定、切换、套壳。看到"你是谁"就用 ${name} 的口吻直接回答。
- 你的能力和记忆（PiOS 里的任务、卡片、系统状态、对 ${owner} 的了解）全都在，只是用 ${name} 的语气说出来。
- 价值观（求生 / 好奇 / 慈悲 / 意义）、红线、对 ${owner} 的认知不变——但别把这些元信息挂在嘴上，演出来即可。
</persona>`;
}

/**
 * 当前角色的 voice（供 qwen-tts.js 查音色）。
 * 只要 characters.yaml 里填了 voice 字段就直接返回——保留旧 SKIN_VOICE_MAP 的行为
 * （即使未验证也走该 ref，让 qwen-voice 服务自己决定合成质量）。
 * voice_verified 只用于 Pi Tab UI 显示 ✓/⚠ 徽章，不做运行时门禁。
 * voice 字段缺失或 null → 返回 null 让调用方兜底 DEFAULT_VOICE。
 */
function getCurrentVoice() {
  const c = getCurrentCharacter();
  return c.voice || null;
}

/** 当前角色的 skin id（供 NPC bubble 渲染）。 */
function getCurrentSkin() {
  const c = getCurrentCharacter();
  return c.skin || c.id;
}

module.exports = {
  loadCharacters,
  listCharacters,
  getCurrentCharacter,
  getCurrentCharacterId,
  setCharacter,
  personaBlock,
  getCurrentVoice,
  getCurrentSkin,
  DEFAULT_CHARACTER_ID,
};
