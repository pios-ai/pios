/**
 * BrowserView Preload — 在页面 JS 之前执行，反检测
 * 这个文件注入到每个 BrowserView（网页标签页），不是主窗口。
 */

// 在 main world 注入反检测（contextBridge 只能在 isolated world，
// 但我们需要修改 main world 的 navigator 等对象）
const { contextBridge, ipcRenderer } = require('electron');

// PiOS Home 页专用 IPC API（仅暴露给 Home 页，其他网页也能调但无 handler）
contextBridge.exposeInMainWorld('piHome', {
  // 深链接跳转：打开指定 conversationId 的会话
  openConversation: (conversationId) => ipcRenderer.send('home:openConversation', conversationId),
  // Plugin 管理（PiBrowser Resources → Plugins 用）
  pluginList: () => ipcRenderer.invoke('pios:plugin-list'),
  pluginActivate: (id) => ipcRenderer.invoke('pios:plugin-activate', id),
});

// 通过 executeJavaScript 无法在 page JS 之前执行，
// 但 preload 的顶层代码可以在 page JS 之前修改 window 属性——
// 前提是 contextIsolation: false。
// 如果 contextIsolation: true（默认），需要用 webFrame 注入。

const { webFrame } = require('electron');

// 在 main world 执行（page JS 能看到的 world）
webFrame.executeJavaScript(`
  // 1. navigator.webdriver = false
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. 伪造 chrome 对象
  if (!window.chrome) {
    window.chrome = {
      runtime: {
        id: undefined,
        connect: function() {},
        sendMessage: function() {},
        onMessage: { addListener: function() {}, removeListener: function() {} },
        onConnect: { addListener: function() {}, removeListener: function() {} },
      },
      loadTimes: function() { return {}; },
      csi: function() { return {}; },
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
    };
  }

  // 3. 伪造 plugins
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      var p = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
      ];
      p.item = function(i) { return this[i] || null; };
      p.namedItem = function(n) { return this.find(function(x){ return x.name === n; }) || null; };
      p.refresh = function() {};
      return p;
    }
  });

  // 4. 伪造 mimeTypes
  Object.defineProperty(navigator, 'mimeTypes', {
    get: function() {
      var m = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
      ];
      m.item = function(i) { return this[i] || null; };
      m.namedItem = function(n) { return this.find(function(x){ return x.type === n; }) || null; };
      return m;
    }
  });

  // 5. languages
  Object.defineProperty(navigator, 'languages', { get: function() { return ['zh-CN', 'zh', 'en-US', 'en']; } });
  Object.defineProperty(navigator, 'language', { get: function() { return 'zh-CN'; } });

  // 6. platform（确保一致）
  Object.defineProperty(navigator, 'platform', { get: function() { return 'MacIntel'; } });

  // 7. hardwareConcurrency（真实值可能被检测，伪造为常见值）
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: function() { return 8; } });

  // 8. deviceMemory
  Object.defineProperty(navigator, 'deviceMemory', { get: function() { return 8; } });

  // 9. maxTouchPoints（桌面 = 0）
  Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 0; } });

  // 10. connection（真 Chrome 有 NetworkInformation）
  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: function() { return { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }; }
    });
  }

  // 11. permissions 修补
  if (navigator.permissions) {
    var origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(params) {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: 'default', onchange: null });
      }
      return origQuery(params);
    };
  }

  // 12. 删除 Electron / Node 痕迹
  delete window.process;
  delete window.require;
  delete window.module;
  delete window.exports;
  delete window.__electron_webpack_hmr;
  delete window.Buffer;
  delete window.global;

  // 13. Notification 构造函数存在（Electron 可能没有）
  if (typeof Notification === 'undefined') {
    window.Notification = function() {};
    window.Notification.permission = 'default';
    window.Notification.requestPermission = function() { return Promise.resolve('default'); };
  }

  // 14. canvas fingerprint 微扰
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type) {
    if (this.width > 16 && this.height > 16) {
      try {
        var ctx = this.getContext('2d');
        if (ctx) {
          var s = ctx.fillStyle;
          ctx.fillStyle = 'rgba(1,1,1,0.01)';
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = s;
        }
      } catch(e) {}
    }
    return origToDataURL.apply(this, arguments);
  };

  // 15. WebGL vendor/renderer 伪装
  var getParameterOrig = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Google Inc. (Apple)';  // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)';  // UNMASKED_RENDERER_WEBGL
    return getParameterOrig.apply(this, arguments);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    var getParam2Orig = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Google Inc. (Apple)';
      if (param === 37446) return 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)';
      return getParam2Orig.apply(this, arguments);
    };
  }

  // Done — 现在这个页面的 JS 环境看起来像真 Chrome
  true;
`);
