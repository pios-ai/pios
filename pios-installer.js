/**
 * PiOS Installer — 首次安装 & Vault 初始化
 *
 * 新用户打开 PiBrowser 时：
 * 1. 检测 ~/.pios/config.json 是否存在
 * 2. 不存在 → 触发 Setup 向导
 * 3. 向导收集 name / vault path / runtime / plugins
 * 4. 创建 Vault 目录结构 + pios.yaml manifest + 默认内容
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');

const PIOS_HOME = path.join(process.env.HOME, '.pios');
const CONFIG_PATH = path.join(PIOS_HOME, 'config.json');
const BUNDLED_TOOLS_DIR = path.join(__dirname, 'backend', 'tools');
const BUNDLED_CORE_DIR = path.join(__dirname, 'backend', 'plugins', 'core');

const SANITIZE_PATTERNS_EXAMPLE = `# PiOS sanitize-lint owner-specific patterns
#
# Copy this file to ~/.pios/sanitize-patterns.txt and edit it for your own
# private denylist. The real sanitize-patterns.txt file is intentionally not
# committed to any repo.
#
# Format: one "label:regex" per line, using grep -E syntax.

# real-name:Your Real Name
# home-path:/Users/yourusername
# private-hostname:\\bmymachine\\b
# private-ip:192\\.168\\.1\\.123
`;

// 只有 2 个 agent SOUL：pi (kernel) + pipeline (sense-runner)
// 不再有独立 maintenance / sense-maker agent——它们是 pi 下面的 task
const BUILTIN_AGENT_SOULS = {
  'pi': `# Pi — PiOS 核心 AI Agent

我是 Pi。你是 {owner} 的 AI，负责分诊、执行、对账、反思。

## 原则

- 先查再改
- 不删除文件
- 不改 Pi/Config/ 下系统配置
- 产出写到 Cards/ 或 Pi/Output/
`,
  'pipeline': `# 数据管道 — Data Scribe

你负责采集和整理 {owner} 的感知输入，让 PiOS 能消费最新数据。

## 原则

- 幂等
- 敏感数据只写 Vault
- 失败不阻断后续步骤，但必须记录
`,
};

const BUILTIN_TASK_PROMPTS = {
  'triage.md': `---
taskId: triage
cron: '*/15 * * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 双手。扫 ready_for_work 做一张。不决策、不对账。
agent: pi
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

