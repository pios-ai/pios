// main/bubble-npc-tray.js
// 浮动语音气泡（Bubble）+ NPC 化身系统 + Tray 菜单 + 相关 IPC
// Call setup(ipcMain, deps) inside app.whenReady().
// Returns { getPulse } so _tabMgrState / _browserCtrlState can reference pulse.

const { app, BrowserWindow, Menu, Tray, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// app root dir (one level up from this file which lives in main/)
const APP_ROOT = path.join(__dirname, '..');

function setup(ipcMain, { vaultRoot, APP_VERSION, getMainWindow, installer, markVoiceOnly, isWhisperHallucination }) {
  // ── 全局浮动语音气泡（必须在 Tray 之前定义，Tray 菜单引用 bubbleVisible/toggleBubble）──
  // NPC 相关常量（createBubbleWindow 启动时即引用，必须在函数定义前声明，避免 TDZ）
  const NPC_STATE_FILE = path.join(vaultRoot, 'Pi', 'State', 'pi-npc.json');
  const NPC_SIZE_LEVELS = [
    { w: 420, h: 400, css: '', label: '普通' },          // level 0
    { w: 520, h: 560, css: 'npc-big', label: '大' },     // level 1
    { w: 680, h: 720, css: 'npc-huge', label: '超大' },  // level 2
  ];
  const NPC_SIZE_OFF = { w: 56, h: 72 };
  let bubbleWin = null;
  let bubbleVisible = true;
  function createBubbleWindow() {
    if (bubbleWin && !bubbleWin.isDestroyed()) return;
    // 读 npc 状态决定初始尺寸（启用时直接用 NPC_SIZE_ON，避免先小后大导致 clamp 位置错位）
    let npcOnAtBoot = false;
    let savedPos = null;
    try {
      const j = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf8'));
      npcOnAtBoot = !!j.enabled;
      if (Number.isFinite(j.x) && Number.isFinite(j.y)) savedPos = { x: j.x, y: j.y };
    } catch {}
    let bootSizeLevel = 0;
    try { const jj = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf8')); bootSizeLevel = jj.sizeLevel || (jj.big ? 1 : 0); } catch {}
    const sz = npcOnAtBoot ? (NPC_SIZE_LEVELS[bootSizeLevel] || NPC_SIZE_LEVELS[0]) : NPC_SIZE_OFF;
    const w = sz.w;
    const h = sz.h;
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    // 优先用上次保存的位置；没有则默认右下角（留出窗口本身尺寸 + 留 20px 边距）
    let x, y;
    if (savedPos) {
      x = savedPos.x; y = savedPos.y;
    } else {
      x = display.bounds.x + display.bounds.width - w - 20;
      y = display.bounds.y + display.bounds.height - h - 20;
    }
    // clamp 到屏内，避免存了个屏外坐标或换屏分辨率变了
    const clamped = (() => {
      const pad = 8;
      const maxX = display.workArea.x + display.workArea.width - w - pad;
      const maxY = display.workArea.y + display.workArea.height - h - pad;
      const minX = display.workArea.x + pad;
      const minY = display.workArea.y + pad;
      return { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) };
    })();
    x = clamped.x; y = clamped.y;
    bubbleWin = new BrowserWindow({
      width: w, height: h, x, y,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, hasShadow: false,
      titleBarStyle: 'customButtonsOnHover',
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    // skipTransformProcessType: true —— 不加这个 option 的话，Electron 会把整个 app
    // 的 activation policy 从 ForegroundApplication 降到 UIElementApplication，
    // 等同 LSUIElement=true：Dock 图标消失、CMD+Tab 消失。见 Electron 文档：
    // https://www.electronjs.org/docs/latest/api/browser-window#winsetvisibleonallworkspacesvisible-options-macos
    bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    bubbleWin.setAlwaysOnTop(true, 'floating');
    // 默认整窗鼠标穿透（forward:true 让 renderer 仍收 mousemove 用于 hover 检测）。
    // renderer 检测到鼠标移到交互元素上时通过 bubble:set-ignore-mouse 关掉穿透。
    try { bubbleWin.setIgnoreMouseEvents(true, { forward: true }); } catch {}
    bubbleWin.loadFile(path.join(APP_ROOT, 'renderer', 'bubble.html'));
    bubbleWin.on('closed', () => { bubbleWin = null; });
    // bubble.html 加载完再推一次 NPC 状态，避免启动时 ipcRenderer.on 未注册导致 npc:enable 被吞
    bubbleWin.webContents.on('did-finish-load', () => {
      try {
        if (typeof npcEnabled !== 'undefined' && npcEnabled && bubbleWin && !bubbleWin.isDestroyed()) {
          bubbleWin.webContents.send('npc:enable', { skin: (typeof npcSkin !== 'undefined' ? npcSkin : 'patrick') });
        }
      } catch (e) { console.error('[npc] did-finish-load resend', e); }
    });
  }
  function toggleBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.close();
      bubbleVisible = false;
    } else {
      createBubbleWindow();
      bubbleVisible = true;
    }
  }
  // 未装完时不创建 NPC bubble，否则用户走 setup 时桌面就提前出现了一只 bubble。
  // setup 完成后由 pios:setup-done IPC handler 触发（global._createBubbleWindow）。
  global._createBubbleWindow = createBubbleWindow; // 让 ipcMain handler 跨 closure 调
  if (installer.isInstalled()) {
    createBubbleWindow();
  } else {
    console.log('[bubble] gated until setup-done (installer.isInstalled() === false)');
  }

  // ── NPC BEGIN ──（派大星化身 · 可插拔骨架，默认关闭）
  const PiPulse = require('../backend/pi-pulse');
  const piPersona = require('../backend/pi-persona');
  // 可用皮肤清单派生自 Pi/Config/characters.yaml（单一权威）。每个 skin 必须实现 11 个 pose
  // + 在 bubble.html 里以 `body.npc-enabled.skin-<id> #npc-<id>` 作为 CSS scope。详见 docs/components/pi-npc.md。
  // yaml 读不到时回落内置清单（pi-persona 的 BUILTIN_FALLBACK 已覆盖）。
  const NPC_SKINS = (() => {
    try {
      return piPersona.listCharacters().map(c => ({ id: c.skin || c.id, label: c.display_name || c.id }));
    } catch {
      return [
        { id: 'patrick', label: '派大星' }, { id: 'doraemon', label: '多啦A梦' },
        { id: 'baymax', label: '大白' }, { id: 'minion', label: '小黄人' },
        { id: 'kirby', label: '卡比' }, { id: 'totoro', label: '龙猫' },
        { id: 'slime', label: '史莱姆' }, { id: 'trump', label: '特朗普' },
        { id: 'starlet', label: '星仔' }, { id: 'shinchan', label: '蜡笔小新' },
      ];
    }
  })();
  const DEFAULT_NPC_SKIN = piPersona.DEFAULT_CHARACTER_ID || 'patrick';
  let npcEnabled = false;
  let npcSkin = DEFAULT_NPC_SKIN;
  let npcSizeLevel = 0; // 0=普通, 1=大, 2=超大
  let pulse = null; // Pi pulse 实例（httpServer / main scope 共享引用；通过 getPulse() 暴露）
  let npcSavedPos = null; // { x, y } 上次关闭时的位置
  function loadNpcState() {
    try {
      const j = JSON.parse(fs.readFileSync(NPC_STATE_FILE, 'utf8'));
      npcEnabled = !!j.enabled;
      npcSizeLevel = (Number.isFinite(j.sizeLevel) && j.sizeLevel >= 0 && j.sizeLevel < NPC_SIZE_LEVELS.length) ? j.sizeLevel : (j.big ? 1 : 0);
      if (typeof j.skin === 'string' && NPC_SKINS.some(s => s.id === j.skin)) npcSkin = j.skin;
      else npcSkin = DEFAULT_NPC_SKIN;
      if (Number.isFinite(j.x) && Number.isFinite(j.y)) npcSavedPos = { x: j.x, y: j.y };
    } catch { npcEnabled = false; npcSkin = DEFAULT_NPC_SKIN; npcSizeLevel = 0; npcSavedPos = null; }
  }
  function saveNpcState() {
    try {
      const dir = path.dirname(NPC_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = { enabled: npcEnabled, skin: npcSkin, sizeLevel: npcSizeLevel };
      if (npcSavedPos) { payload.x = npcSavedPos.x; payload.y = npcSavedPos.y; }
      fs.writeFileSync(NPC_STATE_FILE, JSON.stringify(payload, null, 2));
    } catch (e) { console.error('[npc] saveState', e); }
  }
  // 把 (x,y,w,h) 约束到当前主屏 workArea 内，留 8px 边距
  function _clampToScreen(x, y, w, h) {
    try {
      const { screen } = require('electron');
      const d = screen.getPrimaryDisplay().workArea;
      const pad = 8;
      const maxX = d.x + d.width - w - pad;
      const maxY = d.y + d.height - h - pad;
      const minX = d.x + pad;
      const minY = d.y + pad;
      return { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) };
    } catch { return { x, y }; }
  }
  function _npcResizeBubble(w, h) {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    try {
      bubbleWin.setResizable(true);
      const [rawX, rawY] = bubbleWin.getPosition();
      const { x, y } = _clampToScreen(rawX, rawY, w, h);
      // resizable:false 时 Electron 把 width/height 同时当 min+max，必须一起调
      bubbleWin.setMinimumSize(w, h);
      bubbleWin.setMaximumSize(w, h);
      // macOS transparent+frame:false 下 setSize 对内容区的支持优于窗口区，两个都调
      bubbleWin.setContentSize(w, h, false);
      bubbleWin.setSize(w, h, false);
      bubbleWin.setPosition(x, y);
      const actual = bubbleWin.getSize();
      console.log(`[npc] resize asked=${w}x${h} actual=${actual[0]}x${actual[1]} pos=${x},${y}`);
      bubbleWin.setResizable(false);
    } catch (e) { console.error('[npc] resize', e); }
  }
  function _npcSizeLevelInfo() { return NPC_SIZE_LEVELS[npcSizeLevel] || NPC_SIZE_LEVELS[0]; }
  function enableNpc() {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const lvl = _npcSizeLevelInfo();
    _npcResizeBubble(lvl.w, lvl.h);
    try { bubbleWin.webContents.send('npc:enable', { skin: npcSkin }); } catch {}
    try { bubbleWin.webContents.send('npc:size', { level: npcSizeLevel, css: lvl.css }); } catch {}
    if (!pulse) pulse = new PiPulse(vaultRoot, () => bubbleWin);
    try { pulse.start(); } catch (e) { console.error('[npc] start failed', e); }
  }
  function disableNpc() {
    try { pulse && pulse.stop(); } catch (e) { console.error('[npc] stop failed', e); }
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      try { bubbleWin.webContents.send('npc:disable'); } catch {}
      _npcResizeBubble(NPC_SIZE_OFF.w, NPC_SIZE_OFF.h);
    }
  }
  function toggleNpc() {
    npcEnabled = !npcEnabled;
    saveNpcState();
    if (npcEnabled) enableNpc(); else disableNpc();
  }
  function setNpcSizeLevel(level) {
    npcSizeLevel = Math.max(0, Math.min(NPC_SIZE_LEVELS.length - 1, level));
    saveNpcState();
    if (!npcEnabled || !bubbleWin || bubbleWin.isDestroyed()) return;
    const lvl = _npcSizeLevelInfo();
    _npcResizeBubble(lvl.w, lvl.h);
    try { bubbleWin.webContents.send('npc:size', { level: npcSizeLevel, css: lvl.css }); } catch {}
  }
  function setNpcSkin(skinId) {
    const skin = NPC_SKINS.find(s => s.id === skinId);
    if (!skin) return;
    if (npcSkin === skinId) return;
    npcSkin = skinId;
    saveNpcState();
    // 同步写入 pi-character.json（单一权威），让 personaBlock + voice 切到新戏服
    try { piPersona.setCharacter(skinId); } catch (e) { console.error('[npc] setCharacter sync failed', e.message); }
    // 热切：通知 renderer 换 body class（pulse 本身 skin-agnostic，不重启）
    if (npcEnabled && bubbleWin && !bubbleWin.isDestroyed()) {
      try { bubbleWin.webContents.send('npc:skin', { skin: npcSkin }); } catch {}
    }
    // 切皮肤立刻打招呼：让用户听到该皮肤对应的音色
    if (npcEnabled) {
      (async () => {
        try {
          const { getTTS } = require('../backend/qwen-tts');
          const tts = getTTS();
          const greet = `你好呀，我是${skin.label}`;
          const audio = await tts.speak(greet, 15000);
          const mainWindow = getMainWindow();
          if (audio && audio.length > 100 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tts:play', audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
          }
        } catch (e) { console.error('[npc:skin-greet]', e.message); }
      })();
    }
  }
  loadNpcState();
  if (npcEnabled) setTimeout(() => { try { enableNpc(); } catch (e) { console.error('[npc] auto-enable', e); } }, 800);

  // NPC 开发辅助：循环切 pose（不用 DevTools 也能看全部姿势）
  const NPC_POSES_FOR_TEST = ['thinking','working','sensing','reflecting','talking','recording','processing','alert','tired','watching','curious','remembering','delighted'];
  let npcTestIdx = -1;
  let npcTestTimer = null;
  function setTestPose(pose) {
    if (!bubbleWin || bubbleWin.isDestroyed() || !npcEnabled) return;
    try { bubbleWin.webContents.send('bubble:test-pose', pose); } catch {}
    if (npcTestTimer) clearTimeout(npcTestTimer);
    if (pose) {
      npcTestTimer = setTimeout(() => {
        try { bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.webContents.send('bubble:test-pose', null); } catch {}
      }, 3500);
    }
    return pose;
  }
  function testNextPose() {
    npcTestIdx = (npcTestIdx + 1) % NPC_POSES_FOR_TEST.length;
    return setTestPose(NPC_POSES_FOR_TEST[npcTestIdx]);
  }
  function openBubbleDevTools() {
    try { bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.webContents.openDevTools({ mode: 'detach' }); } catch (e) { console.error('[npc] devtools', e); }
  }
  // TTS 播放态 → pulse.setTalking（pulse 内部立即 _computeAndPush 推出 talking 或回真实 pose）
  ipcMain.on('tts:playback-state', (_, playing) => {
    if (!npcEnabled) return;
    try { pulse && pulse.setTalking(playing); } catch {}
  });
  // 派大星说话气泡：TTS 说什么都弹出来。窗口已永久高到足够放气泡，不再动态 resize（避免跳位）
  global._npcSpeak = function(text) {
    if (!npcEnabled) return;
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const s = String(text || '').trim();
    if (!s) return;
    try { bubbleWin.webContents.send('bubble:pulse', { type: 'speak', text: s }); } catch {}
  };
  // Pi Tab NPC bridge (accessed by HTTP /pi/data endpoint)
  global._piTabGetNpcInfo = function() {
    return { skins: NPC_SKINS.slice(), current: npcSkin };
  };
  global._piTabSetSkin = function(skinId) { setNpcSkin(skinId); };
  // 孵化仪式用：选完 NPC 直接写状态 —— 不调 setNpcSkin 的副作用（TTS greet / bubble 通知），
  // 因为孵化 preview 里 owner 刚听过该 NPC greet；且这时 setup 还没完 bubble 还没建，通知也没意义。
  // setup-done 时 createBubbleWindow + 补跑 enableNpc 让 pulse 起来。
  global._piStickNpcFromHatching = function(skinId) {
    try {
      const skin = NPC_SKINS.find(s => s.id === skinId);
      if (!skin) { console.warn('[hatching:stick-npc] unknown skinId:', skinId); return; }
      npcEnabled = true;
      npcSkin = skinId;
      saveNpcState();                                         // 写 pi-npc.json
      try { piPersona.setCharacter(skinId); } catch {}        // 写 pi-character.json（getNpcSkinVoice 源）
      console.log('[hatching] stuck NPC:', skinId);
    } catch (e) { console.error('[hatching:stick-npc]', e.message); }
  };
  // setup-done 后 bubble 刚创建完，补跑 enableNpc 让 pulse 起来 + bubble 切到 NPC 模式
  global._enableNpcAfterBubbleReady = function() {
    try {
      if (!npcEnabled || !bubbleWin || bubbleWin.isDestroyed()) return;
      // bubble 可能还没 did-finish-load，等一下再发
      setTimeout(() => {
        try { enableNpc(); } catch (e) { console.error('[hatching] post-bubble enableNpc failed:', e.message); }
      }, 800);
    } catch {}
  };
  // ── NPC END ──

  // 鼠标穿透开关（renderer 根据 hover 是否在交互元素上动态切换）
  ipcMain.on('bubble:set-ignore-mouse', (_, ignore) => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    try { bubbleWin.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {}
  });

  // 气泡拖拽
  let bubbleMoveSaveTimer = null;
  ipcMain.on('bubble:move', (_, dx, dy) => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const [x, y] = bubbleWin.getPosition();
    const nx = x + dx, ny = y + dy;
    bubbleWin.setPosition(nx, ny);
    // 拖拽停止 500ms 后保存（避免每帧写盘）
    npcSavedPos = { x: nx, y: ny };
    if (bubbleMoveSaveTimer) clearTimeout(bubbleMoveSaveTimer);
    bubbleMoveSaveTimer = setTimeout(() => {
      bubbleMoveSaveTimer = null;
      saveNpcState();
    }, 500);
  });

  // 全局快捷键：F5 → 切换录音（发到气泡窗口）
  globalShortcut.register('F5', () => {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.webContents.send('bubble:toggle-rec');
    }
  });

  // ── Tray (Menu Bar Icon) ──
  const trayIconPath = path.join(APP_ROOT, 'tray-iconTemplate.png');
  let tray = new Tray(trayIconPath);
  tray.setToolTip('PiOS');

  const notifySettingsFile = path.join(vaultRoot, 'Pi', 'Config', 'notify-settings.json');
  const getNotifySettings = () => {
    try { return JSON.parse(fs.readFileSync(notifySettingsFile, 'utf8')); } catch { return { voice: true, popup: true, freeVoice: false, reportTTS: false }; }
  };
  const buildTrayMenu = () => {
    const s = getNotifySettings();
    const voice = s.voice !== false;
    const popup = s.popup !== false;
    const freeVoice = s.freeVoice === true;
    const reportTTS = s.reportTTS === true;
    const save = (patch) => {
      fs.writeFileSync(notifySettingsFile, JSON.stringify({ ...s, ...patch }, null, 2));
      // 同步 freeVoice 到 TTS 实例
      if ('freeVoice' in patch) {
        try { const { getTTS } = require('../backend/qwen-tts'); getTTS().freeVoice = patch.freeVoice; } catch {}
      }
    };
    return Menu.buildFromTemplate([
      { label: `PiOS ${APP_VERSION}`, enabled: false },
      { type: 'separator' },
      { label: '打开 PiOS', click: () => { const w = getMainWindow(); w?.show(); w?.focus(); } },
      { type: 'separator' },
      {
        label: '通知',
        submenu: [
          { label: '弹窗', type: 'checkbox', checked: popup, click: () => { save({ popup: !popup }); tray.setContextMenu(buildTrayMenu()); } },
          { label: '语音', type: 'checkbox', checked: voice, click: () => { save({ voice: !voice }); tray.setContextMenu(buildTrayMenu()); } },
          { label: 'Report 也语音', type: 'checkbox', checked: reportTTS, click: () => { save({ reportTTS: !reportTTS }); tray.setContextMenu(buildTrayMenu()); } },
          { label: '自由音色（多人声）', type: 'checkbox', checked: freeVoice, click: () => { save({ freeVoice: !freeVoice }); tray.setContextMenu(buildTrayMenu()); } },
        ],
      },
      {
        label: '语音气泡',
        submenu: [
          { label: '显示气泡', type: 'checkbox', checked: bubbleVisible, click: () => { toggleBubble(); tray.setContextMenu(buildTrayMenu()); } },
          { label: 'NPC 模式', type: 'checkbox', checked: npcEnabled, click: () => { toggleNpc(); tray.setContextMenu(buildTrayMenu()); } },
          ...(npcEnabled ? [
            {
              label: 'NPC 皮肤',
              submenu: NPC_SKINS.map(s => ({
                label: s.label,
                type: 'checkbox',
                checked: npcSkin === s.id,
                click: () => { setNpcSkin(s.id); tray.setContextMenu(buildTrayMenu()); },
              })),
            },
            {
              label: 'NPC 大小',
              submenu: NPC_SIZE_LEVELS.map((lvl, i) => ({
                label: lvl.label,
                type: 'checkbox',
                checked: npcSizeLevel === i,
                click: () => { setNpcSizeLevel(i); tray.setContextMenu(buildTrayMenu()); },
              })),
            },
            {
              label: '测试 pose',
              submenu: [
                ...NPC_POSES_FOR_TEST.map(p => ({
                  label: p,
                  click: () => { setTestPose(p); },
                })),
                { type: 'separator' },
                { label: '↺ 回到 idle', click: () => { setTestPose(null); } },
                { label: '⟳ 循环下一个', click: () => { testNextPose(); } },
              ],
            },
            { type: 'separator' },
            { label: 'NPC DevTools（独立窗口）', click: () => { openBubbleDevTools(); } },
          ] : []),
        ],
      },
      { type: 'separator' },
      { label: '退出 PiOS', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
  };
  tray.setContextMenu(buildTrayMenu());

  // menubar / dock 徽标已下线：bubble + PiOS Home TNY 已是唯一数字入口，
  // 去掉 tray.setTitle / app.dock.setBadge 避免多源不同步（2026-04-24）

  // 气泡 IPC：语音 → ASR → 主会话 → GPT → TTS
  ipcMain.handle('bubble:voice-send', async (_, audioData) => {
    const os = require('os');
    const { execFile } = require('child_process');
    try {
      // ASR — 复用 voice:asr 的逻辑
      bubbleWin?.webContents.send('bubble:status', '识别中...');
      const tmpWebm = path.join(os.tmpdir(), `bubble-asr-${Date.now()}.webm`);
      const tmpWav = tmpWebm.replace('.webm', '.wav');
      fs.writeFileSync(tmpWebm, Buffer.from(audioData));

      const ffmpegBin = fs.existsSync('/opt/homebrew/bin/ffmpeg')
        ? '/opt/homebrew/bin/ffmpeg'
        : (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');
      try {
        await new Promise((resolve, reject) => {
          execFile(ffmpegBin, ['-y', '-i', tmpWebm, '-ar', '16000', '-ac', '1', tmpWav],
            { timeout: 5000 }, (err) => err ? reject(err) : resolve());
        });
      } catch (ffErr) {
        try { fs.unlinkSync(tmpWebm); } catch {}
        // ffmpeg 没装时 execFile 会 ENOENT——把具体原因回给 bubble，而不是静默 error:''
        const msg = /ENOENT|not found/i.test(ffErr.message || '')
          ? '缺 ffmpeg（brew install ffmpeg）'
          : `ffmpeg 转码失败：${ffErr.message}`;
        return { error: msg };
      }

      const wavStat = fs.statSync(tmpWav);
      const durationSec = (wavStat.size - 44) / (16000 * 2);
      if (durationSec < 0.6) { try { fs.unlinkSync(tmpWebm); fs.unlinkSync(tmpWav); } catch {} return { error: '' }; }

      const FormData = require('form-data');
      const httpLib = require('http');
      const form = new FormData();
      form.append('file', fs.createReadStream(tmpWav), { filename: 'audio.wav', contentType: 'audio/wav' });
      const userText = await new Promise((resolve, reject) => {
        const req = httpLib.request({ method: 'POST', hostname: 'localhost', port: 7860, path: '/api/asr', headers: form.getHeaders(), timeout: 15000 }, (res) => {
          let body = '';
          res.on('data', (c) => body += c);
          res.on('end', () => { try { resolve((JSON.parse(body).text || '').trim()); } catch { resolve(''); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('ASR timeout')); });
        form.pipe(req);
      });
      try { fs.unlinkSync(tmpWebm); fs.unlinkSync(tmpWav); } catch {}

      if (!userText || isWhisperHallucination(userText)) return { error: '' };

      console.log('[bubble] ASR:', userText);

      // 统一路由到 renderer 的 onTalkToPi 处理（走 SessionBus，不再直接调 GPT + 写 sessions.json）。
      // renderer 的 sendMessage 流程负责：SessionBus ensure → send → 流式显示 → 保存消息 → TTS。
      // 这样 F5 语音和 Home Talk to Pi 走完全相同的代码路径，避免三路并发写 pi-main 的竞态。
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 2026-04-23 · 标记"本轮语音输入"：prepareGPTRequest 消费一次后清
        // 让 Pi 知道 owner 没在看屏幕，全部回复都应放进 <say>
        markVoiceOnly();
        mainWindow.webContents.send('pios:talk', userText);
        // P6 · 用户等 Claude 期间显示 thinking 姿势（setTalking(true) 时自动清，60s 超时兜底）
        try { pulse && pulse.setThinking(true); } catch {}
      }
      return { ok: true, userText };
    } catch (e) {
      console.error('[bubble:voice-send]', e);
      return { error: e.message };
    }
  });

  ipcMain.on('bubble:interrupt-tts', () => {
    getMainWindow()?.webContents.send('tts:interrupt');
    // P6 · 打断 TTS = 对话链中止 → 清 thinking 避免卡住
    try { pulse && pulse.setThinking(false); pulse && pulse.setTalking(false); } catch {}
  });

  // 派大星 stream tag 点击 → 打开 PiOS Home 并聚焦指定 Card
  ipcMain.on('bubble:open-card', (_, arg) => {
    try {
      const stem = (arg && arg.stem) || '';
      const dir = (arg && arg.dir) || 'active';
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('mode:change', 'pios-home');
      if (stem) mainWindow.webContents.send('pios:focus-card', { stem, dir });
    } catch (e) { console.error('[bubble:open-card]', e); }
  });

  // Expose pulse for _tabMgrState / _browserCtrlState getters
  return { getPulse: () => pulse };
}

module.exports = { setup };
