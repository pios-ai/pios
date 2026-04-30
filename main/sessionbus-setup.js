// SessionBus v2 + 4 个 engine adapter + ContextInjector 注册
// 提取自 main.js "SessionBus v2（刀 1 + 刀 2 spike）" 段。
// 对应卡片：Cards/archive/pibrowser-session-model-v2.md

function setup(deps) {
  const {
    vaultRoot,
    MAIN_SESSION_ID,
    loadSessions,
    getMainWindow,
    getTTS,
    prepareGPTRequest,
    prepareCodexRequest,
  } = deps;

  const { getSessionBus } = require('../backend/session-bus');
  const { ClaudeInteractiveAdapter } = require('../backend/adapters/claude-interactive');
  const { GPTDirectAdapter } = require('../backend/adapters/gpt-direct');
  const { CodexInteractiveAdapter } = require('../backend/adapters/codex-interactive');
  const { RunSessionAdapter } = require('../backend/adapters/run-session');
  const { ContextInjector } = require('../backend/context-injector');

  const sessionBus = getSessionBus();

  sessionBus.registerAdapter(
    'claude',
    new ClaudeInteractiveAdapter({
      getTTS: () => {
        try { return getTTS(); } catch { return null; }
      },
      onAudio: (sessionId, buf) => {
        const mw = getMainWindow();
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('session:audio', sessionId, buf);
        }
      },
    })
  );

  // 刀 2 spike：GPT + Codex adapter + context injector 注册，但 renderer 老路径还没切过来。
  const contextInjector = new ContextInjector({
    loadSessions,
    mainSessionId: MAIN_SESSION_ID,
  });

  sessionBus.registerAdapter(
    'gpt',
    new GPTDirectAdapter({
      prepareRequest: prepareGPTRequest,
    })
  );

  sessionBus.registerAdapter(
    'codex',
    new CodexInteractiveAdapter({
      prepareRequest: prepareCodexRequest,
    })
  );

  // 刀 3: RunSessionAdapter 给后台 task session 用（registerSession 时用 engineKey 'run'）
  sessionBus.registerAdapter(
    'run',
    new RunSessionAdapter({ vaultRoot }),
  );

  // 把 bus 的所有事件转发到 renderer（按 sessionId 路由在 renderer 侧处理）
  sessionBus.subscribeAll((payload) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try { mw.webContents.send('session:event', payload); } catch {}
    }
  });

  return { sessionBus, contextInjector };
}

module.exports = { setup };
