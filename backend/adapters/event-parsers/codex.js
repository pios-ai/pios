/**
 * CodexEventParser — 刀 3
 *
 * 把 Codex CLI 的 rollout 文件（`~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{id}.jsonl`）
 * 每一行解析成归一化 BusEvent，和 claude.js 对等。
 *
 * Rollout 文件格式（刀 3 实证实验 2026-04-16 02:10 从现有 session 文件验证）：
 *   {timestamp, type: 'session_meta', payload: {id, cwd, timestamp, ...}}
 *   {timestamp, type: 'turn_context', payload: {turn_id, cwd, model, ...}}
 *   {timestamp, type: 'event_msg', payload: {type: 'task_started' | 'task_complete' |
 *     'agent_message' | 'user_message' | 'token_count', ...}}
 *   {timestamp, type: 'response_item', payload: {type: 'message' | 'function_call' |
 *     'function_call_output' | 'reasoning' | 'custom_tool_call', ...}}
 *
 * 规则（避免双发 / 噪声）：
 *   - `session_meta / turn_context / token_count / reasoning / function_call_output` → 跳过
 *   - `event_msg.agent_message` → text event（首选 assistant 文本来源）
 *   - `response_item.message` with role='assistant' → 跳过（和 agent_message 重复）
 *   - `response_item.message` with role='user' → user-echo event
 *   - `event_msg.task_started` → 跳过（adapter 通过 attach/send 管理 state）
 *   - `event_msg.task_complete` → done event
 *   - `response_item.function_call` / `custom_tool_call` → tool event
 */

function _shortPath(p = '', max = 80) {
  const s = String(p || '');
  if (!s) return '';
  if (s.length <= max) return s;
  const parts = s.split('/');
  return '.../' + parts.slice(-3).join('/');
}

