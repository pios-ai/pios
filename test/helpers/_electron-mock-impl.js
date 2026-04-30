'use strict';
//
// Stub electron module — what `require('electron')` resolves to inside tests
// when electron-mock.js has installed the resolver hook. Reads state lazily
// from electron-mock.js so tests can install/uninstall per suite.

const path = require('path');
const { _getState, MockBrowserWindow, MockBrowserView } = require('./electron-mock');

function _state() {
  const s = _getState();
  if (!s) throw new Error('[electron-mock] not installed — call installElectronMock() in before()');
  return s;
}

// app — the most-used surface. getPath('userData') is the load-time call
// that drives sessions.json placement.
const app = {
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  getPath: (name) => {
    const s = _state();
    if (name === 'userData') return s.userDataDir;
    if (name === 'home') return process.env.HOME || '';
    if (name === 'temp') return require('os').tmpdir();
    if (name === 'appData') return path.join(s.userDataDir, '..');
    return s.userDataDir;
  },
  getName: () => 'PiOS',
  getVersion: () => '0.0.0-test',
  getAppPath: () => process.cwd(),
  getLocale: () => 'en-US',
  on: (event, fn) => {
    const s = _state();
    if (!s.appEventListeners.has(event)) s.appEventListeners.set(event, []);
    s.appEventListeners.get(event).push(fn);
  },
  once(event, fn) { return this.on(event, fn); },
  quit: () => {},
  exit: () => {},
  setAppUserModelId: () => {},
  dock: { setIcon: () => {}, hide: () => {}, show: () => {} },
};

// ipcMain — modules that destructure const {ipcMain} = require('electron')
// see this. Most main/* code receives ipcMain as a register() argument
// instead, but expose it for completeness.
const ipcMain = {
  handle: (channel, fn) => { _state().ipcHandlers.set(channel, fn); },
  removeHandler: (channel) => { _state().ipcHandlers.delete(channel); },
  on: (channel, fn) => {
    const s = _state();
    if (!s.ipcOn.has(channel)) s.ipcOn.set(channel, []);
    s.ipcOn.get(channel).push(fn);
  },
  removeAllListeners: (channel) => { _state().ipcOn.delete(channel); },
  emit: (channel, ...args) => {
    const fns = _state().ipcOn.get(channel) || [];
    for (const fn of fns) fn(...args);
  },
};

// dialog — return a queued response if one was pre-loaded, else a no-op.
const dialog = {
  showOpenDialog: async () => _state().dialogResponses.shift() || { canceled: true, filePaths: [] },
  showSaveDialog: async () => _state().dialogResponses.shift() || { canceled: true, filePath: undefined },
  showMessageBox: async () => _state().dialogResponses.shift() || { response: 0 },
  showErrorBox: () => {},
};

// shell — clicked-link / show-in-folder. Tests can spy via _state().
const shell = {
  openExternal: async (url) => { _state()._lastShellOpen = url; return true; },
  openPath: async (p) => { _state()._lastShellPath = p; return ''; },
  showItemInFolder: () => {},
};

// clipboard — minimal in-memory.
const clipboard = {
  _text: '',
  readText() { return this._text; },
  writeText(s) { this._text = s; },
  readImage: () => ({ isEmpty: () => true }),
  writeImage: () => {},
};

// Menu / MenuItem / Tray / Notification / globalShortcut / powerMonitor / screen
class MockMenu {
  constructor() { this._items = []; }
  append(item) { this._items.push(item); }
  popup() {}
  closePopup() {}
  static buildFromTemplate(template) {
    const m = new MockMenu();
    m._items = template;
    return m;
  }
  static setApplicationMenu() {}
  static getApplicationMenu() { return null; }
}
class MockMenuItem { constructor(opts) { Object.assign(this, opts); } }
class MockTray {
  constructor(image) { this._image = image; this._listeners = new Map(); }
  setToolTip() {}
  setContextMenu() {}
  setImage() {}
  destroy() {}
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }
}
class MockNotification {
  constructor(opts = {}) {
    Object.assign(this, opts);
    _state().notifications.push(this);
  }
  show() {}
  close() {}
  on() {}
}
const globalShortcut = {
  register: () => true,
  unregister: () => {},
  unregisterAll: () => {},
  isRegistered: () => false,
};
const powerMonitor = {
  on: (event, fn) => {
    const s = _state();
    if (!s.powerListeners.has(event)) s.powerListeners.set(event, []);
    s.powerListeners.get(event).push(fn);
  },
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
};
const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getAllDisplays: () => [{ workAreaSize: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on: () => {},
};
const session = {
  defaultSession: {
    cookies: { get: async () => [], set: async () => {} },
    webRequest: { onBeforeRequest: () => {} },
  },
  fromPartition: () => ({ cookies: { get: async () => [], set: async () => {} } }),
};
const protocol = { registerFileProtocol: () => true, registerHttpProtocol: () => true };
const systemPreferences = {
  getColor: () => '#000000',
  getMediaAccessStatus: () => 'granted',
  isDarkMode: () => false,
};
const nativeImage = {
  createFromPath: () => ({ isEmpty: () => false, toDataURL: () => '' }),
  createEmpty: () => ({ isEmpty: () => true }),
};

module.exports = {
  app,
  ipcMain,
  ipcRenderer: { send: () => {}, invoke: () => Promise.resolve() },
  BrowserWindow: MockBrowserWindow,
  BrowserView: MockBrowserView,
  Menu: MockMenu,
  MenuItem: MockMenuItem,
  Tray: MockTray,
  Notification: MockNotification,
  dialog,
  shell,
  clipboard,
  globalShortcut,
  powerMonitor,
  screen,
  session,
  protocol,
  systemPreferences,
  nativeImage,
  webContents: { fromId: () => null, getAllWebContents: () => [] },
  contextBridge: { exposeInMainWorld: () => {} },
};
