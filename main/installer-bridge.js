// ── installer-bridge.js ──
// 安装器 + 依赖检查 + 插件激活 IPC handlers
// 导出 register(ipcMain, { mainWindow, tryCreateHomeTabs, switchToChatMode }) 供 main.js 调用

'use strict';

const fs = require('fs');
const path = require('path');

const installer = require('../backend/pios-installer');
const VAULT_ROOT = require('../backend/vault-root');
const _depsCheck = require('../backend/deps-check');
const _depsInstall = require('../backend/deps-install');

function register(ipcMain, { mainWindow, getMainWindow, tryCreateHomeTabs, switchToChatMode }) {
  // 兼容：旧 main.js 直接传 mainWindow 值（注册时 main.js 还没把 mainWindow 赋值，
  // 实际拿到的是 null），新 main.js 应传 getMainWindow getter，每次 IPC handler 调用现取，
  // 保证拿到最新窗口引用。见 issue #3：'PiOS 主窗口未就绪' 出现在窗口已 ready 后点
  // 激活按钮——根因是闭包捕获了注册时刻的 null 值。
  const _resolveMainWindow = () => {
    if (typeof getMainWindow === 'function') return getMainWindow();
    return mainWindow;
  };

  // ── Installer IPC ────────────────────────────────────

  ipcMain.handle('pios:is-installed', () => installer.isInstalled());
  ipcMain.handle('pios:get-config', () => installer.loadConfig());
  ipcMain.handle('pios:install', (_, options) => installer.install(options));

  // renderer 在 setup overlay 关闭（用户点 "Start Using PiOS"）后调本 IPC 才创建 Home BrowserView，
  // 否则原生 BrowserView 层会盖住 setup-done "PiOS is ready!" 屏
  ipcMain.handle('pios:setup-done', async () => {
    try { tryCreateHomeTabs(); } catch (e) { return { ok: false, err: e.message }; }
    // setup 走完了，bubble window 也可以建了（之前被 isInstalled gate 拦着）
    try { if (typeof global._createBubbleWindow === 'function') global._createBubbleWindow(); } catch {}
    // 孵化里如果选了 NPC 并 stick（npcEnabled=true），bubble 刚建完，补跑 enableNpc
    try { if (typeof global._enableNpcAfterBubbleReady === 'function') global._enableNpcAfterBubbleReady(); } catch {}
    // 立即跑一次 auth-check.sh 刷新 runtime status（否则要等 cron 每小时才第一次跑，
    // 用户装完 codex/claude 看 System panel 会显示 down —— 这是 owner 之前报"登录了 codex 似乎无效"的根因）
    try {
      const cfg = installer.loadConfig();
      if (cfg && cfg.vault_root) {
        const authCheck = path.join(cfg.vault_root, 'Pi', 'Tools', 'auth-check.sh');
        if (fs.existsSync(authCheck)) {
          require('child_process').spawn('bash', [authCheck], {
            detached: true, stdio: 'ignore',
            env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`, VAULT: cfg.vault_root },
          }).unref();
          console.log('[setup-done] kicked off auth-check.sh for initial runtime status');
        }
      }
    } catch (e) { console.error('[setup-done] auth-check spawn failed:', e.message); }
    return { ok: true };
  });

  // 孵化仪式选定 NPC 后，把它粘到 pi-character.json + 启用 NPC，
  // 让 Home 里 Pi 说话走固定音色，不再每句换。
  ipcMain.handle('pios:stick-npc', (_, skinId) => {
    try {
      if (typeof global._piStickNpcFromHatching === 'function') {
        global._piStickNpcFromHatching(skinId);
        return { ok: true };
      }
      return { ok: false, err: 'stick-npc function not ready' };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  // ── Deps IPC ─────────────────────────────────────────

  // Setup Wizard 第 0 页：环境依赖检查 + 一键装
  ipcMain.handle('deps:check', () => _depsCheck.check());
  ipcMain.handle('deps:install', async (evt, which) => {
    const onProgress = (chunk) => {
      try { evt.sender.send('deps:progress', which, chunk); } catch {}
    };
    try {
      let r;
      if (which === 'xcode_clt') r = await _depsInstall.installXcodeCLT(onProgress);
      else if (which === 'brew') r = await _depsInstall.installBrew(onProgress);
      else if (which === 'node') r = await _depsInstall.installNode(onProgress);
      else if (which === 'python312') r = await _depsInstall.installPython312(onProgress);
      else if (which === 'ffmpeg') r = await _depsInstall.installFfmpeg(onProgress);
      else if (which === 'claude') r = await _depsInstall.installClaudeCli(onProgress);
      else if (which === 'codex') r = await _depsInstall.installCodex(onProgress);
      else return { ok: false, code: -1, tail: `unknown dep: ${which}` };
      return r;
    } catch (e) {
      return { ok: false, code: -1, tail: `[install error] ${e.message}` };
    }
  });

  // ── Plugin IPC ───────────────────────────────────────

  // Plugin 激活：开一个 Terminal + claude 跑 plugin.yaml 里指定的 activate prompt
  // 这条引导是 AI-mediated，不再用阶梯向导（owner 2026-04-25 决定：一个按钮进会话，AI 看人下药）
  ipcMain.handle('pios:plugin-list', async () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pios', 'config.json'), 'utf-8'));
      const vault = cfg.vault_root || path.join(process.env.HOME, 'PiOS-Vault');
      const installed = Array.isArray(cfg.plugins) ? cfg.plugins : [];
      const pluginState = cfg.plugin_state || {};
      const pluginsDir = path.join(vault, 'Pi', 'Plugins');

      // 加载 pios.yaml 一次，给"task-enabled fallback"判断用：
      // 当 plugin.yaml 没 success_marker（health/photos）或 marker 文件不存在（早期手工
      // 配置过 wechat 没跑过 AI 引导流程），降级用"agents.*.tasks 或 sense.pipelines 里
      // 跟该 plugin 关联的 task 是否 enabled" 当激活信号——用户手动 toggle on 也算"已激活"。
      let manifest = {};
      try {
        const yamlPath = path.join(vault, 'Pi', 'Config', 'pios.yaml');
        manifest = require('js-yaml').load(fs.readFileSync(yamlPath, 'utf-8')) || {};
      } catch {}

      const _isActivatedByEnabledTask = (pluginId, meta) => {
        // 规则 1：plugin.yaml 自己声明的 tasks 任一在 manifest 里 enabled
        const ownTaskIds = Object.keys((meta && meta.tasks) || {});
        if (ownTaskIds.length > 0) {
          for (const aid of Object.keys(manifest.agents || {})) {
            const agentTasks = (manifest.agents[aid].tasks) || {};
            for (const tid of ownTaskIds) {
              if (agentTasks[tid] && agentTasks[tid].enabled === true) return true;
            }
          }
        }
        // 规则 2：sense.pipelines 里 requires 含该 plugin id 且 enabled:true
        const pipelines = (manifest.sense && manifest.sense.pipelines) || {};
        for (const pcfg of Object.values(pipelines)) {
          const reqs = Array.isArray(pcfg.requires) ? pcfg.requires : [];
          if (reqs.includes(pluginId) && pcfg.enabled === true) return true;
        }
        return false;
      };

      const result = [];
      for (const id of installed) {
        if (['vault', 'shell', 'web-search', 'browser'].includes(id)) continue; // core 无需激活
        const metaFile = path.join(pluginsDir, id, 'plugin.yaml');
        if (!fs.existsSync(metaFile)) continue; // 2026-04-25: 没 plugin.yaml 说明该 id 产品已不支持（老 config 残留 health/photos 等），过滤掉不展示
        const meta = require('js-yaml').load(fs.readFileSync(metaFile, 'utf-8'));

        let activated = false;

        // 方法 1：success_marker 文件检查
        if (meta && Array.isArray(meta.activation?.success_marker) && meta.activation.success_marker.length > 0) {
          activated = meta.activation.success_marker.every(f => {
            const p = f
              .replace(/\{home\}/g, process.env.HOME)
              .replace(/\{pios_home\}/g, path.join(process.env.HOME, '.pios'))
              .replace(/\{vault\}/g, vault);
            return fs.existsSync(p);
          });
        }

        // 方法 2：fallback——manifest 里关联 task / pipeline 已 enabled
        if (!activated) {
          activated = _isActivatedByEnabledTask(id, meta);
        }

        result.push({
          id,
          name: meta?.name || id,
          description: meta?.description || '',
          has_activation: !!(meta?.activation?.prompt),
          activated,
          last_activated_at: pluginState[id]?.activated_at || null,
        });
      }
      return { ok: true, plugins: result };
    } catch (e) {
      return { ok: false, error: e.message, plugins: [] };
    }
  });

  ipcMain.handle('pios:plugin-activate', async (_, pluginId) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pios', 'config.json'), 'utf-8'));
      const vault = cfg.vault_root || path.join(process.env.HOME, 'PiOS-Vault');
      const owner = cfg.owner_name || 'User';
      const pluginDir = path.join(vault, 'Pi', 'Plugins', pluginId);
      const metaFile = path.join(pluginDir, 'plugin.yaml');
      if (!fs.existsSync(metaFile)) return { ok: false, error: `plugin ${pluginId} not installed` };
      const meta = require('js-yaml').load(fs.readFileSync(metaFile, 'utf-8'));
      const promptFile = path.join(pluginDir, meta.activation?.prompt || 'prompts/activate.md');
      if (!fs.existsSync(promptFile)) return { ok: false, error: `activation prompt not found at ${promptFile}` };

      // 读 prompt + 把 {vault} / {owner} 填进去
      let promptText = fs.readFileSync(promptFile, 'utf-8');
      promptText = promptText.replace(/\{vault\}/g, vault).replace(/\{owner\}/g, owner);

      // 不开 Terminal——在 PiBrowser 主窗口里 fork 一个新 session，让 Pi 在 native chat 里跟用户聊
      // mainWindow 收到事件 → renderer 调 createSession + sendMessage(text=promptText)
      const _mw = _resolveMainWindow();
      if (!_mw || _mw.isDestroyed()) {
        const reason = !_mw ? (_mw === null ? 'null' : 'undefined') : 'destroyed';
        return { ok: false, error: `PiOS 主窗口未就绪（resolveMainWindow=${reason}）。如果 PiOS 已经打开，刷新页面或重启 PiOS 再试；如果是首次激活立即出现这个错误，是 main.js 把 mainWindow 当值传给 installer-bridge 而没用 getter（见 issue #3 修复）。` };
      }
      try { _mw.show(); _mw.focus(); } catch {}
      // 用户当前在 Home BrowserView 点的"激活"——切回 chat 模式让用户能看见会话
      // （Home 还在，tabs 保留；用户激活完点 toolbar Home 图标可以回去）
      try { switchToChatMode(); } catch (e) { console.error('[plugin-activate] switchToChatMode:', e.message); }
      _mw.webContents.send('plugin:start-activation', {
        pluginId,
        title: `激活 ${meta.name || pluginId}`,
        // 第一条 user message：直接把 activate.md 整段传给 Pi。Pi 看到一段"激活 X 的完整说明"，
        // 按里面写的成功标准 + 工具清单 + 阶段节奏一步步带用户走。
        firstUserMessage: promptText + '\n\n---\n\n现在开始，先做"阶段 1：环境自检"。',
      });
      return { ok: true, pluginId };
    } catch (e) {
      console.error('[plugin-activate]', e);
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register };
