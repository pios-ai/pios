// main/app-menu.js
// App menu bar (Menu.buildFromTemplate) + Cmd+Shift+J quick input window.
// Call setup(ipcMain, deps) inside app.whenReady().

const { app, Menu, globalShortcut, BrowserWindow } = require('electron');

function setup(ipcMain, { APP_VERSION, createTab, closeTab, switchToChatMode, getMainWindow, getActiveTabId, getTabs }) {
  // ── App Menu (accelerators, only active when app is focused) ──
  // 用 Menu accelerator 代替 globalShortcut，只在 app 聚焦时生效
  const menu = Menu.buildFromTemplate([
    {
      label: 'Pi',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: '新标签页', accelerator: 'CmdOrCtrl+T', click: () => createTab('http://127.0.0.1:17891/home') },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => { if (getActiveTabId()) closeTab(getActiveTabId()); } },
        { type: 'separator' },
        { label: '添加书签', accelerator: 'CmdOrCtrl+D', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab) getMainWindow().webContents.send('bookmarks:promptAdd', { title: tab.title, url: tab.url });
        }},
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: '页面内搜索', accelerator: 'CmdOrCtrl+F', click: () => {
          getMainWindow().webContents.send('browser:showFind');
        }},
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab && tab.view) tab.view.webContents.setZoomLevel(Math.min(tab.view.webContents.getZoomLevel() + 0.5, 5));
        }},
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab && tab.view) tab.view.webContents.setZoomLevel(Math.max(tab.view.webContents.getZoomLevel() - 0.5, -5));
        }},
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab && tab.view) tab.view.webContents.setZoomLevel(0);
        }},
        { type: 'separator' },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab && tab.view) tab.view.webContents.reload();
        }},
        { role: 'togglefullscreen' },
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        { label: '后退', accelerator: 'CmdOrCtrl+[', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab && tab.view) tab.view.webContents.goBack();
        }},
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab && tab.view) tab.view.webContents.goForward();
        }},
        { type: 'separator' },
        { label: '历史记录', accelerator: 'CmdOrCtrl+Y', click: () => {
          getMainWindow().webContents.send('browser:showHistory');
        }},
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: '问 Pi (页面内容)', accelerator: 'CmdOrCtrl+J', click: () => {
          const tab = getTabs().find(t => t.id === getActiveTabId());
          if (tab && tab.view) {
            tab.view.webContents.executeJavaScript(
              `window.getSelection().toString() || document.body.innerText.substring(0, 3000)`
            ).then(text => {
              getMainWindow().webContents.send('terminal:context', text);
            }).catch(() => {});
          }
        }},
        { label: '切换引擎 Codex/Claude', accelerator: 'CmdOrCtrl+E', click: () => {
          getMainWindow().webContents.send('engine:toggle');
        }},
        { label: '切换侧边栏', accelerator: 'CmdOrCtrl+Shift+.', click: () => {
          getMainWindow().webContents.send('sidebar:toggle');
        }},
        { label: '全屏聊天', accelerator: 'CmdOrCtrl+\\', click: () => {
          getMainWindow().webContents.send('chat:fullscreen-toggle');
        }},
        { label: '切换会话列表', accelerator: 'CmdOrCtrl+Shift+B', click: () => {
          getMainWindow().webContents.send('session-sidebar:toggle');
        }},
        { label: '回到 Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => {
          getMainWindow().webContents.send('navigate:home');
        }},
        { label: 'Talk to Pi', accelerator: 'CmdOrCtrl+P', click: () => {
          getMainWindow().webContents.send('shortcut:talkToPi');
        }},
        { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => {
          getMainWindow().webContents.send('shortcut:newSession');
        }},
        { label: '清空会话', accelerator: 'CmdOrCtrl+Shift+K', click: () => {
          getMainWindow().webContents.send('shortcut:clearChat');
        }},
        { label: '插入/解绑页面', accelerator: 'CmdOrCtrl+I', click: () => {
          getMainWindow().webContents.send('shortcut:togglePageContext');
        }},
        { label: '语音输入', accelerator: 'CmdOrCtrl+Shift+V', click: () => {
          getMainWindow().webContents.send('shortcut:voiceToggle');
        }},
        { label: '查看快捷键', accelerator: 'CmdOrCtrl+/', click: () => {
          getMainWindow().webContents.send('shortcut:showHelp');
        }},
        { type: 'separator' },
        { label: '聚焦地址栏', accelerator: 'CmdOrCtrl+L', click: () => {
          getMainWindow().webContents.send('url:focus');
        }},
        { label: '命令面板', accelerator: 'CmdOrCtrl+K', click: () => {
          getMainWindow().webContents.send('command:palette');
        }},
        { label: '搜索对话', accelerator: 'CmdOrCtrl+Shift+F', click: () => {
          getMainWindow().webContents.send('chat:search');
        }},
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ]
    },
    {
      label: 'Tab',
      submenu: [
        { label: '下一个标签页', accelerator: 'CmdOrCtrl+Shift+]', click: () => {
          getMainWindow().webContents.send('tab:next');
        }},
        { label: '上一个标签页', accelerator: 'CmdOrCtrl+Shift+[', click: () => {
          getMainWindow().webContents.send('tab:prev');
        }},
        { type: 'separator' },
        ...[1,2,3,4,5,6,7,8,9].map(n => ({
          label: `标签页 ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => {
            getMainWindow().webContents.send('tab:switchByIndex', n - 1);
          }
        })),
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  // ── 全局快捷键：Cmd+Shift+J → 快捷小窗 ──
  let quickWin = null;
  let quickSent = false;
  globalShortcut.register('CommandOrControl+Shift+J', () => {
    if (quickWin && !quickWin.isDestroyed()) { quickWin.close(); return; }
    quickSent = false;
    const { screen } = require('electron');
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const x = Math.round(display.bounds.x + (display.bounds.width - 560) / 2);
    const y = display.bounds.y + display.bounds.height - 120;
    quickWin = new BrowserWindow({
      width: 560, height: 56, x, y,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, hasShadow: true,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    quickWin.loadFile('quick-input.html');
    quickWin.on('blur', () => {
      if (quickWin && !quickWin.isDestroyed()) {
        if (!quickSent) app.hide(); // 先隐藏 app，再关小窗
        quickWin.close();
      }
    });
    quickWin.on('closed', () => { quickWin = null; });
  });
  ipcMain.on('quick-dismiss', () => { if (quickWin && !quickWin.isDestroyed()) quickWin.close(); });
  ipcMain.on('quick-send', (_, text) => {
    quickSent = true;
    if (quickWin && !quickWin.isDestroyed()) quickWin.close();
    switchToChatMode();
    const mainWindow = getMainWindow();
    mainWindow.show();
    mainWindow.focus();
    // 等 renderer 处理完 mode:change 后再发送
    setTimeout(() => {
      mainWindow.webContents.executeJavaScript(`
        (async () => {
          try {
            if (typeof window._quickSend === 'function') {
              await window._quickSend(${JSON.stringify(text)});
            } else {
              console.error('[quick-send] _quickSend not found');
            }
          } catch(e) { console.error('[quick-send] error:', e.message); }
        })()
      `).catch(e => console.error('[quick-send exec]', e.message));
    }, 500);
  });
}

module.exports = { setup };
