// Sense layer — 感知层（Pipeline + Radar）
// 读：从 pios.yaml sense.* 读元数据 + 通过 task_ref 合并运行时
// 写：toggle / editConfig / installRadar（原子写 pios.yaml：tmp + rename）

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const matter = require('gray-matter');
const VAULT_ROOT = require('./vault-root');
const { writeAtomic } = require('./lib/atomic-write');

const YAML_PATH = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
const RADARS_DIR = path.join(VAULT_ROOT, 'Pi', 'Radars');

// ── 低层：原子读写 ────────────────────────────────────────
function loadManifest() {
  return yaml.load(fs.readFileSync(YAML_PATH, 'utf-8'));
}

function saveManifestAtomic(data) {
  const dumped = yaml.dump(data, { lineWidth: 200, sortKeys: false, noRefs: true, quotingType: "'", forceQuotes: false });
  writeAtomic(YAML_PATH, dumped);
}

// ── 读 ────────────────────────────────────────
function loadSense(loadTasksFn) {
  let manifest;
  try { manifest = loadManifest(); } catch (e) { return { pipelines: [], radars: [], error: e.message }; }
  const sense = manifest.sense || {};
  const tasks = (typeof loadTasksFn === 'function' ? loadTasksFn() : []) || [];
  const taskIndex = {};
  for (const t of tasks) taskIndex[`${t.agent}/${t.taskId}`] = t;

  function resolveRuntime(entry) {
    if (!entry.task_ref) return null;
    const rt = taskIndex[entry.task_ref];
    if (!rt) return { error: `task_ref not found: ${entry.task_ref}` };
    return {
      cron: rt.cron,
      hosts: rt.hosts,
      engines: rt.engines,
      nextRun: rt.nextRun,
      lastRunRecord: rt.lastRunRecord,
      description: rt.description,
      prompt: rt.prompt,
    };
  }
  function normalize(section, id, entry) {
    return {
      id, section,
      name: entry.name || id,
      icon: entry.icon || (section === 'pipelines' ? '🚰' : '🔍'),
      category_ui: entry.category_ui || 'general',
      built_in: entry.built_in !== false,
      installed: entry.installed !== false,
      enabled: entry.enabled !== false,
      source: entry.source || null,
      question: entry.question || null,
      question_ref: entry.question_ref || null,
      output: entry.output || null,
      downstream: entry.downstream || [],
      requires: entry.requires || [],
      task_ref: entry.task_ref || null,
      runner: entry.runner || null,
      project: entry.project || null,
      runtime: resolveRuntime(entry),
    };
  }
  return {
    pipelines: Object.entries(sense.pipelines || {}).map(([id, e]) => normalize('pipelines', id, e)),
    radars: Object.entries(sense.radars || {}).map(([id, e]) => normalize('radars', id, e)),
  };
}

// ── 写：toggle enabled（同步写 sense 和 agent.tasks）─────
function toggle({ section, id, enabled } = {}) {
  if (!['pipelines', 'radars'].includes(section)) throw new Error('bad section');
  if (!id) throw new Error('id required');
  enabled = !!enabled;
  const m = loadManifest();
  const entry = (m.sense && m.sense[section] && m.sense[section][id]);
  if (!entry) throw new Error(`sense.${section}.${id} not found`);
  entry.enabled = enabled;
  // 同步 agent.tasks.<tid>.enabled
  if (entry.task_ref) {
    const [ag, tid] = entry.task_ref.split('/', 2);
    if (m.agents && m.agents[ag] && m.agents[ag].tasks && m.agents[ag].tasks[tid]) {
      m.agents[ag].tasks[tid].enabled = enabled;
    }
  }
  saveManifestAtomic(m);
  return { ok: true };
}

// ── 写：editConfig（cron / question / downstream / project / icon / name / requires）──
const EDITABLE = new Set(['cron', 'question', 'downstream', 'project', 'icon', 'name', 'requires', 'description']);

