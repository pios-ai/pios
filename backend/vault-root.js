/**
 * vault-root.js — PiOS Vault path resolution
 *
 * Priority:
 * 1. PIOS_VAULT environment variable
 * 2. ~/.pios/config.json "vault_root" field
 * 3. ~/PiOS (default — 对齐 pios-installer.js 的默认 vault_root)
 */

const fs = require('fs');
const path = require('path');

function getVaultRoot() {
  if (process.env.PIOS_VAULT) return process.env.PIOS_VAULT;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pios', 'config.json'), 'utf-8'));
    if (cfg.vault_root) return cfg.vault_root;
  } catch {}
  return path.join(process.env.HOME, 'PiOS');
}

module.exports = getVaultRoot();
