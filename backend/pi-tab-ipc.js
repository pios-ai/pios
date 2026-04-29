/**
 * pi-tab-ipc.js — Pi Tab 数据读取模块
 *
 * HTTP endpoints (/pi, /pi/data, /pi/skin) 注册在 main.js httpServer 里，
 * 本模块只提供数据读取辅助函数，由 main.js require 并调用。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * 读取 Pi Tab 所需的全部数据，返回可序列化对象。
 *
 * @param {string} vaultRoot  - VAULT_ROOT
 * @param {Function} loadSessions - main.js 的 loadSessions()
 * @param {Function} getNpcInfo   - () => { skins, current }，由 main.js 在 NPC 初始化后注入
 */
function getPiTabData(vaultRoot, loadSessions, getNpcInfo) {
  const readVault = (p) => {
    try { return fs.readFileSync(path.join(vaultRoot, p), 'utf-8'); } catch { return null; }
  };

  // owner name from pios.yaml
  let owner = 'User';
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(vaultRoot, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    owner = manifest.owner || 'User';
  } catch {}

  // A+B: identity files
  const soul = readVault('Pi/SOUL.md');
  const boot = readVault('Pi/BOOT.md');
  const heartbeat = readVault('Pi/HEARTBEAT.md');

  // A 区底盘（价值观，owner 可编辑）
  // 读 alignment 文件路径：manifest.direction.alignment，兜底 Pi/Config/alignment.md
  let alignment = null;
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(vaultRoot, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    const alignRel = (manifest && manifest.direction && manifest.direction.alignment) || 'alignment.md';
    // direction.alignment 可以是相对 Pi/Config/ 的文件名（如 "alignment.md"），也可以是绝对相对 vault 的路径
    const candidates = [
      path.join(vaultRoot, 'Pi', 'Config', alignRel),
      path.join(vaultRoot, alignRel),
    ];
    for (const p of candidates) {
      try { alignment = fs.readFileSync(p, 'utf-8'); break; } catch {}
    }
  } catch {}
  if (alignment === null) alignment = readVault('Pi/Config/alignment.md');

  // E: NPC info（保留向后兼容：skins + current skin id）
  const npcInfo = (typeof getNpcInfo === 'function') ? getNpcInfo() : { skins: [], current: 'patrick' };

  // E': 角色清单（characters.yaml 单一权威）+ 当前角色
  let characters = { list: [], current: 'patrick' };
  try {
    const piPersona = require('./pi-persona');
    characters = {
      list: piPersona.listCharacters(),
      current: piPersona.getCurrentCharacterId(),
    };
  } catch {}

  // C: schedule — pios.yaml agents + recent runs
  let schedule = { agents: [], latestRuns: [] };
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(vaultRoot, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    const agentsObj = manifest.agents || {};
    schedule.agents = Object.keys(agentsObj).map(id => ({ id, ...agentsObj[id] }));
  } catch {}

  // latest run per agent in last 24h
  const runsDir = path.join(vaultRoot, 'Pi', 'State', 'runs');
  const latestPerAgent = {};
  if (fs.existsSync(runsDir)) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    try {
      const files = fs.readdirSync(runsDir).filter(f =>
        f.endsWith('.json') && !f.endsWith('.stats') && !f.endsWith('.jsonl')
      );
      for (const f of files) {
        try {
          const full = path.join(runsDir, f);
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) continue;
          const r = JSON.parse(fs.readFileSync(full, 'utf-8'));
          if (!r.agent) continue;
          if (!latestPerAgent[r.agent] || stat.mtimeMs > latestPerAgent[r.agent].mtime) {
            latestPerAgent[r.agent] = { run: r, mtime: stat.mtimeMs };
          }
        } catch {}
      }
    } catch {}
  }
  schedule.latestRuns = Object.values(latestPerAgent).map(e => e.run);

  // D: owner profile files
  const profileDir = path.join(vaultRoot, owner, 'Profile');
  const profiles = {};
  if (fs.existsSync(profileDir)) {
    try {
      for (const f of fs.readdirSync(profileDir)) {
        if (!f.endsWith('.md')) continue;
        try { profiles[f] = fs.readFileSync(path.join(profileDir, f), 'utf-8'); }
        catch { profiles[f] = null; }
      }
    } catch {}
  }

  // F: pi-main session messages
  let piMainMessages = null;
  try {
    const sessions = loadSessions();
    const piMain = (sessions.sessions || []).find(s => s.id === 'pi-main');
    piMainMessages = piMain ? (piMain.messages || []).slice(-20) : null;
  } catch {}

  // G: presence
  let presence = { idle_s: null, status: 'unknown', label: '未知' };
  try {
    const presenceMod = require('./presence');
    presence = presenceMod.getPresence();
  } catch {}

  return { soul, boot, heartbeat, alignment, npcInfo, characters, schedule, profiles, piMainMessages, owner, presence };
}

module.exports = { getPiTabData };