function editConfig({ section, id, patch } = {}) {
  if (!['pipelines', 'radars'].includes(section)) throw new Error('bad section');
  if (!id) throw new Error('id required');
  if (!patch || typeof patch !== 'object') throw new Error('patch required');
  for (const k of Object.keys(patch)) {
    if (!EDITABLE.has(k)) throw new Error(`field not editable: ${k}`);
  }
  const m = loadManifest();
  const entry = (m.sense && m.sense[section] && m.sense[section][id]);
  if (!entry) throw new Error(`sense.${section}.${id} not found`);

  // cron → 写到 task_ref 指向的 agent.tasks.<tid>.trigger.cron
  if ('cron' in patch) {
    if (!entry.task_ref) throw new Error('cannot edit cron: no task_ref');
    const [ag, tid] = entry.task_ref.split('/', 2);
    const t = m.agents?.[ag]?.tasks?.[tid];
    if (!t) throw new Error(`task_ref resolved to non-existent task: ${entry.task_ref}`);
    t.trigger = t.trigger || {};
    t.trigger.cron = String(patch.cron).trim();
  }
  // question / description / icon / name → 直接改 sense entry
  for (const k of ['question', 'description', 'icon', 'name']) {
    if (k in patch) entry[k] = patch[k];
  }
  // downstream / requires → array
  for (const k of ['downstream', 'requires']) {
    if (k in patch) entry[k] = Array.isArray(patch[k]) ? patch[k] : [];
  }
  // project → null 或 string
  if ('project' in patch) {
    entry.project = patch.project || null;
  }
  saveManifestAtomic(m);
  return { ok: true };
}

// ── 读：output（log=读目录最近 N 文件，dashboard=读单文件）────
function readOutput({ section, id, limit = 3 } = {}) {
  if (!['pipelines', 'radars'].includes(section)) throw new Error('bad section');
  if (!id) throw new Error('id required');
  const m = loadManifest();
  const entry = m.sense?.[section]?.[id];
  if (!entry) throw new Error(`sense.${section}.${id} not found`);
  const out = entry.output || {};
  if (!out.path) return { type: out.type || 'log', files: [], content: null };

  const abs = path.isAbsolute(out.path) ? out.path : path.join(VAULT_ROOT, out.path);
  if (out.type === 'dashboard') {
    try {
      const content = fs.readFileSync(abs, 'utf-8');
      const stat = fs.statSync(abs);
      return { type: 'dashboard', path: out.path, mtime: stat.mtime.toISOString(), content };
    } catch (e) {
      return { type: 'dashboard', path: out.path, content: null, error: e.message };
    }
  }
  // log 型：找目录里最近 N 个 md
  try {
    // 若 abs 是目录
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const files = walkMd(abs).sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, Math.min(10, limit)));
      const result = files.map(f => ({
        path: path.relative(VAULT_ROOT, f.full),
        mtime: new Date(f.mtime).toISOString(),
        size: f.size,
        preview: (() => { try { return fs.readFileSync(f.full, 'utf-8').slice(0, 4000); } catch { return null; } })(),
      }));
      return { type: 'log', path: out.path, files: result };
    }
    // 若 abs 是单文件（极少见但可能）
    const content = fs.readFileSync(abs, 'utf-8');
    return { type: 'log', path: out.path, files: [{ path: out.path, mtime: stat.mtime.toISOString(), size: stat.size, preview: content.slice(0, 4000) }] };
  } catch (e) {
    return { type: out.type || 'log', path: out.path, files: [], error: e.message };
  }
}

