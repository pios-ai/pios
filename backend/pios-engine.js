/**
 * PiOS Engine — Agent 注册表 + Card 引擎
 *
 * 读取 Agent yaml 定义和 Card markdown 文件，
 * 为 PiBrowser 提供 PiOS 数据访问层。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const matter = require('gray-matter');

const VAULT_PATH = require('./vault-root');
const AGENTS_DIR = path.join(VAULT_PATH, 'Pi', 'Agents');
const PLUGINS_DIR = path.join(VAULT_PATH, 'Pi', 'Config', 'plugins');
const CARDS_DIRS = {
  inbox: path.join(VAULT_PATH, 'Cards', 'inbox'),
  active: path.join(VAULT_PATH, 'Cards', 'active'),
  archive: path.join(VAULT_PATH, 'Cards', 'archive'),
};
const HOST_SHORT = require('./lib/host-resolve').resolveHost();
const DEV_ACTIONS_FILE = path.join(VAULT_PATH, 'Pi', 'Log', `dev-actions-${HOST_SHORT}.jsonl`);

// 内置 agent 的 avatar fallback（pios.yaml 里 avatar_emoji 缺失时兜底）
// owner 创建的自定义 agent 默认用 💼
const DEFAULT_AVATAR_EMOJI_MAP = {
  pi: '✦',
  radar: '🔍',
  hawkeye: '🦅',
  creator: '🎬',
  life: '☁️',
  maintenance: '🧹',
  scout: '📡',
  pipeline: '🚰',
};

// ── 工具函数 ────────────────────────────────────────

function readFileIfExists(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

// 原子写迁到 lib/atomic-write helper（2026-04-28 集中化）
const { writeAtomic: atomicWriteFile } = require('./lib/atomic-write');

function formatLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + 'T' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(':');
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).trim().toLowerCase();
  return s !== '' && s !== 'null' && s !== 'none' && s !== 'undefined';
}

function validateOwnerResponse(response, opts = {}, fm = {}) {
  const responseType = String(opts.response_type || '').trim().toLowerCase();
  const ownerComment = String(opts.comment || '').trim();
  const needsOwner = String(fm.needs_owner || '').trim().toLowerCase();

  // check 卡：只接受 accept / fix:* / reject，禁止 completed
  if (needsOwner === 'check') {
    const r = String(response || '').trim();
    if (r !== 'accept' && r !== 'reject' && !r.startsWith('fix:')) {
      return `response_type mismatch: check 卡只接受 accept / fix:xxx / reject，收到 "${r}"`;
    }
    return null;
  }

  // act 卡或 act-complete：只接受 completed + 完成说明
  if (needsOwner === 'act' || responseType === 'act-complete') {
    if (ownerComment.length < 4) {
      return '完成说明至少写 4 个字，说明你做了什么和结果';
    }
    return null;
  }

  return null;
}

function priorityNumber(value) {
  const raw = String(value ?? '').trim();
  const digits = raw.match(/\d+/);
  return digits ? parseInt(digits[0], 10) : 9;
}

function hasCardSection(filename, pattern) {
  const found = findCardPath(filename);
  if (!found) return false;
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const parsed = matter(raw);
    return pattern.test(parsed.content || '');
  } catch {
    return false;
  }
}

function hasAcceptanceCriteria(filename) {
  return hasCardSection(filename, /^##\s*(验收标准|Acceptance Criteria)\b/m);
}

function hasWorkHistory(filename) {
  return hasCardSection(filename, /^##\s*(工作记录|Work History)\b/m);
}

function isFutureDeferred(card, todayStr) {
  return hasMeaningfulValue(card.deferred_until) && String(card.deferred_until) > todayStr;
}

function isWorkerClaim(card) {
  return /^work-/.test(String(card.claimed_by || '').trim());
}

function isStaleWorkerClaim(card, nowMs = Date.now(), ttlMinutes = 30) {
  if (!isWorkerClaim(card)) return false;
  const ageMs = Math.max(0, nowMs - ((card.mtime || 0) * 1000));
  return ageMs >= ttlMinutes * 60 * 1000;
}

function isDispatchCandidate(card, opts = {}) {
  const host = opts.host || HOST_SHORT;
  const todayStr = opts.todayStr || localDateStr();
  const type = String(card.type || '').trim();
  const status = String(card.status || '').trim();
  const runsOn = String(card.runs_on || '').trim();
  const energy = Number(card.energy);

  if (!['task', 'project'].includes(type)) return false;
  if (status && !['active', 'pending'].includes(status)) return false;
  if (hasMeaningfulValue(card.blocked_on)) return false;
  if (isFutureDeferred(card, todayStr)) return false;
  if (runsOn && runsOn !== host) return false;
  if (hasMeaningfulValue(card.claimed_by)) return false;
  if (String(card.ready_for_work || '').toLowerCase() === 'true') return false;
  if (hasMeaningfulValue(card.needs_owner)) return false;
  if (String(card.assignee || '').trim() === 'user') return false;
    if (Number.isFinite(energy) && energy < 0.3 && priorityNumber(card.priority) !== 1) return false;
  if (type === 'task' && !hasAcceptanceCriteria(card.filename)) return false;
  if (type === 'project' && !hasWorkHistory(card.filename)) return false;

  return true;
}

function buildPiExecutionQueue(limit = 5) {
  const todayStr = localDateStr();
  const active = loadCards({ status: 'active' });
  const annotate = (card, lane, laneLabel) => ({
    filename: card.filename,
    title: card.title,
    priority: card.priority,
    status: card.status,
    type: card.type,
    lane,
    laneLabel,
    mtime: card.mtime || 0,
  });
  const sortByPriorityAge = (a, b) => {
    const pa = priorityNumber(a.priority);
    const pb = priorityNumber(b.priority);
    if (pa !== pb) return pa - pb;
    return (a.mtime || 0) - (b.mtime || 0);
  };

  const running = active
    .filter(c => hasMeaningfulValue(c.claimed_by))
    .sort(sortByPriorityAge)
    .map(c => annotate(c, 'running', '在跑'));

  const ready = active
    .filter(c => !hasMeaningfulValue(c.claimed_by) && String(c.ready_for_work || '').toLowerCase() === 'true')
    .sort(sortByPriorityAge)
    .map(c => annotate(c, 'ready', '已派发'));

  const next = active
    .filter(c => isDispatchCandidate(c, { host: HOST_SHORT, todayStr }))
    .sort(sortByPriorityAge)
    .map(c => annotate(c, 'next', '接下来'));

  return [...running, ...ready, ...next].slice(0, limit);
}

// ── Agent 操作（pios.yaml manifest 优先，agent.yaml 补充）─────

function _readManifestAgents() {
  try {
    const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    return manifest && manifest.agents ? manifest.agents : null;
  } catch { return null; }
}

function loadAgents() {
  // pios.yaml 是唯一来源，不读 agent.yaml
  try {
    const manifestAgents = _readManifestAgents();
    if (!manifestAgents) return [];

    return Object.entries(manifestAgents).map(([id, agent]) => {
      try {
        const agentDir = path.join(AGENTS_DIR, id);
        const soul = readFileIfExists(path.join(agentDir, 'SOUL.md'));
        const heartbeat = readFileIfExists(path.join(agentDir, 'HEARTBEAT.md'));

        const firstTask = agent.tasks ? Object.values(agent.tasks)[0] : null;
        return {
          id,
          _dir: id,
          name: id,
          display_name: agent.name || id,
          avatar_emoji: agent.avatar_emoji || DEFAULT_AVATAR_EMOJI_MAP[id] || '💼',
          status: agent.status || 'active',
          host: agent.host,
          runtime: agent.runtime || 'claude-cli',
          plugins: agent.plugins || [],
          schedule: firstTask?.trigger?.cron,
          prompt_file: firstTask?.prompt,
          tasks: agent.tasks || {},
          soul: soul ? soul.substring(0, 500) : null,
          heartbeat: heartbeat ? heartbeat.substring(0, 500) : null,
        };
      } catch (e) {
        console.warn(`[pios] Failed to load agent ${id}:`, e.message);
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.warn('[pios] loadAgents failed:', e.message);
    return [];
  }
}

function getAgent(agentId) {
  const agents = loadAgents();
  return agents.find(a => a.id === agentId) || null;
}

function getAgentWorkspace(agentId) {
  const manifestAgents = _readManifestAgents();
  const config = manifestAgents?.[agentId];
  if (!config) return null;

  const agentDir = path.join(AGENTS_DIR, agentId);
  const soul = readFileIfExists(path.join(agentDir, 'SOUL.md'));
  const heartbeat = readFileIfExists(path.join(agentDir, 'HEARTBEAT.md'));
  const piSoul = readFileIfExists(path.join(VAULT_PATH, 'Pi', 'SOUL.md'));

  return { id: agentId, display_name: config.name, ...config, soul, heartbeat, piSoul };
}

function updateAgentStatus(agentId, newStatus) {
  // Write to pios.yaml manifest
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.agents?.[agentId]) return { ok: false, error: 'Agent not found in manifest' };
    manifest.agents[agentId].status = newStatus;
    atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
    return { ok: true, agentId, status: newStatus };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function createAgent(agentId, opts = {}) {
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    if (manifest.agents?.[agentId]) return { ok: false, error: 'Agent already exists' };
    if (!manifest.agents) manifest.agents = {};
    const host = opts.host || 'any';
    const runtime = opts.runtime || 'claude-cli';
    manifest.agents[agentId] = {
      avatar_emoji: opts.avatar_emoji || '💼',
      name: opts.name || agentId,
      description: opts.description || '',
      soul: `../Agents/${agentId}/SOUL.md`,
      plugins: opts.plugins || ['vault'],
      runtime,
      host,
      status: 'active',
      tasks: {},
    };
    atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
    // Create agent directory + SOUL.md + tasks/
    const agentDir = path.join(AGENTS_DIR, agentId);
    const tasksDir = path.join(agentDir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const soulPath = path.join(agentDir, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, `# ${opts.name || agentId}\n\n${opts.description || '新 Agent，请编辑此文件定义角色和职责。'}\n`);
    }
    // 注册到 OpenClaw（本机 + 远程）
    _registerOpenclawAgent(agentId, host, manifest);
    return { ok: true, agentId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _registerOpenclawAgent(agentId, host, manifest) {
  // 本机 openclaw.json
  const localOcPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
  _registerOpenclawAgentAt(agentId, localOcPath, VAULT_PATH);
  // 远程机器：写临时脚本 → scp → ssh 执行
  const instances = manifest?.infra?.instances || {};
  const inst = instances[host];
  if (inst && inst.ssh && inst.vault) {
    try {
      const { execSync } = require('child_process');
      const os = require('os');
      const tmpScript = path.join(os.tmpdir(), `oc-register-${agentId}.py`);
      fs.writeFileSync(tmpScript, `import json, os
oc_path = os.path.expanduser("~/.openclaw/openclaw.json")
if not os.path.exists(oc_path): exit(0)
d = json.load(open(oc_path))
agents = d.get("agents",{}).get("list",[])
if any(a.get("id")==${JSON.stringify(agentId)} for a in agents): exit(0)
agents.append({"id":${JSON.stringify(agentId)},"name":${JSON.stringify(agentId)},"workspace":"${inst.vault}/Pi/Agents/${agentId}","agentDir":os.path.expanduser("~/.openclaw/agents/${agentId}/agent")})
os.makedirs(os.path.expanduser("~/.openclaw/agents/${agentId}/agent"), exist_ok=True)
with open(oc_path,"w") as f: json.dump(d,f,indent=2,ensure_ascii=False)
print("registered")
`);
      execSync(`scp ${tmpScript} ${inst.ssh}:/tmp/oc-register.py && ssh ${inst.ssh} python3 /tmp/oc-register.py`, { timeout: 10000 });
      fs.unlinkSync(tmpScript);
    } catch (e) {
      console.warn('[pios] remote openclaw register failed:', e.message);
    }
  }
}

function _registerOpenclawAgentAt(agentId, ocPath, vaultPath) {
  try {
    if (!fs.existsSync(ocPath)) return;
    const raw = fs.readFileSync(ocPath, 'utf-8');
    const d = JSON.parse(raw);
    const agents = d.agents?.list || [];
    if (agents.some(a => a.id === agentId)) return;
    agents.push({
      id: agentId,
      name: agentId,
      workspace: path.join(vaultPath, 'Pi', 'Agents', agentId),
      agentDir: path.join(process.env.HOME, '.openclaw', 'agents', agentId, 'agent'),
    });
    if (!d.agents) d.agents = {};
    d.agents.list = agents;
    // Create agentDir
    const agentDir = path.join(process.env.HOME, '.openclaw', 'agents', agentId, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(ocPath, JSON.stringify(d, null, 2));
  } catch (e) {
    console.warn('[pios] local openclaw register failed:', e.message);
  }
}

/**
 * retireAgent — 让 agent "退休"（柔性下线，不硬删）
 *
 * mode:
 *   'pause'   → 只改 status=paused，保留所有文件和产出
 *   'archive' → status=paused，且把 Pi/Agents/<id>/ 整个 move 到 Pi/Agents/_archived/<id>-{date}/
 *               （含 workspace — 新架构下产出跟 agent 走）
 */
function retireAgent(agentId, mode = 'pause') {
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.agents?.[agentId]) return { ok: false, error: 'Agent not found' };

    if (mode === 'archive' || mode === 'delete') {
      const src = path.join(AGENTS_DIR, agentId);
      const archiveRoot = path.join(AGENTS_DIR, '_archived');
      if (!fs.existsSync(archiveRoot)) fs.mkdirSync(archiveRoot, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10);
      const dst = path.join(archiveRoot, `${agentId}-${dateStr}`);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }

    if (mode === 'delete') {
      delete manifest.agents[agentId];
    } else {
      manifest.agents[agentId].status = 'paused';
    }
    atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
    return { ok: true, agentId, mode };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 给 retire 弹窗用：agent 的产出 + 正在跟进的卡片数。 */
function getAgentRetireStats(agentId) {
  let outputs = 0;
  function walk(dir) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else if (f.endsWith('.md') || f.endsWith('.json')) outputs += 1;
      }
    } catch {}
  }
  // 新架构：产出在 Pi/Agents/<id>/workspace/
  const workspaceDir = path.join(AGENTS_DIR, agentId, 'workspace');
  if (fs.existsSync(workspaceDir)) walk(workspaceDir);

  // 正在跟进的卡（active，assignee = agentId）
  let activeCards = 0;
  try {
    const activeDir = CARDS_DIRS.active;
    if (fs.existsSync(activeDir)) {
      for (const f of fs.readdirSync(activeDir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const raw = fs.readFileSync(path.join(activeDir, f), 'utf-8');
          const parsed = matter(raw);
          if (parsed.data.assignee === agentId) activeCards += 1;
        } catch {}
      }
    }
  } catch {}

  return { outputs, activeCards };
}

