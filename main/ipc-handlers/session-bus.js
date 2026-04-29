'use strict';

const path = require('path');
const fs = require('fs');

// ── SessionBus IPC handlers ──
// 依赖：ipcMain, { sessionBus, vaultRoot }

module.exports = { register };

function _getSkipPermissions(vaultRoot) {
  try {
    const yaml = require('js-yaml');
    const manifestPath = path.join(vaultRoot, 'Pi', 'Config', 'pios.yaml');
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    return !!(manifest && manifest.infra && manifest.infra.claude_settings && manifest.infra.claude_settings.skip_permissions);
  } catch { return false; }
}

function register(ipcMain, { sessionBus, vaultRoot }) {
  ipcMain.handle('session:attach', async (_, { sessionId, engine, meta }) => {
    try {
      if (!sessionBus.hasAdapter(engine)) {
        return { ok: false, error: `engine "${engine}" not supported by session bus v2 yet` };
      }
      sessionBus.registerSession(sessionId, engine, meta || {});
      await sessionBus.attach(sessionId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ensure: 只在未注册或引擎不同时 register，保留现有 client 的 _sessionId（--resume 连续性）
  ipcMain.handle('session:ensure', async (_, { sessionId, engine, claudeSessionId, codexThreadId }) => {
    try {
      const existing = sessionBus.getSession(sessionId);
      if (existing && existing.engine === engine) return { ok: true, reused: true };
      // 引擎不同 → forget 旧的再重建
      if (existing) sessionBus.forgetSession(sessionId);
      if (!sessionBus.hasAdapter(engine)) {
        return { ok: false, error: `engine "${engine}" not supported` };
      }
      sessionBus.registerSession(sessionId, engine, {});
      // 传已保存的 session/thread 身份给 adapter，避免切会话/重启后丢上下文。
      await sessionBus.attach(sessionId, { claudeSessionId, codexThreadId });
      return { ok: true, reused: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('session:send', async (_, { sessionId, text, opts }) => {
    try {
      // 容错：send 前若未注册就按 opts.engine（默认 claude）注册
      if (!sessionBus.getSession(sessionId)) {
        const engine = (opts && opts.engine) || 'claude';
        if (!sessionBus.hasAdapter(engine)) {
          return { error: `engine "${engine}" not supported by session bus v2 yet` };
        }
        sessionBus.registerSession(sessionId, engine, (opts && opts.meta) || {});
      }
      const yamlSkip = _getSkipPermissions(vaultRoot);
      // per-session permissionLevel 优先；fallback 到 yaml 全局配置
      const permissionLevel = (opts && opts.permissionLevel) || (yamlSkip ? 'full' : 'safe');
      const skipPermissions = permissionLevel === 'full';
      const result = await sessionBus.send(sessionId, text, { skipPermissions, permissionLevel, ...(opts || {}) });
      return result;
    } catch (e) {
      // 友好错误：按当前 session 的真实引擎返回，不要把 Codex 错误伪装成 Claude。
      const msg = e.message || '';
      const engine = sessionBus.getSession(sessionId)?.engine || (opts && opts.engine) || 'claude';
      if (msg.includes('401') || msg.includes('authentication') || msg.includes('unauthorized')) {
        if (engine === 'codex') {
          return { error: 'Codex 未认证。请在终端运行 codex login，或到 Resources 页面重新登录。' };
        }
        return { error: 'Claude 未认证。请在终端运行 claude login 完成登录，然后重试。' };
      }
      if (msg.includes('ENOENT') || /command not found|spawn .*ENOENT/i.test(msg)) {
        if (engine === 'codex') {
          return { error: 'Codex CLI 未安装。请先安装 codex，并确认命令在 PATH 里可见。' };
        }
        return { error: 'Claude CLI 未安装。请先安装：npm install -g @anthropic-ai/claude-code' };
      }
      if (/timed out after \d+ms/i.test(msg) && engine === 'codex') {
        return { error: 'Codex 响应超时。PiBrowser 已把等待时间放宽到 5 分钟；如果还是超时，这次请求更像长任务，建议切 Claude/Agent 路径处理。' };
      }
      return { error: msg };
    }
  });

  // tick 7: handle (async) 而不是 on (fire-and-forget)，让 renderer 能 await
  // SIGINT + wait jsonl 写完 的完成（task session 路径最多 10s）
  ipcMain.handle('session:interrupt', async (_, sessionId) => {
    try {
      return await sessionBus.interrupt(sessionId);
    } catch (e) {
      console.warn('[session:interrupt]', e.message);
      return false;
    }
  });

  ipcMain.on('session:forget', (_, sessionId) => {
    try { sessionBus.forgetSession(sessionId); } catch {}
  });
}
