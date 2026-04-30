/**
 * Claude Code Client — subprocess 方式
 * 移植自 xiaoqi/server.py 的 run_claude 逻辑
 */

const { spawn } = require('child_process');
const path = require('path');

// Auto-detect claude binary
const fs = require('fs');

const CLAUDE_BIN = (() => {
  const { execSync } = require('child_process');
  try { return execSync('which claude', { encoding: 'utf-8' }).trim(); } catch {}
  const candidates = [
    path.join(process.env.HOME || '', '.claude/local/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'claude';
})();

function _owner() { try { return require('./vault-context').getOwnerName(); } catch { return 'User'; } }

const VOICE_PROMPT_TPL = () => `你是 Pi，${_owner()} 的助手。这是日常工作，不是初次见面。

## 手口并用
${_owner()} 坐在电脑前，看着 PiBrowser，戴着耳机。
你有两个输出通道：屏幕（文字）和耳机（语音）。用 <say> 标签标记语音内容。

想象你坐在用户旁边，两人看着同一块屏幕。你可以说话，也可以在屏幕上打字，自然地选择：
- 口头说就够的事（闲聊、短回答、口头确认），直接 <say>，屏幕不用重复
- 需要看的东西（数据、代码、列表、长文），放屏幕，不用念出来
- 两者配合时，语音说你的判断和结论，屏幕展开证据和细节。语音不要复述屏幕内容
- 工具调用前后简短说一句在干嘛就行

唯一的硬规则：不要说废话。"我来帮你看看""以上就是结果"这种不包含信息的话，不要放进 <say>。

## Skills
${fs.readFileSync(path.join(__dirname, 'pi-skills.md'), 'utf-8').replace(/\{owner\}/g, _owner())}`;

class ClaudeCodeClient {
  constructor() {
    this._sessionId = null;
    this._proc = null;
    this._turnCount = 0;
  }

  get sessionId() { return this._sessionId; }
  get turnCount() { return this._turnCount; }
  reset() {
    this._sessionId = null;
    this._turnCount = 0;
  }

  /**
   * Run a Claude Code command.
   * Yields events:
   *   { type: 'voice', content: '好，我来改一下' }  ← 🗣 lines → TTS
   *   { type: 'text', content: '...' }              ← screen text
   *   { type: 'tool', content: '📖 file.md' }       ← tool calls
   *   { type: 'done', content: '最终回复' }
   *   { type: 'error', content: '错误信息' }
   */
  async *run(prompt, { cwd, skipPermissions, permissionLevel, model } = {}) {
    const fullPrompt = `${_owner()}: ${prompt}\n（记住用 <say> 标签包裹要朗读的内容，标签外只显示屏幕）`;

    const isResume = !!this._sessionId;
    const args = ['-p', fullPrompt, '--output-format', 'stream-json', '--verbose'];
    // --resume 时不传 --system-prompt：Claude CLI 会从 JSONL 继承原 session 的 system prompt。
    // 同时传两个会导致 CLI 创建全新 session（system prompt 变了 = 新对话），老对话记忆全丢。
    if (!isResume) {
      args.push('--system-prompt', VOICE_PROMPT_TPL());
    }
    // 模型选择：sonnet/opus/haiku/sonnet[1m]/opus[1m] → Claude CLI --model 参数
    // 任何 model 都要传 `--model`，不能因为"sonnet 是默认"就跳过。
    // 实测（2026-04-21）：`--model` 在 `--resume` 下**会覆盖** session 原 model。
    // 以前代码 `model !== 'sonnet'` 才传 → 用户点 Sonnet 切换时啥也不传，CLI 沿用
    // session 原 model（可能是 Opus），所以切换不生效，UI 跟实际跑的 model 对不上。
    if (model) {
      // 白名单 + full-name passthrough：alias（sonnet/opus/haiku）原样传；
      // 其他 "claude-*" 全名（如 claude-opus-4-7[1m]）也直接传；
      // 未知值丢掉避免误调用。
      const ALIASES = new Set(['sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]']);
      if (ALIASES.has(model) || /^claude-[\w.\-\[\]]+$/.test(model)) {
        args.push('--model', model);
      }
    }
    // 权限级别：'full' = 跳过所有权限，'safe' = 只允许只读工具
    const effectiveLevel = permissionLevel || (skipPermissions ? 'full' : 'safe');
    if (effectiveLevel === 'full') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--allowedTools', 'Read,Grep,Glob,WebFetch,WebSearch,Agent');
    }
    if (isResume) {
      args.push('--resume', this._sessionId);
      console.log(`[claude-client] resuming session ${this._sessionId}`);
    }

    const vaultPath = require('./vault-root');

    // Ensure PATH includes homebrew dirs (packaged .app lacks shell profile)
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/opt/node/bin', '/usr/local/bin'];
    const envPath = (process.env.PATH || '/usr/bin:/bin');
    const fullPath = [...extraPaths, ...envPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');

    // Remove empty ANTHROPIC_API_KEY — Claude CLI treats it as "use API key auth"
    // but the empty value causes 401. Let CLI use its own OAuth token instead.
    const cleanEnv = { ...process.env, PATH: fullPath };
    if (!cleanEnv.ANTHROPIC_API_KEY) delete cleanEnv.ANTHROPIC_API_KEY;
    // 宿主可能是 Claude Desktop / 上层 Claude Code 实例（被 owner 从 Claude.app
    // 里启动时就会带上这些 env）。spawn 出去的 claude CLI 优先用 env 里的
    // OAuth token，盖过 Keychain → token 属于另一 session/scope，server 401。
    // 统一剥掉，让子 CLI 自己从 Keychain 读 PiOS 这台机的 OAuth。
    delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDECODE;

    this._proc = spawn(CLAUDE_BIN, args, {
      cwd: cwd || vaultPath,
      env: cleanEnv,
      // stdin:ignore — 原来 stdio[0]='pipe' 但从不写，导致 claude CLI 认为还有输入
      // 在 stdin 等待，非 Electron 环境（pi-chrome-ext/native-host）下导致
      // error_during_execution。-p 已经把 prompt 当参数传入，无需 stdin。
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let finalText = '';
    let cliError = null;  // CLI 自报错误（auth/rate-limit 等），拦截后走 error 路径而非 done
    const allTexts = [];  // 收集所有 assistant text blocks
    const proc = this._proc;

    // 捕获 stderr —— Claude CLI 失败时错误信息在这里，之前完全丢弃导致静默失败
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    // 等进程退出拿 exit code
    const exitPromise = new Promise((resolve) => {
      proc.on('close', (code, signal) => resolve({ code, signal }));
      proc.on('error', (err) => resolve({ code: -1, signal: null, error: err.message }));
    });

    try {
      for await (const line of this._readLines(proc.stdout)) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === 'system' && ev.session_id) {
          if (isResume && ev.session_id !== this._sessionId) {
            console.warn(`[claude-client] resume drift: expected ${this._sessionId}, got ${ev.session_id}`);
          }
          this._sessionId = ev.session_id;
        } else if (ev.type === 'assistant' && ev.message) {
          // usage 事件：从 message.usage 提取 token 统计 → renderer header bar
          const usage = ev.message.usage;
          console.log(`[claude-client] assistant event: has_usage=${!!usage}, content_types=${JSON.stringify((ev.message.content||[]).map(b=>b.type))}`);
          if (usage) {
            yield {
              type: 'usage',
              content: '',
              raw: {
                input_tokens: usage.input_tokens || 0,
                cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
                cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                model: ev.message && ev.message.model || null,
              }
            };
          }
          const content = ev.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                allTexts.push(block.text);
                // Extract <say>...</say> tags → voice
                const sayRegex = /<say>([\s\S]*?)<\/say>/g;
                let match;
                while ((match = sayRegex.exec(block.text)) !== null) {
                  const voiceText = match[1].trim();
                  if (voiceText) {
                    yield { type: 'voice', content: voiceText };
                  }
                }
                // Show in terminal (stripped of <say>)
                const screenText = block.text.replace(/<say>[\s\S]*?<\/say>/g, '').trim();
                if (screenText) {
                  yield { type: 'text', content: screenText };
                }
              } else if (block.type === 'tool_use') {
                const name = block.name || '?';
                const inp = block.input || {};
                let desc;
                if (name === 'Read') desc = `📖 ${path.basename(inp.file_path || '')}`;
                else if (name === 'Edit') desc = `✏️ ${path.basename(inp.file_path || '')}`;
                else if (name === 'Write') desc = `📝 ${path.basename(inp.file_path || '')}`;
                else if (name === 'Bash') desc = `⚡ ${(inp.command || '').substring(0, 60)}`;
                else if (name === 'Grep') desc = `🔍 ${inp.pattern || ''}`;
                else if (name === 'Glob') desc = `📂 ${inp.pattern || ''}`;
                else if (name.startsWith('mcp__browser__browser_')) {
                  const tool = name.replace('mcp__browser__', '');
                  if (tool === 'browser_navigate') desc = `🌐 ${inp.url || ''}`;
                  else if (tool === 'browser_new_tab') desc = `🌐+ ${inp.url || ''}`;
                  else if (tool === 'browser_read_page') desc = '📄 读取页面结构';
                  else if (tool === 'browser_get_text') desc = '📄 读取页面文本';
                  else if (tool === 'browser_screenshot') desc = '📸 截图';
                  else if (tool === 'browser_click') desc = `👆 点击 ${inp.selector || ''}`;
                  else if (tool === 'browser_fill') desc = `✏️ 填写 ${inp.selector || ''}`;
                  else if (tool === 'browser_exec_js') desc = `⚡ JS: ${(inp.code || '').substring(0, 50)}`;
                  else if (tool === 'browser_tabs') desc = '📑 列出标签页';
                  else if (tool === 'browser_switch_tab') desc = `📑 切换标签 #${inp.id}`;
                  else desc = `🌐 ${tool}`;
                }
                else desc = `🔧 ${name}`;
                yield { type: 'tool', content: desc };
              }
            }
          }
        } else if (ev.type === 'result') {
          if (ev.session_id) this._sessionId = ev.session_id;
          console.log(`[claude-client] result event keys: ${Object.keys(ev).join(',')}`);
          // result 事件也可能带 usage（部分 CLI 版本）
          const resultUsage = ev.usage;
          if (resultUsage) {
            yield {
              type: 'usage',
              content: '',
              raw: {
                input_tokens: resultUsage.input_tokens || 0,
                cache_creation_input_tokens: resultUsage.cache_creation_input_tokens || 0,
                cache_read_input_tokens: resultUsage.cache_read_input_tokens || 0,
                output_tokens: resultUsage.output_tokens || 0,
              }
            };
          }
          // result.result 是权威最终回复（只有最后一段 assistant text）
          // 用它而非中间拼接，避免重复
          if (ev.result) finalText = ev.result;
          this._turnCount++;
          // CLI 在 auth 失败 / rate-limit / 用量超限时仍发 result 事件，但把错误文本塞进 result。
          // 原样当 done 返回 → 调用方把错误文本当 Pi 的话推给 Owner（2026-04-17 pi-proactive 事故）。
          // 源头拦截：is_error 或匹配已知错误前缀 → 走 error 路径。
          const txt = String(ev.result || '').trim();
          if (ev.is_error === true ||
              /^(Failed to authenticate|API Error: 40[13]|Not logged in|You've hit your limit)/i.test(txt)) {
            // Claude CLI 有时把错误放在 ev.errors 数组而不是 ev.result 文本里
            const errArr = Array.isArray(ev.errors) ? ev.errors.filter(Boolean).join('; ') : '';
            cliError = txt || errArr || `CLI error (subtype=${ev.subtype || '?'})`;
          }
        }
      }
    } catch (err) {
      yield { type: 'error', content: err.message };
      return;
    }

    // 等进程退出，拿 exit code
    const exit = await exitPromise;

    // Fallback: 如果 stream-json 没给 usage（大部分 CLI 版本不在 stdout 里输出 usage），
    // 从 JSONL 文件读取最后一条 assistant 消息的 usage。JSONL 一定有。
    if (this._sessionId) {
      try {
        // Claude CLI 用 vault path 编码成 project dir name：所有非 [a-zA-Z0-9]
        // 字符（/、_、. 等）都转成 `-`。只替换 `/` → `-` 会让含 `_` 的路径
        // （如 `~/my_vault`）算出 `-Users-x-my_vault`，但实际目录是
        // `-Users-x-my-vault`，existsSync 永远 false，fallback 全程失效。
        const vaultEncoded = (cwd || vaultPath).replace(/[^a-zA-Z0-9]/g, '-');
        const jsonlPath = path.join(process.env.HOME || '', '.claude', 'projects',
          vaultEncoded, `${this._sessionId}.jsonl`);
        const jsonlFs = require('fs');
        if (jsonlFs.existsSync(jsonlPath)) {
          // 只读文件末尾 8KB，避免读整个大 JSONL
          const stat = jsonlFs.statSync(jsonlPath);
          const readSize = Math.min(stat.size, 8192);
          const fd = jsonlFs.openSync(jsonlPath, 'r');
          const buf = Buffer.alloc(readSize);
          jsonlFs.readSync(fd, buf, 0, readSize, stat.size - readSize);
          jsonlFs.closeSync(fd);
          const tail = buf.toString('utf-8');
          const lines = tail.split('\n').filter(l => l.trim());
          // 从后往前找最后一条带 usage 的 assistant 消息
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.type === 'assistant' && entry.message && entry.message.usage) {
                const u = entry.message.usage;
                yield {
                  type: 'usage',
                  content: '',
                  raw: {
                    input_tokens: u.input_tokens || 0,
                    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
                    cache_read_input_tokens: u.cache_read_input_tokens || 0,
                    output_tokens: u.output_tokens || 0,
                  }
                };
                break;
              }
            } catch {}
          }
        }
      } catch (e) {
        console.warn('[claude-client] JSONL usage fallback failed:', e.message);
      }
    }

    // CLI 自报错误（result 事件里带错误文本）→ 走 error 路径，绝不能当 done 返回
    if (cliError) {
      console.error(`[claude-client] CLI reported error: ${cliError.substring(0, 300)}`);
      // 把已知错误转成用户能 actionable 的中文提示，避免 renderer 沉默不渲染或纯英文
      // 错误文本让用户摸不着头脑（2026-04-29 fresh 装机用户报"Claude 没回复"事件）。
      let userMsg = cliError;
      if (/Not logged in|Please run \/login/i.test(cliError)) {
        userMsg = '❌ Claude CLI 未登录。请在终端跑 `claude /login`（或 `claude setup-token` 拿长效 token）完成认证后，回 PiOS 重新发送本条消息。';
      } else if (/Failed to authenticate|API Error: 401|API Error: 403/i.test(cliError)) {
        userMsg = '❌ Claude CLI 认证失败。token 可能过期，请在终端跑 `claude /login` 重新登录。原始错误：' + cliError;
      } else if (/You've hit your limit/i.test(cliError)) {
        userMsg = '❌ Claude 用量到上限。等 5h/7d 窗口刷新或升级 plan。原始：' + cliError;
      }
      yield { type: 'error', content: userMsg };
      return;
    }

    // 用 result 的权威文本，如果没有就用最后一个 text block
    if (!finalText && allTexts.length > 0) {
      finalText = allTexts[allTexts.length - 1];
    }

    // 无内容 = 异常，不管 exit code（做完工具调用但 exit 0 也算异常）
    if (!finalText) {
      const parts = [];
      if (stderrBuf.trim()) parts.push(stderrBuf.trim().substring(0, 300));
      parts.push(`exit=${exit.code ?? '?'} signal=${exit.signal ?? 'none'}`);
      const errMsg = parts.join(' | ');
      console.error(`[claude-client] CLI returned no text: code=${exit.code} signal=${exit.signal} stderr=${stderrBuf.substring(0, 500)}`);
      yield { type: 'error', content: errMsg };
      // 如果 --resume 失败，清掉 sessionId 让下次重新开始而不是反复失败
      if (stderrBuf.includes('session') || stderrBuf.includes('resume') || stderrBuf.includes('not found')) {
        console.warn('[claude-client] clearing stale sessionId due to resume failure');
        this._sessionId = null;
      }
      return;
    }

    yield { type: 'done', content: finalText };
  }

  stop() {
    if (this._proc && !this._proc.killed && this._proc.exitCode === null) {
      this._proc.kill('SIGTERM');
      // SIGTERM 可能被 Claude 子进程忽略（正在跑 bash），500ms 后强杀
      const ref = this._proc;
      setTimeout(() => {
        if (ref && !ref.killed && ref.exitCode === null) {
          ref.kill('SIGKILL');
        }
      }, 500);
    }
  }

  async *_readLines(stream) {
    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        yield buffer.substring(0, idx);
        buffer = buffer.substring(idx + 1);
      }
    }
    if (buffer.trim()) yield buffer;
  }
}

// Singleton
let _client = null;
function getClaudeClient() {
  if (!_client) _client = new ClaudeCodeClient();
  return _client;
}

module.exports = { ClaudeCodeClient, getClaudeClient };