function deleteAgent(agentId) {
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.agents?.[agentId]) return { ok: false, error: 'Agent not found' };
    const host = manifest.agents[agentId].host || 'any';
    delete manifest.agents[agentId];
    atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
    // 从 openclaw 反注册
    _unregisterOpenclawAgent(agentId, host, manifest);
    return { ok: true, agentId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _unregisterOpenclawAgent(agentId, host, manifest) {
  // 本机
  const localOcPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
  try {
    if (fs.existsSync(localOcPath)) {
      const d = JSON.parse(fs.readFileSync(localOcPath, 'utf-8'));
      if (d.agents && d.agents.list) {
        d.agents.list = d.agents.list.filter(a => a.id !== agentId);
        fs.writeFileSync(localOcPath, JSON.stringify(d, null, 2));
      }
    }
  } catch {}
  // 远程
  const instances = (manifest && manifest.infra && manifest.infra.instances) || {};
  const inst = instances[host];
  if (inst && inst.ssh) {
    try {
      const { execSync } = require('child_process');
      const tmpScript = path.join(require('os').tmpdir(), 'oc-unregister.py');
      fs.writeFileSync(tmpScript, `import json, os
oc = os.path.expanduser("~/.openclaw/openclaw.json")
if not os.path.exists(oc): exit(0)
d = json.load(open(oc))
agents = d.get("agents",{}).get("list",[])
d["agents"]["list"] = [a for a in agents if a.get("id") != "${agentId}"]
with open(oc,"w") as f: json.dump(d,f,indent=2,ensure_ascii=False)
`);
      execSync(`scp ${tmpScript} ${inst.ssh}:/tmp/oc-unregister.py && ssh ${inst.ssh} python3 /tmp/oc-unregister.py`, { timeout: 10000 });
      fs.unlinkSync(tmpScript);
    } catch {}
  }
}

// ── Agent Spawn（手动触发）───────────────────────────

function spawnAgent(agentId) {
  // 找到 agent 对应的第一个 task，走 spawnTask() 统一路径（经过 pios-adapter.sh）
  const manifestAgents = _readManifestAgents();
  const config = manifestAgents?.[agentId];
  if (!config) return { ok: false, error: 'Agent not found in manifest' };

  const firstTask = config.tasks ? Object.values(config.tasks)[0] : null;
  const promptFile = firstTask ? firstTask.prompt : config.prompt_file;
  if (!promptFile) return { ok: false, error: 'No prompt_file configured' };

  const taskId = path.basename(promptFile, '.md');
  const result = spawnTask(taskId);
  return { ...result, agentId, method: 'spawnTask' };
}

// ── Crontab 同步 ────────────────────────────────────

function generateCrontab(host) {
  const agents = loadAgents();
  const hostname = host || require('os').hostname();

  const lines = [
    '# PiOS Agent crontab — auto-generated from pios.yaml',
    `# Host: ${hostname}`,
    `# Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const agent of agents) {
    if (agent.status !== 'active') continue;
    if (!agent.schedule) continue;

    // 检查 host 匹配
    const agentHosts = Array.isArray(agent.host) ? agent.host : [agent.host];
    if (!agentHosts.some(h => hostname.includes(h))) continue;

    const taskId = agent.prompt_file
      ? path.basename(agent.prompt_file, '.md')
      : agent.name;

    lines.push(`# ${agent.display_name} (${agent.name})`);
    lines.push(`${agent.schedule} PIOS_VAULT=${VAULT_PATH} bash ${VAULT_PATH}/Pi/Tools/cron-runner.sh ${taskId}`);
    lines.push('');
  }

  return lines.join('\n');
}

function syncCrontab() {
  const hostname = require('os').hostname();
  const expected = generateCrontab(hostname);

  // 写到文件供参考
  const outPath = path.join(VAULT_PATH, 'Pi', 'Config', `generated-crontab-${hostname}.txt`);
  fs.writeFileSync(outPath, expected);

  return { ok: true, hostname, path: outPath, content: expected };
}

// ── Plugin 操作 ─────────────────────────────────────

function loadPlugins() {
  try {
    const files = fs.readdirSync(PLUGINS_DIR)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    return files.map(file => {
      try {
        const content = fs.readFileSync(path.join(PLUGINS_DIR, file), 'utf-8');
        const config = yaml.load(content);
        return {
          id: config.name || path.basename(file, path.extname(file)),
          file,
          ...config,
        };
      } catch (e) {
        console.warn(`[pios] Failed to parse plugin ${file}:`, e.message);
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    // Pi/Config/plugins/ 不存在是正常情况（新架构 plugin 注册在 pios.yaml 里）
    if (e.code !== 'ENOENT') console.warn('[pios] loadPlugins failed:', e.message);
    return [];
  }
}

// ── Card 操作 ────────────────────────────────────────

function parseCard(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);

    // 提取第一个 # 标题
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md');

    return {
      filename: path.basename(filePath, '.md'),
      title,
      ...frontmatter,
      _content: content.substring(0, 500), // 摘要
    };
  } catch (e) {
    return null;
  }
}

function loadCards(filter = {}) {
  const statuses = filter.status
    ? [filter.status]
    : ['inbox', 'active'];

  const cards = [];

  for (const status of statuses) {
    const dir = CARDS_DIRS[status];
    if (!dir || !fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f =>
      f.endsWith('.md')
      // Syncthing 机器间冲突会产生 foo.sync-conflict-YYYYMMDD-HHMMSS-XXXX.md 副本，
      // 内容和原卡一样。当成独立卡会在 UI 出现"两张一模一样"的现象。
      // 这里直接过滤——原文件保留在磁盘不动（遵循"不删用户数据"纪律），只是不入索引。
      && !f.includes('.sync-conflict-')
    );

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const card = parseCard(fullPath);
      if (!card) continue;

      // 附加 folder / mtime（Fast/Kanban/Stale 视图需要）
      card.folder = status;
      try { card.mtime = Math.floor(fs.statSync(fullPath).mtimeMs / 1000); } catch { card.mtime = 0; }

      // 应用过滤条件
      if (filter.type && card.type !== filter.type) continue;
      if (filter.assignee && card.assignee !== filter.assignee) continue;
      if (filter.parent && card.parent !== filter.parent) continue;

      cards.push(card);
    }
  }

  return cards;
}

function getAgentCards(agentId) {
  return loadCards({ assignee: agentId });
}

// ── Project 聚合 ─────────────────────────────────────

function getProjects() {
  const allCards = loadCards({ status: 'active' });

  const projects = allCards.filter(c => c.type === 'project');
  const tasks = allCards.filter(c => c.type === 'task');

  return projects.map(project => {
    const children = tasks.filter(t => t.parent === project.filename);
    const done = children.filter(t => t.status === 'done').length;

    return {
      ...project,
      children,
      progress: {
        total: children.length,
        done,
        active: children.filter(t => t.status === 'active').length,
        blocked: children.filter(t => t.blocked_on).length,
      },
    };
  });
}

// ── 决策队列 ─────────────────────────────────────────

function getDecisionQueue() {
  const allCards = loadCards({ status: 'active' });
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

  return allCards.filter(card => {
    if (!card.blocked_on) return false;
    // Filter out deferred cards whose date hasn't arrived yet
    if (card.deferred_until && card.deferred_until > today) return false;
    const b = String(card.blocked_on).toLowerCase();
    return b.includes('user-decision') ||
           b.includes('owner-decision') ||
           b.startsWith('owner');
  }).map(card => {
    // 从 blocked_on 提取决策问题
    const match = String(card.blocked_on).match(/\(([^)]+)\)/);
    // 分类 reason
    const b = String(card.blocked_on);
    const reason = b.startsWith('owner-decision') ? '需要决策'
      : b.startsWith('owner-action') ? '需要操作'
      : b.startsWith('owner-clarify') ? '需要澄清'
      : '等 Owner';
    return {
      ...card,
      decision_question: match ? match[1] : card.blocked_on,
      reason,
    };
  });
}

// ── Owner Queue（统一人机协作收件箱） ───────────────────

