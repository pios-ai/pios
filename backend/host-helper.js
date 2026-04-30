/**
 * host-helper.js — 统一主机名解析
 *
 * 优先级：
 *   1. process.env.PIOS_HOST（测试/手动覆盖）
 *   2. ~/.pios/config.json 里 host_map[hostname] 别名
 *   3. hostname -s 的短名
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

function loadConfig() {
  try {
    const p = path.join(os.homedir(), '.pios', 'config.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function rawHost() {
  return os.hostname().split('.')[0];
}

function resolveHost() {
  if (process.env.PIOS_HOST) return process.env.PIOS_HOST;
  const raw = rawHost();
  const cfg = loadConfig();
  const map = cfg.host_map || {};
  return map[raw] || raw;
}

function primaryHost() {
  return loadConfig().primary_host || '';
}

function isPrimary() {
  return resolveHost() === primaryHost();
}

module.exports = { resolveHost, primaryHost, isPrimary, rawHost, loadConfig };
