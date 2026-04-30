'use strict';
//
// electron-mock — minimal stub of `require('electron')` for unit tests.
//
// Why: modules under main/ require electron, which transitively pulls in the
// native binary at runtime. CI doesn't have it (npm ci --ignore-scripts skips
// the postinstall). And even if it did, the native runtime is heavyweight and
// stateful — tests would need a real BrowserWindow context. Instead we stub
// the small surface used by main/* modules.
//
// What's covered (the destructure patterns observed in main/*):
//   const { app } = require('electron')
//   const { ipcMain } = ...   (passed as arg today, but ready if needed)
//   const { BrowserWindow, BrowserView, Menu, dialog, clipboard, shell, app } = ...
//   const { Notification, Tray, globalShortcut } = ...
//   const { powerMonitor, screen } = ...
//
// Not covered: real IPC over the Chromium renderer, real BrowserView/Window
// rendering, file dialogs. Tests that need any of these belong in
// integration/ with a real Electron build, not here.
//
// Usage:
//
//   const { installElectronMock, mock } = require('../helpers/electron-mock');
//
//   describe('session-manager', () => {
//     before(() => installElectronMock({ userData: '/tmp/x' }));
//     after(() => uninstallElectronMock());
//     // requires inside this block see the mock electron
//   });
//
// Or, simpler `useElectronMock()` wrapper that registers before/after hooks:
//
//   describe('session-manager', () => {
//     useElectronMock();   // creates mkdtemp userData per suite, auto-cleans
//     // ...
//   });

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { before, after } = require('node:test');

const MOCK_PATH = path.resolve(__dirname, '_electron-mock-impl.js');

// ── stub state holders (reset on install) ──────────────────────────────────

let _state = null;

function _freshState({ userData }) {
  return {
    userDataDir: userData,
    ipcHandlers: new Map(),  // channel → fn
    ipcOn: new Map(),        // channel → [fn, fn, ...]
    appEventListeners: new Map(),
    powerListeners: new Map(),
    notifications: [],
    dialogResponses: [],     // queue: dialog.showOpenDialog/showMessageBox returns shift()
  };
}

// ── BrowserWindow / BrowserView stub ───────────────────────────────────────

class MockBrowserWindow {
  constructor(opts = {}) {
    this._opts = opts;
    this._destroyed = false;
    this._sentMessages = [];          // [{channel, payload}, ...]
    this._listeners = new Map();
    this.webContents = {
      send: (channel, ...payload) => { this._sentMessages.push({ channel, payload }); },
      on: () => {},
      once: () => {},
      executeJavaScript: () => Promise.resolve(),
      loadURL: () => Promise.resolve(),
      session: { cookies: { get: async () => [], set: async () => {} } },
    };
  }
  isDestroyed() { return this._destroyed; }
  destroy() { this._destroyed = true; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }
  once(event, fn) { return this.on(event, fn); }
  show() {}
  hide() {}
  focus() {}
  blur() {}
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  setSize() {}
  setPosition() {}
  setBrowserView() {}
  addBrowserView() {}
  removeBrowserView() {}
  getBrowserViews() { return []; }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
}

class MockBrowserView extends MockBrowserWindow {}

// ── installer ──────────────────────────────────────────────────────────────

/**
 * Patch Module._resolveFilename so any require('electron') inside the test
 * process returns our stub. Idempotent — calling install twice replaces
 * the previous state but leaves the resolver hook in place.
 */
function installElectronMock(opts = {}) {
  const userData = opts.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'pios-electron-mock-'));
  _state = _freshState({ userData });

  // Bust the require cache for any previously-loaded electron-mock-impl so
  // the next require pulls in fresh state-bound module.exports.
  delete require.cache[MOCK_PATH];

  if (!installElectronMock._patched) {
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function(request, parent, ...rest) {
      if (request === 'electron') return MOCK_PATH;
      return origResolve.call(this, request, parent, ...rest);
    };
    installElectronMock._origResolve = origResolve;
    installElectronMock._patched = true;
  }
  return _state;
}

function uninstallElectronMock() {
  if (installElectronMock._patched) {
    Module._resolveFilename = installElectronMock._origResolve;
    installElectronMock._patched = false;
  }
  if (_state && _state.userDataDir) {
    try { fs.rmSync(_state.userDataDir, { recursive: true, force: true }); } catch {}
  }
  _state = null;
  // Drop any cached modules that closed over the mock.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/main/') || k === MOCK_PATH) {
      delete require.cache[k];
    }
  }
}

/** Hook helper: install mock at suite-start, tear down at suite-end. */
function useElectronMock(opts = {}) {
  const ctx = { state: null, mkbw: () => new MockBrowserWindow() };
  before(() => { ctx.state = installElectronMock(opts); });
  after(() => uninstallElectronMock());
  return ctx;
}

// ── public api ─────────────────────────────────────────────────────────────

module.exports = {
  installElectronMock,
  uninstallElectronMock,
  useElectronMock,
  MockBrowserWindow,
  MockBrowserView,
  // The mock module's stub objects (ipcMain etc.) live in _electron-mock-impl.js
  // and read _state lazily so per-suite installs see fresh state.
  _getState: () => _state,
};