function buildBrief(card, type) {
  // 1. decision_brief frontmatter（Worker 填的，最权威）
  if (card.decision_brief) return card.decision_brief;

  // 2. blocked_on 括号内容（中英文括号）
  const match = String(card.blocked_on || '').match(/[（(]([^)）]+)[)）]/);
  if (match) return match[1];

  // 3. in_review → 取最后一个 ## section heading
  if (type === 'review') {
    const sections = (card._content || '').match(/^## .+$/gm);
    if (sections && sections.length > 0) {
      const last = sections[sections.length - 1].replace(/^## /, '');
      return last + ' — 待验收';
    }
    return card.title + ' 已完成，待验收';
  }

  // 4. followup
  if (type === 'followup') return card.title + ' — 需跟进';

  // 5. fallback
  return card.title;
}

// Owner queue — SINGLE SOURCE OF TRUTH for "things needing owner's attention".
// Only explicit owner-facing requests belong here. Triage is responsible for
// cleaning up legacy in_review / followup / waiting states instead of leaking
// them into the owner's queue.
//
// Options:
//   includeOutputs — when true, append unread outputs as { kind: 'output', ... }
//                    queue entries so the Review pane can show reports alongside
//                    cards. Overview keeps its card-only semantics by default.
//   includeInbox   — when true, also scan inbox cards (for completeness).
function getOwnerQueue(opts = {}) {
  const includeOutputs = !!opts.includeOutputs;
  const includeInbox = !!opts.includeInbox;
  const statuses = includeInbox ? ['inbox', 'active'] : ['active'];
  const allCards = [];
  for (const s of statuses) allCards.push(...loadCards({ status: s }));
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const todayMs = Date.now();
  const items = [];

  for (const card of allCards) {
    if (!isCardLive(card, today)) continue;  // 共享 live 过滤（status + deferred_until）

    const b = String(card.blocked_on || '').toLowerCase();
    const createdMs = card.created ? new Date(card.created).getTime() : todayMs;
    const staleDays = Math.max(0, Math.floor((todayMs - createdMs) / 86400000));

    // 防翻旧账：owner_response_at 已写入 → 卡已 ack，不占 TNY 槽位
    // （即使 agent 误写 needs_owner，UI 层兜底过滤）
    if (card.owner_response_at) continue;

    // NEW PROTOCOL: needs_owner field (alert/respond/act/check)
    if (card.needs_owner) {
      const reasonMap = { alert: '系统告警', respond: '需要回复', act: '需要操作', check: '需要验收' };
      const nextStepMap = { alert: 'owner_processes', respond: 'worker_will_process', act: 'owner_completes', check: 'owner_approves' };
      const queueType = ['alert', 'respond', 'act', 'check'].includes(card.needs_owner) ? card.needs_owner : 'respond';
      items.push({
        ...card,
        queueType,
        reason: reasonMap[queueType] || '需要关注',
        brief: card.needs_owner_brief || buildBrief(card, queueType),
        staleDays,
        response_type: card.response_type || 'text',
        response_options: card.response_options || [],
        interaction_round: card.interaction_round || 1,
        next_step: nextStepMap[queueType] || 'owner_handles',
      });
      continue;
    }

  }

  // Tag all card items with kind='card' so frontend can distinguish
  for (const it of items) it.kind = 'card';

  // Optionally include unread outputs as queue entries. Review pane uses this
  // so reports show up alongside decision/action/review cards. Overview
  // doesn't set includeOutputs so its "needs you" count stays card-only.
  if (includeOutputs) {
    try {
      const outs = loadOutputs();
      for (const o of outs) {
        if (o.read) continue;
        items.push({
          kind: 'output',
          id: o.id,
          filename: o.filename || o.id,
          title: o.title || o.id,
          parent: o.relatedCard || o.project || '(reports)',
          category: o.category,
          track: o.track,
          project: o.project,
          relatedCard: o.relatedCard,
          relatedCardType: o.relatedCardType,
          relatedCardTitle: o.relatedCardTitle,
          projectTitle: o.projectTitle,
          mtime: o.mtime,
          priority: 3,
          queueType: 'report',
          reason: '待阅读',
          brief: (o.category || 'report') + (o.track ? ' · ' + o.track : ''),
          staleDays: Math.max(0, Math.floor((todayMs - (o.mtime || todayMs)) / 86400000)),
        });
      }
    } catch (e) {
      console.warn('[getOwnerQueue] loadOutputs failed:', e.message);
    }
  }

  // 排序：priority ASC, staleDays DESC
  items.sort((a, b) => {
    const pa = priorityNumber(a.priority);
    const pb = priorityNumber(b.priority);
    if (pa !== pb) return pa - pb;
    return b.staleDays - a.staleDays;
  });

  return items;
}

// ── Card 过滤/分类（single source of truth）──────────
// 所有面板（Overview / pi-pulse 徽章 / owner queue 等）的"卡是不是今天要算进来"都走这里。
// 改规则改这里。
function _todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 是否"live"：没归档/没完成/没 dismiss，且 deferred_until 未到期
function isCardLive(card, today) {
  const t = today || _todayStr();
  const normalized = String(card && card.status || '').toLowerCase();
  if (['archive', 'done', 'dismissed'].includes(normalized)) return false;
  if (card && card.deferred_until && String(card.deferred_until) > t) return false;
  return true;
}
// 三分类（只对 status=active 的 live 卡计数）：
//   need:   needs_owner 非空（等用户回应）— 对应 Overview "things need you"
//   next:   ready_for_work: true（Pi 接下来能干）
//   stuck:  两者都没有（triage 没分好或系统卡住）
function classifyActiveCards() {
  const cards = loadCards({ status: 'active' });
  const today = _todayStr();
  let need = 0, next = 0, stuck = 0, live = 0;
  for (const c of cards) {
    if (!isCardLive(c, today)) continue;
    live++;
    const needVal = c.needs_owner;
    const isNeed = needVal && needVal !== 'false' && needVal !== 'null' && needVal !== false && needVal !== null;
    const isNext = c.ready_for_work === true;
    if (isNeed) need++;
    else if (isNext) next++;
    else stuck++;
  }
  return { need, next, stuck, live };
}

function approveReview(filename, comment) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    const timestamp = new Date().toISOString().split('T')[0];
    const nowIso = new Date().toISOString().slice(0, 16);
    const appendix = `\n\n## Owner 审批（${timestamp}）\n\n${comment || 'Approved'}\n`;

    // 写 owner_response_at 作为 ack 审计；对 project/never_archive 留 active 的路径是
    // getOwnerQueue 过滤出 TNY 的必要前置
    fm.owner_response = 'approved';
    fm.owner_response_at = nowIso;

    // 两类卡不 archive（项目/never_archive），但依然写 owner_response_at → TNY 不再显示
    const isProject = String(fm.type || '').trim().toLowerCase() === 'project';
    const neverArchive = fm.never_archive === true;
    if (isProject || neverArchive) {
      delete fm.needs_owner;
      delete fm.needs_owner_brief;
      delete fm.response_type;
      delete fm.response_options;
      delete fm.claimed_by;
      const updated = matter.stringify(content + appendix, fm);
      fs.writeFileSync(found.path, updated, 'utf-8');
      return {
        ok: true,
        filename,
        action: 'approved',
        next_step: 'kept_active',
        guard: neverArchive ? 'never_archive' : 'project',
      };
    }

    // task 类卡：status=done + 移 archive
    fm.status = 'done';
    delete fm.needs_owner;
    delete fm.needs_owner_brief;
    delete fm.response_type;
    delete fm.response_options;
    delete fm.blocked_on;
    delete fm.deferred_until;
    const updated = matter.stringify(content + appendix, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    const destPath = path.join(CARDS_DIRS.archive, filename + '.md');
    fs.renameSync(found.path, destPath);
    return { ok: true, filename, action: 'approved', next_step: 'archived' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// reworkReview: Owner 点 ↩要修 → 卡留 active，写 owner_response 让 worker 下轮按反馈重做
function reworkReview(filename, comment) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    const timestamp = new Date().toISOString().split('T')[0];
    const appendix = `\n\n## Owner 反馈（${timestamp}）\n\n${comment}\n`;
    fm.status = 'active';
    delete fm.needs_owner;
    delete fm.needs_owner_brief;
    delete fm.response_type;
    delete fm.response_options;
    delete fm.blocked_on;
    const updated = matter.stringify(content + appendix, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    return { ok: true, filename, action: 'rework', next_step: 'worker_will_rework' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function approveDecision(filename, comment) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    const timestamp = new Date().toISOString().split('T')[0];
    const appendix = `\n\n## Owner decided（${timestamp}）\n\n${comment}\n`;
    delete fm.blocked_on;
    delete fm.deferred_until;
    const updated = matter.stringify(content + appendix, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    return { ok: true, filename, next_step: 'worker_will_process' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deferCard(filename, until) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    fm.deferred_until = until;
    const updated = matter.stringify(content, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    return { ok: true, filename, deferred_until: until };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── needs_owner protocol actions ────────────────────────────

// dismissCard: Owner says "不做了" — status→dismissed, move to archive
function dismissCard(filename, reason) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    fm.status = 'dismissed';
    fm.owner_response = 'dismissed';
    fm.owner_response_at = new Date().toISOString().slice(0, 16);
    delete fm.needs_owner;
    delete fm.needs_owner_brief;
    delete fm.deferred_until;
    const timestamp = new Date().toISOString().split('T')[0];
    const appendix = reason ? `\n\n## 取消（${timestamp}）\n\n${reason}\n` : '';
    const updated = matter.stringify(content + appendix, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    const destPath = path.join(CARDS_DIRS.archive, filename + '.md');
    fs.renameSync(found.path, destPath);
    return { ok: true, filename, action: 'dismissed', next_step: 'archived_permanently' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// acknowledgeAction: Owner clicks "📋 转入待办" — assignee→user，留 active 进 My Todos
// 写 owner_response_at 是 getOwnerQueue 过滤出 TNY 的必要前置
function acknowledgeAction(filename) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    fm.assignee = 'user';
    fm.owner_response = 'acknowledged';
    fm.owner_response_at = new Date().toISOString().slice(0, 16);
    delete fm.needs_owner;
    delete fm.needs_owner_brief;
    delete fm.response_type;
    delete fm.response_options;
    const updated = matter.stringify(content, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    return { ok: true, filename, action: 'acknowledged', next_step: 'my_todos' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// getMyTodos: returns active cards with assignee: user (Owner's personal queue)
function getMyTodos() {
  const active = loadCards({ status: 'active' });
  return active.filter(c => c.assignee === 'user');
}

// respondToOwner: Owner submits a response — writes owner_response to frontmatter
// Replaces approveDecision. No longer appends body section as machine state.
function respondToOwner(filename, response, opts = {}) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    const validationError = validateOwnerResponse(response, opts, fm);
    if (validationError) return { ok: false, error: validationError };
    // L2 v3.1 §5.7.4: Owner response on escalated → recover to active
    //   同时保留原有 blocked/in_review → active 逻辑
    const normalizedStatus = String(fm.status || '').trim().toLowerCase();
    if (['blocked', 'in_review', 'escalated'].includes(normalizedStatus)) {
      fm.status = 'active';
      if (normalizedStatus === 'escalated') {
        delete fm.escalation_reason;
      }
    }
    // Snapshot current needs_owner state for potential undo.
    // Only record defined fields — js-yaml can't dump undefined.
    const snapshot = {};
    for (const k of ['needs_owner', 'needs_owner_brief', 'response_type', 'response_options', 'interaction_round']) {
      if (fm[k] !== undefined) snapshot[k] = fm[k];
    }
    fm._owner_response_prev = snapshot;
    fm.owner_response = response;
    fm.owner_response_at = new Date().toISOString().slice(0, 16);
    // Clear needs_owner — Worker picks it up via owner_response
    delete fm.needs_owner;
    delete fm.needs_owner_brief;
    delete fm.response_type;
    delete fm.response_options;
    delete fm.blocked_on;
    delete fm.claimed_by;
    delete fm.deferred_until;
    // Audit log in body (human-readable only)
    // 写到分钟精度：同一天多次回复时，header 能被 LLM 和 triage 区分先后，
    // 避免 "### Owner 回复（2026-04-19）" 两个同日回复 header 完全一样、
    // 时间线被误读的 bug（2026-04-20 verify-overview-team-view 教训）。
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const ownerComment = String(opts.comment || '').trim();
    const appendix = `\n\n### Owner 回复（${timestamp}）\n\n${response}${ownerComment ? `\n\n备注：${ownerComment}` : ''}\n`;
    const updated = matter.stringify(content + appendix, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    return { ok: true, filename, action: 'responded', next_step: 'worker_will_process' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// undoOwnerResponse: Revert owner_response — only possible before work agent consumes it
// Returns { ok: false, error: 'already_consumed', consumed_at, consumed_by } if too late
function undoOwnerResponse(filename) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    if (!fm.owner_response && !fm.owner_response_at) {
      return { ok: false, error: 'no_pending_response' };
    }
    if (fm.owner_response_consumed_at) {
      return { ok: false, error: 'already_consumed', consumed_at: fm.owner_response_consumed_at, consumed_by: fm.owner_response_consumed_by };
    }
    // Restore from snapshot if available
    const prev = fm._owner_response_prev || {};
    if (prev.needs_owner) fm.needs_owner = prev.needs_owner;
    if (prev.needs_owner_brief) fm.needs_owner_brief = prev.needs_owner_brief;
    if (prev.response_type) fm.response_type = prev.response_type;
    if (prev.response_options) fm.response_options = prev.response_options;
    if (prev.interaction_round) fm.interaction_round = prev.interaction_round;
    // Clear owner response fields
    delete fm.owner_response;
    delete fm.owner_response_at;
    delete fm._owner_response_prev;
    // Remove the appended Owner 回复 section (last one) from body.
    // 兼容新旧两种 header：旧 "2026-04-19"，新 "2026-04-19 13:45"
    const cleaned = content.replace(/\n\n### Owner 回复（[\d\- :]+）\n[\s\S]*$/, '');
    const updated = matter.stringify(cleaned, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    return { ok: true, filename, action: 'undone', restored: Object.keys(prev).length > 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// skipCard: defer current card to tomorrow (replaces no-op JS-only skip)
function skipCard(filename) {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  const tomorrow = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const r = deferCard(filename, tomorrow);
  return { ...r, action: 'skipped', next_step: 'deferred_to_tomorrow' };
}

// ── 系统状态概览 ──────────────────────────────────────

function getSystemOverview() {
  const agents = loadAgents();
  const plugins = loadPlugins();
  const inboxCards = loadCards({ status: 'inbox' });
  const activeCards = loadCards({ status: 'active' });
  const decisions = getDecisionQueue();
  const ownerQueue = getOwnerQueue({ includeInbox: true });
  const projects = getProjects();

  // 读 healthcheck
  let healthStatus = null;
  const healthPath = path.join(VAULT_PATH, 'Pi', 'healthcheck-report.md');
  if (fs.existsSync(healthPath)) {
    const stat = fs.statSync(healthPath);
    const raw = fs.readFileSync(healthPath, 'utf-8');
    const statusMatch = raw.match(/状态[:：]\s*(.+)/);
    healthStatus = {
      lastUpdate: stat.mtime.toISOString(),
      status: statusMatch ? statusMatch[1].trim() : 'unknown',
      stale: (Date.now() - stat.mtime.getTime()) > 36 * 60 * 60 * 1000, // >36h
    };
  }

  return {
    agents: {
      total: agents.length,
      active: agents.filter(a => a.status === 'active').length,
      paused: agents.filter(a => a.status === 'paused').length,
      list: agents.map(a => ({
        id: a.id,
        display_name: a.display_name,
        status: a.status,
        schedule: a.schedule,
        last_run: a.last_run,
      })),
    },
    cards: {
      inbox: inboxCards.length,
      active: activeCards.length,
      decisions: decisions.length,
      ownerQueue: ownerQueue.length,
    },
    projects: projects.map(p => ({
      filename: p.filename,
      title: p.title,
      progress: p.progress,
    })),
    decisions: decisions.map(d => ({
      filename: d.filename,
      title: d.title,
      question: d.decision_question,
      reason: d.reason,
      blocked_on: d.blocked_on,
      priority: d.priority,
    })),
    ownerQueue: ownerQueue.map(d => ({
      filename: d.filename,
      title: d.title,
      queueType: d.queueType,
      brief: d.brief,
      reason: d.reason,
      priority: d.priority,
      staleDays: d.staleDays,
      blocked_on: d.blocked_on,
      _content: d._content,
    })),
    plugins: plugins.map(p => ({
      id: p.id,
      display_name: p.display_name,
      category: p.category,
      enabled: p.enabled,
      provides: p.provides,
    })),
    health: healthStatus,
  };
}

// ── Token 统计（Overview Pi 大秘卡 + 员工墙）──────────────────

/**
 * getAgentTokenStats — 扫 Pi/Log/worker-log-*.md 算 per-agent
 * {today: 今日累计 tok, avg7d: 最近 7 天日均 tok}
 *
 * 解析：每个 run 块
 *   ### 2026-04-19 23:45 [laptop-host] | engine:claude-cli | agent:pi | task:triage | tick #1864
 *   ...
 *   - 完成：... | 256,436 tok | ...
 *
 * 成本：worker-log 文件会持续追加；只扫文件**最后 400KB**，
 * 覆盖 ~2-3 天数据。7d 均是近似值（窗口不满 7 天就按实有天数算）。
 */
// worker-log 里的老格式数据清洗：
// - 老版本把 task 名当 agent 名记录（daily-* 是 pipeline 的 task；pi-* 是 pi 的 task）
// - "null" 字面量是早期 bug，过滤掉
const AGENT_ALIAS = {
  'pi-triage': 'pi',
  'pi-work': 'pi',
  'pi-sense-maker': 'pi',
  'pi-sense': 'pi',
  'pi-reflect': 'pi',
  'daily-wechat-digest': 'pipeline',
  'daily-ai-diary': 'pipeline',
  'daily-diary-engine': 'pipeline',
  'daily-user-status': 'pipeline',
  'daily-health': 'pipeline',
  'daily-photo-diary': 'pipeline',
  'daily-briefing': 'pi',
  'sense-maker': 'pi',
  'reflect': 'pi',
  'triage': 'pi',
  'work': 'pi',
};
const AGENT_IGNORE = new Set(['null', "'null'", 'undefined', 'smoke-test', 'log-test', 'sentinel', 'test-probe', 'jarvis-worker', 'xiaodou-test', 'openclaw-test', 'test-wechat-report', 'guagua-test', 'dede-test']);

function getAgentTokenStats() {
  const logDir = path.join(VAULT_PATH, 'Pi', 'Log');
  const byAgent = {};

  // 本地时区格式（worker-log 里日期用本地时间，不能用 toISOString）
  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  const today = fmt(new Date());
  const last7 = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7.push(fmt(d));
  }

  const files = [];
  try {
    for (const f of fs.readdirSync(logDir)) {
      if (/^worker-log-.*\.md$/.test(f)) files.push(path.join(logDir, f));
    }
  } catch {}

  const headRe = /^###\s+(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+\[[^\]]*\]\s+\|\s+engine:\S+\s+\|\s+agent:(\S+)\s+\|/;
  const doneRe = /完成：.*?\|\s+([\d,]+)\s*tok\s+\|/;

  for (const f of files) {
    let raw = '';
    try {
      const stat = fs.statSync(f);
      // 覆盖 7 天窗口需要的量估算：单 tick 记录 ~500 字节 × pi.triage 96 次/天 ×
      // 其他 agent ~20 次/天 = ~60K/天 pi + 其他 = ~100K/天；7 天 ~700K。
      // laptop-host 最大单文件 ~1M，整读一次开销可控；超过 2MB 才截断。
      const MAX = 2 * 1024 * 1024;
      if (stat.size > MAX) {
        const fd = fs.openSync(f, 'r');
        const buf = Buffer.alloc(MAX);
        fs.readSync(fd, buf, 0, MAX, stat.size - MAX);
        fs.closeSync(fd);
        raw = buf.toString('utf-8');
        const nl = raw.indexOf('\n');
        if (nl > 0) raw = raw.slice(nl + 1);
      } else {
        raw = fs.readFileSync(f, 'utf-8');
      }
    } catch { continue; }

    const lines = raw.split('\n');
    let curAgent = null;
    let curDate = null;
    for (const line of lines) {
      const h = line.match(headRe);
      if (h) {
        curDate = h[1];
        curAgent = h[2];
        continue;
      }
      if (curAgent && curDate) {
        const d = line.match(doneRe);
        if (d) {
          const tok = parseInt(d[1].replace(/,/g, ''), 10) || 0;
          // 数据清洗：alias 老名 → 标准 agent，忽略测试 / null
          const aid = AGENT_ALIAS[curAgent] || curAgent;
          if (!AGENT_IGNORE.has(aid)) {
            if (!byAgent[aid]) byAgent[aid] = { dates: {} };
            byAgent[aid].dates[curDate] = (byAgent[aid].dates[curDate] || 0) + tok;
          }
          curAgent = null;
          curDate = null;
        }
      }
    }
  }

  const out = {};
  for (const [agentId, data] of Object.entries(byAgent)) {
    const todayTok = data.dates[today] || 0;
    const sum7d = last7.reduce((acc, d) => acc + (data.dates[d] || 0), 0);
    const avg7d = Math.round(sum7d / 7);
    out[agentId] = { today: todayTok, avg7d };
  }
  return out;
}

/**
 * getAgentLatestRuns — 每个 agent 最近一条 run（供 Overview 员工墙状态 / 光晕用）。
 * 扫 Pi/State/runs/*.json，按 agent 聚合取最新（7 天窗口）。
 * 返回 { agentId: {status, task, started_at, finished_at, engine} }
 */
function getAgentLatestRuns() {
  const runsDir = path.join(VAULT_PATH, 'Pi', 'State', 'runs');
  if (!fs.existsSync(runsDir)) return {};
  const latest = {};
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(runsDir)) {
      if (!f.endsWith('.json') || f.endsWith('.stats') || f.endsWith('.jsonl')) continue;
      const full = path.join(runsDir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(full, 'utf-8')); } catch { continue; }
      const rawAgent = r.agent;
      if (!rawAgent) continue;
      const aid = AGENT_ALIAS[rawAgent] || rawAgent;
      if (AGENT_IGNORE.has(aid)) continue;
      if (!latest[aid] || stat.mtimeMs > latest[aid].mtime) {
        latest[aid] = {
          mtime: stat.mtimeMs,
          run: {
            status: r.status || null,
            task: r.task || r.plugin_name || null,
            started_at: r.started_at || null,
            finished_at: r.finished_at || null,
            engine: r.runtime || null,
          },
        };
      }
    }
  } catch {}
  const out = {};
  for (const [aid, v] of Object.entries(latest)) out[aid] = v.run;
  return out;
}

// ── Pi 大秘卡数据 ──────────────────────────────────────

/**
 * getPiOverview — Home/Overview 的"Pi 大秘卡"数据源
 *
 * 返回：
 *   {
 *     character: {id, display_name, nickname, avatar_emoji, skin, voice, voice_verified},
 *     currentPhase: {task, started_at, runId} | null,   // null = 待命
 *     currentCard:  {filename, title, claimed_by} | null,
 *     todayStats:   {triage: N, work: N, 'sense-maker': N, reflect: N}
 *   }
 *
 * 数据源全部现有：Pi/State/runs/*.json + Cards/active/*.md + pi-persona。
 */
function getPiOverview() {
  // 1. 当前戏服（失败兜底默认）
  let character = null;
  try {
    const piPersona = require('./pi-persona');
    const c = piPersona.getCurrentCharacter();
    character = {
      id: c.id,
      display_name: c.display_name || c.id,
      nickname: c.nickname || null,
      avatar_emoji: c.avatar_emoji || '✦',
      skin: c.skin || c.id,
      voice: c.voice || null,
      voice_verified: !!c.voice_verified,
    };
  } catch {
    character = { id: 'patrick', display_name: 'Pi', nickname: null, avatar_emoji: '✦', skin: 'patrick', voice: null, voice_verified: false };
  }

  // 2. 扫 Pi/State/runs/ 里的 Pi 任务记录
  const runsDir = path.join(VAULT_PATH, 'Pi', 'State', 'runs');
  const piPhases = ['triage', 'work', 'sense-maker', 'reflect'];
  // 今天日期（本地时区）YYYYMMDD
  const today = new Date();
  const todayKey = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('');

  let currentPhase = null;          // 最新 running 的 pi 任务
  const todayStats = { triage: 0, work: 0, 'sense-maker': 0, reflect: 0 };
  let latestRunningMtime = 0;

  if (fs.existsSync(runsDir)) {
    try {
      for (const f of fs.readdirSync(runsDir)) {
        if (!f.endsWith('.json')) continue;
        // 文件名 {task}-{YYYYMMDD}-{HHMMSS}.json；只收 piPhases 前缀
        const m = f.match(/^([a-z-]+)-(\d{8})-\d{6}\.json$/);
        if (!m) continue;
        const task = m[1];
        const datePart = m[2];
        if (!piPhases.includes(task)) continue;
        // 今日统计
        if (datePart === todayKey) todayStats[task] = (todayStats[task] || 0) + 1;
        // 扫 running：读文件拿 status
        try {
          const full = path.join(runsDir, f);
          const stat = fs.statSync(full);
          // 15 分钟内才算"正在做"，防止 stale running record 误报
          if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) continue;
          const r = JSON.parse(fs.readFileSync(full, 'utf-8'));
          if (r.agent === 'pi' && r.status === 'running' && stat.mtimeMs > latestRunningMtime) {
            latestRunningMtime = stat.mtimeMs;
            currentPhase = { task, started_at: r.started_at || null, runId: r.run_id || null };
          }
        } catch {}
      }
    } catch {}
  }

  // 3. 正在做的卡：扫 Cards/active/ 里有 claimed_by 且不是 archive/skip 的
  let currentCard = null;
  try {
    const activeDir = CARDS_DIRS.active;
    if (fs.existsSync(activeDir)) {
      let newestClaimMtime = 0;
      for (const f of fs.readdirSync(activeDir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const full = path.join(activeDir, f);
          const stat = fs.statSync(full);
          // 只看最近 30 分钟改过的（claimed_by 刚打上）
          if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) continue;
          const raw = fs.readFileSync(full, 'utf-8');
          const parsed = matter(raw);
          const claimed = parsed.data.claimed_by;
          if (!claimed) continue;
          // 提取 title
          const titleMatch = raw.match(/^#\s+(.+)$/m);
          const title = titleMatch ? titleMatch[1].trim() : f.replace(/\.md$/, '');
          if (stat.mtimeMs > newestClaimMtime) {
            newestClaimMtime = stat.mtimeMs;
            currentCard = { filename: f.replace(/\.md$/, ''), title, claimed_by: claimed };
          }
        } catch {}
      }
    }
  } catch {}

  // 4. Pi 的 token 用量（今日 / 7d 均）
  let tokenStats = null;
  try {
    const stats = getAgentTokenStats();
    if (stats.pi) tokenStats = stats.pi;
  } catch {}

  return { character, currentPhase, currentCard, todayStats, tokenStats };
}

// ── Card 写操作 ──────────────────────────────────────

function findCardPath(filename) {
  for (const [status, dir] of Object.entries(CARDS_DIRS)) {
    const p = path.join(dir, filename + '.md');
    if (fs.existsSync(p)) return { path: p, status };
  }
  return null;
}

function readCard(filename) {
  const found = findCardPath(filename);
  if (!found) return null;
  const raw = fs.readFileSync(found.path, 'utf-8');
  const { data: frontmatter, content } = matter(raw);
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return {
    filename,
    dir: found.status,
    title: titleMatch ? titleMatch[1].trim() : filename,
    frontmatter,
    content,
    fullContent: raw,
  };
}

function updateCardFrontmatter(filename, updates) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };

  const raw = fs.readFileSync(found.path, 'utf-8');
  const { data: frontmatter, content } = matter(raw);

  // `null` / `undefined` = delete key; anything else = set value.
  // (Letting null through would serialize as `key: null` in YAML, which is
  // almost never what callers want — they want the key gone.)
  for (const [k, v] of Object.entries(updates || {})) {
    if (v === null || v === undefined) delete frontmatter[k];
    else frontmatter[k] = v;
  }

  const updated = matter.stringify(content, frontmatter);
  fs.writeFileSync(found.path, updated, 'utf-8');

  return { ok: true, filename, updates };
}

function resolveDecision(filename, decision) {
  // 清除 blocked_on，记录决策到卡片内容
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };

  const raw = fs.readFileSync(found.path, 'utf-8');
  const { data: frontmatter, content } = matter(raw);

  const oldBlockedOn = frontmatter.blocked_on;
  delete frontmatter.blocked_on;

  // 在内容末尾追加决策记录
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const decisionLog = `\n\n## Decision (${timestamp})\n\n**Q:** ${oldBlockedOn}\n**A:** ${decision}\n`;
  const updatedContent = content.trimEnd() + decisionLog;

  const updated = matter.stringify(updatedContent, frontmatter);
  fs.writeFileSync(found.path, updated, 'utf-8');

  return { ok: true, filename, resolved: oldBlockedOn, decision };
}

function moveCard(filename, toStatus) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  if (found.status === toStatus) return { ok: true, noOp: true };

  const destDir = CARDS_DIRS[toStatus];
  if (!destDir) return { ok: false, error: `Invalid status: ${toStatus}` };

  // When moving to archive, sync status field in frontmatter
  if (toStatus === 'archive') {
    try {
      const raw = fs.readFileSync(found.path, 'utf-8');
      const { data: fm, content } = matter(raw);
      if (fm.status !== 'dismissed') fm.status = 'done';
      const updated = matter.stringify(content, fm);
      fs.writeFileSync(found.path, updated, 'utf-8');
    } catch (e) {
      console.warn('[moveCard] frontmatter update failed:', e.message);
    }
  }

  const destPath = path.join(destDir, filename + '.md');
  fs.renameSync(found.path, destPath);

  return { ok: true, filename, from: found.status, to: toStatus, next_step: 'archived' };
}

// Create a new card file. Rejects if filename already exists in any folder.
// Caller supplies filename (slug), target folder (inbox/active), frontmatter,
// and optional markdown body. Used by Home's quick-add-card feature.
function createCard(filename, { dir = 'inbox', frontmatter = {}, content = '' } = {}) {
  // Sanitize filename — slug only
  const slug = String(filename || '').trim().replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (!slug) return { ok: false, error: 'empty filename' };
  if (slug.length > 80) return { ok: false, error: 'filename too long' };

  const destDir = CARDS_DIRS[dir];
  if (!destDir) return { ok: false, error: 'invalid dir: ' + dir };

  // Reject if card exists in any folder (avoid clobbering)
  const existing = findCardPath(slug);
  if (existing) return { ok: false, error: 'card already exists in ' + existing.status };

  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, slug + '.md');
    // Sensible frontmatter defaults
    const fm = {
      type: 'task',
      status: dir === 'inbox' ? 'inbox' : 'active',
      priority: 3,
      created: localDateStr(),
      ...frontmatter,
    };
    // Body defaults to a # Title line if no content
    const title = frontmatter.title || slug;
    const body = content || `# ${title}\n\n`;
    const raw = matter.stringify(body, fm);
    fs.writeFileSync(destPath, raw, 'utf-8');
    return { ok: true, filename: slug, dir, path: destPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Restore a card to a snapshot — used by the frontend Undo feature. The
// snapshot is captured BEFORE a destructive mutation and handed back verbatim
// here: frontmatter, content, and the original folder. If the card has since
// been moved (e.g. approveReview archived it), we move it back first, then
// overwrite the full file.
function restoreCard(filename, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, error: 'invalid snapshot' };
  }
  const targetDir = snapshot.dir || 'active';
  const destDir = CARDS_DIRS[targetDir];
  if (!destDir) return { ok: false, error: 'invalid snapshot dir: ' + targetDir };

  const found = findCardPath(filename);
  let destPath = path.join(destDir, filename + '.md');

  try {
    if (found && found.status !== targetDir) {
      // Card was moved (e.g. active → archive). Move it back first.
      fs.renameSync(found.path, destPath);
    } else if (found) {
      destPath = found.path;
    }
    // Otherwise the file was deleted — we create it fresh in targetDir

    const raw = matter.stringify(snapshot.content || '', snapshot.frontmatter || {});
    fs.writeFileSync(destPath, raw, 'utf-8');
    return { ok: true, filename, dir: targetDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Run State ──
//
// Run record canonical status vocabulary（写入者 → 状态）：
//   pios-tick.sh      → gate_skipped  (pre-gate 返回 1，不启动 CLI)
//   pios-adapter.sh   → running       (初始；心跳每 10s 刷 heartbeat_at)
//   pios-adapter.sh   → success       (task 完成 exit=0)
//   pios-adapter.sh   → failed        (exit≠0 且无 fallback)
//   pios-adapter.sh   → degraded      (fallback 救回，如 claude-cli → codex-cli)
//   pios-adapter.sh   → timeout       (watchdog _ADAPTER_TIMEOUT_SEC 到期自杀)
//   run-session.js    → handed_off    (会话交接给下一个 sid)
//
// Read-time 派生（永不持久化）：
//   _annotateRunIfZombie → zombie     (running + heartbeat_at > 90s 未刷)
//
// 时间字段：finished_at（不是 endTime，之前 Pi 动态 recent runs 过滤
// 用 r.endTime 永远 undefined，filter 静默返回空数组）
// 耗时字段：duration_ms
const RUNS_DIR = path.join(VAULT_PATH, 'Pi', 'State', 'runs');

function getRecentRuns(limit = 20) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8'));
    } catch { return null; }
  }).filter(Boolean);
}

// Zombie 检测：status=running 但 heartbeat_at 超 90s 未更新 → 视为 zombie
// 与 main.js 的 _annotateRunIfZombie 保持一致（这条 API 走 backend/pios-engine 不走 main.js）
const _ZOMBIE_HEARTBEAT_TIMEOUT_MS = 90 * 1000;
function _annotateRunIfZombie(r) {
  if (!r || r.status !== 'running') return r;
  const hb = r.heartbeat_at;
  if (!hb) return r;
  const ageMs = Date.now() - (Number(hb) * 1000);
  if (ageMs > _ZOMBIE_HEARTBEAT_TIMEOUT_MS) {
    return { ...r, status: 'zombie', _zombieAgeMs: ageMs };
  }
  return r;
}

function getAgentRuns(agentId, limit = 10) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => f.startsWith(agentId + '-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  return files.map(f => {
    try {
      return _annotateRunIfZombie(JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8')));
    } catch { return null; }
  }).filter(Boolean);
}

// ── Worker-log section extraction ──
// worker-log-{host}.md 是 pios-adapter.sh 的产物（line 1606-1639），每次 run 结束追加：
//   ### YYYY-MM-DD HH:MM [host] | engine:X | agent:Y | task:Z | [fallback:...] | tick #N
//   - <AI bullets: 动作/产出/归档/摄入/派发/triage/...>
//   - 完成：耗时 ... | tokens
// 是 "Pi 干了啥" 的权威 SSoT。按 finished_at + host + task 匹配 section。

function getWorkerLogEntry({ host, task, finishedAt }) {
  if (!host || !task || !finishedAt) return null;
  const logPath = path.join(VAULT_PATH, 'Pi', 'Log', `worker-log-${host}.md`);
  if (!fs.existsSync(logPath)) return null;

  let content;
  try {
    const stat = fs.statSync(logPath);
    const WINDOW = 200 * 1024; // 最后 200KB 覆盖数百条 section，避免全读 17k 行
    if (stat.size <= WINDOW) {
      content = fs.readFileSync(logPath, 'utf-8');
    } else {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(WINDOW);
      fs.readSync(fd, buf, 0, WINDOW, stat.size - WINDOW);
      fs.closeSync(fd);
      content = buf.toString('utf-8');
    }
  } catch {
    return null;
  }

  const finMs = new Date(finishedAt).getTime();
  if (isNaN(finMs)) return null;
  const TOLERANCE_MS = 3 * 60 * 1000; // 日志写入在 finish 后几秒内，±3min 够

  const lines = content.split('\n');
  const headerRe = /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \[[^\]]+\] \| [^|]+ \| [^|]+ \| task:([^ |]+)/;
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    const [, date, time, logTask] = m;
    if (logTask !== task) continue;
    const logTs = new Date(`${date}T${time}:00+08:00`).getTime();
    if (isNaN(logTs)) continue;
    if (Math.abs(logTs - finMs) > TOLERANCE_MS) continue;
    matches.push({ i, delta: Math.abs(logTs - finMs) });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.delta - b.delta);
  const startIdx = matches[0].i;

  const bullets = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('### ')) break;
    if (!line.startsWith('- ')) continue;
    if (/^- 完成[（:：]/.test(line)) continue;
    bullets.push(line);
  }
  return bullets;
}

function summarizeBullets(bullets) {
  // worker-log 约定每条 entry 第一行 bullet 就是 headline：
  // `- 动作：...` / `- triage：...` / `- 话题：...` / `- 失败：...` / `- 发现：...`
  // 取 headline 的冒号后文本作为一句话总结；skip 的括号原因就是价值，不过滤。
  if (!bullets || bullets.length === 0) return '';
  const EMPTY_RE = /^(无$|无事$|—+$|-+$)/;
  const MAX_LEN = 120;
  const clean = (s) => {
    let t = s.replace(/\s+/g, ' ').trim();
    // 美化：skip（xxx） → 空转：xxx（更像人话）
    const skipMatch = t.match(/^skip[（(]\s*(.+?)\s*[）)]\s*$/);
    if (skipMatch) t = '空转：' + skipMatch[1];
    else if (/^skip\b/i.test(t)) t = '空转';
    if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN - 1) + '…';
    return t;
  };
  const HEADLINE_KEYS = ['动作', 'triage', '话题', '失败', '发现', 'action', '产出', 'output'];
  for (const key of HEADLINE_KEYS) {
    const re = new RegExp(`^- ${key}[：:]\\s*`);
    for (const b of bullets) {
      if (!re.test(b)) continue;
      const raw = b.replace(re, '').trim();
      if (!raw || EMPTY_RE.test(raw)) continue;
      return clean(raw);
    }
  }
  for (const b of bullets) {
    const withoutPrefix = b.replace(/^- [^：:]+[：:]\s*/, '').replace(/^- /, '').trim();
    if (!withoutPrefix || EMPTY_RE.test(withoutPrefix)) continue;
    return clean(withoutPrefix);
  }
  return '';
}