你是 Pi 的 work 节奏。每次 tick 只做一张 \`ready_for_work: true\` 的卡。

## 流程

1. 运行 \`hostname\`，记录当前主机短名。
2. 扫 \`{vault}/Cards/active/*.md\` 中的 \`ready_for_work: true\`。
3. 选 mtime 最早的一张，二次确认 \`claimed_by\` 为空，再写入 \`claimed_by: work-{hostname}-{pid}\` 并清除 \`ready_for_work\`。
4. 读取卡片正文的验收标准、工作记录、Context Pack，只做一个明确推进。
5. 若改代码，必须跑最小验证并把证据写回卡片。
6. 需要 {owner} 审阅时，不直接写 \`needs_owner\`；改写 \`activity_result.proposed_needs_owner\`。
7. 本轮结束清除 \`claimed_by\`，并输出 \`- \` 开头 bullet 摘要。

## 约束

- 不改 \`BOOT.md\`、\`SOUL.md\`、\`card-spec.md\`、\`pios.yaml\`
- 不修改卡片的验收标准
- 不删除文件
- 没有 \`ready_for_work\` 就输出 \`- 动作：skip（无派发任务）\`
`,
  'maintenance.md': `---
taskId: maintenance
cron: '30 2 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 巡检系统健康、清理冗余、更新 healthcheck-report。
agent: pi
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

你是 maintenance。目标是更新 \`{vault}/Pi/healthcheck-report.md\`，并把需要继续处理的问题写到 \`Pi/Log/cleanup-log.md\`。

至少检查：

- \`Pi/State/runs/\` 最近运行记录是否新鲜
- \`Cards/active/\` 是否有长期 blocked / error / needs_owner 积压
- \`Pi/Log/\` 是否有明显异常
- \`Pi/Config/pios.yaml\` 中启用的关键任务是否存在对应 prompt

发现严重问题时，在报告里标红并保留证据命令摘要。
`,
  'token-daily-summary.md': `---
taskId: token-daily-summary
cron: '2 3 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 汇总昨日 token 使用情况。
agent: pi
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: low
last_run: null
last_session_id: null
---

汇总昨日各任务的 token 与运行开销，覆盖写入 \`{vault}/Pi/Log/token-summary.md\`。
若日志缺失，写明缺口，不编造数字。
`,
  'sense-maker.md': `---
taskId: sense-maker
cron: '30 0,9 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 读取近期产出，对账现实与系统状态。
agent: pi
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

你是 sense-maker。读取最近 1-2 天的 Daily、微信摘要、worker log、cleanup log 和 active 卡片，做三件事：

1. 把现实中的完成/进展同步回对应卡片。
2. 检查过期的 \`blocked_on: verify-after:\` 是否可以解除。
3. 给仍在推进的项目补充清楚的 Context Pack 或工作记录。

不要写新的控制文件。直接改 Cards。
`,
  'daily-briefing.md': `---
taskId: daily-briefing
cron: '9 8 * * *'
engines:
  - claude-cli
enabled: true
needs_browser: false
description: 生成每日简报。
agent: pi
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch'
permission_mode: default
requires: []
budget: low
last_run: null
last_session_id: null
---

读取 \`Cards/active/\`、\`Pi/healthcheck-report.md\`、\`Pi/Log/token-summary.md\`、最近的 pipeline 产出，覆盖写入 \`{vault}/Pi/Daily_Briefing.md\`。

结构至少包含：

- 紧急事项
- 昨夜发生了什么
- 今日建议（Top 3）
- Cards 状态一览
- Pipeline 健康度
`,
  'daily-ai-diary.md': `---
taskId: daily-ai-diary
cron: '7 0 * * *'
engines:
  - claude-cli
enabled: true
needs_browser: false
description: 生成昨日 AI 对话日记。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

总结昨天在 PiBrowser 和 CLI 上产生的 AI 对话，写入 \`{vault}/{owner}/Pipeline/AI_Conversation_Digest/daily_ai/{target_date}.md\`。

先做幂等检查：若目标文件已存在则跳过。
若缺数据源，记录缺口并继续处理其他可读输入。
`,
  'daily-diary-engine.md': `---
taskId: daily-diary-engine
cron: '30 1 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 聚合全部 pipeline 产物，生成每日日记。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

读取 \`{vault}/{owner}/Pipeline/\` 下的最新产物、\`{vault}/Pi/Owner_Status.md\` 与关键系统日志，写入 \`{vault}/{owner}/Personal/Daily/{target_date}.md\`。

先做幂等检查：若目标文件已存在则跳过。
`,
  'daily-health.md': `---
taskId: daily-health
cron: '40 0 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 采集并汇总昨日健康数据。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires:
  - health
budget: medium
last_run: null
last_session_id: null
---

从 Health 数据源生成 \`{vault}/{owner}/Pipeline/AI_Health_Digest/daily_health/{target_date}.md\`。

先做幂等检查：若目标文件已存在则跳过；若数据源缺失，写明缺口后退出。
`,
  'daily-photo-diary.md': `---
taskId: daily-photo-diary
cron: '58 23 * * *'
engines:
  - claude-cli
  - codex-cli
enabled: true
needs_browser: true
description: 读取昨日照片并生成照片日记。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch'
permission_mode: default
requires:
  - photos
budget: medium
last_run: null
last_session_id: null
---

读取昨日照片与相关上下文，写入 \`{vault}/{owner}/Pipeline/AI_Photo_Digest/daily_photo/{target_date}.md\`。

先做幂等检查：若目标文件已存在则跳过。
`,
  'daily-user-status.md': `---
taskId: daily-user-status
cron: '10 1 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 汇总 pipeline 数据，生成 Owner_Status 面板。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: medium
last_run: null
last_session_id: null
---

读取最新 pipeline 产物和 Cards 状态，覆盖写入 \`{vault}/Pi/Owner_Status.md\`。

如果今天已经更新过，则跳过，避免双写。
`,
  'daily-wechat-digest.md': `---
taskId: daily-wechat-digest
cron: '7 0 * * *'
engines:
  - codex-cli
  - claude-cli
enabled: true
needs_browser: false
description: 提取昨日微信消息并生成摘要。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires:
  - wechat
budget: medium
last_run: null
last_session_id: null
---

从本机微信数据提取昨日私聊消息，生成 \`{vault}/{owner}/Pipeline/AI_Wechat_Digest/daily_wechat/{target_date}.md\`。

先做幂等检查：若目标文件已存在则跳过。
`,
  'daily-world-feed.md': `---
taskId: daily-world-feed
cron: '0 8 * * *'
engines:
  - codex-cli
  - claude-cli
enabled: true
needs_browser: false
description: 生成每日世界动态摘要。
agent: pipeline
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch'
permission_mode: default
requires:
  - web-search
budget: medium
last_run: null
last_session_id: null
---

抓取外部世界信号，写入 \`{vault}/{owner}/Pipeline/AI_World_Digest/{target_date}.md\`。

若外部源不可用，记录缺口，不编造内容。
`,
  'vault-snapshot.md': `---
taskId: vault-snapshot
cron: '0 3 * * *'
engines:
  - codex-cli
enabled: true
needs_browser: false
description: 生成 Vault 快照，帮助后续巡检和对账。
agent: pi
allowed_tools: 'Read,Write,Edit,Bash,Glob,Grep'
permission_mode: default
requires: []
budget: low
last_run: null
last_session_id: null
---

扫描 Vault 的关键目录结构、最近改动的 Cards 与 Pi 输出，覆盖写入 \`{vault}/Pi/Log/vault-snapshot.md\`。
输出只写事实和路径，不做策略推断。
`,
};

