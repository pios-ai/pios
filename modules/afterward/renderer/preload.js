/**
 * Afterward preload — secure bridge between renderer and Node main.
 * Only exposes minimal, well-scoped APIs (contextBridge pattern).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('afterward', {
  // Status / state
  status: () => ipcRenderer.invoke('afterward:status'),
  checkState: () => ipcRenderer.invoke('afterward:check-state'),

  // Auth
  unlock: (password) => ipcRenderer.invoke('afterward:unlock', { password }),
  lock: () => ipcRenderer.invoke('afterward:lock'),

  // Heartbeat actions
  passiveHeartbeat: () => ipcRenderer.invoke('afterward:passive-heartbeat'),
  challengePass: () => ipcRenderer.invoke('afterward:challenge-pass'),

  // Vault
  vaultList: () => ipcRenderer.invoke('afterward:vault-list'),
  vaultRead: (relPath) => ipcRenderer.invoke('afterward:vault-read', { relPath }),
  vaultWrite: (relPath, content) => ipcRenderer.invoke('afterward:vault-write', { relPath, content }),

  // Onboarding
  isInitialized: () => ipcRenderer.invoke('afterward:is-initialized'),
  onboard: (password, trustees) => ipcRenderer.invoke('afterward:onboard', { password, trustees }),

  // Change master password (re-encrypt all + regenerate shares)
  changePassword: (oldPassword, newPassword) => ipcRenderer.invoke('afterward:change-password', { oldPassword, newPassword }),

  // Trustees
  trusteesRead: () => ipcRenderer.invoke('afterward:trustees-read'),

  // Audit
  auditRead: (limit) => ipcRenderer.invoke('afterward:audit-read', { limit }),

  // Instructions (actions + missions YAML)
  instructionsRead: () => ipcRenderer.invoke('afterward:instructions-read'),
  instructionsWrite: (yaml) => ipcRenderer.invoke('afterward:instructions-write', { yaml }),

  // Drill
  drillRun: () => ipcRenderer.invoke('afterward:drill-run'),

  // Touch ID
  touchidAvailable: () => ipcRenderer.invoke('afterward:touchid-available'),
  touchidEnable: () => ipcRenderer.invoke('afterward:touchid-enable'),
  touchidDisable: () => ipcRenderer.invoke('afterward:touchid-disable'),
  touchidUnlock: () => ipcRenderer.invoke('afterward:touchid-unlock'),

  // Pi access tokens (for external HTTP callers like Claude Code)
  authorizePi: (opts) => ipcRenderer.invoke('afterward:authorize-pi', opts),
  listTokens: () => ipcRenderer.invoke('afterward:list-tokens'),
  revokeToken: (token) => ipcRenderer.invoke('afterward:revoke-token', { token }),
});