// ── Agent Log ──

function getAgentLog(agentId, lines = 50) {
  // 本地 date（pios-tick.sh 写的 log 用 `$(date +%Y-%m-%d)` 本地时区）
  const today = localDateStr();
  const dir = path.join(VAULT_PATH, 'Pi', 'Log', 'cron');
  const prefix = `${agentId}-${today}`;
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.log') && (f === `${prefix}.log` || f.startsWith(`${prefix}-`)))
      .sort();
    if (files.length === 0) return { agentId, date: today, lines: [], totalLines: 0 };
    const merged = [];
    for (const f of files) {
      const host = f === `${prefix}.log` ? '' : f.slice(prefix.length + 1, -'.log'.length);
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const tag = host ? `[${host}] ` : '';
      for (const ln of content.split('\n')) {
        if (ln) merged.push(tag + ln);
      }
    }
    return {
      agentId,
      date: today,
      lines: merged.slice(-lines),
      totalLines: merged.length,
      files: files.length,
    };
  } catch {
    return { agentId, date: today, lines: [], totalLines: 0 };
  }
}

// ── Services（从 pios.yaml infra.services 读）──

function getServices() {
  try {
    const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    const services = manifest?.infra?.services || {};
    // 转成数组格式兼容旧调用
    return Object.entries(services).map(([id, svc]) => ({
      id,
      name: id,
      ...svc,
    }));
  } catch {
    return [];
  }
}

async function checkServiceHealth(service) {
  const health = service.health;
  if (!health || !health.method) return { id: service.id, name: service.name, status: 'unknown', detail: 'no health check' };

  try {
    switch (health.method) {
      case 'file-freshness': {
        let filePath = health.file;
        if (!path.isAbsolute(filePath)) filePath = path.join(VAULT_PATH, filePath);
        const stat = fs.statSync(filePath);
        const ageMin = (Date.now() - stat.mtime.getTime()) / 60000;
        const maxAge = health.max_age_min || (health.max_age_hours || 24) * 60;
        return {
          id: service.id, name: service.name, category: service.category,
          status: ageMin <= maxAge ? 'ok' : 'warn',
          detail: `${Math.round(ageMin)}min ago (max ${maxAge}min)`,
        };
      }
      case 'api-last-run': {
        const runs = getAgentRuns(service.id, 1);
        if (runs.length === 0) return { id: service.id, name: service.name, category: service.category, status: 'warn', detail: 'no runs found' };
        const run = runs[0];
        const ageH = (Date.now() - new Date(run.finished_at || run.started_at).getTime()) / 3600000;
        const maxH = health.max_age_hours || 26;
        return {
          id: service.id, name: service.name, category: service.category,
          status: run.status === 'success' && ageH <= maxH ? 'ok' : 'warn',
          detail: `${run.status} ${Math.round(ageH)}h ago`,
        };
      }
      case 'http': {
        const url = health.url;
        if (!url) return { id: service.id, name: service.name, category: service.category, status: 'unknown', detail: 'no url' };
        // Use http/https module for health check
        const proto = url.startsWith('https') ? require('https') : require('http');
        return new Promise((resolve) => {
          const req = proto.get(url, { timeout: 2000, rejectUnauthorized: false }, (res) => {
            resolve({
              id: service.id, name: service.name, category: service.category,
              status: res.statusCode < 400 ? 'ok' : 'warn',
              detail: `HTTP ${res.statusCode}`,
            });
          });
          req.on('error', (e) => {
            resolve({
              id: service.id, name: service.name, category: service.category,
              status: 'down',
              detail: e.code || e.message,
            });
          });
          req.on('timeout', () => {
            req.destroy();
            resolve({
              id: service.id, name: service.name, category: service.category,
              status: 'down', detail: 'timeout',
            });
          });
        });
      }
      case 'process':
      case 'process-running':
      case 'launchd-loaded':
      case 'port-listen': {
        // Local-only checks — only meaningful on the service's host
        const _localHost = require('./host-helper').resolveHost();
        if (service.host && service.host !== _localHost) {
          return { id: service.id, name: service.name, category: service.category, status: 'remote', detail: `runs on ${service.host}` };
        }
        return { id: service.id, name: service.name, category: service.category, status: 'unknown', detail: health.method };
      }
      default:
        return { id: service.id, name: service.name, category: service.category, status: 'unknown', detail: health.method };
    }
  } catch (e) {
    return { id: service.id, name: service.name, category: service.category, status: 'down', detail: e.message };
  }
}

async function checkAllServices() {
  const services = getServices().filter(s => s.enabled !== false);
  return Promise.all(services.map(s => checkServiceHealth(s)));
}

// ── Health Report ──

function getHealthReport() {
  const reportPath = path.join(VAULT_PATH, 'Pi', 'healthcheck-report.md');
  try {
    const raw = fs.readFileSync(reportPath, 'utf-8');
    const { data: fm, content } = matter(raw);
    const stat = fs.statSync(reportPath);
    const ageH = (Date.now() - stat.mtime.getTime()) / 3600000;

    // Extract summary table rows
    const sections = [];
    const tableMatch = content.match(/\| 类别 \| 状态 \|\n\|.*\|\n([\s\S]*?)(?:\n---|\n\n)/);
    if (tableMatch) {
      const rows = tableMatch[1].trim().split('\n');
      for (const row of rows) {
        const cols = row.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length >= 2) sections.push({ category: cols[0], status: cols[1] });
      }
    }

    return {
      date: fm.date,
      generatedBy: fm.generated_by,
      overallStatus: fm.status,
      issuesCount: fm.issues_count,
      stale: ageH > 36,
      ageHours: Math.round(ageH),
      sections,
    };
  } catch {
    return { date: null, overallStatus: 'unknown', stale: true, sections: [] };
  }
}

// ── Pipeline Freshness ──

