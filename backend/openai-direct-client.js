/**
 * OpenAI Direct Client — 用 Codex OAuth token 直连 ChatGPT backend API
 * 参考 OpenClaw 的 openai-codex-responses.js 实现
 *
 * 端点: https://chatgpt.com/backend-api/codex/responses
 * 认证: Codex OAuth (ChatGPT subscription)
 * 网络: Node 原生 https.request + HttpsProxyAgent（和 openclaw 同栈）。
 *       早期版本用 curl spawn，在 Clash 代理下 TLS 握手频繁失败（curl 35：
 *       SSL_ERROR_SYSCALL / unexpected eof），试过换 Homebrew curl、加 retry
 *       都治标不治本。Node 的 OpenSSL + HttpsProxyAgent 对 CONNECT tunnel 处理
 *       稳得多，并且支持 minVersion:TLSv1.3 强制现代握手。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { StringDecoder } = require('string_decoder');

const AUTH_FILE = path.join(process.env.HOME || '', '.codex/auth.json');
const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

// 代理 URL 解析：env var → macOS networksetup（.app 启动时 env 没有 HTTPS_PROXY）
function _resolveProxyUrl() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    || process.env.https_proxy || process.env.http_proxy;
  if (fromEnv) return fromEnv;
  try {
    const { execSync } = require('child_process');
    const out = execSync('networksetup -getsecurewebproxy Wi-Fi', { encoding: 'utf-8', timeout: 2000 });
    const enabled = /Enabled:\s*Yes/i.test(out);
    const server = out.match(/Server:\s*(\S+)/)?.[1];
    const port = out.match(/Port:\s*(\d+)/)?.[1];
    if (enabled && server && port) return `http://${server}:${port}`;
  } catch {}
  return null;
}

class OpenAIDirectClient {
  constructor() {
    this._conversationHistory = [];
    this._maxHistory = 50;
  }

  _loadAuth() {
    if (!fs.existsSync(AUTH_FILE)) {
      throw new Error('Codex 未登录：找不到 ~/.codex/auth.json。请先运行 codex login');
    }
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    if (!auth.tokens?.access_token) {
      throw new Error('Codex token 无效：auth.json 中没有 access_token');
    }
    return auth.tokens.access_token;
  }

  _extractAccountId(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid JWT');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
      if (!accountId) throw new Error('No chatgpt_account_id in JWT');
      return accountId;
    } catch (e) {
      throw new Error(`无法从 token 解析 accountId: ${e.message}`);
    }
  }

  reset() {
    this._conversationHistory = [];
  }

  /**
   * 流式发送消息，每收到 delta 调用 onDelta(text)
   * 返回 { content, usage, abort() }
   */
  chatStream(userMessage, options = {}, onDelta) {
    const token = this._loadAuth();
    const accountId = this._extractAccountId(token);
    const model = options.model || 'gpt-5.5';

    this._conversationHistory.push({ role: 'user', content: userMessage });
    if (this._conversationHistory.length > this._maxHistory) {
      this._conversationHistory = this._conversationHistory.slice(-this._maxHistory);
    }

    // Build input: history is text-only; current (last) message gets images appended
    const images = options.images || []; // [{ base64, mimeType }]
    const input = this._conversationHistory.map((m, idx) => {
      const isLast = idx === this._conversationHistory.length - 1;
      const contentArr = [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }];
      if (isLast && m.role === 'user' && images.length) {
        images.forEach(({ base64, mimeType }) => {
          contentArr.push({ type: 'input_image', image_url: `data:${mimeType};base64,${base64}` });
        });
      }
      return { type: 'message', role: m.role, content: contentArr };
    });

    const body = {
      model, store: false, stream: true,
      instructions: options.systemPrompt || 'You are a helpful AI assistant. Use <say> tags for spoken content.',
      input,
      text: { verbosity: 'medium' },
      include: ['reasoning.encrypted_content'],
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const headers = {
      'Authorization': `Bearer ${token}`,
      'chatgpt-account-id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'User-Agent': 'pi-browser (darwin)',
    };

    const bodyStr = JSON.stringify(body);
    const timeout = options.timeout || 120000;
    const proxyUrl = _resolveProxyUrl();
    const url = new URL(CODEX_API_URL);

    let fullText = '';
    let usage = { input: 0, output: 0 };
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let req = null;

    const promise = new Promise((resolve, reject) => {
      const reqOptions = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
        minVersion: 'TLSv1.3',   // openclaw 同款：强制现代 TLS，Clash tunnel 下稳定
        timeout,
      };
      if (proxyUrl) {
        reqOptions.agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
      }

      req = https.request(reqOptions, (res) => {
        // 非 200 → 吃完 body 抛错（401/403/5xx 等）
        if (res.statusCode !== 200) {
          let errBody = '';
          res.setEncoding('utf-8');
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => {
            try {
              const obj = JSON.parse(errBody);
              if (obj.error?.message) return reject(new Error(obj.error.message));
              if (obj.detail) return reject(new Error(typeof obj.detail === 'string' ? obj.detail : JSON.stringify(obj.detail)));
            } catch {}
            reject(new Error(`HTTP ${res.statusCode}: ${errBody.substring(0, 300)}`));
          });
          return;
        }
        res.on('data', (chunk) => {
          buffer += decoder.write(chunk);
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.substring(0, idx);
            buffer = buffer.substring(idx + 2);
            const dataLines = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
            for (const data of dataLines) {
              if (!data || data === '[DONE]') continue;
              try {
                const ev = JSON.parse(data);
                if (ev.type === 'response.output_text.delta' && ev.delta) {
                  fullText += ev.delta;
                  if (onDelta) onDelta(ev.delta);
                }
                if (ev.type === 'response.output_text.done' && ev.text) fullText = ev.text;
                if (ev.type === 'response.completed' && ev.response?.usage) usage = ev.response.usage;
                if (ev.type === 'error') { reject(new Error(ev.message || JSON.stringify(ev))); res.destroy(); return; }
                if (ev.type === 'response.failed') { reject(new Error(ev.response?.error?.message || 'Response failed')); res.destroy(); return; }
              } catch {}
            }
          }
        });
        res.on('end', () => {
          buffer += decoder.end();
          if (fullText) this._conversationHistory.push({ role: 'assistant', content: fullText });
          resolve({ content: fullText, usage });
        });
        res.on('error', (e) => reject(new Error(`流读取失败: ${e.message}`)));
      });
      req.on('error', (e) => reject(new Error(`HTTPS 请求失败: ${e.message}`)));
      req.on('timeout', () => { req.destroy(new Error(`请求超时 ${timeout}ms`)); });
      req.write(bodyStr);
      req.end();
    });

    promise.abort = () => { if (req) req.destroy(); };
    return promise;
  }

  /**
   * 发送消息并获取完整回复（通过 Node 原生 https+HttpsProxyAgent 走系统代理）
   */
  async chat(userMessage, options = {}) {
    const token = this._loadAuth();
    const accountId = this._extractAccountId(token);
    const model = options.model || 'gpt-5.5';

    this._conversationHistory.push({ role: 'user', content: userMessage });
    if (this._conversationHistory.length > this._maxHistory) {
      this._conversationHistory = this._conversationHistory.slice(-this._maxHistory);
    }

    const input = this._conversationHistory.map(m => ({
      type: 'message',
      role: m.role,
      content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }]
    }));

    const body = {
      model,
      store: false,
      stream: true,
      instructions: options.systemPrompt || 'You are a helpful AI assistant. Use <say> tags for spoken content.',
      input,
      text: { verbosity: 'medium' },
      include: ['reasoning.encrypted_content'],
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const headers = {
      'Authorization': `Bearer ${token}`,
      'chatgpt-account-id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'User-Agent': 'pi-browser (darwin)',
    };

    const bodyStr = JSON.stringify(body);
    const timeout = options.timeout || 120000;
    const proxyUrl = _resolveProxyUrl();
    const url = new URL(CODEX_API_URL);

    return new Promise((resolve, reject) => {
      const reqOptions = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
        minVersion: 'TLSv1.3',
        timeout,
      };
      if (proxyUrl) {
        reqOptions.agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
      }

      let fullText = '';
      let usage = { input: 0, output: 0 };
      let buffer = '';
      const decoder2 = new StringDecoder('utf8');

      const req = https.request(reqOptions, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.setEncoding('utf-8');
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => {
            try {
              const obj = JSON.parse(errBody);
              if (obj.error?.message) return reject(new Error(obj.error.message));
              if (obj.detail) return reject(new Error(typeof obj.detail === 'string' ? obj.detail : JSON.stringify(obj.detail)));
            } catch {}
            reject(new Error(`HTTP ${res.statusCode}: ${errBody.substring(0, 300)}`));
          });
          return;
        }
        res.on('data', (chunk) => {
          buffer += decoder2.write(chunk);
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.substring(0, idx);
            buffer = buffer.substring(idx + 2);
            const dataLines = block.split('\n')
              .filter(l => l.startsWith('data:'))
              .map(l => l.slice(5).trim());
            for (const data of dataLines) {
              if (!data || data === '[DONE]') continue;
              try {
                const ev = JSON.parse(data);
                if (ev.type === 'response.output_text.delta' && ev.delta) fullText += ev.delta;
                if (ev.type === 'response.output_text.done' && ev.text) fullText = ev.text;
                if (ev.type === 'response.completed' && ev.response?.usage) usage = ev.response.usage;
                if (ev.type === 'error') { reject(new Error(ev.message || JSON.stringify(ev))); res.destroy(); return; }
                if (ev.type === 'response.failed') { reject(new Error(ev.response?.error?.message || 'Response failed')); res.destroy(); return; }
              } catch {}
            }
          }
        });
        res.on('end', () => {
          buffer += decoder2.end();
          if (fullText) this._conversationHistory.push({ role: 'assistant', content: fullText });
          resolve({ content: fullText, usage });
        });
        res.on('error', (e) => reject(new Error(`流读取失败: ${e.message}`)));
      });
      req.on('error', (e) => reject(new Error(`HTTPS 请求失败: ${e.message}`)));
      req.on('timeout', () => { req.destroy(new Error(`请求超时 ${timeout}ms`)); });
      req.write(bodyStr);
      req.end();
    });
  }
}

// Singleton
let _client = null;
function getOpenAIDirectClient() {
  if (!_client) _client = new OpenAIDirectClient();
  return _client;
}

module.exports = { OpenAIDirectClient, getOpenAIDirectClient };