function walkMd(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out);
    else if (e.name.endsWith('.md')) {
      try {
        const st = fs.statSync(full);
        out.push({ full, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  return out;
}

// ── 写：installRadar（用户自建）────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const RADAR_PROMPT_TEMPLATE = (opts) => `---
description: 用户自建雷达 - ${opts.name}
---

你是 ${opts.runner} agent，在运行 radar \`${opts.id}\`。

## 问题

${opts.question}

## 扫描方式

用可用工具（web-search / browser / project context）找最近 24 小时的新信号。
- 去重：已在 \`${opts.output_path}\` 之前产物里出现过的不重复
- 按相关度和价值排序，最多 10 条
${opts.project ? `\n## 关联项目\n\n绑定 project: \`${opts.project}\`。读 \`Projects/${opts.project}/DOMAIN.md\`（若存在）作为背景上下文。\n` : ''}
## 输出

写到 \`${opts.output_path}${opts.output_type === 'log' ? '{YYYY-MM-DD}.md' : ''}\`。

每条：
- **标题**
- 来源 (URL)
- 一句话摘要
- 为什么重要（与问题的相关度）

完成后输出：
\`\`\`
radar ${opts.id}: N 条新信号
\`\`\`
`;

function installRadar(spec = {}) {
  // spec: { id?, name, icon?, question, cron, project?, output_path?, output_type?, runtimes? }
  if (!spec.name) throw new Error('name required');
  if (!spec.question) throw new Error('question required');
  if (!spec.cron) throw new Error('cron required');

  const name = String(spec.name).trim().slice(0, 60);
  let id = spec.id ? slugify(spec.id) : slugify(name);
  if (!id) id = 'radar-' + Date.now().toString(36);
  const icon = spec.icon || '🔭';
  const cron = String(spec.cron).trim();
  const project = spec.project || null;
  const output_type = spec.output_type === 'dashboard' ? 'dashboard' : 'log';

  // runner 由 project 决定
  let runner = 'radar';
  if (project === 'ai-ecommerce') runner = 'hawkeye';

  // output path 默认
  let output_path = spec.output_path;
  if (!output_path) {
    output_path = project
      ? `Projects/${project}/Radar/${id}/`
      : `Pi/Output/radar/${id}/`;
  }

  // 1. 写 Pi/Radars/<id>/manifest.yaml + prompt.md
  const radarDir = path.join(RADARS_DIR, id);
  fs.mkdirSync(radarDir, { recursive: true });
  const manifestObj = {
    id, name, icon,
    question: String(spec.question),
    cron, project, runner,
    output: { type: output_type, path: output_path },
    created: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(radarDir, 'manifest.yaml'),
    yaml.dump(manifestObj, { sortKeys: false, lineWidth: 200 }), 'utf-8');
  const promptBody = RADAR_PROMPT_TEMPLATE({
    id, name, runner, question: spec.question, project,
    output_path, output_type,
  });
  const promptPath = path.join(radarDir, 'prompt.md');
  fs.writeFileSync(promptPath, promptBody, 'utf-8');

  // 2. 更新 pios.yaml：agent.tasks[runner][id] + sense.radars[id]
  const m = loadManifest();
  if (!m.agents || !m.agents[runner]) throw new Error(`runner agent ${runner} not found`);
  m.agents[runner].tasks = m.agents[runner].tasks || {};
  const relPromptPath = path.relative(path.join(VAULT_ROOT, 'Pi', 'Config'), promptPath);
  m.agents[runner].tasks[id] = {
    description: `[用户自建] ${name}`,
    enabled: true,
    host: 'laptop-host',
    prompt: relPromptPath,
    runtimes: ['claude-cli'],
    trigger: { cron },
  };

  m.sense = m.sense || {};
  m.sense.radars = m.sense.radars || {};
  if (m.sense.radars[id]) throw new Error(`radar ${id} already exists`);
  m.sense.radars[id] = {
    name, icon,
    category_ui: 'custom',
    question: String(spec.question),
    output: { type: output_type, path: output_path },
    downstream: [],
    requires: ['web-search'],
    task_ref: `${runner}/${id}`,
    runner, project,
    built_in: false, installed: true, enabled: true,
  };
  saveManifestAtomic(m);

  return { ok: true, id, runner, output_path, radar_dir: path.relative(VAULT_ROOT, radarDir) };
}

module.exports = { loadSense, toggle, editConfig, readOutput, installRadar };