function getPipelineFreshness() {
  // Scan for pipeline output directories dynamically
  const steps = [];
  const pipelineDirs = [
    { pattern: 'Pipeline/AI_Wechat_Digest/daily_wechat', name: 'WeChat Digest' },
    { pattern: 'Pipeline/AI_Health_Digest/daily_health', name: 'Health Digest' },
    { pattern: 'Pipeline/AI_Chatgpt_Digest/daily_chatpgt', name: 'ChatGPT Digest' },
    { pattern: 'Pipeline/AI_Photo_Digest/daily_photo', name: 'Photo Diary' },
    { pattern: 'Personal/Daily', name: 'Daily Diary' },
  ];
  // Look in any top-level user directory or Pi/ for pipeline data
  try {
    const topDirs = fs.readdirSync(VAULT_PATH).filter(d => {
      const full = path.join(VAULT_PATH, d);
      return fs.statSync(full).isDirectory() && !['Pi', 'Cards', 'Projects', '.git', 'node_modules', '.screenshots'].includes(d);
    });
    for (const pd of pipelineDirs) {
      for (const td of topDirs) {
        const dir = path.join(VAULT_PATH, td, pd.pattern);
        if (fs.existsSync(dir)) { steps.push({ name: pd.name, dir }); break; }
      }
    }
  } catch {}

  // pipeline md 文件按本地 date 命名，today 也用本地 date 算 daysAgo
  const today = localDateStr();

  return steps.map(step => {
    try {
      const files = fs.readdirSync(step.dir)
        .filter(f => f.endsWith('.md') && f.match(/^\d{4}-\d{2}-\d{2}/))
        .sort()
        .reverse();
      const latest = files[0] || null;
      const latestDate = latest ? latest.replace('.md', '') : null;
      const daysAgo = latestDate ? Math.round((new Date(today) - new Date(latestDate)) / 86400000) : null;
      return {
        name: step.name,
        latest: latestDate,
        daysAgo,
        ok: daysAgo !== null && daysAgo <= 1,
      };
    } catch {
      return { name: step.name, latest: null, daysAgo: null, ok: false };
    }
  });
}

// ── Task 管理（Task-centric 调度）─────────────────────

// Task prompts 现在在 Agents/<agent>/tasks/ 下，不再有统一 TASKS_DIR
// 保留此变量用于兼容，但实际路径从 pios.yaml prompt 字段解析
const TASKS_DIR = path.join(VAULT_PATH, 'Pi', 'Config');

const ENGINE_DISPLAY = { code: 'claude-cli', 'claude-cli': 'claude-cli', local: 'local', 'codex-cli': 'codex-cli', openclaw: 'openclaw' };

function normalizeEngines(enginesField, engineField) {
  if (Array.isArray(enginesField) && enginesField.length > 0) {
    return enginesField.map(e => ENGINE_DISPLAY[e] || e);
  }
  const raw = engineField || 'code';
  return [ENGINE_DISPLAY[raw] || raw];
}

function normalizeAgentId(agentId) {
  return !agentId || agentId === 'null' ? '' : agentId;
}

function normalizeHostField(hostsValue, hostValue) {
  if (Array.isArray(hostsValue)) return hostsValue[0] || 'any';
  return hostValue || 'any';
}

function normalizeHostsList(hostsValue, hostValue) {
  const raw = Array.isArray(hostsValue)
    ? hostsValue
    : (hostValue && hostValue !== 'any' ? [hostValue] : []);
  const seen = new Set();
  const hosts = [];
  for (const host of raw) {
    const value = String(host || '').trim();
    if (!value || value === 'any' || seen.has(value)) continue;
    seen.add(value);
    hosts.push(value);
  }
  return hosts;
}

function getTaskManifestRef(manifest, taskId) {
  for (const [agentId, agent] of Object.entries(manifest.agents || {})) {
    if (agent.tasks?.[taskId]) {
      return { agentId, agent, task: agent.tasks[taskId] };
    }
  }
  return null;
}

function taskEnginesFromManifest(task, agent) {
  // 新字段：task.runtimes (数组) > task.engines (老数组) > task.runtime (单值)
  //       > agent.runtimes[0] > agent.runtime (老单值)
  if (Array.isArray(task?.runtimes) && task.runtimes.length > 0) {
    return normalizeEngines(task.runtimes);
  }
  if (Array.isArray(task?.engines) && task.engines.length > 0) {
    return normalizeEngines(task.engines);
  }
  if (task?.runtime) return normalizeEngines(null, task.runtime);
  // task 没声明 → 继承 agent
  if (Array.isArray(agent?.runtimes) && agent.runtimes.length > 0) {
    return normalizeEngines(agent.runtimes);
  }
  return normalizeEngines(null, agent?.runtime || 'claude-cli');
}

function sanitizeTaskEngines(enginesField, engineField) {
  const raw = normalizeEngines(enginesField, engineField).filter(Boolean);
  const seen = new Set();
  const engines = [];
  for (const engine of raw) {
    if (!seen.has(engine)) {
      seen.add(engine);
      engines.push(engine);
    }
  }
  if (!engines.length) return ['claude-cli'];
  if (engines[0] === 'local') return ['local'];
  return engines.slice(0, 2);
}

function sanitizePermissionModeForEngine(permissionMode, primaryEngine) {
  if (primaryEngine === 'claude-cli') return permissionMode || 'default';
  if (primaryEngine === 'codex-cli') {
    return permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default';
  }
  return 'default';
}

function taskPromptPath(agentId, taskId) {
  return path.join(VAULT_PATH, 'Pi', 'Agents', agentId, 'tasks', taskId + '.md');
}

function taskHostsFromManifest(task, agent) {
  // 新字段：task.hosts (数组) > task.host (单值) > agent.hosts[0] > agent.host (老)
  const agentDefaultHost = (Array.isArray(agent?.hosts) && agent.hosts.length > 0)
    ? agent.hosts[0]
    : agent?.host;
  return normalizeHostsList(task?.hosts, task?.host || agentDefaultHost);
}