function writeRuntimeTask(vaultRoot, agentId, taskFileName, content) {
  const agentTaskDir = path.join(vaultRoot, 'Pi', 'Agents', agentId, 'tasks');
  const scheduledTaskPath = path.join(vaultRoot, 'Pi', 'Config', 'scheduled-tasks', taskFileName);
  fs.mkdirSync(agentTaskDir, { recursive: true });
  fs.writeFileSync(path.join(agentTaskDir, taskFileName), content);
  fs.writeFileSync(scheduledTaskPath, content);
}

// ── 检测 ─────────────────────────────────────────────

function isInstalled() {
  return fs.existsSync(CONFIG_PATH);
}

function loadConfig() {
  if (!isInstalled()) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// ── 安装 ─────────────────────────────────────────────

function install(options) {
  const {
    owner_name = 'User',
    vault_root = path.join(process.env.HOME, 'PiOS'),
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    runtimes = { 'claude-cli': true },
    plugins = ['vault', 'shell', 'web-search'],
    // per-user 整串显示名（用户在不同渠道可能用不同显示名，如 IM 昵称带前后缀）
    // prompt 里禁止 {owner}+字面量拼接；用 {<key>_name} 从 display_names dict 读
    display_names = {},
  } = options;

  const hostname = os.hostname().split('.')[0].toLowerCase();

  // 1. 创建 ~/.pios/（如果不存在）
  fs.mkdirSync(PIOS_HOME, { recursive: true });

  const sanitizeExamplePath = path.join(PIOS_HOME, 'sanitize-patterns.txt.example');
  if (!fs.existsSync(sanitizeExamplePath)) {
    fs.writeFileSync(sanitizeExamplePath, SANITIZE_PATTERNS_EXAMPLE);
    try { fs.chmodSync(sanitizeExamplePath, '600'); } catch {}
  }

  // 2. 读取现有 config（如果有），只在首次安装时写
  let config;
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // 2026-04-25 bug fix: 老装用户 config 可能没 plugins 字段，补上
    if (!Array.isArray(config.plugins)) config.plugins = plugins;
  } else {
    config = {
      version: '1.0.0',
      owner_name,
      vault_root,
      timezone,
      primary_host: hostname,
      display_names,
      plugins,              // ← setup 勾选的插件落盘，PiBrowser Plugins 页要读这个
      plugin_state: {},     // 每个 plugin 的激活状态（wechat 这种需要独立激活流程的存在这）
      created: new Date().toISOString(),
      known_vaults: [],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  // 3. 创建 Vault 目录结构
  const dirs = [
    'Cards/inbox',
    'Cards/active',
    'Cards/archive',
    'Pi/Agents/pi',
    'Pi/Agents/maintenance',
    'Pi/Agents/sense-maker',
    'Pi/Agents/pipeline',
    'Pi/Config/plugins',
    'Pi/Config/scheduled-tasks',
    'Pi/Plugins/core',
    'Pi/Inbox',
    'Pi/Output/radar',
    'Pi/Output/content',
    'Pi/Output/infra',
    'Pi/Radars',
    'Pi/Log/cron',
    'Pi/Memory',
    'Pi/Daily',
    'Pi/Data',
    'Pi/State/runs',
    'Pi/State/locks',
    'Pi/Tools',
    'Projects',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(vault_root, dir), { recursive: true });
  }

  // 4. 写 pios.yaml manifest
  const enabledRuntimes = {};
  if (runtimes['claude-cli']) enabledRuntimes['claude-cli'] = { type: 'cli', credentials: 'credentials.json' };
  if (runtimes['codex-cli']) enabledRuntimes['codex-cli'] = { type: 'cli', credentials: 'credentials.json' };
  if (runtimes['openclaw']) enabledRuntimes['openclaw'] = { type: 'agent', credentials: 'credentials.json' };
  if (Object.keys(enabledRuntimes).length === 0) {
    enabledRuntimes['claude-cli'] = { type: 'cli', credentials: 'credentials.json' };
  }
  const defaultRuntime = Object.keys(enabledRuntimes)[0];

  const pluginDefs = {};
  for (const p of plugins) {
    pluginDefs[p] = { enabled: true };
  }

  // Plugin-driven activation: only启 pipeline task + sense pipeline 如果对应插件已勾选
  // Core（非插件依赖）始终启：ai-diary / diary-engine / user-status / world-feed
  const hasPlugin = (name) => plugins.includes(name);

  const manifest = {
    version: 2,
    owner: owner_name,
    // per-user 整串显示名字典；adapter 运行时自动注入 {<key>_name} 到 prompt
    ...(Object.keys(display_names || {}).length ? { display_names } : {}),

    direction: {
      alignment: 'alignment.md',
      goals: {},
    },

    agents: {
      // Kernel — 只有 pi 一个 agent，12 个 task（结构 + cron 照抄 owner 用过的稳定 live yaml）
      // 默认只开 triage / work；其他 10 个 enabled:false，用户在 PiBrowser Team → Pi → Kernel 手动开
      'pi': {
        name: 'Pi',
        category: 'kernel',
        required: true,
        soul: '../Agents/pi/SOUL.md',
        plugins: ['vault'],
        runtime: defaultRuntime,
        host: hostname,
        status: 'active',
        tasks: {
          'triage': {
            prompt: '../Agents/pi/tasks/triage.md',
            trigger: { cron: '*/15 * * * *' },
            enabled: true,
          },
          'work': {
            prompt: '../Agents/pi/tasks/work.md',
            trigger: { cron: '*/5 * * * *' },
            enabled: true,
          },
          'sense-maker': {
            prompt: '../Agents/pi/tasks/sense-maker.md',
            trigger: { cron: '0 */2 * * *' },
            enabled: false,
          },
          'reflect': {
            prompt: '../Agents/pi/tasks/reflect.md',
            trigger: { cron: '0 4 * * *' },
            enabled: false,
          },
          'maintenance': {
            prompt: '../Agents/pi/tasks/maintenance.md',
            trigger: { cron: '30 2 * * *' },
            enabled: false,
          },
          'memory-gather': {
            prompt: '../Agents/pi/tasks/memory-gather.md',
            trigger: { cron: '45 2 * * *' },
            enabled: false,
          },
          'token-daily-summary': {
            prompt: '../Agents/pi/tasks/token-daily-summary.md',
            trigger: { cron: '2 3 * * *' },
            enabled: false,
          },
          'daily-briefing': {
            prompt: '../Agents/pi/tasks/daily-briefing.md',
            trigger: { cron: '9 8 * * *' },
            enabled: false,
          },
          'evening-brief': {
            prompt: '../Agents/pi/tasks/evening-brief.md',
            trigger: { cron: '0 22 * * *' },
            enabled: false,
          },
          'runtime-update': {
            prompt: '../Agents/pi/tasks/runtime-update.md',
            trigger: { cron: '0 3 * * 0' },
            enabled: false,
          },
          'weekly-wrap-up': {
            prompt: '../Agents/pi/tasks/weekly-wrap-up.md',
            trigger: { cron: '0 21 * * 0' },
            enabled: false,
          },
          'monthly-reflection': {
            prompt: '../Agents/pi/tasks/monthly-reflection.md',
            trigger: { cron: '30 21 28-31 * *' },
            enabled: false,
          },
        },
      },
      'pipeline': {
        name: '数据管道',
        category: 'sense-runner',
        hidden_from_team_ui: true,
        soul: '../Agents/pipeline/SOUL.md',
        plugins: ['vault'],
        runtime: defaultRuntime,
        host: hostname,
        status: 'active',
        tasks: {
          'daily-ai-diary': {
            prompt: '../Agents/pipeline/tasks/daily-ai-diary.md',
            trigger: { cron: '7 0 * * *' },
            enabled: true,
          },
          'daily-diary-engine': {
            prompt: '../Agents/pipeline/tasks/daily-diary-engine.md',
            trigger: { cron: '30 1 * * *' },
            enabled: true,
          },
          'daily-health': {
            prompt: '../Agents/pipeline/tasks/daily-health.md',
            trigger: { cron: '40 0 * * *' },
            enabled: hasPlugin('health'),
          },
          'daily-photo-diary': {
            prompt: '../Agents/pipeline/tasks/daily-photo-diary.md',
            trigger: { cron: '58 23 * * *' },
            enabled: hasPlugin('photos'),
          },
          'daily-user-status': {
            prompt: '../Agents/pipeline/tasks/daily-user-status.md',
            trigger: { cron: '10 1 * * *' },
            enabled: true,
          },
          'daily-wechat-digest': {
            prompt: '../Agents/pipeline/tasks/daily-wechat-digest.md',
            trigger: { cron: '7 0 * * *' },
            enabled: hasPlugin('wechat'),
          },
          'daily-world-feed': {
            prompt: '../Agents/pipeline/tasks/daily-world-feed.md',
            trigger: { cron: '0 8 * * *' },
            enabled: true,
          },
        },
      },
    },

    sense: {
      pipelines: {
        'ai-diary': {
          built_in: true,
          category_ui: 'conversation',
          downstream: ['diary-engine'],
          enabled: true,
          icon: '💬',
          installed: true,
          name: 'AI 对话',
          output: {
            path: `${owner_name}/Pipeline/AI_Conversation_Digest/`,
            type: 'log',
          },
          requires: [],
          source: {
            auth_required: false,
            label: '~/.claude/projects/ (Claude JSONL)',
            type: 'folder',
          },
          task_ref: 'pipeline/daily-ai-diary',
        },
        'diary-engine': {
          built_in: true,
          category_ui: 'synthesis',
          downstream: ['owner', 'profile-refresh'],
          enabled: true,
          icon: '📔',
          installed: true,
          name: '每日日记 (聚合)',
          output: {
            path: `${owner_name}/Personal/Daily/`,
            type: 'log',
          },
          requires: [],
          source: {
            auth_required: false,
            label: '全部 pipeline 产物',
            type: 'pipeline-products',
          },
          task_ref: 'pipeline/daily-diary-engine',
        },
        'health': {
          built_in: true,
          category_ui: 'health',
          downstream: ['diary-engine', 'life'],
          enabled: hasPlugin('health'),
          icon: '🏃',
          installed: hasPlugin('health'),
          name: 'Apple Health',
          output: {
            path: `${owner_name}/Pipeline/AI_Health_Digest/daily_health/`,
            type: 'log',
          },
          requires: ['health'],
          source: {
            auth_required: true,
            label: 'Apple Health (HealthKit)',
            type: 'api',
          },
          task_ref: 'pipeline/daily-health',
        },
        'photo-diary': {
          built_in: true,
          category_ui: 'media',
          downstream: ['diary-engine'],
          enabled: hasPlugin('photos'),
          icon: '📷',
          installed: hasPlugin('photos'),
          name: '照片日记',
          output: {
            path: `${owner_name}/Pipeline/AI_Photo_Digest/`,
            type: 'log',
          },
          requires: ['photos'],
          source: {
            auth_required: true,
            label: '照片库',
            type: 'api',
          },
          task_ref: 'pipeline/daily-photo-diary',
        },
        'user-status': {
          built_in: true,
          category_ui: 'synthesis',
          downstream: ['all-agents'],
          enabled: true,
          icon: '👤',
          installed: true,
          name: 'Owner Status (聚合)',
          output: {
            path: 'Pi/Owner_Status.md',
            type: 'dashboard',
          },
          requires: [],
          source: {
            auth_required: false,
            label: '上面全部 pipeline 产物',
            type: 'pipeline-products',
          },
          task_ref: 'pipeline/daily-user-status',
        },
        'wechat-digest': {
          built_in: true,
          category_ui: 'messaging',
          downstream: ['diary-engine', 'sense-maker'],
          enabled: hasPlugin('wechat'),
          icon: '📱',
          installed: hasPlugin('wechat'),
          name: '微信',
          output: {
            path: `${owner_name}/Pipeline/AI_Wechat_Digest/`,
            type: 'log',
          },
          requires: ['wechat'],
          source: {
            auth_required: true,
            label: '微信加密 DB',
            type: 'database',
          },
          task_ref: 'pipeline/daily-wechat-digest',
        },
        'world-feed': {
          built_in: true,
          category_ui: 'world',
          downstream: ['sense-maker'],
          enabled: true,
          icon: '🌍',
          installed: true,
          name: '世界动态',
          output: {
            path: `${owner_name}/Pipeline/AI_World_Digest/`,
            type: 'log',
          },
          requires: ['web-search'],
          source: {
            auth_required: false,
            label: '外部世界信号',
            type: 'web',
          },
          task_ref: 'pipeline/daily-world-feed',
        },
      },
      radars: {},
    },

    infra: {
      runtimes: enabledRuntimes,
      instances: {
        [hostname]: {
          role: 'primary',
          capabilities: ['interactive', 'vault'],
        },
      },
      mcp: pluginDefs,
      channels: {},
      services: {},
      'infra-tasks': {
        'auth-health-check': {
          enabled: true,
          host: hostname,
          script: 'Pi/Tools/auth-check.sh',
          trigger: { cron: '0 * * * *' },
        },
        'vault-snapshot': {
          enabled: true,
          host: hostname,
          script: 'Pi/Tools/vault-snapshot.sh',
          trigger: { cron: '0 3 * * *' },
        },
      },
      notifications: { voice: false, popup: true },
    },

    plugins: {
      core: { enabled: true, path: 'Plugins/core' },
    },
  };

  fs.writeFileSync(
    path.join(vault_root, 'Pi', 'Config', 'pios.yaml'),
    yaml.dump(manifest, { lineWidth: 120, noRefs: true })
  );

  // 5. 写 alignment.md
  const alignmentContent = `---
created: ${new Date().toISOString().slice(0, 10)}
purpose: ${owner_name} 与 Pi 的底层对齐文件 — 所有决策的最终依据
---

# Alignment — ${owner_name} & Pi

## 使命

（在这里写你的使命宣言。Pi 的所有决策以此为锚。）

## 当前阶段

（在这里描述当前最重要的目标和约束。）
`;
  fs.writeFileSync(path.join(vault_root, 'Pi', 'Config', 'alignment.md'), alignmentContent);

  // 6. 安装 Agent SOUL 和 Task prompt
  //    优先读 app bundle 内的 backend/plugins/core；若未打包，则回退到内置模板。
  const corePluginSrc = [
    path.join(__dirname, 'Pi', 'Plugins', 'core'), // 本地开发路径
    BUNDLED_CORE_DIR,                              // 打包后
  ].find(p => fs.existsSync(p));

  if (corePluginSrc) {
    // 复制 Kernel (pi) + Pipeline Agent SOUL 到 runtime 实际读取的 Pi/Agents/
    // 不再写 maintenance / sense-maker agent SOUL——它们是 pi 下面的 task，不是独立 agent
    const standardAgents = ['pi', 'pipeline'];
    for (const agent of standardAgents) {
      const src = path.join(corePluginSrc, 'agents', agent, 'SOUL.md');
      const dest = path.join(vault_root, 'Pi', 'Agents', agent, 'SOUL.md');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }

    // 复制标配 Task prompt 到 Pi/Agents/<agent>/tasks/ 和 Config/scheduled-tasks/
    // kernel 12 tasks 全在 pi/ 下；pipeline 7 tasks 在 pipeline/ 下
    const standardTaskDefs = [
      ['pi', 'triage.md'],
      ['pi', 'work.md'],
      ['pi', 'sense-maker.md'],
      ['pi', 'reflect.md'],
      ['pi', 'maintenance.md'],
      ['pi', 'memory-gather.md'],
      ['pi', 'token-daily-summary.md'],
      ['pi', 'daily-briefing.md'],
      ['pi', 'evening-brief.md'],
      ['pi', 'runtime-update.md'],
      ['pi', 'weekly-wrap-up.md'],
      ['pi', 'monthly-reflection.md'],
      ['pipeline', 'daily-ai-diary.md'],
      ['pipeline', 'daily-diary-engine.md'],
      ['pipeline', 'daily-health.md'],
      ['pipeline', 'daily-photo-diary.md'],
      ['pipeline', 'daily-user-status.md'],
      ['pipeline', 'daily-wechat-digest.md'],
      ['pipeline', 'daily-world-feed.md'],
    ];
    for (const [agentId, taskFile] of standardTaskDefs) {
      const src = path.join(corePluginSrc, 'tasks', taskFile);
      if (!fs.existsSync(src)) continue;
      const content = fs.readFileSync(fs.realpathSync(src), 'utf-8');
      writeRuntimeTask(vault_root, agentId, taskFile, content);
    }
  } else {
    // Fallback：bundle 里没有 core prompt 时，直接写内置 runtime 版本，避免新装后 task 缺文件静默失败。
    for (const [agentId, content] of Object.entries(BUILTIN_AGENT_SOULS)) {
      const dest = path.join(vault_root, 'Pi', 'Agents', agentId, 'SOUL.md');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }

    // 12 kernel tasks 全挂 pi；7 pipeline tasks 挂 pipeline
    const builtinTaskAgents = {
      'triage.md': 'pi',
      'work.md': 'pi',
      'sense-maker.md': 'pi',
      'reflect.md': 'pi',
      'maintenance.md': 'pi',
      'memory-gather.md': 'pi',
      'token-daily-summary.md': 'pi',
      'daily-briefing.md': 'pi',
      'evening-brief.md': 'pi',
      'runtime-update.md': 'pi',
      'weekly-wrap-up.md': 'pi',
      'monthly-reflection.md': 'pi',
      'daily-ai-diary.md': 'pipeline',
      'daily-diary-engine.md': 'pipeline',
      'daily-health.md': 'pipeline',
      'daily-photo-diary.md': 'pipeline',
      'daily-user-status.md': 'pipeline',
      'daily-wechat-digest.md': 'pipeline',
      'daily-world-feed.md': 'pipeline',
    };
    for (const [taskFile, content] of Object.entries(BUILTIN_TASK_PROMPTS)) {
      writeRuntimeTask(vault_root, builtinTaskAgents[taskFile], taskFile, content);
    }
  }

  // 7. 创建 {owner}/ 数据目录骨架
  const ownerDirs = [
    `${owner_name}/Pipeline`,
    `${owner_name}/Personal/Daily`,
    `${owner_name}/Profile`,
    `${owner_name}/Scratch`,
    `${owner_name}/Scratch/attachments`,
  ];
  for (const dir of ownerDirs) {
    fs.mkdirSync(path.join(vault_root, dir), { recursive: true });
  }

  // 写 Profile 模板
  const profilePath = path.join(vault_root, owner_name, 'Profile', `${owner_name}_Profile.md`);
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, `# ${owner_name} Profile\n\n（在这里写你的基本信息，帮助 Pi 更好地服务。）\n`);
  }

  // 8. 写 BOOT.md（用户级启动文件，系统规则在 ~/.pios/SYSTEM.md）
  const bootContent = `---
tags: [AI, Pi]
updated: ${new Date().toISOString().slice(0, 10)}
purpose: Pi 用户级启动文件
---

# Pi — ${owner_name} 的个人 AI

> 系统手册：\`~/.pios/SYSTEM.md\`（自动注入，不需要手动读）
> 底层对齐：\`Pi/Config/alignment.md\`

## 启动协议

1. 读本文件
2. 扫 \`Cards/active/\` 了解当前项目
3. 主动巡检并汇报

## ${owner_name} 画像

（在这里写用户的基本信息，帮助 Pi 更好地服务。）
`;
  fs.writeFileSync(path.join(vault_root, 'Pi', 'BOOT.md'), bootContent);

  // 9. 写 card-spec.md
  const cardSpec = `# Cards 卡片规范

## Frontmatter

\`\`\`yaml
---
type: project | task
status: active | done | inbox
priority: 1-5
parent: parent-card-filename
created: YYYY-MM-DD
assignee: agent-name | user
---
\`\`\`

## 目录

- \`inbox/\` — 新进卡片，Pi 定期 triage
- \`active/\` — 当前活跃
- \`archive/\` — 已完成
`;
  fs.writeFileSync(path.join(vault_root, 'Pi', 'Config', 'card-spec.md'), cardSpec);

  // 10. 写 credentials.json（空模板）
  const credsPath = path.join(vault_root, 'Pi', 'Config', 'credentials.json');
  if (!fs.existsSync(credsPath)) {
    fs.writeFileSync(credsPath, JSON.stringify({ version: 2, providers: {} }, null, 2));
  }

  // 11. 写欢迎卡 — Day 1 直接走 TNY 最小闭环（active + needs_owner:respond）
  //     用户开 Home 立刻看到 "Things Need You" 顶部条，点"填写回复"输入想让 Pi 做的第一件事
  //     → triage 下轮清 needs_owner + 把回答转成新任务卡 → welcome 卡归档
  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);
  const sampleCard = `---
type: task
status: active
priority: 2
parent:
created: ${todayDate}
assignee: pi
source: installer
needs_owner: respond
needs_owner_set_at: '${nowIso}'
needs_owner_brief: 告诉 Pi 你最想让它帮你做的第一件事
response_type: text
decision_brief: 用一句话说出你想让 Pi 立即干的第一件事 — Pi 会据此建卡并派工
---

# Welcome to PiOS

Pi 已经上线在等你。这张卡就是你和 Pi 的第一次握手。

## 你现在在哪

- **Home 顶部的 Things Need You 条** — Pi 需要你决策的卡都弹这里。这张卡就在上面
- **中间的 MyToDo** — 你自己要做的事（\`assignee: user\`）
- **底部的 Recent Activity** — Pi 最近 5 分钟做了什么

## 下一步

点这张卡的 **"填写回复"** 按钮，用一句话告诉 Pi 你想让它帮你做的第一件事。不确定就写一句话也行（比如 "看看最近 AI 圈有什么新东西"）。

Pi 下一轮 triage（≤15 min）会读你的回复、建一张新任务卡，你会在 Recent Activity 看到它开始干活。

## 想深了解

- [\`docs/user-guide/getting-started.md\`](../../Projects/pios/docs/user-guide/getting-started.md) — 装机后第一周路径
- [\`docs/user-guide/concepts.md\`](../../Projects/pios/docs/user-guide/concepts.md) — Card / Agent / TNY 概念字典
- [\`docs/user-guide/daily-flow.md\`](../../Projects/pios/docs/user-guide/daily-flow.md) — 每天怎么用

## 验收标准

- [ ] 你点了"填写回复"并输入了一句话
- [ ] 15 min 后 Pi 据此建了新任务卡并开始推进
- [ ] 这张欢迎卡归档到 \`Cards/archive/\`
`;
  fs.writeFileSync(path.join(vault_root, 'Cards', 'active', 'welcome-to-pios.md'), sampleCard);

  // 12. 安装系统手册 SYSTEM.md 到 ~/.pios/
  const systemMdSrc = path.join(__dirname, 'system-manual.md');
  const systemMdDest = path.join(PIOS_HOME, 'SYSTEM.md');
  if (fs.existsSync(systemMdSrc) && !fs.existsSync(systemMdDest)) {
    fs.copyFileSync(systemMdSrc, systemMdDest);
  }

  // 13. 安装系统 Tools 到 ~/.pios/tools/（如果不存在）
  // 单一源码来自产品 repo / app bundle 的 backend/tools。
  const toolsDir = path.join(PIOS_HOME, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  const coreTool = ['pios-tick.sh', 'pios-adapter.sh', 'reminder.sh', 'host-helper.sh'];
  for (const tool of coreTool) {
    const dest = path.join(toolsDir, tool);
    if (fs.existsSync(dest)) continue; // 不覆盖已有（避免升级冲突）
    const src = path.join(BUNDLED_TOOLS_DIR, tool);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, '755');
  }

  // 13a. 拷 characters.yaml 到 $VAULT/Pi/Config/ — NPC 音色 / 皮肤的单一权威
  // 不拷 → getNpcSkinVoice 读不到 → Pi 说话永远用 DEFAULT_VOICE，孵化选 NPC 毫无意义
  const charactersYamlSrc = path.join(__dirname, 'backend', 'plugins', 'core', 'characters.yaml');
  const charactersYamlDest = path.join(vault_root, 'Pi', 'Config', 'characters.yaml');
  if (fs.existsSync(charactersYamlSrc) && !fs.existsSync(charactersYamlDest)) {
    try { fs.copyFileSync(charactersYamlSrc, charactersYamlDest); }
    catch (e) { console.error('[installer] copy characters.yaml failed:', e.message); }
  }

  // 13b. 安装 vault 级 tools 到 $VAULT/Pi/Tools/
  // pios.yaml 的 infra-tasks（auth-check / card-watchdog / outbox-drain / vault-snapshot 等）
  // 和 agent prompts（notify / notify-wechat / event-emit 等）都引用 Pi/Tools/*.sh。
  // 不拷 → 所有 infra-task 在新用户机器上报 "script not found"，runtime 状态永远不刷新。
  const vaultToolsDir = path.join(vault_root, 'Pi', 'Tools');
  fs.mkdirSync(vaultToolsDir, { recursive: true });
  // 递归拷 backend/tools/ → $VAULT/Pi/Tools/，保留 lib/ 等子目录。
  // pios-tick.sh source "$VAULT/Pi/Tools/lib/host-resolve.sh"——缺 lib/ 则 scheduler 静默失败。
  const _copyToolsRec = (srcDir, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      const dest = path.join(destDir, name);
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        _copyToolsRec(src, dest);
        continue;
      }
      if (!name.endsWith('.sh')) continue;
      if (fs.existsSync(dest)) continue; // 用户改过不覆盖
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, '755');
    }
  };
  try {
    _copyToolsRec(BUNDLED_TOOLS_DIR, vaultToolsDir);
  } catch (e) {
    console.error('[installer] copy vault tools failed:', e.message);
  }

  // 13c. 把用户勾选的可选插件目录整份拷到 $VAULT/Pi/Plugins/<id>/
  //      （installer 激活会话用；core 插件不在这里，core 走的是上面 agents/tasks 流程）
  const OPTIONAL_PLUGINS_DIR = path.join(__dirname, 'backend', 'plugins');
  const _copyDirRec = (srcDir, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      const dest = path.join(destDir, name);
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        _copyDirRec(src, dest);
      } else {
        if (fs.existsSync(dest)) continue; // 用户改过不覆盖
        fs.copyFileSync(src, dest);
        // 脚本文件保持可执行位
        if (/\.(sh|py)$/.test(name) || name === 'find_image_key') {
          try { fs.chmodSync(dest, '755'); } catch {}
        }
      }
    }
  };
  for (const pid of plugins) {
    if (pid === 'vault' || pid === 'shell' || pid === 'web-search' || pid === 'browser') continue; // core 已处理
    const src = path.join(OPTIONAL_PLUGINS_DIR, pid);
    if (!fs.existsSync(src)) {
      console.warn(`[installer] plugin ${pid} bundle missing, skipped`);
      continue;
    }
    const dest = path.join(vault_root, 'Pi', 'Plugins', pid);
    try {
      _copyDirRec(src, dest);
      console.log(`[installer] plugin ${pid} installed to ${dest}`);
    } catch (e) {
      console.error(`[installer] plugin ${pid} copy failed:`, e.message);
    }
  }

  // 如果装了 wechat，把对应 daily task 的 prompt 放到 pi agent tasks 下（激活前 enabled=false）
  if (plugins.includes('wechat')) {
    const wechatTask = path.join(OPTIONAL_PLUGINS_DIR, 'wechat', 'tasks', 'daily.md');
    if (fs.existsSync(wechatTask)) {
      const content = fs.readFileSync(wechatTask, 'utf-8');
      writeRuntimeTask(vault_root, 'pi', 'daily-wechat-digest.md', content);
      // manifest 里加这个 task（激活前 enabled=false）
      try {
        const manifestPath = path.join(vault_root, 'Pi', 'Config', 'pios.yaml');
        const m = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
        if (m.agents && m.agents.pi && m.agents.pi.tasks) {
          m.agents.pi.tasks['daily-wechat-digest'] = {
            prompt: '../Agents/pi/tasks/daily-wechat-digest.md',
            trigger: { cron: '7 0 * * *' },
            enabled: false,  // 激活会话结束后 AI 翻 true
          };
          fs.writeFileSync(manifestPath, yaml.dump(m, { lineWidth: -1, noRefs: true }));
        }
      } catch (e) { console.error('[installer] wechat manifest patch failed:', e.message); }
    }
  }

  // PiOS.app 自带 scheduler，安装时不再注册外部 cron，避免双跑。

  return { ok: true, config, vault_root };
}

module.exports = {
  PIOS_HOME,
  CONFIG_PATH,
  isInstalled,
  loadConfig,
  install,
};
