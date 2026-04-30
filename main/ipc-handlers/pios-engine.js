// ── pios-engine.js ──
// PiOS Engine IPC handlers + Card operation IPC + Runtime IPC
// 导出 register(ipcMain) 供 main.js 调用

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const pios = require('../../backend/pios-engine');
const VAULT_ROOT = require('../../backend/vault-root');

function register(ipcMain) {
  // ── PiOS Engine IPC ──────────────────────────────────

  ipcMain.handle('pios:agents', () => pios.loadAgents());
  ipcMain.handle('pios:agent', (_, agentId) => pios.getAgent(agentId));
  ipcMain.handle('pios:cards', (_, filter) => pios.loadCards(filter));
  ipcMain.handle('pios:agent-cards', (_, agentId) => pios.getAgentCards(agentId));
  ipcMain.handle('pios:projects', () => pios.getProjects());
  ipcMain.handle('pios:decisions', () => pios.getDecisionQueue());
  ipcMain.handle('pios:overview', () => pios.getSystemOverview());
  ipcMain.handle('pios:plugins', () => pios.loadPlugins());
  ipcMain.handle('pios:agent-workspace', (_, agentId) => pios.getAgentWorkspace(agentId));
  ipcMain.handle('pios:update-agent-status', (_, agentId, status) => pios.updateAgentStatus(agentId, status));
  ipcMain.handle('pios:sync-crontab', () => pios.syncCrontab());
  ipcMain.handle('pios:spawn-agent', (_, agentId) => pios.spawnAgent(agentId));

  // ── Card Operations IPC ──────────────────────────────

  ipcMain.handle('pios:read-card', (_, filename) => pios.readCard(filename));
  ipcMain.handle('pios:update-card', (_, filename, updates) => pios.updateCardFrontmatter(filename, updates));
  ipcMain.handle('pios:resolve-decision', (_, filename, decision) => pios.resolveDecision(filename, decision));
  ipcMain.handle('pios:move-card', (_, filename, toStatus) => pios.moveCard(filename, toStatus));
  ipcMain.handle('pios:approve-review', (_, filename, comment) => pios.approveReview(filename, comment));
  ipcMain.handle('pios:rework-review', (_, filename, comment) => pios.reworkReview(filename, comment));
  ipcMain.handle('pios:respond-to-owner', (_, filename, response, opts) => pios.respondToOwner(filename, response, opts || {}));
  ipcMain.handle('pios:approve-permission', (_, filename) => pios.approvePermission(filename));
  ipcMain.handle('pios:defer-card', (_, filename, until) => pios.deferCard(filename, until));

  // ── Runtime IPC ──────────────────────────────────────

  ipcMain.handle('pios:runtimes', () => {
    try {
      const piosPath = path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml');
      const piosConfig = yaml.load(fs.readFileSync(piosPath, 'utf-8'));
      const runtimes = (piosConfig.infra && piosConfig.infra.runtimes) ? piosConfig.infra.runtimes : {};
      return Object.entries(runtimes).map(([id, r]) => ({
        id,
        name: r.name || id,
        status: r.status || 'unknown',
        error: r.error || null,
        last_success: r.last_success || null,
        down_since: r.down_since || null,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('pios:runtime-restart', async (_, runtimeId) => {
    if (runtimeId !== 'openclaw') return { ok: false, error: 'Only openclaw restart is supported' };
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec('openclaw gateway restart', { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: stderr || err.message });
        else resolve({ ok: true, output: stdout.trim() });
      });
    });
  });

  // 一键重新探活 auth-based runtimes (claude-cli / codex-cli)
  // 跑 auth-manager check + auth-check.sh，两者都会根据实时探活结果写回 pios.yaml。
  // 用在 quota 提前恢复 / 外部登录后系统没察觉的场景。
  ipcMain.handle('pios:runtime-refresh-auth', async (_, runtimeId) => {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      const vault = VAULT_ROOT;
      const cmd = `bash "${vault}/Pi/Tools/auth-manager.sh" check 2>&1; bash "${vault}/Pi/Tools/auth-check.sh" 2>&1`;
      exec(cmd, { timeout: 30000, env: { ...process.env, PIOS_VAULT: vault } }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        // Re-read pios.yaml for the runtime's new status
        try {
          const piosPath = path.join(vault, 'Pi', 'Config', 'pios.yaml');
          const piosConfig = yaml.load(fs.readFileSync(piosPath, 'utf-8'));
          const rt = piosConfig?.infra?.runtimes?.[runtimeId] || {};
          resolve({
            ok: rt.status === 'ok',
            status: rt.status || 'unknown',
            error: rt.error || null,
            output: output.trim().split('\n').slice(-6).join('\n'),
          });
        } catch (e) {
          resolve({ ok: false, error: e.message, output: output.trim() });
        }
      });
    });
  });
}

module.exports = { register };
