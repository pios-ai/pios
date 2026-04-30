/**
 * plugin-registry.js — runtime registry for PiOS plugins.
 *
 * Reads every `backend/plugins/{name}/plugin.yaml` once at load time and
 * exposes a small API for core agents (triage / sense-maker / reflect)
 * to:
 *   - enumerate enabled plugins
 *   - look up which plugin owns a given card source
 *   - resolve plugin-defined data paths with {owner}/{vault}/{date}
 *     substitution
 *   - invoke a plugin's `on_gate` / `on_ingest` hook scripts and parse
 *     their stdout JSON
 *
 * This is the Phase-3a infra layer. Core agent prompts will be migrated
 * to consume this registry in Phase-3b. Until then the registry is dormant
 * — built and tested but not yet wired into triage.
 *
 * See docs/components/plugin-system.md "Plugin ↔ Core Agent Interaction"
 * for the schema and hook contract this implements.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ── locations ────────────────────────────────────────────────────────────

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const VAULT_ROOT = (() => {
  try { return require('../vault-root'); }
  catch { return process.env.PIOS_VAULT || path.join(os.homedir(), 'PiOS'); }
})();

// per-plugin gate state lives under vault, host-sharded so multi-machine
// runs don't stomp each other (same pattern as gate-state-{host}.json).
function _stateFilePath(pluginId, host) {
  const safeHost = String(host || 'unknown').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return path.join(VAULT_ROOT, 'Pi', 'State', `plugin-${pluginId}-state-${safeHost}.json`);
}

// ── tiny YAML parser shim ────────────────────────────────────────────────
// We intentionally don't pull in a YAML dependency: plugin.yaml schema is
// flat enough that we can rely on `js-yaml` if it's already a project
// dep, or fall back to a minimal hand-parse for the fields we need.

let _yamlParse = null;
function _loadYamlParser() {
  if (_yamlParse) return _yamlParse;
  try {
    _yamlParse = require('js-yaml').load;
  } catch {
    throw new Error(
      '[plugin-registry] js-yaml is required to parse plugin.yaml. '
      + 'Run `npm install js-yaml` (it should already be a project dep).'
    );
  }
  return _yamlParse;
}

// ── load ─────────────────────────────────────────────────────────────────

let _plugins = null;  // Map<id, parsed manifest + dir>

// Per-plugin enable/disable map derived from pios.yaml (Phase-3b).
// null = pios.yaml not loaded yet; Map<id, boolean> once loaded.
let _piosEnabledMap = null;

function _loadPiosYamlEnabled() {
  if (_piosEnabledMap !== null) return _piosEnabledMap;
  _piosEnabledMap = new Map();
  try {
    const yamlPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
    const parse = _loadYamlParser();
    const cfg = parse(fs.readFileSync(yamlPath, 'utf8'));
    if (cfg && cfg.plugins && typeof cfg.plugins === 'object') {
      for (const [id, entry] of Object.entries(cfg.plugins)) {
        if (entry && typeof entry === 'object') {
          const enabled = entry.enabled !== false;
          _piosEnabledMap.set(id, enabled);
          if (entry.path) {
            const pathAlias = path.basename(String(entry.path));
            if (pathAlias) _piosEnabledMap.set(pathAlias, enabled);
          }
        }
      }
    }
  } catch {
    // pios.yaml missing or unparseable — treat all plugins as enabled.
  }
  return _piosEnabledMap;
}

function load(opts = {}) {
  const dir = opts.pluginsDir || PLUGINS_DIR;
  const out = new Map();
  const parse = _loadYamlParser();

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    _plugins = out;
    return out;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pluginYamlPath = path.join(dir, ent.name, 'plugin.yaml');
    if (!fs.existsSync(pluginYamlPath)) continue;
    let manifest;
    try {
      manifest = parse(fs.readFileSync(pluginYamlPath, 'utf8'));
    } catch (err) {
      console.warn(`[plugin-registry] skipping ${ent.name}: yaml parse failed: ${err.message}`);
      continue;
    }
    if (!manifest || typeof manifest !== 'object') continue;
    const id = manifest.id || ent.name;
    out.set(id, {
      id,
      dir: path.join(dir, ent.name),
      manifest,
      provides: manifest.provides || {},
      triage_hooks: manifest.triage_hooks || {},
    });
  }
  _plugins = out;
  return out;
}

function _ensureLoaded() {
  if (!_plugins) load();
  return _plugins;
}

// ── query ────────────────────────────────────────────────────────────────

function listEnabled() {
  const all = _ensureLoaded();
  const enabledMap = _loadPiosYamlEnabled();
  return Array.from(all.values()).filter(p => {
    // If pios.yaml has an explicit entry for this plugin, respect it.
    // If the plugin is not listed in pios.yaml, fall back to plugin.yaml enabled field.
    if (enabledMap.size > 0 && enabledMap.has(p.id)) {
      return enabledMap.get(p.id);
    }
    return p.manifest.enabled !== false;
  });
}

function findBySource(cardSource) {
  for (const p of _ensureLoaded().values()) {
    const sources = (p.provides && p.provides.card_sources) || [];
    if (sources.includes(cardSource)) return p;
  }
  return null;
}

function _substituteTokens(template, ctx) {
  return String(template).replace(/\{(owner|vault|date|host|home)\}/g, (_, key) => {
    if (key === 'date') return new Date().toISOString().slice(0, 10);
    if (key === 'home') return os.homedir();
    return ctx[key] || `{${key}}`;
  });
}

function resolvePath(pluginId, pathKey, ctx = {}) {
  const all = _ensureLoaded();
  const plugin = all.get(pluginId);
  if (!plugin) return null;
  const tmpl = plugin.provides && plugin.provides.data_paths && plugin.provides.data_paths[pathKey];
  if (!tmpl) return null;
  const owner = ctx.owner || process.env.PIOS_OWNER || 'owner';
  const vault = ctx.vault || VAULT_ROOT;
  const host  = ctx.host  || process.env.PIOS_HOST  || os.hostname().split('.')[0];
  const resolved = _substituteTokens(tmpl, { owner, vault, host });
  // If the resolved path is relative, make it vault-relative.
  if (resolved.startsWith('/') || resolved.startsWith(os.homedir())) return resolved;
  return path.join(vault, resolved);
}

// ── hook execution ───────────────────────────────────────────────────────

function _hookEnv(plugin, host, extraEnv = {}) {
  const owner = process.env.PIOS_OWNER || 'owner';
  const stateFile = _stateFilePath(plugin.id, host);
  return {
    ...process.env,
    PIOS_VAULT: VAULT_ROOT,
    PIOS_HOST: host,
    PIOS_OWNER: owner,
    PIOS_PLUGIN_ID: plugin.id,
    PIOS_PLUGIN_DIR: plugin.dir,
    PIOS_PLUGIN_LAST_STATE_JSON: stateFile,
    ...extraEnv,
  };
}

function _runScript(scriptPath, env, timeoutMs) {
  // Resolve relative to plugin dir if not absolute
  const out = execFileSync('bash', [scriptPath], {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out;
}

function _parseJsonStdout(raw, contextLabel) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error(`[plugin-registry] ${contextLabel} produced empty stdout`);
  }
  // The contract says "single line of JSON". Be tolerant: if the script
  // emits log lines before the JSON, try parsing the last non-empty line.
  const lines = trimmed.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i].trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      try { return JSON.parse(candidate); } catch { /* try next */ }
    }
  }
  throw new Error(
    `[plugin-registry] ${contextLabel} stdout is not parseable JSON.\n--- raw stdout ---\n${trimmed}`
  );
}

