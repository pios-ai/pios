const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pi', {
  // Modal overlay（BrowserView 压过 z-index 的通用解决方案）
  setModalOverlay: (open) => ipcRenderer.invoke('mainWindow:setModalOverlay', open),
  // 页面感知
  getPageContent: () => ipcRenderer.invoke('pi:getPageContent'),
  onPageContext: (callback) => ipcRenderer.on('page:contextUpdate', (_, ctx) => callback(ctx)),
  getStructuredPage: () => ipcRenderer.invoke('browser:getStructuredPage'),
  execJS: (code) => ipcRenderer.invoke('browser:execJS', code),
  screenshot: () => ipcRenderer.invoke('browser:screenshot'),

  // 导航
  navigate: (url) => ipcRenderer.send('browser:navigate', url),
  goBack: () => ipcRenderer.send('browser:goBack'),
  goForward: () => ipcRenderer.send('browser:goForward'),
  reload: () => ipcRenderer.send('browser:reload'),
  onNavigate: (callback) => ipcRenderer.on('browser:navigated', (_, url) => callback(url)),
  onNavState: (callback) => ipcRenderer.on('browser:navState', (_, state) => callback(state)),
  onLoading: (callback) => ipcRenderer.on('browser:loading', (_, loading) => callback(loading)),
  onLoadError: (callback) => ipcRenderer.on('browser:loadError', (_, err) => callback(err)),

  // 页面内搜索
  findInPage: (text) => ipcRenderer.send('browser:findInPage', text),
  onShowFind: (callback) => ipcRenderer.on('browser:showFind', () => callback()),

  // Tab 管理
  newTab: (url) => ipcRenderer.send('tab:new', url),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  switchTab: (id) => ipcRenderer.send('tab:switch', id),
  pinTab: (id) => ipcRenderer.send('tab:pin', id),
  showTabMenu: (id, x, y) => ipcRenderer.send('tab:contextmenu', id, x, y),
  backToChat: () => ipcRenderer.send('browser:backToChat'),
  restoreFromFullscreen: () => ipcRenderer.send('browser:restoreFromFullscreen'),
  restoreTabs: () => ipcRenderer.invoke('tabs:restore'),
  reorderTab: (dragId, dropId) => ipcRenderer.invoke('tabs:reorder', { dragId, dropId }),
  onTabsUpdated: (callback) => ipcRenderer.on('tabs:updated', (_, tabs) => callback(tabs)),

  // 侧边栏折叠/展开/调宽（通知 main 调整 BrowserView 宽度）
  sidebarCollapse: () => ipcRenderer.send('sidebar:collapse'),
  sidebarExpand: () => ipcRenderer.send('sidebar:expand'),
  sidebarResize: (width) => ipcRenderer.send('sidebar:resize', width),
  sessionSidebarOpen: () => ipcRenderer.send('session-sidebar:open'),
  sessionSidebarClose: () => ipcRenderer.send('session-sidebar:close'),

  // 书签
  bookmarksList: () => ipcRenderer.invoke('bookmarks:list'),
  bookmarksAdd: (data) => ipcRenderer.invoke('bookmarks:add', data),
  bookmarksRemove: (url) => ipcRenderer.invoke('bookmarks:remove', url),
  onBookmarkPrompt: (callback) => ipcRenderer.on('bookmarks:promptAdd', (_, data) => callback(data)),

  // 对话持久化（旧 API，保留兼容）
  saveConversation: (engine, role, content) => ipcRenderer.invoke('conversation:save', engine, role, content),
  loadConversations: () => ipcRenderer.invoke('conversation:load'),
  clearConversations: () => ipcRenderer.invoke('conversation:clear'),

  // 对话管理（多 session）
  sessionsList: () => ipcRenderer.invoke('sessions:list'),
  sessionLoad: (id) => ipcRenderer.invoke('sessions:load', id),
  sessionSave: (session) => ipcRenderer.invoke('sessions:save', session),
  sessionArchive: (id) => ipcRenderer.invoke('sessions:archive', id),
  sessionUnarchive: (id) => ipcRenderer.invoke('sessions:unarchive', id),
  sessionDeleteArchived: () => ipcRenderer.invoke('sessions:delete-archived'),
  sessionRename: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  sessionDelete: (id) => ipcRenderer.invoke('sessions:delete', id),
  sessionsListArchived: () => ipcRenderer.invoke('sessions:list-archived'),
  sessionGetActive: () => ipcRenderer.invoke('sessions:getActive'),
  onSessionsRefresh: (callback) => ipcRenderer.on('sessions:refresh', () => callback()),
  // 自定义分组
  groupsList: () => ipcRenderer.invoke('sessions:groups-list'),
  groupCreate: (name) => ipcRenderer.invoke('sessions:group-create', name),
  groupRename: (id, name) => ipcRenderer.invoke('sessions:group-rename', id, name),
  groupDelete: (id) => ipcRenderer.invoke('sessions:group-delete', id),
  sessionSetGroup: (sessionId, groupId) => ipcRenderer.invoke('sessions:set-group', sessionId, groupId),

  // 历史记录
  historyList: () => ipcRenderer.invoke('history:list'),
  historyRemove: (url) => ipcRenderer.invoke('history:remove', url),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  onShowHistory: (callback) => ipcRenderer.on('browser:showHistory', () => callback()),

  // 浏览记忆
  memoriesList: () => ipcRenderer.invoke('memories:list'),
  memoriesDelete: (filename) => ipcRenderer.invoke('memories:delete', filename),
  memoriesSearch: (query) => ipcRenderer.invoke('memories:search', query),

  // 隐私控制
  privacyList: () => ipcRenderer.invoke('privacy:list'),
  privacyAdd: (domain) => ipcRenderer.invoke('privacy:add', domain),
  privacyRemove: (domain) => ipcRenderer.invoke('privacy:remove', domain),
  privacyIncognito: (enabled) => ipcRenderer.invoke('privacy:incognito', enabled),
  privacyCheck: (url) => ipcRenderer.invoke('privacy:check', url),
  onPrivacyStatus: (callback) => ipcRenderer.on('privacy:status', (_, status) => callback(status)),

  // 下载通知
  onDownload: (callback) => ipcRenderer.on('browser:download', (_, info) => callback(info)),

  // 终端上下文
  onTerminalContext: (callback) => ipcRenderer.on('terminal:context', (_, text) => callback(text)),

  // 面板（打开时需隐藏 BrowserView，否则 native 层遮挡 HTML overlay）
  panelOpen: () => ipcRenderer.send('panel:open'),
  panelClose: () => ipcRenderer.send('panel:close'),

  // 引擎切换（Cmd+E）
  onEngineToggle: (callback) => ipcRenderer.on('engine:toggle', () => callback()),
  // 侧边栏切换（Cmd+Shift+.）
  onSidebarToggle: (callback) => ipcRenderer.on('sidebar:toggle', () => callback()),
  onChatFullscreenToggle: (callback) => ipcRenderer.on('chat:fullscreen-toggle', () => callback()),
  onSessionSidebarToggle: (callback) => ipcRenderer.on('session-sidebar:toggle', () => callback()),
  onNavigateHome: (callback) => ipcRenderer.on('navigate:home', () => callback()),
  onShortcutTalkToPi: (callback) => ipcRenderer.on('shortcut:talkToPi', () => callback()),
  onNewSession: (callback) => ipcRenderer.on('shortcut:newSession', () => callback()),
  onClearChat: (callback) => ipcRenderer.on('shortcut:clearChat', () => callback()),
  onTogglePageContext: (callback) => ipcRenderer.on('shortcut:togglePageContext', () => callback()),
  requestPageContext: () => ipcRenderer.send('page:requestContext'),
  onVoiceToggle: (callback) => ipcRenderer.on('shortcut:voiceToggle', () => callback()),
  onShowShortcutHelp: (callback) => ipcRenderer.on('shortcut:showHelp', () => callback()),
  // CMD 三击快捷小窗
  onQuickInput: (callback) => ipcRenderer.on('quick-input:toggle', () => callback()),
  // 地址栏聚焦（Cmd+L）
  onUrlFocus: (callback) => ipcRenderer.on('url:focus', () => callback()),
  // Tab 切换
  onTabNext: (callback) => ipcRenderer.on('tab:next', () => callback()),
  onTabPrev: (callback) => ipcRenderer.on('tab:prev', () => callback()),
  onTabSwitchByIndex: (callback) => ipcRenderer.on('tab:switchByIndex', (_, idx) => callback(idx)),

  // 窗口模式
  onModeChange: (callback) => ipcRenderer.on('mode:change', (_, mode) => callback(mode)),
  onTalkToPi: (callback) => ipcRenderer.on('pios:talk', (_, text) => callback(text)),
  onCallPi: (callback) => ipcRenderer.on('pios:call-pi', (_, payload) => callback(payload)),
  onPiProactive: (callback) => ipcRenderer.on('pi:proactive', (_, msg) => callback(msg)),
  onTTSPlay: (callback) => ipcRenderer.on('tts:play', (_, buf) => callback(buf)),
  onTTSInterrupt: (callback) => ipcRenderer.on('tts:interrupt', () => callback()),
  // 通知 TTS 走 renderer 本地 voiceTTS（和对话 TTS 同一条路，不跨 IPC 传 buffer）
  // 2026-04-19 修：sendNotification 不再传 audio buffer（经 IPC 序列化 byteLength 丢失），
  // 只传 text string，renderer 自己调 voiceTTS 拿 buffer → audioQueue.enqueue
  onNotifySpeak: (callback) => ipcRenderer.on('notify:speak', (_, text) => callback(text)),
  ttsPlaybackState: (playing) => ipcRenderer.send('tts:playback-state', !!playing),
  onSidebarOverlay: (callback) => ipcRenderer.on('sidebar:overlay', (_, isOverlay) => callback(isOverlay)),
  onSessionOpen: (callback) => ipcRenderer.on('session:open', (_, id, engine) => callback(id, engine)),
  onSessionSidebarClose: (callback) => ipcRenderer.on('session-sidebar:close', () => callback()),
  onTabSessionSwitch: (callback) => ipcRenderer.on('session:switchToTab', (_, sessionId) => callback(sessionId)),
  onOpenConversation: (callback) => ipcRenderer.on('session:openConversation', (_, conversationId) => callback(conversationId)),
  onPluginActivation: (callback) => ipcRenderer.on('plugin:start-activation', (_, payload) => callback(payload)),

  // 语音 — 本地 ASR (whisper)
  voiceASR: (audioBuffer) => ipcRenderer.invoke('voice:asr', audioBuffer),

  // 引擎切换
  switchEngine: (engine) => ipcRenderer.send('engine:switch', engine),
  getEngine: () => ipcRenderer.invoke('engine:current'),

  // GPT Direct (Codex OAuth) —— 会话状态相关 API 保留；send/stop/delta 事件走 SessionBus
  // 刀 2 step 6b: 已删 `sendGPT/stopGPT/onGPTDelta/offGPTDelta/onGPTDone`
  resetGPT: () => ipcRenderer.send('gpt:reset'),
  restoreGPT: (messages) => ipcRenderer.send('gpt:restore', messages),

  // Claude Code —— reset 仍供 agent mode / 切会话时清 singleton 用
  // 刀 2 step 6b: 已删 `sendClaude/stopClaude/onClaudeEvent`
  resetClaude: () => ipcRenderer.send('claude:reset'),
  onClaudeAudio: (callback) => ipcRenderer.on('claude:audio', (_, buf) => callback(buf)),

  // ── SessionBus v2（刀 1）──
  // Feature flag in renderer/app.js 开启后走这套 API，所有事件统一带 sessionId/requestId 路由。
  sessionBusAttach: (sessionId, engine, meta) => ipcRenderer.invoke('session:attach', { sessionId, engine, meta }),
  sessionBusSend: (sessionId, text, opts) => ipcRenderer.invoke('session:send', { sessionId, text, opts }),
  // tick 7: 改 invoke 让 renderer 能 await（task session 的 SIGINT+wait 最长 10s）
  sessionBusInterrupt: (sessionId) => ipcRenderer.invoke('session:interrupt', sessionId),
  sessionBusForget: (sessionId) => ipcRenderer.send('session:forget', sessionId),
  // ensure: 如果已注册且引擎相同就跳过，不销毁 client（保留 _sessionId / --resume）
  sessionBusEnsure: (sessionId, engine, opts) => ipcRenderer.invoke('session:ensure', { sessionId, engine, ...(opts || {}) }),
  onSessionBusEvent: (callback) => ipcRenderer.on('session:event', (_, payload) => callback(payload)),
  onSessionBusAudio: (callback) => ipcRenderer.on('session:audio', (_, sessionId, buf) => callback(sessionId, buf)),

  // Agent Mode
  sendAgent: (task) => ipcRenderer.invoke('pi:agent', task),
  stopAgent: () => ipcRenderer.send('agent:stop'),
  onAgentEvent: (callback) => ipcRenderer.on('agent:event', (_, ev) => callback(ev)),
  agentConfirm: (confirmed) => ipcRenderer.send('agent:confirm', confirmed),

  // TTS（Codex 模式）
  voiceTTS: (text, preset) => ipcRenderer.invoke('voice:tts', text, preset),
  debugTrace: (tag, info) => ipcRenderer.invoke('debug:trace', tag, info),

  // 命令面板 & 对话搜索
  onCommandPalette: (callback) => ipcRenderer.on('command:palette', () => callback()),
  onChatSearch: (callback) => ipcRenderer.on('chat:search', () => callback()),

  // 截图保存到临时文件（返回文件路径）
  saveScreenshot: (base64) => ipcRenderer.invoke('browser:saveScreenshot', base64),

  // 文件选择器（返回 [{ name, ext, size, content, isImage, base64 }]）
  pickFiles: () => ipcRenderer.invoke('browser:pickFiles'),
  processFilePaths: (paths) => ipcRenderer.invoke('browser:processFilePaths', paths),
  parseFileBuffer: (name, arrayBuffer) => ipcRenderer.invoke('browser:parseFileBuffer', { name, arrayBuffer }),

  // 桌面通知
  notify: (title, body) => ipcRenderer.send('app:notify', title, body),

  // ── PiOS Engine ──
  piosListAgents: () => ipcRenderer.invoke('pios:agents'),
  piosGetAgent: (agentId) => ipcRenderer.invoke('pios:agent', agentId),
  piosLoadCards: (filter) => ipcRenderer.invoke('pios:cards', filter),
  piosAgentCards: (agentId) => ipcRenderer.invoke('pios:agent-cards', agentId),
  piosProjects: () => ipcRenderer.invoke('pios:projects'),
  piosDecisions: () => ipcRenderer.invoke('pios:decisions'),
  piosOverview: () => ipcRenderer.invoke('pios:overview'),
  piosPlugins: () => ipcRenderer.invoke('pios:plugins'),
  piosPluginList: () => ipcRenderer.invoke('pios:plugin-list'),
  piosPluginActivate: (id) => ipcRenderer.invoke('pios:plugin-activate', id),
  piosAgentWorkspace: (agentId) => ipcRenderer.invoke('pios:agent-workspace', agentId),
  piosUpdateAgentStatus: (agentId, status) => ipcRenderer.invoke('pios:update-agent-status', agentId, status),
  piosSyncCrontab: () => ipcRenderer.invoke('pios:sync-crontab'),
  piosSpawnAgent: (agentId) => ipcRenderer.invoke('pios:spawn-agent', agentId),
  piosIsInstalled: () => ipcRenderer.invoke('pios:is-installed'),
  piosGetConfig: () => ipcRenderer.invoke('pios:get-config'),
  piosInstall: (options) => ipcRenderer.invoke('pios:install', options),
  piosSetupDone: () => ipcRenderer.invoke('pios:setup-done'),
  piosStickNpc: (skinId) => ipcRenderer.invoke('pios:stick-npc', skinId),
  qwenStatus: () => ipcRenderer.invoke('pios:qwen-status'),
  qwenTtsWav: (opts) => ipcRenderer.invoke('pios:qwen-tts-wav', opts),
  qwenEnsureStarted: () => ipcRenderer.invoke('pios:qwen-ensure-started'),
  piosReadCard: (filename) => ipcRenderer.invoke('pios:read-card', filename),
  piosUpdateCard: (filename, updates) => ipcRenderer.invoke('pios:update-card', filename, updates),
  piosResolveDecision: (filename, decision) => ipcRenderer.invoke('pios:resolve-decision', filename, decision),
  piosMoveCard: (filename, toStatus) => ipcRenderer.invoke('pios:move-card', filename, toStatus),
  piosApproveReview: (filename, comment) => ipcRenderer.invoke('pios:approve-review', filename, comment),
  piosReworkReview: (filename, comment) => ipcRenderer.invoke('pios:rework-review', filename, comment),
  piosRespondToOwner: (filename, response, opts) => ipcRenderer.invoke('pios:respond-to-owner', filename, response, opts),
  piosDeferCard: (filename, until) => ipcRenderer.invoke('pios:defer-card', filename, until),
  piosApprovePermission: (filename) => ipcRenderer.invoke('pios:approve-permission', filename),
  piosRuntimes: () => ipcRenderer.invoke('pios:runtimes'),
  piosRuntimeRestart: (runtimeId) => ipcRenderer.invoke('pios:runtime-restart', runtimeId),
  piosRuntimeRefreshAuth: (runtimeId) => ipcRenderer.invoke('pios:runtime-refresh-auth', runtimeId),

  // App 版本
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Setup Wizard 第 0 页：环境检查 + 自动装
  depsCheck: () => ipcRenderer.invoke('deps:check'),
  depsInstall: (which) => ipcRenderer.invoke('deps:install', which),
  onDepsProgress: (cb) => {
    const listener = (_evt, which, chunk) => cb(which, chunk);
    ipcRenderer.on('deps:progress', listener);
    return () => ipcRenderer.removeListener('deps:progress', listener);
  },

});
