/**
 * Codex MCP Client — Node.js 版
 * 移植自 Projects/voice-companion/codex_mcp_client.py
 *
 * 通过 stdio MCP 协议与 codex mcp-server 保持长连接。
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const VAULT_ROOT = require('./vault-root');

// Auto-detect codex binary: env override → PATH lookup → well-known locations
const CODEX_BIN = process.env.CODEX_BIN ||
  (() => {
    const { execSync } = require('child_process');
    const fs = require('fs');
    try { return execSync('which codex', { encoding: 'utf-8' }).trim(); } catch {}
    // Check well-known locations
    const candidates = [
      path.join(process.env.HOME || '', '.npm-global/bin/codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ];
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    return 'codex'; // fallback to PATH
  })();
const NODE_PATH = process.platform === 'darwin'
  ? '/opt/homebrew/opt/node/bin'
  : path.dirname(process.execPath);
const DEFAULT_CODEX_TIMEOUT_MS = 300000;

class CodexMCPClient {
  constructor() {
    this._proc = null;
    this._msgId = 0;
    this._pending = new Map(); // id -> { resolve, reject }
    this._started = false;
    this._startPromise = null;
    this._fullAuto = false; // 当前 MCP server 的沙箱模式
  }

  async start({ fullAuto = false } = {}) {
    // 模式变更时重启 MCP server
    if (this._started && this._proc && !this._proc.killed) {
      if (this._fullAuto !== fullAuto) {
        console.log(`[codex-mcp] permission mode changed (${this._fullAuto ? 'safe' : 'full'} → ${fullAuto ? 'safe' : 'full'}), restarting`);
        await this.stop();
      } else {
        return;
      }
    }
    this._fullAuto = fullAuto;

    const env = {
      ...process.env,
      PATH: `${NODE_PATH}:${path.dirname(CODEX_BIN)}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`
    };

    const mcpArgs = ['mcp-server'];
    if (fullAuto) {
      mcpArgs.push('-c', 'approval_policy="on-request"', '-c', 'sandbox="workspace-write"');
    }
    this._proc = spawn(CODEX_BIN, mcpArgs, {
      cwd: VAULT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });

    this._proc.on('exit', (code) => {
      console.log(`[codex-mcp] process exited with code ${code}`);
      this._started = false;
      // Reject all pending
      for (const [id, { reject }] of this._pending) {
        reject(new Error('MCP server exited'));
      }
      this._pending.clear();
    });

    this._proc.stderr.on('data', (data) => {
      console.error(`[codex-mcp stderr] ${data.toString().trim()}`);
    });

    // Read loop
    const rl = readline.createInterface({ input: this._proc.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        const id = msg.id;
        if (id !== undefined && this._pending.has(id)) {
          const { resolve, reject } = this._pending.get(id);
          this._pending.delete(id);
          if (msg.error) {
            reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result || {});
          }
        }
      } catch (e) {
        // Non-JSON output, ignore
      }
    });

    // MCP initialize handshake
    const resp = await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pios', version: '0.1' }
    });
    console.log('[codex-mcp] initialized:', resp.serverInfo?.name, resp.serverInfo?.version);

    // Send initialized notification
    this._notify('notifications/initialized');
    this._started = true;
  }

  async stop() {
    if (this._proc && !this._proc.killed) {
      this._proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!this._proc.killed) this._proc.kill('SIGKILL');
    }
    this._proc = null;
    this._started = false;
    this._pending.clear();
  }

  async call(prompt, { timeout = DEFAULT_CODEX_TIMEOUT_MS, model, cwd, fullAuto } = {}) {
    return this._withRetry(async () => {
      await this._ensureStarted({ fullAuto });
      const args = { prompt };
      if (model) args.model = model;
      args.cwd = cwd || VAULT_ROOT;
      const resp = await this._send('tools/call', {
        name: 'codex',
        arguments: args
      }, timeout);
      return this._extractResult(resp);
    });
  }

  async reply(threadId, prompt, { timeout = DEFAULT_CODEX_TIMEOUT_MS, fullAuto } = {}) {
    return this._withRetry(async () => {
      await this._ensureStarted({ fullAuto });
      const resp = await this._send('tools/call', {
        name: 'codex-reply',
        arguments: { threadId, prompt }
      }, timeout);
      return this._extractResult(resp);
    });
  }

  async _withRetry(fn, retries = 1) {
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === retries) throw err;
        console.warn(`[codex-mcp] retrying after: ${err.message}`);
        await this.stop();
      }
    }
  }

  _extractResult(resp) {
    // Check MCP isError flag — 401/auth errors often come back as isError:true with error text in content
    if (resp.isError) {
      const contentList = resp.content || [];
      const errorText = contentList.filter(i => i.type === 'text').map(i => i.text).join('\n');
      throw new Error(errorText || 'MCP tool returned isError');
    }

    const structured = resp.structuredContent;
    if (structured && structured.content) return structured;

    const contentList = resp.content || [];
    const texts = contentList
      .filter(item => item.type === 'text')
      .map(item => item.text);
    return { threadId: '', content: texts.join('\n') };
  }

  async _ensureStarted({ fullAuto = false } = {}) {
    // 模式变更需要重启
    if (this._started && this._proc && !this._proc.killed && this._fullAuto !== fullAuto) {
      await this.stop();
    }
    if (!this._started || !this._proc || this._proc.killed) {
      if (!this._startPromise) {
        this._startPromise = this.start({ fullAuto }).finally(() => {
          this._startPromise = null;
        });
      }
      await this._startPromise;
    }
  }

  _send(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      this._msgId++;
      const id = this._msgId;
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;

      this._pending.set(id, { resolve, reject });

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP call ${method} timed out after ${timeout}ms`));
      }, timeout);

      // Wrap resolve/reject to clear timer
      const origResolve = resolve;
      const origReject = reject;
      this._pending.set(id, {
        resolve: (val) => { clearTimeout(timer); origResolve(val); },
        reject: (err) => { clearTimeout(timer); origReject(err); }
      });

      this._proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  _notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this._proc.stdin.write(JSON.stringify(msg) + '\n');
  }
}

// Singleton
let _client = null;

function getClient() {
  if (!_client) _client = new CodexMCPClient();
  return _client;
}

module.exports = { CodexMCPClient, getClient };
