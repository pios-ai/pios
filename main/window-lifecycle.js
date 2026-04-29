// mainWindow 生命周期事件 + app close hooks
// 提取自 main.js app.whenReady 块尾部 + app.on('before-quit'/'activate')。

const fs = require('fs');

function attach(deps) {
  const {
    app,
    getMainWindow,
    getCurrentMode,
    layoutActiveTab,
    saveTabs,
    flushSessionsToDisk,
    windowStateFile,
  } = deps;

  let lastNormalBounds = null;

  const mainWindow = getMainWindow();
  if (!mainWindow) throw new Error('window-lifecycle.attach: mainWindow not ready');
  lastNormalBounds = mainWindow.getBounds();

  // 关闭窗口时最小化到 Tray（macOS 行为）
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    saveTabs();
    // 2026-04-22 bug 修：saveSessions 是 debounced 800ms 写盘，如果 Cmd+Q 发生在 debounce 窗口内
    // （例如刚点 Call Pi 分配 groupId 后立刻退出），cache 里的变更永远没落盘 → 重启看到旧数据
    // （比如新会话不在 "Things Need You" 分组、标题没保存等）。这里强制 flush 一次，跳过 debounce。
    try { flushSessionsToDisk(); } catch {}
  });

  // 点 Dock 图标 / Cmd+Tab 重新显示并聚焦
  app.on('activate', () => {
    const mw = getMainWindow();
    if (mw) {
      if (app.dock) app.dock.show();
      if (mw.isMinimized()) mw.restore();
      mw.show();
      mw.focus();
    }
  });

  // 确保 app 始终出现在 Cmd+Tab 切换器中
  mainWindow.on('hide', () => {
    if (app.dock) app.dock.show();
  });

  // 窗口状态保存（用 lastNormalBounds 避开 maximize/fullscreen 时的非正常尺寸）
  mainWindow.on('resize', () => {
    if (getCurrentMode() === 'browser') layoutActiveTab();
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      lastNormalBounds = mainWindow.getBounds();
    }
  });

  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      lastNormalBounds = mainWindow.getBounds();
    }
  });

  mainWindow.on('close', () => {
    const state = {
      ...lastNormalBounds,
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    };
    try { fs.writeFileSync(windowStateFile, JSON.stringify(state)); } catch {}
  });
}

module.exports = { attach };
