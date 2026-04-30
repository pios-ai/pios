/**
 * ClaudeEventParser — 刀 3
 *
 * 把 Claude CLI 写进 `~/.claude/projects/{cwd}/{sessionId}.jsonl` 的每一行
 * 解析成归一化的 BusEvent：
 *
 *   { type: 'tool' | 'text' | 'done' | 'system' | 'error', content: string, raw?: object }
 *
 * 返回 `null` 表示这一行不需要 publish（queue-operation / last-prompt / tool_result 等内部噪声）。
 *
 * 使用：`RunSessionAdapter` 在 `fs.watchFile` 拿到新行后调 `parseLine(line)`，
 * 不为 null 就 `publish(event)` 到 SessionBus。
 *
 * 参考格式（刀 3 实证实验 2026-04-16 02:04 验证 —— 持久化的 jsonl 文件里**没有**
 * stream-json 的 `result` / `system` 包装层，只有裸的 user/assistant/queue-operation/
 * last-prompt 行）：
 *   {type: 'user', message: {content: 'xxx'}}              ← real user text
 *   {type: 'user', message: {content: [{type: 'tool_result', ...}]}}  ← tool result (skip)
 *   {type: 'assistant', message: {content: [
 *     {type: 'text', text: '...'},
 *     {type: 'tool_use', name: 'Read', input: {...}}
 *   ]}}
 *   {type: 'queue-operation', ...}       ← internal, skip
 *   {type: 'last-prompt', ...}           ← 每个 turn 结束后出现，作为 turn-end 信号
 *
 * "done" event 由 RunSessionAdapter 从 run record 的 status 变化决定，不在这里判定。
 */

const path = require('path');

/**
 * 从文本中拆分 <say> 标签，返回 { voice: string[], screen: string }。
 * 与 Codex parser 的 _splitSayBlocks 对齐。
 */
function _splitSayBlocks(text = '') {
  const voice = [];
  const screen = text.replace(/<say(?:\s+voice="\w+")?\s*>([\s\S]*?)<\/say>/g, (_, inner) => {
    const t = String(inner || '').trim();
    if (t) voice.push(t);
    return '';
  }).trim();
  return { voice, screen };
}

/**
 * 把 tool_use block 转成显示图标 + 描述（和 ClaudeCodeClient 里的格式对齐）。
 */
function toolUseLabel(name, input = {}) {
  if (name === 'Read') return `📖 ${path.basename(input.file_path || '')}`;
  if (name === 'Edit') return `✏️ ${path.basename(input.file_path || '')}`;
  if (name === 'Write') return `📝 ${path.basename(input.file_path || '')}`;
  if (name === 'Bash') return `⚡ ${(input.command || '').substring(0, 60)}`;
  if (name === 'Grep') return `🔍 ${input.pattern || ''}`;
  if (name === 'Glob') return `📂 ${input.pattern || ''}`;
  if (name && name.startsWith('mcp__browser__')) {
    const tool = name.replace('mcp__browser__', '');
    if (tool === 'browser_navigate') return `🌐 ${input.url || ''}`;
    if (tool === 'browser_new_tab') return `🌐+ ${input.url || ''}`;
    if (tool === 'browser_read_page') return '📄 读取页面结构';
    if (tool === 'browser_get_text') return '📄 读取页面文本';
    if (tool === 'browser_screenshot') return '📸 截图';
    if (tool === 'browser_click') return `👆 点击 ${input.selector || ''}`;
    if (tool === 'browser_fill') return `✏️ 填写 ${input.selector || ''}`;
    if (tool === 'browser_exec_js') return `⚡ JS: ${(input.code || '').substring(0, 50)}`;
    if (tool === 'browser_tabs') return '📑 列出标签页';
    if (tool === 'browser_switch_tab') return `📑 切换标签 #${input.id}`;
    return `🌐 ${tool}`;
  }
  return `🔧 ${name}`;
}

/**
 * 解析一行 Claude jsonl 成 0~N 个 BusEvent。
 * @param {string} line - 单行 JSON（trimmed）
 * @returns {Array<{type: string, content: string, raw?: object}>}
 */
function parseLine(line) {
  if (!line || !line.trim()) return [];
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }

  // System / internal 行
  if (ev.type === 'queue-operation') return [];
  if (ev.type === 'system') return []; // adapter 从文件名拿 sessionId，不需要 publish
  // last-prompt = 一个 turn 结束的标记。adapter 可根据这个事件收尾 spinner / 标记步骤 done。
  if (ev.type === 'last-prompt') return [{ type: 'turn-end', content: '' }];

  // User 消息：只处理 real user text，跳过 tool_result
  if (ev.type === 'user' && ev.message) {
    const c = ev.message.content;
    if (typeof c === 'string' && c.trim()) {
      // 真实 user 输入 —— 大多数场景 adapter 已经知道（是它自己 send 的），
      // 但 task session 的 watcher 场景可能从 jsonl 第一次看到。用 'user-echo' 类型，
      // 方便 renderer 区分"我发的"和"外部写进来的"。
      return [{ type: 'user-echo', content: c }];
    }
    // content 是 array（tool_result）→ 跳过
    return [];
  }

  // Assistant 消息：拆成 text、tool_use、usage 三种 event
  if (ev.type === 'assistant' && ev.message) {
    const c = ev.message.content;
    if (!Array.isArray(c)) return [];
    const out = [];

    // usage 事件：从 message.usage 提取 token 统计
    const usage = ev.message && ev.message.usage;
    if (usage) {
      out.push({
        type: 'usage',
        content: '',
        raw: {
          input_tokens: usage.input_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          model: ev.message && ev.message.model || null,
        }
      });
    }
    for (const block of c) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        const { voice, screen } = _splitSayBlocks(block.text);
        // voice events 先于 text event（与 Codex parser 一致）
        for (const v of voice) out.push({ type: 'voice', content: v });
        if (screen) out.push({ type: 'text', content: screen });
      } else if (block.type === 'tool_use') {
        out.push({ type: 'tool', content: toolUseLabel(block.name, block.input || {}) });
      }
    }
    return out;
  }

  // `result` 类型只在 `--output-format stream-json` 的 stdout 里出现，持久化 jsonl 不存。
  // 保留解析以支持 stdout 流场景（future use）。
  if (ev.type === 'result') {
    return [{ type: 'done', content: ev.result || '' }];
  }

  return [];
}

/**
 * 从 jsonl 第一行（system init）提取 sessionId。
 * 调用方 (RunSessionAdapter) 可用它 sanity check 文件和期望 sessionId 是否一致。
 */
function extractSessionId(firstLine) {
  try {
    const ev = JSON.parse(firstLine);
    if (ev.type === 'system' && ev.session_id) return ev.session_id;
  } catch {}
  return null;
}

module.exports = { parseLine, extractSessionId, toolUseLabel };
