# Test conventions

Tests for PiOS use the built-in [`node --test`](https://nodejs.org/api/test.html) runner (node 20+). No framework dependencies. Run them with `npm test`.

## Layout

```
test/
├── helpers/                 ← shared test utilities (fixture-vault, future: electron-mock)
├── unit/                    ← per-module tests; <100ms per file ideally
│   ├── pi-greet.test.js     ← maps 1:1 to backend/pi-greet.js
│   ├── pi-route.test.js     ← maps 1:1 to backend/pi-route.js
│   └── ...
├── integration/             ← multi-module / file-system / yaml-schema
│   ├── owner-complete-flow.test.js
│   ├── plugin-yaml.test.js
│   └── ...
├── fixtures/
│   └── vault/               ← committed minimal Pi vault for fixture tests
└── CONVENTIONS.md           ← this file
```

**Mapping rule**: a test file under `test/unit/` is named after the module under `backend/` or `main/` it tests. New module → new sibling test file.

## When to write what

| Code under | Test goes in | Why |
|---|---|---|
| `backend/<module>.js` (pure or fixture-vault-only deps) | `test/unit/<module>.test.js` | fast, deterministic, regression-anchor |
| `main/<module>.js` requiring `electron` | `test/unit/<module>.test.js` + `useElectronMock()` | mock layer stubs `app` / `ipcMain` / `BrowserWindow` etc. |
| `main/ipc-handlers/<x>.js` | `test/unit/ipc-<x>.test.js` | mock ipcMain, invoke channels, assert return + side-effects |
| `renderer/lib/<module>.js` (UMD module — pure or DOM) | `test/unit/renderer/<module>.test.js` | node:test + jsdom for DOM-using helpers |
| Multi-module flow (engine + persona + plugin) | `test/integration/<flow>.test.js` | verifies the seam between modules |
| YAML schema in `backend/plugins/*/plugin.yaml` etc. | `test/integration/<area>-yaml.test.js` | catches schema drift across edits |

## Writing a test (template)

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useFixtureVault } = require('../helpers/fixture-vault');