function _persistSinceState(plugin, host, sinceState) {
  if (!sinceState || typeof sinceState !== 'object') return;
  const stateFile = _stateFilePath(plugin.id, host);
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); } catch {}
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch {}
  const merged = { ...prior, ...sinceState };
  const tmp = stateFile + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  fs.renameSync(tmp, stateFile);
}

async function runGate(pluginId, opts = {}) {
  const plugin = _ensureLoaded().get(pluginId);
  if (!plugin) throw new Error(`[plugin-registry] unknown plugin: ${pluginId}`);
  const hookCfg = plugin.triage_hooks && plugin.triage_hooks.on_gate;
  if (!hookCfg) return { fire: false, _reason: 'no_on_gate_hook' };

  const scriptPath = path.join(plugin.dir, hookCfg.script);
  if (!fs.existsSync(scriptPath)) {
    return { fire: false, _reason: `script_missing:${hookCfg.script}` };
  }
  const host = opts.host || process.env.PIOS_HOST || os.hostname().split('.')[0];
  const timeoutMs = (hookCfg.timeout_sec || 5) * 1000;

  let raw;
  try {
    raw = _runScript(scriptPath, _hookEnv(plugin, host), timeoutMs);
  } catch (err) {
    return { fire: false, _reason: 'script_error', _error: err.message };
  }
  let parsed;
  try {
    parsed = _parseJsonStdout(raw, `${pluginId}/on_gate`);
  } catch (err) {
    return { fire: false, _reason: 'parse_error', _error: err.message };
  }

  if (parsed.fire && parsed.since_state) {
    _persistSinceState(plugin, host, parsed.since_state);
  }
  return parsed;
}

async function runIngest(pluginId, gatePayload, opts = {}) {
  const plugin = _ensureLoaded().get(pluginId);
  if (!plugin) throw new Error(`[plugin-registry] unknown plugin: ${pluginId}`);
  const hookCfg = plugin.triage_hooks && plugin.triage_hooks.on_ingest;
  if (!hookCfg) return { events: [], _reason: 'no_on_ingest_hook' };

  const scriptPath = path.join(plugin.dir, hookCfg.script);
  if (!fs.existsSync(scriptPath)) {
    return { events: [], _reason: `script_missing:${hookCfg.script}` };
  }
  const host = opts.host || process.env.PIOS_HOST || os.hostname().split('.')[0];
  const timeoutMs = (hookCfg.timeout_sec || 60) * 1000;

  const env = _hookEnv(plugin, host, {
    PIOS_PLUGIN_GATE_PAYLOAD: JSON.stringify(gatePayload || {}),
  });

  let raw;
  try {
    raw = _runScript(scriptPath, env, timeoutMs);
  } catch (err) {
    return { events: [], _reason: 'script_error', _error: err.message };
  }
  try {
    return _parseJsonStdout(raw, `${pluginId}/on_ingest`);
  } catch (err) {
    return { events: [], _reason: 'parse_error', _error: err.message };
  }
}

async function runAllGates(opts = {}) {
  const plugins = listEnabled();
  const results = {};
  for (const p of plugins) {
    results[p.id] = await runGate(p.id, opts);
  }
  return results;
}

module.exports = {
  load,
  listEnabled,
  findBySource,
  resolvePath,
  runGate,
  runIngest,
  runAllGates,
};