function _shortText(v = '', max = 80) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.substring(0, max)}...`;
}

function _splitSayBlocks(text = '') {
  const input = String(text || '');
  const voice = [];
  const screen = input.replace(/<say(?:\s+voice="\w+")?\s*>([\s\S]*?)<\/say>/g, (_, inner) => {
    const t = String(inner || '').trim();
    if (t) voice.push(t);
    return '';
  }).trim();
  return { voice, screen };
}

function _parseArgs(args, fallbackInput = null) {
  const source = args != null && args !== '' ? args : fallbackInput;
  if (!source) return {};
  if (typeof source === 'object') return source;
  try { return JSON.parse(source); } catch { return { raw: String(source) }; }
}

function _codexUsageEvent(info) {
  const last = info && info.last_token_usage;
  const total = info && info.total_token_usage;
  const current = last || total;
  if (!current) return null;
  return {
    type: 'usage',
    content: '',
    raw: {
      input_tokens: current.input_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: current.cached_input_tokens || 0,
      output_tokens: current.output_tokens || 0,
      reasoning_output_tokens: current.reasoning_output_tokens || 0,
      total_tokens: current.total_tokens || 0,
      model_context_window: info.model_context_window || null,
      total_input_tokens: total?.input_tokens || 0,
      total_cache_read_input_tokens: total?.cached_input_tokens || 0,
      total_output_tokens: total?.output_tokens || 0,
      total_reasoning_output_tokens: total?.reasoning_output_tokens || 0,
      total_tokens_all_steps: total?.total_tokens || 0,
    }
  };
}

function _compactToolName(name = '') {
  return String(name || '')
    .replace(/^mcp__codex_apps__github_/, 'github:')
    .replace(/^mcp__codex_apps__slack__legacy__/, 'slack:')
    .replace(/^mcp__browser__/, 'browser:')
    .replace(/^mcp__/, '');
}

function _endActionLabel(action = {}) {
  if (!action || typeof action !== 'object') return '';
  const type = action.type || '';
  if (type === 'open_url') return `打开 ${_shortText(action.url || '链接')}`;
  if (type === 'search') return `搜索 ${_shortText(action.query || 'query')}`;
  return _shortText(type || '完成');
}

function toolLabel(name = '', args = '', input = null) {
  const parsed = _parseArgs(args, input);

  if (name === 'exec_command') {
    return `⚡ ${_shortText(parsed.cmd || parsed.command || parsed.raw || '执行命令')}`;
  }
  if (name === 'read_file' || name === 'Read') {
    return `📖 ${_shortPath(parsed.path || parsed.file_path || parsed.raw || '读取文件')}`;
  }
  if (name === 'search_query') {
    const q = Array.isArray(parsed.search_query)
      ? parsed.search_query.map(item => item?.q).filter(Boolean).join(' | ')
      : parsed.q || parsed.query || parsed.raw || '';
    return `🔍 搜索 ${_shortText(q || 'query')}`;
  }
  if (name === 'open') {
    const target = Array.isArray(parsed.open)
      ? parsed.open.map(item => item?.ref_id).filter(Boolean).join(' | ')
      : parsed.ref_id || parsed.url || parsed.raw || '';
    return `📂 打开 ${_shortText(target || '资源')}`;
  }
  if (name === 'find') {
    return `🔎 查找 ${_shortText(parsed.pattern || parsed.raw || '')}`;
  }
  if (name === 'click') {
    const target = parsed.id != null ? `#${parsed.id}` : (parsed.ref_id || parsed.raw || '');
    return `👆 点击 ${_shortText(target || '元素')}`;
  }
  if (name === 'write_stdin') {
    return `⌨️ 继续终端会话 ${_shortText(parsed.session_id || parsed.raw || '')}`;
  }
  if (name === 'apply_patch') {
    return '✏️ 应用代码补丁';
  }
  if (name === 'update_plan') {
    const steps = Array.isArray(parsed.plan) ? parsed.plan : [];
    const active = steps.find(step => step && step.status === 'in_progress');
    const done = steps.filter(step => step && step.status === 'completed').length;
    if (active && active.step) {
      return `🗺️ 更新计划 ${_shortText(active.step)}`;
    }
    if (steps.length > 0) {
      return `🗺️ 更新计划 ${done}/${steps.length}`;
    }
    return '🗺️ 更新计划';
  }
  if (name === 'list_mcp_resources' || name === 'list_mcp_resource_templates') {
    return '📚 查看 MCP 资源';
  }
  if (name === 'read_mcp_resource') {
    return `📖 读取 MCP 资源 ${_shortText(parsed.uri || parsed.raw || '')}`;
  }
  if (name === 'view_image') {
    return `🖼️ 查看图片 ${_shortPath(parsed.path || parsed.raw || '图片')}`;
  }
  if (name === 'wait_agent') {
    const targets = Array.isArray(parsed.targets)
      ? parsed.targets.join(', ')
      : parsed.target || parsed.raw || '';
    return `⏳ 等待子 agent ${_shortText(targets || '结果')}`;
  }
  if (name === 'web_search_call') {
    return `🔍 搜索网络 ${_shortText(parsed.query || parsed.raw || '')}`.trim();
  }
  if (name.startsWith('github:')) {
    return `🐙 ${_compactToolName(name).replace(/^github:/, 'GitHub ')}`;
  }
  if (name.startsWith('slack:')) {
    return `💬 ${_compactToolName(name).replace(/^slack:/, 'Slack ')}`;
  }
  if (name.startsWith('browser:')) {
    return `🌐 ${_compactToolName(name).replace(/^browser:/, '')}`;
  }

  if (parsed.command) return `⚡ ${_shortText(parsed.command)}`;
  if (parsed.cmd) return `⚡ ${_shortText(parsed.cmd)}`;
  if (parsed.file_path) return `📖 ${_shortPath(parsed.file_path)}`;
  if (parsed.path) return `📖 ${_shortPath(parsed.path)}`;
  if (parsed.pattern) return `🔍 ${_shortText(parsed.pattern)}`;
  if (parsed.raw) return `🔧 ${_compactToolName(name) || 'tool'} ${_shortText(parsed.raw)}`.trim();
  return `🔧 ${_compactToolName(name) || 'tool'}`;
}

function eventLabel(eventType = '', payload = {}) {
  if (eventType === 'context_compacted') return '🧹 已压缩上下文';
  if (eventType === 'web_search_end') {
    const detail = payload.query
      ? `搜索 ${_shortText(payload.query)}`
      : _endActionLabel(payload.action);
    return `🔍 ${detail || '搜索完成'}`;
  }
  return `ℹ️ ${_shortText(eventType || 'event')}`;
}