test.describe('module-name', () => {
  useFixtureVault();         // sets PIOS_VAULT + bootstraps minimal Pi/State files
  let mod;
  test.before(() => { mod = require(path.join(__dirname, '../..', 'backend/module-name')); });

  test('does X when Y', () => {
    const result = mod.doX('Y');
    assert.strictEqual(result, 'expected');
  });
});
```

If the test mutates state, snapshot it:

```javascript
const { snapshotStateFile } = require('../helpers/fixture-vault');
test.describe('writes state', () => {
  useFixtureVault();
  snapshotStateFile('Pi/State/pi-character.json');  // restored after suite
  // tests free to write CHAR_STATE
});
```

If the test needs an isolated mutable vault:

```javascript
const { useTempVault } = require('../helpers/fixture-vault');
test.describe('engine flow', () => {
  const ctx = useTempVault();   // ctx.vault = mkdtemp dir, fresh + cleaned
  // tests can scribble anywhere in ctx.vault
});
```

## What to test

**Yes — high ROI**:
- Pure functions: deterministic input → output (e.g. `voice-filter.getPreset`)
- Module contracts: exported shape doesn't drift (e.g. `pi-persona` returns `{id, display_name, ...}`)
- Fallback chains: missing config → graceful default (e.g. `getCurrentVoice()` null-safety)
- Schema integrity: bundled YAML files always parse + have required fields
- Regression anchors: when you fix a bug, write a test that fails on the unfixed version

**No — low ROI / wrong layer**:
- Cosmetic UI behavior — test in browser, not unit
- Real network calls (Anthropic / OpenAI / Codex) — mock the client; integration tests should not need keys
- LLM output quality — non-deterministic, untestable
- File locking / multi-process race — integration with mkdtemp, NOT against owner vault

## Forbidden

- **Do not target the owner's live vault** — it races with the running PiOS daemon (proven 2026-04-29 by `T16 persona setCharacter: state={}` symptom under a real Pi/State/pi-character.json being written concurrently). Use `useFixtureVault()` (static) or `useTempVault()` (mkdtemp).
- **Do not commit dynamic state files** under `tests/fixtures/vault/Pi/State/` — they're `.gitignore`'d. Only `Pi/State/.gitkeep` is tracked; tests bootstrap missing files at runtime.
- **Do not use `bash scripts/sanitize-lint.sh --no-verify`** to push past a lint failure on `pios-ai*` remotes — that defeats the PII gate. Fix the leak instead.

## How tests run

| Surface | Command | Speed |
|---|---|---|
| `npm test` | runs all unit + integration | ~15s |
| `npm run test:unit` | unit only | ~3s |
| `npm run test:integration` | integration only | ~12s |
| `npm run test:coverage` | + `--experimental-test-coverage` summary | ~15s |
| `npm run test:lint` | sanitize-lint working tree | ~2s |
| `npm run test:all` | lint + unit + integration | ~17s |
| `.githooks/pre-commit` | `test:unit` if staged touches `backend/`, `main/`, or `test/unit/` | ~3s |
| GitHub Actions | full + lint + history scan, node 20 + 22 matrix | ~1min |

## Renderer testing (jsdom + UMD)

`renderer/app.js` is the legacy 7500-line monolith — **don't add tests for it directly** (too coupled to DOM bootstrap; refactoring it risks the daily-driver UI).

For new renderer code: extract reusable helpers into `renderer/lib/<module>.js` using a UMD wrapper, and load them via `<script>` in `pios-home.html` before `app.js` runs:

```html
<script src="renderer/lib/format-helpers.js"></script>  <!-- sets window.RendererFormat -->
<script src="renderer/lib/dom-helpers.js"></script>     <!-- sets window.RendererDom -->
<script src="renderer/app.js"></script>
```

The UMD wrapper template (see `renderer/lib/format-helpers.js`):

```javascript
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RendererXxx = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function pureFn(x) { ... }
  return { pureFn };
}));
```

**Two test patterns:**

1. **Pure helper, no DOM** (`renderer/lib/format-helpers.js`): just `require()` the module — the UMD wrapper detects CommonJS and exports normally. Test like any other backend unit.

2. **DOM-using helper** (`renderer/lib/dom-helpers.js`): the module exports a *factory* that takes a `document`. Pass `new JSDOM().window.document` from the test:

```javascript
const { JSDOM } = require('jsdom');
const factory = require('../../../renderer/lib/dom-helpers');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const helpers = factory(dom.window.document);
// helpers.escapeHtml(...) etc.
```

**What NOT to test in jsdom**: real layout (no rendering engine), real IPC over preload (`window.pi`), real BrowserView navigation, anything needing CSS computed styles or canvas rendering. Those go to manual smoke via `npm run build:dir && bash scripts/install-app.sh`, OR to a future Playwright suite.

## Mocking electron

`test/helpers/electron-mock.js` provides a minimal stub for `require('electron')` covering the surface used by `main/*` (no real Chromium). Use `useElectronMock()` to install/uninstall around a `describe` block:

```javascript
const { useElectronMock, _getState } = require('../helpers/electron-mock');

test.describe('main/session-manager', () => {
  const ctx = useElectronMock();
  let sessMgr;
  test.before(() => {
    delete require.cache[require.resolve('main/session-manager')];  // bust stale require
    sessMgr = require('main/session-manager');
  });
  // tests can read ctx.state.userDataDir for the mock's mkdtemp userData
});
```

For ipc-handler modules that take `(ipcMain, app)` as `register()` args, build a fake ipcMain registry directly (see [ipc-bookmarks.test.js](unit/ipc-bookmarks.test.js)) and pass `require('electron').app` from the installed mock.

What's stubbed:
- `app` — `getPath('userData')` → mkdtemp; `whenReady()` → resolved; etc.
- `ipcMain` — `handle/on/removeHandler` with introspection via `_getState().ipcHandlers`
- `BrowserWindow` / `BrowserView` — class with `webContents.send`, `isDestroyed`, `on`, no real rendering
- `Menu` / `Tray` / `Notification` / `dialog` / `shell` / `clipboard` — minimal no-op shapes
- `powerMonitor` / `screen` / `session` / `protocol` / `systemPreferences` / `nativeImage`

What's NOT stubbed (intentionally):
- Real IPC across renderer ↔ main (no Chromium process)
- BrowserView rendering (no webContents pages)
- File-dialog interaction (return queued responses via `_getState().dialogResponses`)
- Native binary paths (electron postinstall is skipped in CI)

Tests that need any of these belong in a real Electron build, not unit tests.

## Adding a new feature → adding tests

The default for new modules is **co-located test on day 1**. The pre-commit hook does not enforce this yet (it warns when staged code touches `backend/` or `main/` and runs the existing unit suite), but treat it as the convention. Reviewer is allowed to push back on a PR that adds 200 lines of new module without a sibling `*.test.js`.

If a new feature is hard to test → that's a signal the design is wrong. Pure-function-extract the testable part, leave the electron/IPC shell thin.