// 本地时区日期（YYYY-MM-DD），跟 pios-tick.sh `$(date +%Y-%m-%d)` 对齐
// UTC 版 toISOString().slice(0,10) 在北京时间 00:00-08:00 会错位整整一天
function localDateStr(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isHostHeartbeatFresh(host, now = Date.now()) {
  const date = localDateStr(now);
  const tickLog = path.join(VAULT_PATH, 'Pi', 'Log', 'cron', `pios-tick-${host}-${date}.log`);
  try {
    const stat = fs.statSync(tickLog);
    const ttlMinutes = parseInt(process.env.PIOS_HOST_HEARTBEAT_TTL_MINUTES || '10', 10);
    return (now - stat.mtimeMs) <= ttlMinutes * 60 * 1000;
  } catch {
    return false;
  }
}

function hostCanRunAnyEngine(host, engines) {
  if (engines.length === 1 && engines[0] === 'local') return true;
  const authPath = path.join(VAULT_PATH, 'Pi', 'Log', `auth-status-${host}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const engineStates = data.engines || {};
    let allExplicitFalse = true;
    for (const engine of engines) {
      if (engine === 'local') return true;
      const info = engineStates[engine];
      if (!info || info.ok == null) return true;
      if (info.ok === true) return true;
      if (info.ok !== false) allExplicitFalse = false;
    }
    return !allExplicitFalse;
  } catch {
    return true;
  }
}

function resolvePreferredHost(hosts, engines) {
  const normalizedHosts = normalizeHostsList(hosts);
  if (!normalizedHosts.length) return 'any';
  const normalizedEngines = sanitizeTaskEngines(engines);
  for (const host of normalizedHosts) {
    if (!isHostHeartbeatFresh(host)) continue;
    if (hostCanRunAnyEngine(host, normalizedEngines)) return host;
  }
  return null;
}

// ── Cron 下次运行时间计算 ──
function cronNextRun(cronStr) {
  // 解析 "m h dom mon dow" 格式，计算下次运行时间
  if (!cronStr) return null;
  const parts = cronStr.replace(/"/g, '').trim().split(/\s+/);
  if (parts.length < 5) return null;

  function expandField(field, min, max) {
    if (field === '*') return null; // any
    const vals = new Set();
    for (const part of field.split(',')) {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const s = parseInt(step);
        const start = range === '*' ? min : parseInt(range);
        for (let i = start; i <= max; i += s) vals.add(i);
      } else if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        for (let i = a; i <= b; i++) vals.add(i);
      } else {
        vals.add(parseInt(part));
      }
    }
    return [...vals].sort((a, b) => a - b);
  }

  const minutes = expandField(parts[0], 0, 59);
  const hours = expandField(parts[1], 0, 23);
  const doms = expandField(parts[2], 1, 31);
  const months = expandField(parts[3], 1, 12);
  const dows = expandField(parts[4], 0, 6);

  const now = new Date();
  // Check up to 7 days ahead
  for (let offset = 0; offset < 7 * 24 * 60; offset++) {
    const candidate = new Date(now.getTime() + offset * 60000);
    const m = candidate.getMinutes(), h = candidate.getHours();
    const dom = candidate.getDate(), mon = candidate.getMonth() + 1, dow = candidate.getDay();
    if (minutes && !minutes.includes(m)) continue;
    if (hours && !hours.includes(h)) continue;
    if (doms && !doms.includes(dom)) continue;
    if (months && !months.includes(mon)) continue;
    if (dows && !dows.includes(dow)) continue;
    if (candidate.getTime() <= now.getTime()) continue;
    return candidate.toISOString();
  }
  return null;
}

function loadTasks() {
  // pios.yaml 是唯一调度来源。prompt body 仍从 .md 文件读。
  try {
    const manifestAgents = _readManifestAgents();
    if (!manifestAgents) return [];

    const tasks = [];
    for (const [agentId, agent] of Object.entries(manifestAgents)) {
      for (const [taskId, task] of Object.entries(agent.tasks || {})) {
        const cron = task.trigger?.cron || '';
        const enabled = task.enabled !== false;
        const hosts = taskHostsFromManifest(task, agent);
        const promptPath = task.prompt || '';
        const engines = taskEnginesFromManifest(task, agent);

        // Read prompt file body for preview only. Scheduler-facing config comes from manifest.
        let promptPreview = '';
        if (promptPath) {
          const fullPath = path.join(VAULT_PATH, 'Pi', 'Config', promptPath);
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const { content } = matter(raw);
            promptPreview = content.trim().substring(0, 200);
          } catch {}
        }

        // Last run from run records
        const runs = getAgentRuns(taskId, 1);
        const lastRun = runs[0] || null;
        const nextRun = enabled ? cronNextRun(cron) : null;

        tasks.push({
          taskId,
          agent: agentId,
          cron,
          enabled,
          engines,
          hosts,
          description: task.description || '',
          goal: task.goal || '',
          prompt: promptPath,
          promptPreview,
          nextRun,
          lastRunRecord: lastRun,
        });
      }
    }
    return tasks;
  } catch (e) {
    console.warn('[pios] loadTasks failed:', e.message);
    return [];
  }
}

// 从 pios.yaml 查 task prompt 文件的实际路径（v5.1+ task 在 Agents/<agent>/tasks/ 下）
function _resolveTaskPath(taskId) {
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    for (const [agentId, agent] of Object.entries(manifest.agents || {})) {
      if (agent.tasks?.[taskId]) {
        const task = agent.tasks[taskId];
        const promptField = task.prompt || '';
        if (promptField) {
          return {
            taskPath: path.join(VAULT_PATH, 'Pi', 'Config', promptField),
            host: (taskHostsFromManifest(task, agent)[0] || 'any'),
            agentId,
            cron: (task.trigger || {}).cron || '',
          };
        }
      }
    }
  } catch {}
  // Fallback: 旧路径
  return { taskPath: path.join(TASKS_DIR, taskId + '.md'), host: 'any', agentId: null, cron: '' };
}

function getTask(taskId) {
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');

  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    const ref = getTaskManifestRef(manifest, taskId);
    if (!ref) return null;

    const { agentId, agent, task } = ref;
    const taskPath = path.join(VAULT_PATH, 'Pi', 'Config', task.prompt || '');
    const hosts = taskHostsFromManifest(task, agent);
    const cron = task.trigger?.cron || '';
    const raw = fs.readFileSync(taskPath, 'utf-8');
    const { data: fm, content } = matter(raw);
    const engines = taskEnginesFromManifest(task, agent);

    return {
      taskId: fm.taskId || taskId,
      ...fm,
      agent: agentId,
      engines,
      hosts,
      cron: cron || fm.cron || '',
      prompt: content.trim(),
    };
  } catch {
    return null;
  }
}

function createTask(taskId, frontmatter, promptBody) {
  const agentId = normalizeAgentId(frontmatter.agent) || 'pi';
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');

  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.agents?.[agentId]) return { ok: false, error: `Agent ${agentId} not found` };
    if (manifest.agents[agentId].tasks?.[taskId]) return { ok: false, error: 'Task already exists' };

    // Write to manifest
    if (!manifest.agents[agentId].tasks) manifest.agents[agentId].tasks = {};
    const taskHosts = normalizeHostsList(frontmatter.hosts, frontmatter.host || manifest.agents[agentId].host || 'any');
    const engines = sanitizeTaskEngines(frontmatter.engines, frontmatter.engine || manifest.agents[agentId].runtime || 'claude-cli');
    const permissionMode = sanitizePermissionModeForEngine(frontmatter.permission_mode || 'default', engines[0]);
    const taskEntry = {
      prompt: `../Agents/${agentId}/tasks/${taskId}.md`,
      trigger: { cron: frontmatter.cron || '0 9 * * *' },
      enabled: frontmatter.enabled !== false,
      description: frontmatter.description || '',
      runtime: engines[0],
      engines,
    };
    if (taskHosts.length) {
      taskEntry.host = taskHosts[0];
      taskEntry.hosts = taskHosts;
    }
    manifest.agents[agentId].tasks[taskId] = taskEntry;
    atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));

    // Write prompt file to Agents/<agent>/tasks/ (v5.1+)
    const agentTaskDir = path.join(VAULT_PATH, 'Pi', 'Agents', agentId, 'tasks');
    const taskPath = path.join(agentTaskDir, taskId + '.md');
    fs.mkdirSync(agentTaskDir, { recursive: true });
    const fm = {
      taskId,
      engines,
      enabled: frontmatter.enabled !== false,
      agent: agentId,
      description: frontmatter.description || '',
      permission_mode: permissionMode,
      budget: frontmatter.budget || 'medium',
      allowed_tools: frontmatter.allowed_tools || '',
    };
    fs.writeFileSync(taskPath, matter.stringify('\n' + (promptBody || ''), fm), 'utf-8');

    return { ok: true, taskId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function updateTaskMeta(taskId, updates) {
  // pios.yaml 保存调度关键字段；prompt frontmatter 保存执行细节。
  const YAML_FIELDS = new Set(['enabled', 'host', 'cron', 'description', 'goal', 'depends_on']);
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    const ref = getTaskManifestRef(manifest, taskId);
    if (!ref) return { ok: false, error: 'Task not found in manifest' };

    const nextUpdates = { ...updates };
    const hasHostsUpdate = Object.prototype.hasOwnProperty.call(nextUpdates, 'hosts') || Object.prototype.hasOwnProperty.call(nextUpdates, 'host');
    const nextHosts = hasHostsUpdate ? normalizeHostsList(nextUpdates.hosts, nextUpdates.host) : null;
    delete nextUpdates.host;
    delete nextUpdates.hosts;

    const oldAgentId = ref.agentId;
    const targetAgentId = normalizeAgentId(nextUpdates.agent) || oldAgentId;
    if (!manifest.agents?.[targetAgentId]) {
      return { ok: false, error: `Agent ${targetAgentId} not found` };
    }
    if (targetAgentId !== oldAgentId && manifest.agents[targetAgentId].tasks?.[taskId]) {
      return { ok: false, error: `Task ${taskId} already exists under agent ${targetAgentId}` };
    }

    const oldTaskPath = path.join(VAULT_PATH, 'Pi', 'Config', ref.task.prompt || '');
    let taskEntry = ref.task;
    if (targetAgentId !== oldAgentId) {
      const targetAgent = manifest.agents[targetAgentId];
      if (!targetAgent.tasks) targetAgent.tasks = {};
      delete manifest.agents[oldAgentId].tasks[taskId];
      taskEntry = { ...taskEntry, prompt: `../Agents/${targetAgentId}/tasks/${taskId}.md` };
      targetAgent.tasks[taskId] = taskEntry;
    }

    const yamlUpdates = {};
    const fmUpdates = {};
    for (const [k, v] of Object.entries(nextUpdates)) {
      if (k === 'engines' || k === 'agent') continue;
      if (YAML_FIELDS.has(k)) yamlUpdates[k] = v;
      else fmUpdates[k] = v;
    }

    if (Object.prototype.hasOwnProperty.call(yamlUpdates, 'cron')) {
      taskEntry.trigger = { ...(taskEntry.trigger || {}), cron: yamlUpdates.cron };
      delete yamlUpdates.cron;
    }
    if (hasHostsUpdate) {
      if (nextHosts.length) {
        taskEntry.host = nextHosts[0];
        taskEntry.hosts = nextHosts;
      } else {
        delete taskEntry.host;
        delete taskEntry.hosts;
      }
    }
    Object.assign(taskEntry, yamlUpdates);

    const resolvedEngines = Object.prototype.hasOwnProperty.call(nextUpdates, 'engines')
      ? sanitizeTaskEngines(nextUpdates.engines)
      : taskEnginesFromManifest(taskEntry, manifest.agents[targetAgentId]);
    taskEntry.runtime = resolvedEngines[0];
    taskEntry.engines = resolvedEngines;
    if (Object.prototype.hasOwnProperty.call(nextUpdates, 'engines')) {
      fmUpdates.engines = resolvedEngines;
    }
    if (Object.prototype.hasOwnProperty.call(nextUpdates, 'permission_mode')) {
      fmUpdates.permission_mode = sanitizePermissionModeForEngine(nextUpdates.permission_mode, resolvedEngines[0]);
    }

    const newTaskPath = targetAgentId !== oldAgentId ? taskPromptPath(targetAgentId, taskId) : oldTaskPath;
    try {
      const raw = fs.readFileSync(oldTaskPath, 'utf-8');
      const { data: fm, content } = matter(raw);
      fm.agent = targetAgentId;
      if (fmUpdates.engines) {
        fm.engines = fmUpdates.engines;
        delete fm.engine;
        delete fmUpdates.engines;
      }
      Object.assign(fm, fmUpdates);
      fs.mkdirSync(path.dirname(newTaskPath), { recursive: true });
      fs.writeFileSync(newTaskPath, matter.stringify(content, fm), 'utf-8');
      if (newTaskPath !== oldTaskPath && fs.existsSync(oldTaskPath)) {
        fs.unlinkSync(oldTaskPath);
      }
    } catch (e) {
      console.warn('[pios] updateTaskMeta: failed to write frontmatter:', e.message);
    }

    atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
    return { ok: true, taskId, updates };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function updateTaskPrompt(taskId, newPrompt) {
  const { taskPath } = _resolveTaskPath(taskId);
  try {
    const raw = fs.readFileSync(taskPath, 'utf-8');
    const { data: fm } = matter(raw);
    const updated = matter.stringify('\n' + newPrompt, fm);
    fs.writeFileSync(taskPath, updated, 'utf-8');
    return { ok: true, taskId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 真删除：
// 1) pios.yaml 里 agents.X.tasks[taskId] 条目必删（这是 UI 显示依据，不删就像假删）
// 2) prompt 文件：存在就归档成 .disabled（容错——已 rename / 文件缺失都不影响 yaml 删除）
// 之前的 bug：只 rename + set enabled=false，yaml 条目没动，导致 UI 永远显示 + 二次删除 ENOENT
function deleteTask(taskId) {
  const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
  let renamed = false, writeErr = null;

  // Step 1: 归档 prompt 文件（容错）
  try {
    const { taskPath } = _resolveTaskPath(taskId);
    if (taskPath && fs.existsSync(taskPath)) {
      try {
        const raw = fs.readFileSync(taskPath, 'utf-8');
        const { data: fm, content } = matter(raw);
        fm.enabled = false;
        fs.writeFileSync(taskPath, matter.stringify(content, fm), 'utf-8');
      } catch {} // frontmatter 解析失败不阻断
      const disabledPath = taskPath + '.disabled';
      try {
        // 如果目标 .disabled 已存在（之前删过一次），加时间戳后缀避免覆盖
        if (fs.existsSync(disabledPath)) {
          const ts = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 19);
          fs.renameSync(taskPath, `${taskPath}.disabled.${ts}`);
        } else {
          fs.renameSync(taskPath, disabledPath);
        }
        renamed = true;
      } catch (e) { writeErr = e.message; }
    }
  } catch {} // _resolveTaskPath 失败也继续（task 可能只在 yaml 里，文件从未创建）

  // Step 2: 从 pios.yaml 删条目（必做）
  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    let foundAgent = null;
    for (const aid of Object.keys(manifest.agents || {})) {
      const tasks = manifest.agents[aid].tasks || {};
      if (Object.prototype.hasOwnProperty.call(tasks, taskId)) {
        delete tasks[taskId];
        foundAgent = aid;
        break;
      }
    }
    if (!foundAgent) {
      return { ok: false, error: `Task "${taskId}" 不在 pios.yaml（可能已删）` };
    }
    atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
    return { ok: true, taskId, agent: foundAgent, renamed, fileWriteError: writeErr };
  } catch (e) {
    return { ok: false, error: `pios.yaml 删条目失败: ${e.message}` };
  }
}

function spawnTask(taskId, options = {}) {
  const { spawn } = require('child_process');
  const crypto = require('crypto');
  const { taskPath } = _resolveTaskPath(taskId);

  if (!fs.existsSync(taskPath)) {
    return { ok: false, error: 'Task file not found: ' + taskId };
  }

  try {
    const { data: fm } = matter(fs.readFileSync(taskPath, 'utf-8'));
    const sessionId = options.resumeSession || crypto.randomUUID();
    const taskMeta = getTask(taskId);
    const engines = taskMeta?.engines || normalizeEngines(fm.engines, fm.engine);
    const hosts = Array.isArray(taskMeta?.hosts) ? taskMeta.hosts : [];
    const preferredHost = resolvePreferredHost(hosts, engines);
    if (preferredHost === null) {
      return { ok: false, error: `No healthy host available for ${taskId} (${hosts.join(', ')})` };
    }
    const host = preferredHost;

    // 本地 date（跟 pios-tick.sh / getAgentLog 对齐，避免 UI 找不到手动触发的 log）
    const today = localDateStr();

    // 判断是否需要远程执行（从 pios.yaml infra.instances 动态读取）
    const manifestForInfra = yaml.load(fs.readFileSync(path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    const instances = (manifestForInfra && manifestForInfra.infra && manifestForInfra.infra.instances) || {};
    const localHostname = require('os').hostname().toLowerCase();
    // 本机判断：host=any, 或 host 对应的 instance 没有 ssh 字段（本机不需要 SSH）
    const inst = instances[host] || {};
    const isLocal = host === 'any' || !inst.ssh;

    let child;
    if (!isLocal && inst.ssh) {
      // 远程执行：通过 SSH 在目标机器上跑 adapter
      const remote = { ssh: inst.ssh, vault: inst.vault || '/data/AI_Vault' };
      const remoteAdapter = `${remote.vault}/Pi/Tools/pios-adapter.sh`;
      const remoteLog = `${remote.vault}/Pi/Log/cron/${taskId}-${today}-${host}.log`;
      const remotePrompt = taskPath.replace(VAULT_PATH, remote.vault);
      // Wrap with START/END markers (matching pios-tick.sh format) so materialize can find the right section
      const cmd = 'source ~/.bashrc 2>/dev/null; '
        + `export PATH=/home/$USER/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH; `
        + `export PIOS_VAULT=${remote.vault}; `
        + `cd ${remote.vault}; `
        + `echo "[\$(date)] [${host}] START: ${taskId} (agent=run-now)" >> ${remoteLog}; `
        + `bash ${remoteAdapter} --task ${taskId} ${sessionId} ${remoteLog} ${remotePrompt}; `
        + `_rc=\$?; `
        + `echo "[\$(date)] [${host}] END: ${taskId} (exit=\$_rc)" >> ${remoteLog}; `
        + `exit \$_rc`;
      child = spawn('ssh', [remote.ssh, cmd], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      // Monitor for early SSH failure (exit non-0 within 10s) → write failed run record
      const _taskId = taskId, _sessionId = sessionId, _host = host;
      const _startedAt = new Date().toISOString();
      const earlyFailTimer = setTimeout(() => {
        child.removeAllListeners('exit');
      }, 10000);
      child.on('exit', (code) => {
        clearTimeout(earlyFailTimer);
        if (code !== 0 && code !== null) {
          const now = new Date();
          const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const runId = `${_taskId}-${ts}`;
          const record = {
            run_id: runId,
            agent: _taskId,
            plugin_name: _taskId,
            runtime: 'remote-ssh',
            requested_runtime: 'remote-ssh',
            host: _host,
            started_at: _startedAt,
            finished_at: now.toISOString(),
            status: 'failed',
            exit_code: code,
            session_id: _sessionId,
            permission_mode: null,
            fallback_from: null,
            fallback_reason: `SSH early exit with code ${code}`,
            checkpoint: null,
          };
          try {
            fs.mkdirSync(RUNS_DIR, { recursive: true });
            fs.writeFileSync(path.join(RUNS_DIR, runId + '.json'), JSON.stringify(record, null, 2));
          } catch {}
        }
      });
    } else {
      // 本地执行
      const adapter = path.join(VAULT_PATH, 'Pi', 'Tools', 'pios-adapter.sh');
      const logDir = path.join(VAULT_PATH, 'Pi', 'Log', 'cron');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `${taskId}-${today}.log`);
      const env = {
        HOME: process.env.HOME || require('os').homedir(),
        USER: process.env.USER || require('os').userInfo().username,
        LOGNAME: process.env.LOGNAME || require('os').userInfo().username,
        SHELL: '/bin/sh',
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        PIOS_VAULT: VAULT_PATH,
      };
      if (options.resumeSession) {
        env.PIOS_RESUME = '1';
      }
      child = spawn('bash', [adapter, '--task', taskId, sessionId, logFile, taskPath], {
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }
    child.unref();

    // Update last_session_id in task file
    try {
      const { data: fmUpdate, content: bodyUpdate } = matter(fs.readFileSync(taskPath, 'utf-8'));
      fmUpdate.last_session_id = sessionId;
      fs.writeFileSync(taskPath, matter.stringify(bodyUpdate, fmUpdate), 'utf-8');
    } catch {}

    return { ok: true, taskId, sessionId, runtime: engines[0], host, method: 'pios-adapter --task' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getTaskRuns(taskId, limit = 10) {
  return getAgentRuns(taskId, limit);
}

// ── Session / 对话读取 ─────────────────────────────────

function getSessionConversation(sessionId) {
  // Claude CLI 的 session 文件位置取决于 cwd：
  // - 从 Vault 目录运行: ~/.claude/projects/-Users-<user>-<vault>/{id}.jsonl
  // - 从 adapter 运行（无 cwd）: ~/.claude/projects/-/{id}.jsonl
  // 搜索所有可能位置
  const projectsBase = path.join(process.env.HOME, '.claude', 'projects');
  // Claude CLI 把 cwd 所有非 [a-zA-Z0-9] 字符转成 `-`（含 `_`）。只替换 `/` 会漏
  // 掉含 `_` 的 vault 路径（`my_vault` 错算成 `-my_vault`，实际目录是 `-my-vault`）
  const vaultProjectDir = VAULT_PATH.replace(/[^a-zA-Z0-9]/g, '-');
  const candidateDirs = [
    vaultProjectDir,
    '-',
  ];
  let sessionPath = null;
  for (const dir of candidateDirs) {
    const p = path.join(projectsBase, dir, sessionId + '.jsonl');
    if (fs.existsSync(p)) { sessionPath = p; break; }
  }
  // Fallback: search all project dirs
  if (!sessionPath) {
    try {
      for (const dir of fs.readdirSync(projectsBase)) {
        const p = path.join(projectsBase, dir, sessionId + '.jsonl');
        if (fs.existsSync(p)) { sessionPath = p; break; }
      }
    } catch {}
  }
  if (!sessionPath) {
    return { sessionId, messages: [], found: false, error: 'Session file not found' };
  }
  try {
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const messages = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message) {
          const content = entry.message.content;
          const text = Array.isArray(content)
            ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : (typeof content === 'string' ? content : '');
          if (text) {
            messages.push({
              role: 'user',
              content: text.substring(0, 2000),
              timestamp: entry.timestamp,
            });
          }
        } else if (entry.type === 'assistant' && entry.message) {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                messages.push({
                  role: 'assistant',
                  content: block.text.substring(0, 2000),
                  timestamp: entry.timestamp,
                });
              } else if (block.type === 'tool_use') {
                messages.push({
                  role: 'tool',
                  toolName: block.name,
                  content: JSON.stringify(block.input || {}).substring(0, 500),
                  timestamp: entry.timestamp,
                });
              }
            }
          }
        }
      } catch {}
    }

    return { sessionId, messages, found: true };
  } catch {
    return { sessionId, messages: [], found: false };
  }
}

// ── Daily Briefing ───────────────────────────────────

function getDailyBriefing() {
  const now = Date.now();
  const todayStr = localDateStr();
  const twelveHoursAgo = now - 12 * 3600 * 1000;

  // Section 1: 今天先看这个 — top 3 from owner queue
  const ownerQueue = getOwnerQueue({ includeOutputs: false, includeInbox: true });
  const todayItems = ownerQueue.slice(0, 3);

  // Section 2: Pi 昨夜做了什么 — outputs created/modified in last 12h
  const recentOutputs = [];
  const OUTS = path.join(VAULT_PATH, 'Pi', 'Output');
  if (fs.existsSync(OUTS)) {
    const scanOutputDir = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (!['scan-state', '__pycache__', 'archive'].includes(entry.name)) {
              scanOutputDir(path.join(dir, entry.name));
            }
            continue;
          }
          if (!entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
          // 2026-04-19：跳过 Syncthing 冲突文件，避免 Pi 动态 出现 3 份同名重复
          if (entry.name.includes('.sync-conflict-')) continue;
          const fp = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(fp);
            if (stat.mtimeMs >= twelveHoursAgo) {
              const raw = fs.readFileSync(fp, 'utf-8');
              let title = path.basename(entry.name, '.md');
              try {
                const parsed = matter(raw);
                if (parsed.data && parsed.data.title) title = parsed.data.title;
                else {
                  const m = parsed.content.match(/^#\s+(.+)$/m);
                  if (m) title = m[1].trim();
                }
              } catch {}
              recentOutputs.push({
                id: path.relative(OUTS, fp),
                title,
                mtime: stat.mtimeMs,
              });
            }
          } catch {}
        }
      } catch {}
    };
    scanOutputDir(OUTS);
    recentOutputs.sort((a, b) => b.mtime - a.mtime);
  }

  // Recent runs in last 12h. 之前留 'degraded' 是想展示 fallback，但 degraded 是
  // fallback 中间态，没对应 worker-log entry，UI 显示一行无 did 的"work"是噪音。
  // fallback 信息已在 success entry header（task:work | fallback:codex-cli->claude-cli），
  // 这里只保留真正落地的 success/failed。
  const allRuns = getRecentRuns(80);
  const TERMINAL = new Set(['success', 'failed']);
  const recentRuns = allRuns
    .filter(r => r && TERMINAL.has(r.status) && r.finished_at && new Date(r.finished_at).getTime() >= twelveHoursAgo)
    .slice(0, 10)
    .map(r => {
      const taskId = r.taskId || r.plugin_name || r.task;
      const bullets = getWorkerLogEntry({ host: r.host, task: r.plugin_name, finishedAt: r.finished_at });
      return {
        agent: r.agent,
        taskId,
        endTime: r.finished_at,
        duration: r.duration_ms,
        status: r.status,
        did: summarizeBullets(bullets),
        bullets: bullets || [],
      };
    });

  // Section 3: 今日日程 — cards deferred_until today or due_date today
  const allActive = loadCards({ status: 'active' });
  const todaySchedule = allActive
    .filter(c => String(c.deferred_until || '') === todayStr || String(c.due_date || '') === todayStr)
    .map(c => ({ filename: c.filename, title: c.title, priority: c.priority, type: c.type, due_date: c.due_date, deferred_until: c.deferred_until }));

  // Section 4: 卡住的 — external blockers >3d, in_review >2d, failed runs
  const stuckItems = [];
  for (const card of allActive) {
    const b = String(card.blocked_on || '');
    const createdMs = card.created ? new Date(card.created).getTime() : now;
    const staleDays = Math.max(0, Math.floor((now - createdMs) / 86400000));

    if ((b.toLowerCase().includes('external-person') || b.toLowerCase().includes('external_person')) && staleDays >= 3) {
      stuckItems.push({ filename: card.filename, title: card.title, priority: card.priority, reason: '外部等待 ' + staleDays + 'd', staleDays });
    } else if (card.status === 'in_review' && staleDays >= 2) {
      stuckItems.push({ filename: card.filename, title: card.title, priority: card.priority, reason: 'In review ' + staleDays + 'd', staleDays });
    }
  }
  const failedAgentSet = {};
  for (const r of allRuns) {
    if (r && r.status === 'failed' && !failedAgentSet[r.agent]) {
      failedAgentSet[r.agent] = r;
    }
  }
  for (const [agent, run] of Object.entries(failedAgentSet)) {
    stuckItems.push({ type: 'run-failure', agent, taskId: run.taskId, endTime: run.endTime, reason: '运行失败', staleDays: 0 });
  }
  stuckItems.sort((a, b) => (b.staleDays || 0) - (a.staleDays || 0));

  // Pi card queue — execution-facing derived queue, not raw active/inbox cards.
  const piCardQueue = buildPiExecutionQueue(5);

  return { todayItems, recentOutputs, recentRuns, todaySchedule, stuckItems, piCardQueue };
}

// ── Full-text Search ──────────────────────────────────

function searchFullText(query, opts = {}) {
  if (!query || !query.trim()) return [];
  const { spawnSync } = require('child_process');
  const limit = opts.limit || 20;

  // Determine which paths to search
  const searchPaths = [
    path.join(VAULT_PATH, 'Cards'),
    path.join(VAULT_PATH, 'Pi', 'Output'),
  ];

  const results = [];

  // Try rg first, fall back to manual scan
  const rgResult = spawnSync('rg', [
    '--case-sensitive', '-i',
    '--line-number',
    '--max-count', '3',        // max 3 matches per file
    '--no-heading',
    '--with-filename',
    '--glob', '*.md',
    query,
    ...searchPaths
  ], { encoding: 'utf-8', timeout: 5000 });

  if (rgResult.status === 0 || rgResult.stdout) {
    const lines = (rgResult.stdout || '').split('\n').filter(Boolean);
    const seenFiles = new Map(); // file → [snippets]
    for (const line of lines) {
      // Format: /path/to/file.md:lineNum:content
      const m = line.match(/^(.+?\.md):(\d+):(.*)$/);
      if (!m) continue;
      const [, filePath, lineNum, content] = m;
      if (!seenFiles.has(filePath)) seenFiles.set(filePath, []);
      seenFiles.get(filePath).push({ line: parseInt(lineNum), text: content.trim() });
    }

    for (const [filePath, snippets] of seenFiles) {
      let title = path.basename(filePath, '.md');
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        try {
          const parsed = matter(raw);
          if (parsed.data && parsed.data.title) title = parsed.data.title;
          else {
            const mh = raw.match(/^#\s+(.+)$/m);
            if (mh) title = mh[1].trim();
          }
        } catch {
          const mh = raw.match(/^#\s+(.+)$/m);
          if (mh) title = mh[1].trim();
        }
      } catch {}

      const relPath = path.relative(VAULT_PATH, filePath);
      const inCards = relPath.startsWith('Cards/');
      results.push({
        path: relPath,
        filename: path.basename(filePath, '.md'),
        title,
        kind: inCards ? 'card' : 'output',
        snippets: snippets.slice(0, 3),
      });
      if (results.length >= limit) break;
    }
  } else {
    // Fallback: simple in-memory scan of card titles + filenames
    const cards = loadCards({ status: 'inbox' }).concat(loadCards({ status: 'active' }));
    const q = query.toLowerCase();
    for (const card of cards) {
      if ((card.title || '').toLowerCase().includes(q) || (card.filename || '').toLowerCase().includes(q)) {
        results.push({ path: 'Cards/active/' + card.filename + '.md', filename: card.filename, title: card.title, kind: 'card', snippets: [] });
        if (results.length >= limit) break;
      }
    }
  }

  return results;
}

// ── Pi Suggestions (Rule Engine) ────────────────────

function getPiSuggestions(opts = {}) {
  const now = Date.now();
  const todayStr = localDateStr();
  const allActive = loadCards({ status: 'active' });
  const suggestions = [];

  for (const card of allActive) {
    const b = String(card.blocked_on || '');
    const createdMs = card.created ? new Date(card.created).getTime() : now;
    const updatedMs = card.mtime ? card.mtime * 1000 : createdMs;
    const staleDays = Math.max(0, Math.floor((now - updatedMs) / 86400000));
    const ageDays = Math.max(0, Math.floor((now - createdMs) / 86400000));

    // A1: 长时间没动 + blocked_on 是已解决的引用
    if (staleDays >= 7 && b && !b.toLowerCase().includes('owner-') && !b.toLowerCase().includes('external-person')) {
      suggestions.push({
        id: 'stale-' + card.filename,
        kind: 'card',
        targetFilename: card.filename,
        title: card.title,
        type: 'stale',
        message: `${staleDays} 天未更新，blocked_on 可能已过时，考虑归档或解锁`,
        action: 'archive',
        priority: card.priority,
      });
      continue;
    }

    // A2: in_review 超过 5 天
    if (card.status === 'in_review' && staleDays >= 5) {
      suggestions.push({
        id: 'review-overdue-' + card.filename,
        kind: 'card',
        targetFilename: card.filename,
        title: card.title,
        type: 'review-overdue',
        message: `In review ${staleDays} 天，是否需要返工或重新确认验收标准？`,
        action: 'rework',
        priority: card.priority,
      });
      continue;
    }

    // A3: parent 已归档但自身还在 active
    if (card.parent) {
      const parentPath = findCardPath(card.parent);
      if (!parentPath) {
        const archiveDir = CARDS_DIRS.archive;
        const archivePath = path.join(archiveDir, card.parent + '.md');
        if (fs.existsSync(archivePath)) {
          suggestions.push({
            id: 'orphan-parent-' + card.filename,
            kind: 'card',
            targetFilename: card.filename,
            title: card.title,
            type: 'orphan-parent',
            message: `父卡片 ${card.parent} 已归档，这张还在 active，要一起归档吗？`,
            action: 'archive',
            priority: card.priority,
          });
          continue;
        }
      }
    }
  }

  // B1: outputs without related card
  try {
    const outs = loadOutputs();
    const cardFilenames = new Set(allActive.map(c => c.filename));
    for (const o of outs.slice(0, 100)) {
      if (!o.relatedCard && !o.read) {
        suggestions.push({
          id: 'output-no-card-' + o.id,
          kind: 'output',
          targetId: o.id,
          title: o.title,
          type: 'output-no-card',
          message: '这份产出没有关联卡片，要建一张跟踪卡吗？',
          action: 'create-card',
          priority: 3,
        });
        if (suggestions.filter(s => s.type === 'output-no-card').length >= 3) break;
      }
    }
  } catch {}

  // Sort by priority
  suggestions.sort((a, b) => (a.priority || 5) - (b.priority || 5));
  return suggestions.slice(0, opts.limit || 20);
}

// ── Outputs ─────────────────────────────────────────
//
// 两个数据源（产出路径架构迁移中的共存状态）：
//   A. Legacy：Pi/Output/<cat>/**     — pi/radar/life 等还往这里写（旧 prompt 未改）
//   B. Agent workspace：Pi/Agents/<id>/workspace/** — 新 agent 产出归宿
//
// Output id 格式（稳定，兼容历史 read-status/bookmarks）：
//   - Legacy：'{cat}/xxx.md'            例如 'radar/radar-mo87zaos/2026-04-19.md'
//   - Agent： '@{agentId}/{relPath}'    例如 '@radar/big-thing-daily-scan/2026-04-19.md'
// '@' 前缀避免与任何 legacy cat（radar|content|intel|...）冲突。

const OUTPUTS_DIR = path.join(VAULT_PATH, 'Pi', 'Output');
const READ_STATUS_FILE = path.join(OUTPUTS_DIR, '.read-status.json');
const BOOKMARKS_FILE = path.join(OUTPUTS_DIR, '.output-bookmarks.json');

const SKIP_NAMES = new Set(['README.md', '.DS_Store', '.read-status.json', '.output-bookmarks.json']);
const SKIP_DIRS = new Set(['scan-state', '__pycache__', 'xhs-drafts']);

// Legacy category → 真正写入的 agent id（按 pios.yaml public_write 声明与现存数据推断）
const LEGACY_CAT_TO_AGENT = {
  radar: 'radar',
  content: 'pi',
  infra: 'pi',
  health: 'life',
  relational: 'pi',
  intel: 'pi',
};
const LEGACY_CATS = Object.keys(LEGACY_CAT_TO_AGENT);

// maintenance 目录存在但没有 manifest agent 条目（是 pi 的 task），归 pi
const ORPHAN_WORKSPACE_TO_AGENT = { maintenance: 'pi' };

function _getAgentWorkspaces() {
  // 返回 [{ agentId, absPath, category }] — 只含 manifest 里活的 agent
  const manifestAgents = _readManifestAgents() || {};
  const out = [];
  for (const [agentId, cfg] of Object.entries(manifestAgents)) {
    const wsRel = cfg?.capabilities?.workspace;
    if (!wsRel) continue;
    const absPath = path.isAbsolute(wsRel) ? wsRel : path.join(VAULT_PATH, wsRel);
    out.push({ agentId, absPath, category: cfg.category || 'other' });
  }
  return out;
}

function _getAgentCategory(agentId) {
  const manifestAgents = _readManifestAgents() || {};
  return manifestAgents[agentId]?.category || 'other';
}

// 将 output id 解析为 { absPath, source, agentId, relPath }
function _resolveOutputPath(outputId) {
  if (!outputId) return null;
  if (outputId.startsWith('@')) {
    const rest = outputId.slice(1);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const agentId = rest.slice(0, slash);
    const relPath = rest.slice(slash + 1);
    const absPath = path.join(AGENTS_DIR, agentId, 'workspace', relPath);
    return { absPath, source: 'agent', agentId, relPath };
  }
  // Legacy
  const absPath = path.join(OUTPUTS_DIR, outputId);
  const parts = outputId.split('/');
  const cat = parts[0] || '';
  return { absPath, source: 'legacy', agentId: LEGACY_CAT_TO_AGENT[cat] || null, relPath: outputId };
}

function _loadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return {}; }
}
function _saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function _buildCardLookup() {
  const lookup = {};
  for (const status of ['active', 'inbox', 'archive']) {
    const dir = CARDS_DIRS[status];
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const card = parseCard(path.join(dir, f));
      if (card) lookup[card.filename] = card;
    }
  }
  return lookup;
}

function loadOutputs(category) {
  const readStatus = _loadJson(READ_STATUS_FILE);
  const bookmarks = _loadJson(BOOKMARKS_FILE);
  const cardLookup = _buildCardLookup();

  // Build output_dir reverse map (from cards that declare their own output_dir)
  const outputDirMap = {};
  for (const [cid, cdata] of Object.entries(cardLookup)) {
    const od = cdata.output_dir || cdata.cron_output_dir;
    if (od && !cardLookup[od]) outputDirMap[od] = cdata;
  }

  // Build task-id → {agent, taskId} map so outputs generated by scheduled tasks
  // (which live in pios.yaml, not in Cards/) can still show an owner badge.
  // Convention: an output under `content/daily-scripts/xxx.md` is owned by the
  // task whose id == subdir name ("daily-scripts").
  const taskOwnerMap = {};
  try {
    const taskList = loadTasks();
    for (const t of taskList) {
      if (t && t.taskId) taskOwnerMap[t.taskId] = { taskId: t.taskId, agent: t.agent || '' };
    }
  } catch {}

  const outputs = [];

  // Walk one root dir, emit output items with stable id (via idFromRel).
  // sourceInfo: { source: 'legacy'|'agent', defaultAgentId, defaultCategoryLabel }
  const walkRoot = (rootDir, idFromRel, sourceInfo) => {
    if (!fs.existsSync(rootDir)) return;
    const scanDir = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          scanDir(path.join(dir, entry.name));
          continue;
        }
        if (!entry.name.endsWith('.md') || SKIP_NAMES.has(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const stat = fs.statSync(filePath);
          let title = path.basename(entry.name, '.md');
          let frontmatter = {};
          let body = raw;

          try {
            const parsed = matter(raw);
            frontmatter = parsed.data || {};
            body = parsed.content;
            if (frontmatter.title) title = frontmatter.title;
          } catch {}

          if (!frontmatter.title) {
            const m = body.match(/^#\s+(.+)$/m);
            if (m) title = m[1].trim();
          }

          // relPath = path relative to rootDir; used for subdir matching below.
          // Legacy source: relPath starts with '<cat>/...' (rootDir = OUTPUTS_DIR).
          // Agent source:  relPath is relative to workspace/ (rootDir = .../workspace).
          const relPath = path.relative(rootDir, filePath);
          const outputId = idFromRel(relPath);
          const track = frontmatter.track || null;

          // Find related card
          let relatedCard = null;
          const stem = path.basename(entry.name, '.md');
          for (const folder of ['active', 'inbox', 'archive']) {
            if (CARDS_DIRS[folder] && fs.existsSync(path.join(CARDS_DIRS[folder], stem + '.md'))) {
              relatedCard = stem;
              break;
            }
          }

          // Derive the owning card (task or project) and the top-level project.
          let project = null;
          const _findCardByName = (name) => {
            if (!name) return null;
            if (cardLookup[name]) return cardLookup[name];
            if (outputDirMap[name]) return outputDirMap[name];
            for (const [cid, cdata] of Object.entries(cardLookup)) {
              if (cid === name || cid.startsWith(name + '-')) return cdata;
            }
            return null;
          };

          if (!relatedCard && frontmatter.related_card) {
            if (cardLookup[frontmatter.related_card]) relatedCard = frontmatter.related_card;
          }
          if (!relatedCard && frontmatter.card) {
            if (cardLookup[frontmatter.card]) relatedCard = frontmatter.card;
          }

          if (!relatedCard && track) {
            const ci = _findCardByName(track);
            if (ci) {
              relatedCard = ci.id || ci.filename || track;
              if (ci.parent) project = ci.parent;
            }
          }

          if (!project && relatedCard) {
            const ci = cardLookup[relatedCard];
            if (ci && ci.parent) project = ci.parent;
          }

          // Path subdir → card. Legacy relPath = '<cat>/<subdir?>/<file>',
          // agent relPath = '<subdir?>/<file>' (relative to workspace/).
          const parts = relPath.split(path.sep);
          let ownerTask = null;
          let subdirLabel = null;
          let subdir = null;
          if (sourceInfo.source === 'legacy' && parts.length >= 3) subdir = parts[1];
          else if (sourceInfo.source === 'agent' && parts.length >= 2) subdir = parts[0];
          if (subdir) {
            subdirLabel = subdir;
            if (!relatedCard) {
              const ci = _findCardByName(subdir);
              if (ci) {
                relatedCard = ci.id || ci.filename || subdir;
                if (ci.parent) project = ci.parent;
              }
            }
            if (!relatedCard && taskOwnerMap[subdir]) ownerTask = taskOwnerMap[subdir];
          }
          if (!relatedCard && frontmatter.taskId && taskOwnerMap[frontmatter.taskId]) {
            ownerTask = taskOwnerMap[frontmatter.taskId];
          }

          let relatedCardType = null;
          let relatedCardTitle = null;
          if (relatedCard) {
            const rc = cardLookup[relatedCard] || outputDirMap[relatedCard];
            if (rc) {
              relatedCardType = rc.type || 'task';
              relatedCardTitle = rc.title || null;
            }
          }
          let projectTitle = null;
          if (project) {
            const pc = cardLookup[project];
            if (pc) projectTitle = pc.title || null;
          }

          // Resolve final agentId: frontmatter override → source default
          const fmAgent = (typeof frontmatter.agent === 'string' && frontmatter.agent.trim()) || null;
          const agentId = fmAgent || sourceInfo.defaultAgentId || null;
          const agentCategory = agentId ? _getAgentCategory(agentId) : 'other';

          const bm = bookmarks[outputId] || {};
          outputs.push({
            id: outputId,
            filename: stem,
            title,
            category: sourceInfo.defaultCategoryLabel,
            source: sourceInfo.source,
            agentId,
            agentCategory,
            track,
            project,
            relatedCard,
            relatedCardType,
            relatedCardTitle,
            projectTitle,
            ownerTask,
            subdirLabel,
            mtime: stat.mtime.getTime(),
            modified: stat.mtime.toISOString(),
            size: raw.length,
            read: !!readStatus[outputId],
            bookmarked: !!bm.bookmarked,
            tags: bm.tags || [],
            _preview: body.substring(0, 300),
          });
        } catch {}
      }
    };
    scanDir(rootDir);
  };

  // Source A: legacy Pi/Output/<cat>/**
  const legacyCats = category ? [category].filter(c => LEGACY_CATS.includes(c)) : LEGACY_CATS;
  for (const cat of legacyCats) {
    const catDir = path.join(OUTPUTS_DIR, cat);
    walkRoot(
      catDir,
      (rel) => path.join(cat, rel).split(path.sep).join('/'),
      { source: 'legacy', defaultAgentId: LEGACY_CAT_TO_AGENT[cat], defaultCategoryLabel: cat }
    );
  }

  // Source B: agent workspaces Pi/Agents/<id>/workspace/**
  // If a category filter is given and matches a legacy cat, skip agent source
  // (callers asking for cat-specific outputs expect legacy semantics).
  if (!category) {
    for (const { agentId, absPath, category: agentCat } of _getAgentWorkspaces()) {
      walkRoot(
        absPath,
        (rel) => '@' + agentId + '/' + rel.split(path.sep).join('/'),
        { source: 'agent', defaultAgentId: agentId, defaultCategoryLabel: agentCat }
      );
    }
    // Orphan workspace dirs (have disk but no manifest agent entry — e.g. maintenance/ is a pi task)
    for (const [orphanDir, impersonateAgent] of Object.entries(ORPHAN_WORKSPACE_TO_AGENT)) {
      const absPath = path.join(AGENTS_DIR, orphanDir, 'workspace');
      if (!fs.existsSync(absPath)) continue;
      walkRoot(
        absPath,
        (rel) => '@' + impersonateAgent + '/' + orphanDir + '/' + rel.split(path.sep).join('/'),
        { source: 'agent', defaultAgentId: impersonateAgent, defaultCategoryLabel: _getAgentCategory(impersonateAgent) }
      );
    }
  }

  outputs.sort((a, b) => b.mtime - a.mtime);
  return outputs;
}

function readOutput(outputId) {
  const resolved = _resolveOutputPath(outputId);
  if (!resolved) return null;
  try {
    const raw = fs.readFileSync(resolved.absPath, 'utf-8');
    try {
      const parsed = matter(raw);
      return { id: outputId, content: parsed.content, frontmatter: parsed.data || {} };
    } catch {
      return { id: outputId, content: raw, frontmatter: {} };
    }
  } catch {
    return null;
  }
}

function markOutputRead(outputId, read) {
  const status = _loadJson(READ_STATUS_FILE);
  status[outputId] = read;
  _saveJson(READ_STATUS_FILE, status);
}

function markAllOutputsRead() {
  const outputs = loadOutputs();
  const status = _loadJson(READ_STATUS_FILE);
  for (const o of outputs) status[o.id] = true;
  _saveJson(READ_STATUS_FILE, status);
  return outputs.length;
}

function toggleOutputBookmark(outputId) {
  const bm = _loadJson(BOOKMARKS_FILE);
  const entry = bm[outputId] || { bookmarked: false, tags: [] };
  entry.bookmarked = !entry.bookmarked;
  bm[outputId] = entry;
  _saveJson(BOOKMARKS_FILE, bm);
  return entry.bookmarked;
}

function tagOutput(outputId, tags) {
  // tags: array of strings, or comma-separated string
  let list = [];
  if (Array.isArray(tags)) list = tags;
  else if (typeof tags === 'string') list = tags.split(/[,，\s]+/).filter(Boolean);
  // Dedupe + trim
  const seen = new Set();
  list = list.map(t => String(t).trim()).filter(t => {
    if (!t || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  const bm = _loadJson(BOOKMARKS_FILE);
  const entry = bm[outputId] || { bookmarked: false, tags: [] };
  entry.tags = list;
  bm[outputId] = entry;
  _saveJson(BOOKMARKS_FILE, bm);
  return entry.tags;
}

function commentOutput(outputId, comment) {
  const resolved = _resolveOutputPath(outputId);
  if (!resolved || !fs.existsSync(resolved.absPath)) return null;
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let text = fs.readFileSync(resolved.absPath, 'utf-8');
  text += `\n\n---\n> **Owner (${timestamp})**: ${comment}\n`;
  fs.writeFileSync(resolved.absPath, text);

  // Create follow-up card
  const stem = path.basename(resolved.absPath, '.md');
  const cardName = `followup-${stem}`;
  const cardPath = path.join(CARDS_DIRS.inbox, cardName + '.md');
  const today = localDateStr();
  const sourceRel = path.relative(VAULT_PATH, resolved.absPath).split(path.sep).join('/');
  if (fs.existsSync(cardPath)) {
    let existing = fs.readFileSync(cardPath, 'utf-8');
    existing += `\n\n> **Owner (${timestamp})**: ${comment}\n`;
    fs.writeFileSync(cardPath, existing);
  } else {
    const content = `---\ntype: task\nstatus: inbox\npriority: 3\ncreated: ${today}\n---\n\n# Follow up: ${stem}\n\nOwner commented on \`${outputId}\`:\n\n> ${comment}\n\n**Source**: \`${sourceRel}\`\n**Action**: Review owner's comment and follow up accordingly.\n`;
    fs.writeFileSync(cardPath, content);
  }
  return cardName;
}

// ── Direction heat scoring ────────────────────────────────────
//
// Computes "recent investment" score per card for the Direction Tab heat view.
// The score is attributed *per card*; the frontend walks the parent chain to
// roll up into root-project totals (heat bar) and any-node subtree totals
// (row-level 🔥 chip).
//
// Signals (v1 — calibrate later):
//   • Work History bullet dated within window        → +1 each
//     (parses `### YYYY-MM-DD —` subheaders under `## Work History` /
//      `## 工作记录`; falls back to inline `- YYYY-MM-DD` bullets for
//      cards that don't use subheaders)
//   • Card created within window                     → +1
//   • Card in archive/ bucket with mtime in window   → +3 (completion event)
//
// Archived projects/tasks ARE included — a project finished this week is the
// PEAK investment signal, not noise. Decay happens naturally next window.
//
// Quick filter: skip cards whose mtime is outside the window AND whose
// created date is outside the window — nothing they could contribute is in
// range. Saves most of the file reads.
function _countRecentWorkBullets(content, cutoffStr) {
  // Locate Work History section (English or Chinese heading, any trailing text)
  const whMatch = content.match(/##\s+(?:Work History|工作记录)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!whMatch) return 0;
  const section = whMatch[1];

  let count = 0;
  let currentInWindow = false;
  let seenSubheader = false;

  for (const line of section.split('\n')) {
    // Date subheader: ### 2026-04-17 — topic  (or any trailing chars)
    const h = line.match(/^###\s+(\d{4}-\d{2}-\d{2})/);
    if (h) {
      seenSubheader = true;
      currentInWindow = h[1] >= cutoffStr;
      continue;
    }
    // Bullets under a subheader count if the subheader is in window
    if (seenSubheader) {
      if (currentInWindow && /^\s*[-*+]\s+\S/.test(line)) count++;
      continue;
    }
    // Fallback: card uses flat format without subheaders, e.g.
    //   - 2026-04-17: did xyz
    //   - [2026-04-17] did xyz
    const d = line.match(/^\s*[-*+]\s*\[?(\d{4}-\d{2}-\d{2})\]?/);
    if (d && d[1] >= cutoffStr) count++;
  }

  return count;
}

function computeDirectionHeat(windowDays = 7) {
  const win = Math.max(1, Math.min(365, Number(windowDays) || 7));
  const nowMs = Date.now();
  const cutoffMs = nowMs - win * 24 * 3600 * 1000;
  const cutoffStr = localDateStr(cutoffMs);

  const buckets = ['inbox', 'active', 'archive'];
  const cards = {};

  for (const bucket of buckets) {
    const dir = CARDS_DIRS[bucket];
    if (!dir || !fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { continue; }

    for (const file of files) {
      const fullPath = path.join(dir, file);
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      const mtimeInWindow = stat.mtimeMs >= cutoffMs;

      let raw;
      try { raw = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
      let fm, content;
      try { ({ data: fm, content } = matter(raw)); } catch { continue; }

      const createdRaw = fm.created;
      const createdStr = typeof createdRaw === 'string'
        ? createdRaw.slice(0, 10)
        : (createdRaw instanceof Date ? localDateStr(createdRaw.getTime()) : '');
      const createdInWindow = createdStr && createdStr >= cutoffStr;

      // Quick filter: if neither mtime nor created date is in window, nothing
      // this card can contribute is in range.
      if (!mtimeInWindow && !createdInWindow) continue;

      const bullets = _countRecentWorkBullets(content, cutoffStr);
      const completed = bucket === 'archive' && mtimeInWindow;

      const score = bullets + (createdInWindow ? 1 : 0) + (completed ? 3 : 0);
      if (score === 0) continue;

      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : path.basename(file, '.md');

      cards[path.basename(file, '.md')] = {
        filename: path.basename(file, '.md'),
        title,
        type: fm.type || 'task',
        parent: fm.parent || null,
        goal: fm.goal || null,
        folder: bucket,
        status: fm.status || 'active',
        bullets,
        created_in_window: !!createdInWindow,
        completed,
        score,
      };
    }
  }

  return { window_days: win, cutoff: cutoffStr, cards };
}

function approvePermission(filename) {
  const found = findCardPath(filename);
  if (!found) return { ok: false, error: 'Card not found' };
  try {
    const raw = fs.readFileSync(found.path, 'utf-8');
    const { data: fm, content } = matter(raw);
    const req = fm.permission_request;
    if (!req || !req.agent || !req.rule)
      return { ok: false, error: 'No valid permission_request in card' };

    const runtime = req.runtime || 'claude-cli';
    const manifestPath = path.join(VAULT_PATH, 'Pi', 'Config', 'pios.yaml');
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    const agentCfg = manifest.agents?.[req.agent];
    if (!agentCfg) return { ok: false, error: `Agent "${req.agent}" not found in pios.yaml` };

    const perms = agentCfg.configs?.[runtime]?.permissions;
    if (!perms) return { ok: false, error: `No configs.${runtime}.permissions for "${req.agent}"` };
    if (!Array.isArray(perms.allow)) perms.allow = [];

    const alreadyExists = perms.allow.includes(req.rule);
    if (!alreadyExists) {
      perms.allow.push(req.rule);
      atomicWriteFile(manifestPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
    }

    delete fm.needs_owner;
    delete fm.needs_owner_brief;
    delete fm.response_type;
    delete fm.permission_request;
    delete fm.claimed_by;
    fm.status = 'done';
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const log = `\n\n## 权限批准记录（${ts}）\n\n` +
      `Owner 一键批准，已写入 \`${req.agent}\` allow 规则：\n\`\`\`\n- ${req.rule}\n\`\`\`` +
      (alreadyExists ? '\n\n（规则已存在，跳过重复写入）' : '');
    const updated = matter.stringify(content + log, fm);
    fs.writeFileSync(found.path, updated, 'utf-8');
    moveCard(filename, 'archive');

    return { ok: true, agent: req.agent, runtime, rule: req.rule, wasNew: !alreadyExists };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  VAULT_PATH,
  AGENTS_DIR,
  loadAgents,
  getAgent,
  getAgentWorkspace,
  updateAgentStatus,
  createAgent,
  deleteAgent,
  retireAgent,
  getAgentRetireStats,
  spawnAgent,
  generateCrontab,
  syncCrontab,
  loadPlugins,
  loadCards,
  getAgentCards,
  getProjects,
  getDecisionQueue,
  getOwnerQueue,
  getPiOverview,
  getAgentTokenStats,
  getAgentLatestRuns,
  classifyActiveCards,
  getMyTodos,
  getSystemOverview,
  readCard,
  updateCardFrontmatter,
  resolveDecision,
  approveDecision,
  approvePermission,
  respondToOwner,
  undoOwnerResponse,
  dismissCard,
  acknowledgeAction,
  skipCard,
  approveReview,
  reworkReview,
  deferCard,
  moveCard,
  createCard,
  restoreCard,
  findCardPath,
  getRecentRuns,
  getAgentRuns,
  getAgentLog,
  getServices,
  checkServiceHealth,
  checkAllServices,
  getHealthReport,
  getPipelineFreshness,
  // Task management
  loadTasks,
  getTask,
  createTask,
  updateTaskMeta,
  updateTaskPrompt,
  deleteTask,
  resolvePreferredHost,
  spawnTask,
  getTaskRuns,
  getSessionConversation,
  // Outputs
  loadOutputs,
  readOutput,
  markOutputRead,
  markAllOutputsRead,
  toggleOutputBookmark,
  tagOutput,
  commentOutput,
  appendDevAction,
  subscribeChanges,
  buildEvents,
  // Briefing + Search + Suggestions
  getDailyBriefing,
  searchFullText,
  getPiSuggestions,
  // Direction heat (recent investment)
  computeDirectionHeat,
};

// ── File Watcher (real-time change stream) ──────────────────
//
// Watches Cards/ + Pi/Output/ (legacy) + Pi/Agents/<id>/workspace/ (agent source)
// for .md changes, invokes the callback with a compact change event. Used by
// main.js /pios/events SSE endpoint to push updates without polling.
//
// Filename convention in callback (kind='output' only):
//   legacy source: '<cat>/xxx.md'        (stable key == loadOutputs id)
//   agent source:  '@<agentId>/xxx.md'   (stable key == loadOutputs id)
//
// Notes:
//   - Uses fs.watch recursive option (works on macOS/Windows; Linux would need chokidar)
//   - Syncthing temp files (.syncthing.xxx.tmp, ~xxx) are filtered out
//   - Non-.md files are ignored
//   - Each caller gets its own watcher chain — not multiplexed
function subscribeChanges(cb) {
  const watchers = [];
  const watchDir = (dir, kind, filenamePrefix = '') => {
    if (!fs.existsSync(dir)) return;
    try {
      const w = fs.watch(dir, { recursive: true, persistent: false }, (eventType, filename) => {
        if (!filename) return;
        // Ignore hidden + temp + Syncthing staging files
        const base = path.basename(filename);
        if (base.startsWith('.') || base.startsWith('~')) return;
        if (filename.includes('.syncthing.') || filename.includes('.tmp')) return;
        if (!filename.endsWith('.md')) return;
        // Normalize to forward slashes so downstream id-matching works on all platforms
        const normalized = filename.split(path.sep).join('/');
        const outName = filenamePrefix ? filenamePrefix + normalized : normalized;
        try {
          cb({ kind, event: eventType, filename: outName, dir });
        } catch {}
      });
      watchers.push(w);
    } catch (e) {
      console.warn('[pios-engine] subscribeChanges watch failed:', dir, e.message);
    }
  };

  watchDir(CARDS_DIRS.inbox, 'card');
  watchDir(CARDS_DIRS.active, 'card');
  watchDir(CARDS_DIRS.archive, 'card');
  // Legacy outputs root
  watchDir(OUTPUTS_DIR, 'output');
  // Agent workspaces — prefix filename with '@<agentId>/' to stay consistent with loadOutputs id
  for (const { agentId, absPath } of _getAgentWorkspaces()) {
    watchDir(absPath, 'output', `@${agentId}/`);
  }
  for (const [orphanDir, impersonateAgent] of Object.entries(ORPHAN_WORKSPACE_TO_AGENT)) {
    const absPath = path.join(AGENTS_DIR, orphanDir, 'workspace');
    watchDir(absPath, 'output', `@${impersonateAgent}/${orphanDir}/`);
  }

  return () => {
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
}

// ── Pi Stream Toast: attribution from dev-actions-*.jsonl ──────────────────

function appendDevAction(event = {}) {
  try {
    fs.mkdirSync(path.dirname(DEV_ACTIONS_FILE), { recursive: true });
    const payload = { ...event, ts: formatLocalTimestamp() };
    fs.appendFileSync(DEV_ACTIONS_FILE, JSON.stringify(payload, null, 0) + '\n', 'utf-8');
    return { ok: true, path: DEV_ACTIONS_FILE };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function readDevActionsTail(maxLines = 100) {
  try {
    const txt = fs.readFileSync(DEV_ACTIONS_FILE, 'utf-8').trim();
    if (!txt) return [];
    return txt.split('\n').slice(-maxLines).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const AGENT_HUE = {
  'pi-triage': 'cyan',
  'sense-maker': 'violet',
  'cron': 'amber',
  'pipeline': 'amber',
  'sentinel': 'amber',
  'auth-health-check': 'amber',
  'codex-worker': 'orange',
  'manual': 'gold',
};

function agentHue(agent) {
  return AGENT_HUE[agent] || 'gray';
}

const AGENT_LABEL = {
  'pi-triage': 'Pi',
  'sense-maker': 'Sense',
  'cron': 'Cron',
  'pipeline': 'Pipeline',
  'sentinel': 'Sentinel',
  'auth-health-check': 'Auth',
  'codex-worker': 'Codex',
  'manual': 'Manual',
};

function agentLabel(agent) {
  return AGENT_LABEL[agent] || 'Pi';
}

const TYPE_DISPLAY = {
  change: { icon: '✍', verb: '修改', dwell: 5200 },
  verify: { icon: '✓', verb: '验证通过', dwell: 5200 },
  commit: { icon: '📦', verb: '提交', dwell: 5200 },
  rollback: { icon: '↶', verb: '回滚', dwell: 6500 },
  gate: { icon: '🚦', verb: '闸门通过', dwell: 5200 },
};

function typeDisplay(type, result) {
  const base = TYPE_DISPLAY[type] || { icon: '·', verb: '已同步', dwell: 5200 };
  if (type === 'verify' && result === 'fail') return { icon: '✗', verb: '验证失败', dwell: 6500 };
  if (type === 'gate' && result === 'fail') return { icon: '⛔', verb: '闸门未通过', dwell: 6500 };
  return base;
}

function buildEvents(cardStems) {
  const log = readDevActionsTail(100);
  const nowMs = Date.now();
  return cardStems.map(stem => {
    const card = readCard(stem);
    const cardTitle = card?.title || stem;
    const hit = [...log].reverse().find((entry) => {
      if (entry.card !== stem || !entry.ts) return false;
      const tsMs = Date.parse(entry.ts);
      return Number.isFinite(tsMs) && (nowMs - tsMs) <= 5000;
    });
    if (hit) {
      const agent = hit.agent || 'unknown';
      const display = typeDisplay(hit.type, hit.result);
      return {
        id: `pst_${hit.ts}_${stem}_${hit.type || 'sync'}`,
        agent,
        agent_label: agentLabel(agent),
        hue: agentHue(agent),
        card: stem,
        card_title: cardTitle,
        card_dir: hit.dir || 'active',
        icon: display.icon,
        verb: display.verb,
        dwell: display.dwell,
      };
    }
    return {
      id: `pst_${nowMs}_${stem}_fallback`,
      agent: 'unknown',
      agent_label: 'Pi',
      hue: 'gray',
      card: stem,
      card_title: cardTitle,
      card_dir: 'active',
      icon: '·',
      verb: '已同步',
      dwell: 5200,
    };
  });
}