/**
 * 解析一行 Codex rollout jsonl → 0~N BusEvent。
 */
function parseLine(line) {
  if (!line || !line.trim()) return [];
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }

  const t = ev.type;
  const p = ev.payload || {};

  // 直接跳过
  if (t === 'session_meta' || t === 'turn_context') return [];
  if (t === 'compacted') {
    return [{ type: 'tool', content: '🧹 已压缩上下文' }];
  }

  if (t === 'event_msg') {
    const pt = p.type;
    if (pt === 'agent_message') {
      // 这是 assistant 文本的首选来源 —— response_item.message 里的 assistant 会被 skip
      const msg = p.message || '';
      if (!msg) return [];
      const { voice, screen } = _splitSayBlocks(msg);
      const events = [];
      for (const v of voice) events.push({ type: 'voice', content: v });
      if (screen) events.push({ type: 'text', content: String(screen) });
      return events;
    }
    if (pt === 'user_message') {
      // user 已经知道自己发了什么，watcher 场景下可以显示（用 user-echo 类型）
      const msg = p.message || '';
      return msg ? [{ type: 'user-echo', content: String(msg) }] : [];
    }
    if (pt === 'token_count') {
      const usageEvent = _codexUsageEvent(p.info);
      return usageEvent ? [usageEvent] : [];
    }
    if (pt === 'task_complete') {
      // codex 的 task_complete 不带最终文本（最终文本在 agent_message 里已经 publish 过了）
      return [
        { type: 'turn-end', content: '' },
        { type: 'done', content: '' }
      ];
    }
    if (pt === 'exec_command_end') {
      const exitCode = Number.isFinite(p.exit_code) ? p.exit_code : null;
      if (exitCode && exitCode !== 0) {
        return [{ type: 'error', content: `命令失败（exit ${exitCode}）: ${_shortText((p.parsed_cmd && p.parsed_cmd[0] && p.parsed_cmd[0].cmd) || (Array.isArray(p.command) ? p.command.join(' ') : p.command || ''))}` }];
      }
      return [];
    }
    if (pt === 'patch_apply_end') {
      if (p.success === false) {
        return [{ type: 'error', content: _shortText(p.stderr || p.stdout || '应用补丁失败') }];
      }
      return [];
    }
    if (pt === 'context_compacted' || pt === 'web_search_end') {
      return [{ type: 'tool', content: eventLabel(pt, p) }];
    }
    // task_started / token_count / 其他低价值 event_msg → 跳过；未知类型做安全降级
    if (pt) return [{ type: 'tool', content: eventLabel(pt, p) }];
    return [];
  }

  if (t === 'response_item') {
    const pt = p.type;
    if (pt === 'message') {
      // role=developer / user / assistant。assistant 的文本已经通过 agent_message 发过，跳过。
      // user 的已经通过 event_msg.user_message 发过，跳过。
      // developer（系统 prompt）跳过。
      return [];
    }
    if (pt === 'function_call' || pt === 'custom_tool_call') {
      const name = p.name || '';
      const args = p.arguments || '';
      return [{ type: 'tool', content: toolLabel(name, args, p.input || null) }];
    }
    if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
      // tool 结果噪声大，跳过
      return [];
    }
    if (pt === 'reasoning') {
      // 模型内部思考，对用户不展示
      return [];
    }
    if (pt === 'web_search_call') {
      return [{ type: 'tool', content: toolLabel('web_search_call', p.arguments || '', p.input || p) }];
    }
    if (pt) return [{ type: 'tool', content: `🔧 ${_compactToolName(pt)}` }];
    return [];
  }

  return [];
}

/**
 * 从 rollout 第一行（session_meta）提取 sessionId。
 */
function extractSessionId(firstLine) {
  try {
    const ev = JSON.parse(firstLine);
    if (ev.type === 'session_meta' && ev.payload && ev.payload.id) return ev.payload.id;
  } catch {}
  return null;
}

module.exports = { parseLine, extractSessionId, toolLabel };
