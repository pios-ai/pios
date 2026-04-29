/**
 * host-resolve.js — Resolve raw OS hostname to canonical PiOS host id.
 *
 * Order of precedence:
 *   1. Environment variable PIOS_HOST (highest, for testing/cron overrides)
 *   2. ~/.pios/config.json -> hostname_aliases: { "<regex>": "<canonical>" }
 *      Patterns are case-insensitive RegExp. First match wins.
 *   3. Platform-based default:
 *        Darwin → "<sanitised hostname>" or "mac-host"
 *        Linux  → "<sanitised hostname>" or "linux-host"
 *        else   → "<sanitised hostname>" or "unknown"
 *
 * The product bundle does NOT hardcode any specific user's hostnames.
 * Multi-machine users configure aliases themselves; single-machine users
 * get a sane default via the platform fallback.
 *
 * Mirrors backend/tools/pios-tick.sh CAPS resolution and Pi/Tools/lib/host-resolve.sh.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let _cached = null;

function _readAliases() {
  try {
    const cfgPath = path.join(os.homedir(), '.pios', 'config.json');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg) return null;
    // Support both naming conventions:
    //   `host_map`           — exact-match {raw_hostname: canonical}, simpler
    //   `hostname_aliases`   — regex pattern {pattern: canonical}, more flexible
    if (cfg.hostname_aliases) return { aliases: cfg.hostname_aliases, kind: 'regex' };
    if (cfg.host_map) return { aliases: cfg.host_map, kind: 'exact' };
    return null;
  } catch {
    return null;
  }
}

function _sanitise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function resolveHost() {
  if (_cached) return _cached;

  const envOverride = process.env.PIOS_HOST;
  if (envOverride) {
    _cached = envOverride;
    return _cached;
  }

  let raw = 'unknown';
  try { raw = os.hostname().split('.')[0]; } catch {}

  const aliasInfo = _readAliases();
  if (aliasInfo && aliasInfo.aliases && typeof aliasInfo.aliases === 'object') {
    if (aliasInfo.kind === 'exact') {
      // host_map: exact hostname → canonical
      if (Object.prototype.hasOwnProperty.call(aliasInfo.aliases, raw)) {
        _cached = aliasInfo.aliases[raw];
        return _cached;
      }
    } else {
      // hostname_aliases: regex pattern → canonical
      for (const [pattern, canonical] of Object.entries(aliasInfo.aliases)) {
        try {
          if (new RegExp(pattern, 'i').test(raw)) {
            _cached = canonical;
            return _cached;
          }
        } catch { /* invalid regex in user config — skip */ }
      }
    }
  }

  const platform = os.platform();
  const fallback = _sanitise(raw);
  if (fallback) {
    _cached = fallback;
  } else if (platform === 'darwin') {
    _cached = 'mac-host';
  } else if (platform === 'linux') {
    _cached = 'linux-host';
  } else {
    _cached = 'unknown';
  }
  return _cached;
}

module.exports = { resolveHost };
