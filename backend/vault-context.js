/**
 * Vault Context — 按需读取 Vault 文件注入 AI 上下文
 * 全部从 vault-root 读，不硬编码任何用户名或路径
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const VAULT_PATH = require('./vault-root');

function readFile(relPath) {
  const full = path.join(VAULT_PATH, relPath);
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

/** 读取 manifest 获取 owner name */
function getOwnerName() {
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    return manifest.owner || 'User';
  } catch {
    return 'User';
  }
}

/** 读取 BOOT.md — frontend（PiBrowser/WeChat）版：裁掉 worker 专用段 */
function getBootContext() {
  const raw = readFile('Pi/BOOT.md');
  if (!raw) return raw;
  // 2026-04-23 E2 修：裁掉 frontend:skip-start → frontend:skip-end 之间的 worker 专用内容
  // （启动协议、巡检清单 —— 前端 Pi 没文件工具执行不了，读到只会把对话变成清单式）
  return raw.replace(/<!--\s*frontend:skip-start\s*-->[\s\S]*?<!--\s*frontend:skip-end\s*-->\s*/g, '');
}

/** 读取 Alignment */
function getAlignmentContext() {
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    const alignPath = manifest.direction?.alignment || 'alignment.md';
    return readFile(path.join('Pi', 'Config', alignPath));
  } catch {
    return null;
  }
}

/** 读取活跃卡片 — 分级摘要，控制总量 */
function getActiveCards() {
  const dir = path.join(VAULT_PATH, 'Cards', 'active');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const cards = files.map(f => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      const fm = {};
      if (fmMatch) {
        for (const line of fmMatch[1].split('\n')) {
          const m = line.match(/^(\w+):\s*(.+)/);
          if (m) fm[m[1]] = m[2].trim();
        }
      }
      const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();
      const title = body.split('\n').find(l => l.startsWith('# ')) || f;
      return { f, fm, title, body };
    });

    const lines = [];
    let totalLen = 0;
    const MAX = 6000;

    // 1) Decision 卡片
    for (const c of cards) {
      if (c.fm.needs_decision === 'true' || c.fm.type === 'decision') {
        const snippet = c.title + '\n' + c.body.substring(0, 300);
        lines.push(`[DECISION] ${snippet}`);
        totalLen += snippet.length;
      }
    }

    // 2) 高优先级（priority 1-2）
    for (const c of cards) {
      if (totalLen > MAX) break;
      const p = parseInt(c.fm.priority);
      if (p <= 2 && c.fm.needs_decision !== 'true' && c.fm.type !== 'decision') {
        const snippet = c.title + '\n' + c.body.substring(0, 150);
        lines.push(snippet);
        totalLen += snippet.length;
      }
    }

    // 3) 其余：只给标题
    for (const c of cards) {
      if (totalLen > MAX) break;
      const p = parseInt(c.fm.priority);
      if (!(p <= 2) && c.fm.needs_decision !== 'true' && c.fm.type !== 'decision') {
        lines.push(`- ${c.title.replace(/^# /, '')}`);
        totalLen += 60;
      }
    }

    return lines.join('\n\n');
  } catch {
    return '';
  }
}

/** 读取 manifest 中的 agents + tasks + goals 摘要 */
function getManifestSummary() {
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    const parts = [];

    // Goals
    const goals = manifest.direction?.goals || {};
    if (Object.keys(goals).length > 0) {
      parts.push('当前目标：');
      for (const [id, g] of Object.entries(goals)) {
        parts.push(`- ${g.description}${g.timeframe ? ' (' + g.timeframe + ')' : ''}`);
      }
    }

    // Agents + Tasks
    const agents = manifest.agents || {};
    const agentLines = [];
    const taskLines = [];
    for (const [aid, agent] of Object.entries(agents)) {
      agentLines.push(`- ${agent.name || aid}（${aid}）: ${agent.status || 'active'}`);
      for (const [tid, task] of Object.entries(agent.tasks || {})) {
        const enabled = task.enabled !== false ? '✓' : '✗';
        const cron = task.trigger?.cron || '';
        taskLines.push(`- [${enabled}] ${tid}（agent: ${aid}）${cron}`);
      }
    }
    if (agentLines.length > 0) parts.push('Agent 团队：\n' + agentLines.join('\n'));
    if (taskLines.length > 0) parts.push('定时任务：\n' + taskLines.join('\n'));

    return parts.join('\n\n');
  } catch {
    return '';
  }
}

/** 读取系统手册（~/.pios/SYSTEM.md，不可修改） */
function getSystemManual() {
  try {
    return fs.readFileSync(path.join(process.env.HOME, '.pios', 'SYSTEM.md'), 'utf-8');
  } catch { return null; }
}

/**
 * 读取 Pi 当下心跳（mood / social / owner-context / episode / diary 节选）
 * 让 Pi 每次 LLM 调用前知道自己"现在"的状态——内源式存在，不再每轮从零角色扮演
 */
function getHeartbeatContext() {
  try {
    const script = path.join(VAULT_PATH, 'Pi', 'Tools', 'pi-heartbeat-context.sh');
    if (!fs.existsSync(script)) return null;
    const out = execFileSync('bash', [script], {
      encoding: 'utf-8',
      timeout: 3000,
      env: { ...process.env, PIOS_VAULT: VAULT_PATH },
    });
    return out && out.trim() ? out : null;
  } catch (e) {
    return null;
  }
}

/** 组装系统上下文 */
function buildSystemContext({ includeProfile = true, includeDiary = false, includeCards = false } = {}) {
  const owner = getOwnerName();
  const parts = [`你是 Pi，${owner} 的 AI 助手，运行在 PiOS 中。

规则：
- 关于 PiOS 的问题（任务、项目、agent、系统状态），从下面的上下文回答
- 如果你需要搜索网络才能回答，告诉 ${owner}，让他说"搜一下 XXX"
- 不要自己搜索网络，除非 ${owner} 明确要求`];

  // 系统手册（不可修改，所有 Pi 实例共享）
  const systemManual = getSystemManual();
  if (systemManual) parts.push(systemManual.substring(0, 3000));

  // BOOT.md
  if (includeProfile) {
    const boot = getBootContext();
    if (boot) parts.push(boot.substring(0, 2000));
  }

  // 2026-04-28：Phase 6 Her — 关系姿态（PiBrowser 没文件工具，必须预拼进 system prompt）
  // BOOT.md 已经只保留指针，全部内容在 relationship-stance.md
  const stance = readFile('Pi/Config/relationship-stance.md');
  if (stance) parts.push(`## 关系姿态\n${stance.substring(0, 3000)}`);

  // Alignment
  const alignment = getAlignmentContext();
  if (alignment) parts.push(`## Alignment\n${alignment.substring(0, 1500)}`);

  // Manifest summary (agents + tasks + goals)
  const manifestSummary = getManifestSummary();
  if (manifestSummary) parts.push(`## PiOS 系统状态\n${manifestSummary}`);

  if (includeCards) {
    const cards = getActiveCards();
    if (cards) parts.push(`## 活跃事项\n${cards}`);
  }

  // 当下心跳：Pi 知道自己现在的状态（mood / social / owner-context / 最近 episode / 昨日 diary 节选）
  // 必装——这是"内源式存在"的关键，让 Pi 每轮 turn 不再从零角色扮演
  const heartbeat = getHeartbeatContext();
  if (heartbeat) parts.push(heartbeat);

  return parts.join('\n\n');
}

module.exports = { VAULT_PATH, readFile, buildSystemContext, getOwnerName, getBootContext, getActiveCards, getHeartbeatContext };
