#!/usr/bin/env node
/**
 * Browser MCP Server (stdio JSON-RPC)
 *
 * Claude Code 通过 --mcp-config 挂载此 server，
 * 工具调用通过 HTTP 桥接到 Electron main process 控制 BrowserView。
 */

const http = require('http');
const API_PORT = 17891;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

// ── Tool definitions ──
const TOOLS = [
  {
    name: 'browser_navigate',
    description: '在 Pi 浏览器的 MCP 后台 tab 中打开 URL（不抢用户当前阅读的 tab；首次调用时开一个后台 tab，后续复用）',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的 URL' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_new_tab',
    description: '为本 MCP session 重新开一个后台 tab 打开 URL（替换当前 MCP 后台 tab，不抢用户焦点）',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL（默认 Google）' } },
    },
  },
  {
    name: 'browser_read_page',
    description: '获取当前页面的结构化内容（标题、URL、标题列表、链接、表单、表格）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_get_text',
    description: '获取当前页面的纯文本内容（前 8000 字符）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: '截取当前页面的截图（返回 base64 PNG）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: '点击页面中匹配 CSS 选择器的元素',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill',
    description: '在表单字段中填入文本',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        value: { type: 'string', description: '要填入的值' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_exec_js',
    description: '在当前页面执行 JavaScript 代码并返回结果',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript 代码' } },
      required: ['code'],
    },
  },
  {
    name: 'browser_tabs',
    description: '列出当前所有打开的标签页',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_switch_tab',
    description: '切换到指定 ID 的标签页',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '标签页 ID（从 browser_tabs 获取）' } },
      required: ['id'],
    },
  },
  {
    name: 'browser_back',
    description: '浏览器后退',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_forward',
    description: '浏览器前进',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_wait',
    description: '等待指定毫秒（页面加载、动画等）',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', description: '等待毫秒数（默认 1000，最大 10000）' } },
    },
  },
];

// ── HTTP bridge to Electron ──
function callAPI(endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve({ result: Buffer.concat(chunks).toString() }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 本 MCP session 独占的后台 tab — AI 任务永远在此 tab 操作，不抢用户 的 activeTab
let mcpTabId = null;
let bgTabClosed = false;

function closeBgTabSync() {
  // MCP server 退出时同步关掉后台 tab，避免给用户留残骸
  if (mcpTabId == null || bgTabClosed) return;
  bgTabClosed = true;
  const id = mcpTabId;
  mcpTabId = null;
  try {
    // 不 await — exit handler 里 event loop 可能已在收尾，尽力而为
    callAPI('/close_tab', { tab_id: id }).catch(() => {});
  } catch {}
}

process.on('SIGINT', () => { closeBgTabSync(); process.exit(0); });
process.on('SIGTERM', () => { closeBgTabSync(); process.exit(0); });
process.stdin.on('end', () => { closeBgTabSync(); });

async function ensureBgTab(url) {
  // 首次 navigate 时在后台开 tab；后续 navigate 复用同一 tab
  if (mcpTabId == null) {
    const r = await callAPI('/new_tab', { url, focus: false });
    if (r && typeof r.tab_id === 'number') mcpTabId = r.tab_id;
    return r;
  }
  return await callAPI('/navigate', { url, tab_id: mcpTabId, focus: false });
}

function withTab(extra = {}) {
  return mcpTabId != null ? { ...extra, tab_id: mcpTabId } : extra;
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'browser_navigate':
      // AI 语义：在 MCP 专属后台 tab 打开 URL，不干扰用户当前阅读
      return await ensureBgTab(args.url);
    case 'browser_new_tab': {
      // 显式新 tab（本 MCP session 换一个 tab 操作）
      const r = await callAPI('/new_tab', { url: args.url || 'https://www.google.com', focus: false });
      if (r && typeof r.tab_id === 'number') mcpTabId = r.tab_id;
      return r;
    }
    case 'browser_read_page':
      return await callAPI('/read_page', withTab());
    case 'browser_get_text':
      return await callAPI('/get_text', withTab());
    case 'browser_screenshot':
      return await callAPI('/screenshot', withTab());
    case 'browser_click':
      return await callAPI('/click', withTab({ selector: args.selector }));
    case 'browser_fill':
      return await callAPI('/fill', withTab({ selector: args.selector, value: args.value }));
    case 'browser_exec_js':
      return await callAPI('/exec_js', withTab({ code: args.code }));
    case 'browser_tabs':
      return await callAPI('/tabs');
    case 'browser_switch_tab':
      // 允许 AI 切换到指定 tab（影响用户的 activeTab —— 通常不该用）
      return await callAPI('/switch_tab', { id: args.id });
    case 'browser_back':
      return await callAPI('/back', withTab());
    case 'browser_forward':
      return await callAPI('/forward', withTab());
    case 'browser_wait': {
      const ms = Math.min(args.ms || 1000, 10000);
      await new Promise(r => setTimeout(r, ms));
      return { result: `waited ${ms}ms` };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// ── JSON-RPC stdio transport ──
let buffer = '';
process.stdin.setEncoding('utf-8');

function send(obj) {
  const msg = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'pios-mcp', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      // No response needed
      break;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await handleToolCall(name, args || {});
        // Screenshot returns base64 image
        if (name === 'browser_screenshot' && result.image) {
          reply(id, {
            content: [{ type: 'image', data: result.image, mimeType: 'image/png' }],
          });
        } else {
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          reply(id, { content: [{ type: 'text', text }] });
        }
      } catch (err) {
        reply(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        replyError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// Parse Content-Length framed messages
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buffer.substring(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.substring(headerEnd + 4); continue; }
    const len = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.substring(bodyStart, bodyStart + len);
    buffer = buffer.substring(bodyStart + len);
    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      process.stderr.write(`[browser-mcp] parse error: ${e.message}\n`);
    }
  }
});

process.stderr.write('[browser-mcp] started\n');
