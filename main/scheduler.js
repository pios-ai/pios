// main/scheduler.js — 内置 pios-tick.sh 调度器
// 每 60 秒 spawn pios-tick.sh + powerMonitor 睡眠唤醒立即补跑。
// 导出: start(vaultRoot, installer) / stop()

'use strict';

const path = require('path');
const fs   = require('fs');

let _tickTimer = null;

function start(vaultRoot, installer) {
  // ⚠️ 2026-04-29 plan c：Vault 是唯一 SSoT runtime。
  // 反转 04-28 "只读 bundle" 决策——bundle SSoT 让 install-app.sh
  // bundle→vault 反向覆盖 21 个 .sh 文件 commit（notify-wechat.sh --media+mirror、
  // outbox-drain、reminder、auth-check 等），4/28 daily-diary-image 出图链路因此哑。
  // 详见 verify-pios-tools-regression-fix-2026-04-29 + plan-c-pios-tools-ssot 卡。
  // 新模型：Vault 是 git commit + Syncthing 同步的权威源；bundle 只在首装由
  // pios-installer.js 13b 一次性 bootstrap 到 Pi/Tools/，之后 install-app.sh 不再覆盖。
  const vaultTick = path.join(vaultRoot, 'Pi', 'Tools', 'pios-tick.sh');
  const tickScript = (() => {
    if (fs.existsSync(vaultTick)) return vaultTick;
    // dev 模式 npm start（Vault 还没 bootstrap）兜底：读 repo source
    const repoTick = path.join(__dirname, '..', 'backend', 'tools', 'pios-tick.sh');
    if (fs.existsSync(repoTick)) return repoTick;
    return null;
  })();

  if (!tickScript) {
    console.warn('[scheduler] pios-tick.sh not found, internal scheduler disabled');
    return;
  }

  const { spawn } = require('child_process');
  const _sleepMarkerPath = path.join(vaultRoot, 'Pi/Log/pios-tick-sleep-marker.jsonl');

  const _runTick = () => {
    // 未装完（vault 不存在）就跑 tick 会挂；另 PATH 必须扩展，否则 tick → adapter → claude/codex 找不到二进制
    if (!installer.isInstalled()) return;
    // 2026-04-28：剥宿主 OAuth env（feedback_spawn_env_strip_oauth.md 漏修
    // 的第三条 spawn 路径）。PiOS 主进程从 Claude Code 启时 env 带宿主
    // OAuth token，传下去 → adapter → claude-cli 用死 token 401 logged-out
    // → fallback codex-cli。某些 host 上调度任务 degraded 的常见根因。
    const _tickEnv = {
      ...process.env,
      PIOS_VAULT: vaultRoot,
      // Electron 子进程默认 PATH 只有 /usr/bin:/bin，不含 Homebrew / npm global。
      // adapter 调 claude/codex 需要扩 PATH，否则 task 静默失败
      PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${process.env.HOME}/.claude/local:${process.env.HOME}/.npm-global/bin:${process.env.PATH || '/usr/bin:/bin'}`,
    };
    delete _tickEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete _tickEnv.CLAUDE_CODE_ENTRYPOINT;
    delete _tickEnv.CLAUDECODE;
    delete _tickEnv.ANTHROPIC_API_KEY;
    const child = spawn('bash', [tickScript], {
      env: _tickEnv,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  };

  _runTick(); // 启动时立即跑一次（isInstalled=false 会 early return）
  _tickTimer = setInterval(_runTick, 60 * 1000);
  console.log(`[scheduler] pios-tick.sh started (${tickScript})`);

  // 2026-04-27: macOS sleep 唤醒后立即补一次 pios-tick（不等下个 60s 周期）。
  // 根因：laptop-host 合盖 sleep → setInterval 暂停 → 醒来等 ≤60s 才跑第一次 →
  //   catch-up 每 tick 最多 2 个 → 8h 空窗漏 reflect/sense-maker/wechat 等 N
  //   个 task → reflect 连续 2 天没自动跑实锤（pi-state-now 04-27 顶段记录）。
  // 修：powerMonitor.on('resume') 立即 kick 一次 _runTick，让 catch-up 链早
  //   启动 6 小时。同时落盘 sleep marker 给 diagnostic。
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('suspend', () => {
      try { fs.appendFileSync(_sleepMarkerPath, JSON.stringify({ ev: 'suspend', ts: new Date().toISOString() }) + '\n'); } catch {}
    });
    powerMonitor.on('resume', () => {
      try { fs.appendFileSync(_sleepMarkerPath, JSON.stringify({ ev: 'resume', ts: new Date().toISOString() }) + '\n'); } catch {}
      console.log('[scheduler] powerMonitor resume → immediate pios-tick');
      _runTick();
    });
  } catch (e) {
    console.warn('[scheduler] powerMonitor unavailable:', e.message);
  }
}

function stop() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

module.exports = { start, stop };
