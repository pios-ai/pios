/**
 * deps-install.js — 一键装 Homebrew / Node / Python 3.12 / Claude CLI
 *
 * 每个入口 spawn 一个子进程，stdout/stderr 通过 onProgress 回调流式推给 renderer。
 * Homebrew 装要 sudo，用 osascript `with administrator privileges` 弹系统密码框（macOS 官方认可）。
 * 其他三项（有 brew 之后）都不要 sudo。
 *
 * 返回 { ok: boolean, code: number, tail: string }；失败 tail 是最后 2KB stderr，方便 UI 显示。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, spawnSync } = require('child_process');

const HOME = os.homedir();
// 多路径 fallback（arm64 / Intel / 用户自装）
const BREW_BIN_CANDIDATES = [
  '/opt/homebrew/bin/brew',
  '/usr/local/bin/brew',
  `${HOME}/homebrew/bin/brew`,
];
const XCODE_CLT_PROBE = '/Library/Developer/CommandLineTools/usr/bin/git';

/** 找已装的 brew（安装后路径可能是 arm64 或 Intel），否则 null */
function _resolveBrew() {
  return BREW_BIN_CANDIDATES.find(p => fs.existsSync(p)) || null;
}

/** 找命令绝对路径；PiOS 子进程 PATH 默认 /usr/bin:/bin 找不到 /opt/homebrew 下的工具 */
function _findCmdAbs(cmd) {
  const probes = [
    `/opt/homebrew/bin/${cmd}`,
    `/opt/homebrew/sbin/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/usr/local/sbin/${cmd}`,
    `${HOME}/.claude/local/${cmd}`,
    `${HOME}/.npm-global/bin/${cmd}`,
    `${HOME}/.volta/bin/${cmd}`,
    `/usr/bin/${cmd}`,
  ];
  for (const p of probes) if (fs.existsSync(p)) return p;
  const r = spawnSync('bash', ['-lc', `command -v ${cmd} 2>/dev/null`], { encoding: 'utf8', timeout: 2000 });
  const out = (r.stdout || '').trim();
  return out && out.startsWith('/') ? out.split('\n')[0] : null;
}

function _probeClaudeAuth() {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', 'claude auth status 2>&1'], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
      timeout: 8000,
    }, (_err, stdout, stderr) => {
      const combined = `${stdout || ''}${stderr || ''}`;
      const jsonMatch = combined.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return resolve({ ok: false, detail: combined.trim() || 'no status output' });
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.loggedIn) {
          return resolve({
            ok: true,
            detail: parsed.emailAddress || parsed.authMethod || 'logged in',
          });
        }
      } catch {}
      resolve({ ok: false, detail: combined.trim() || 'not logged in' });
    });
  });
}

/** spawn 子进程，PATH 自动扩展到 Homebrew 等位置。
 * 必要性：npm shebang 是 `#!/usr/bin/env node`，env 在系统默认 PATH 下找不到 /opt/homebrew/bin/node。
 */
function _run(cmd, args, onProgress) {
  return new Promise((resolve) => {
    let tail = '';
    const appendTail = (chunk) => {
      tail += chunk;
      if (tail.length > 2048) tail = tail.slice(-2048);
    };
    const EXPANDED_PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${HOME}/.claude/local:${HOME}/.npm-global/bin:${process.env.PATH || '/usr/bin:/bin'}`;
    const proc = spawn(cmd, args, {
      env: {
        ...process.env,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        PATH: EXPANDED_PATH,
      },
    });
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      appendTail(s);
      try { onProgress && onProgress(s); } catch {}
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      appendTail(s);
      try { onProgress && onProgress(s); } catch {}
    });
    proc.on('error', (e) => {
      try { onProgress && onProgress(`\n[error] ${e.message}\n`); } catch {}
      resolve({ ok: false, code: -1, tail: tail + `\n[spawn error] ${e.message}` });
    });
    proc.on('close', (code) => {
      resolve({ ok: code === 0, code, tail });
    });
  });
}

/**
 * Xcode Command Line Tools：xcode-select --install 会弹 macOS 原生对话框。
 * 装完后 /Library/Developer/CommandLineTools/usr/bin/git 存在。
 * 下载 5-15 min，这里 trigger 对话框后轮询 max 20 min。
 */
async function installXcodeCLT(onProgress) {
  if (fs.existsSync(XCODE_CLT_PROBE)) {
    try { onProgress && onProgress('[xcode-clt] 已装，跳过\n'); } catch {}
    return { ok: true, code: 0, tail: 'already installed' };
  }
  try {
    onProgress && onProgress('[xcode-clt] 触发系统对话框（点「安装」再等 5-15 min 下载）…\n');
    onProgress && onProgress('[xcode-clt] 这一步不要切走 PiOS；安装完成会自动进入下一项\n');
  } catch {}
  // trigger 系统对话框
  await new Promise((resolve) => {
    execFile('xcode-select', ['--install'], () => resolve());
  });
  // 轮询 20 min
  const deadline = Date.now() + 20 * 60 * 1000;
  let ticks = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(XCODE_CLT_PROBE)) {
      try { onProgress && onProgress('\n[xcode-clt] ✓ 装完成\n'); } catch {}
      return { ok: true, code: 0, tail: 'installed via xcode-select' };
    }
    ticks++;
    if (ticks % 12 === 0) { // 每 1 min 一行提示
      try { onProgress && onProgress(`[xcode-clt] 仍在下载…（${Math.floor((Date.now() - (deadline - 20*60*1000))/60000)} min / 20 min）\n`); } catch {}
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, code: -1, tail: '[xcode-clt] 20 min 超时——可能用户关了对话框，点重试或手动跑 `xcode-select --install`' };
}

/**
 * Homebrew 安装：开 Terminal 跑官方脚本，PiOS 这边轮询。
 *
 * 不能用 `osascript ... with administrator privileges`：那会以 root 跑安装脚本，
 * Homebrew install.sh 第一步检查 EUID = 0 直接拒绝（"Don't run this as root!"）。
 * 正确做法：以普通用户身份跑脚本，脚本内部需要写 /opt/homebrew 时自己调 `sudo` 弹密码框。
 * 这要求 stdin 是 TTY（PiOS spawn 的子进程不是 TTY）→ 用 osascript 开 Terminal 真 TTY 跑。
 */
async function installBrew(onProgress) {
  const alreadyBrew = _resolveBrew();
  if (alreadyBrew) {
    try { onProgress && onProgress(`[brew] 已装（${alreadyBrew}），跳过\n`); } catch {}
    return { ok: true, code: 0, tail: 'already installed' };
  }
  try {
    onProgress && onProgress('[brew] 即将弹出 Terminal 跑 Homebrew 官方安装脚本\n');
    onProgress && onProgress('[brew] 在 Terminal 里输入你的 Mac 登录密码（sudo 提示）然后等 5-15 min\n');
    onProgress && onProgress('[brew] PiOS 会轮询 /opt/homebrew/bin/brew 和 /usr/local/bin/brew；装完会自动检测\n');
  } catch {}

  // 写临时脚本。脚本末尾用 osascript 自己关自己的 Terminal 窗口（Terminal 内发 Apple Events
  // 给自己不走 PiOS 沙盒的 PPPC，用户不用手动关窗）。
  const tmpScript = path.join(os.tmpdir(), `pios-brew-install-${Date.now()}.sh`);
  fs.writeFileSync(tmpScript,
`#!/bin/bash
set -e
echo "▶ Homebrew 安装开始（按提示输你的 Mac 登录密码）"
echo ""
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo ""
echo "✓ Homebrew 安装完成。Terminal 窗口将在 3 秒后自动关闭。"
sleep 3
osascript -e 'tell application "Terminal" to close (every window whose name contains "pios-brew-install")' >/dev/null 2>&1 &
exit 0
`);
  fs.chmodSync(tmpScript, '755');

  // 用 `open -a Terminal $script` 走 LaunchServices；不要 osascript Apple Events
  // （sandboxed PiOS.app 没 NSAppleEventsUsageDescription 时 osascript tell Terminal 会被 PPPC 静默拒绝 — -1743）
  const opened = await new Promise((resolve) => {
    execFile('/usr/bin/open', ['-a', 'Terminal', tmpScript], (err, _stdout, stderr) => {
      if (err) {
        try { onProgress && onProgress(`[brew] open Terminal 失败: ${err.message}\n${stderr || ''}\n`); } catch {}
        resolve(false);
      } else {
        try { onProgress && onProgress('[brew] Terminal 已弹出，请按提示输 Mac 登录密码\n'); } catch {}
        resolve(true);
      }
    });
  });
  if (!opened) {
    return { ok: false, code: -1, tail: `[brew] 打开 Terminal 失败。手动跑：\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` };
  }

  // 轮询 brew 二进制（最长 25 min，含 Xcode CLT 5-15 min）
  const startTs = Date.now();
  const deadline = startTs + 25 * 60 * 1000;
  let ticks = 0;
  while (Date.now() < deadline) {
    const found = _resolveBrew();
    if (found) {
      try { onProgress && onProgress(`\n[brew] ✓ 检测到 ${found}，安装完成\n`); } catch {}
      try { fs.unlinkSync(tmpScript); } catch {}
      return { ok: true, code: 0, tail: `installed: ${found}` };
    }
    ticks++;
    if (ticks % 12 === 0) { // 每 1 min 一行
      try { onProgress && onProgress(`[brew] 仍在轮询 /opt/homebrew/bin/brew 和 /usr/local/bin/brew…（${Math.floor((Date.now() - startTs)/60000)} min / 25 min）\n`); } catch {}
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, code: -1, tail: '[brew] 25 min 超时——回 Terminal 看是不是卡密码 / 网络。装完后点「重新检查」。' };
}

async function installNode(onProgress) {
  const brew = _resolveBrew();
  if (!brew) return { ok: false, code: -1, tail: '[node] 先装 Homebrew' };
  try { onProgress && onProgress(`[node] ${brew} install node\n`); } catch {}
  return await _run(brew, ['install', 'node'], onProgress);
}

async function installPython312(onProgress) {
  const brew = _resolveBrew();
  if (!brew) return { ok: false, code: -1, tail: '[python] 先装 Homebrew' };
  try { onProgress && onProgress(`[python] ${brew} install python@3.12\n`); } catch {}
  const py = await _run(brew, ['install', 'python@3.12'], onProgress);
  if (!py.ok) return py;
  // pios-tick.sh 必须 import yaml——没 PyYAML scheduler 第一 tick 就 fatal，pi-worker 永远不跑
  try { onProgress && onProgress(`[python] pip3 install pyyaml\n`); } catch {}
  // 直接用 brew python 的 pip3.12（brew 不自动建 pip3 symlink，_findCmdAbs 在 Electron 子进程 PATH 下会 miss）
  const pipCandidates = [
    '/opt/homebrew/bin/pip3.12',
    '/opt/homebrew/opt/python@3.12/bin/pip3.12',
    '/usr/local/bin/pip3.12',
    _findCmdAbs('pip3'),
  ].filter(Boolean);
  const pip = pipCandidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || pipCandidates[0];
  const pipRes = await _run(pip, ['install', '--break-system-packages', 'pyyaml'], onProgress);
  // pip 失败不阻断（可能已装），只记录
  if (!pipRes.ok) {
    try { onProgress && onProgress(`[python] pip 安装 pyyaml 失败（可能已装），继续\n`); } catch {}
  }
  return { ok: true, code: 0, tail: 'python@3.12 + pyyaml OK' };
}

// ffmpeg：F5 语音识别要把浏览器录的 webm 转成 whisper 能吃的 16k wav
async function installFfmpeg(onProgress) {
  const brew = _resolveBrew();
  if (!brew) return { ok: false, code: -1, tail: '[ffmpeg] 先装 Homebrew' };
  try { onProgress && onProgress(`[ffmpeg] ${brew} install ffmpeg\n`); } catch {}
  return await _run(brew, ['install', 'ffmpeg'], onProgress);
}

async function installCodex(onProgress) {
  const hasCodex = !!_findCmdAbs('codex');
  if (hasCodex) {
    try { onProgress && onProgress('[codex] 已装，跳过\n'); } catch {}
    return { ok: true, code: 0, tail: 'already installed' };
  }
  const npmBin = _findCmdAbs('npm');
  if (!npmBin) {
    return { ok: false, code: -1, tail: '[codex] 找不到 npm——先把 Node.js 装完' };
  }
  try {
    onProgress && onProgress(`[codex] ${npmBin} install -g @openai/codex\n`);
    onProgress && onProgress('[codex] 装完后首次使用需 codex auth login（开浏览器 OAuth）\n');
  } catch {}
  return await _run(npmBin, ['install', '-g', '@openai/codex'], onProgress);
}

/**
 * Claude CLI：
 *   1) npm install -g @anthropic-ai/claude-code
 *   2) 提示用户手动 claude auth login（会开浏览器 OAuth，是 interactive 的）
 */
async function installClaudeCli(onProgress) {
  const hasClaude = !!_findCmdAbs('claude');
  if (!hasClaude) {
    // 用绝对路径跑 npm（Electron 子进程 PATH 默认不含 /opt/homebrew/bin，裸 'npm' 会 ENOENT）
    const npmBin = _findCmdAbs('npm');
    if (!npmBin) {
      return { ok: false, code: -1, tail: '[claude] 找不到 npm 二进制——先把 Node.js 装完（上一项 Dep）' };
    }
    try {
      onProgress && onProgress(`[claude] ${npmBin} install -g @anthropic-ai/claude-code\n`);
      onProgress && onProgress('[claude] 提示：Claude Desktop (/Applications/Claude.app) 和 Claude CLI 是两个东西；PiOS agent 依赖 CLI，两者不冲突可共存\n');
    } catch {}
    const installRes = await _run(npmBin, ['install', '-g', '@anthropic-ai/claude-code'], onProgress);
    if (!installRes.ok) return installRes;
  } else {
    try { onProgress && onProgress('[claude] 二进制已存在，直接进入登录\n'); } catch {}
  }

  const before = await _probeClaudeAuth();
  if (before.ok) {
    try { onProgress && onProgress(`[claude] 已登录，跳过（${before.detail}）\n`); } catch {}
    return { ok: true, code: 0, tail: 'already logged in' };
  }

  try {
    onProgress && onProgress('[claude] 正在拉起 claude auth login；浏览器会自动打开 OAuth 页面\n');
    onProgress && onProgress('[claude] 完成浏览器登录后，PiOS 会自动继续，不需要切去 Terminal\n');
  } catch {}

  let pty;
  try {
    pty = require('node-pty');
  } catch (err) {
    return { ok: false, code: -1, tail: `node-pty not available: ${err.message}` };
  }

  return await new Promise((resolve) => {
    let tail = '';
    const appendTail = (chunk) => {
      tail += chunk;
      if (tail.length > 4096) tail = tail.slice(-4096);
    };
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      try { proc.kill(); } catch {}
      resolve(result);
    };

    const proc = pty.spawn('bash', ['-lc', 'claude auth login'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`, TERM: 'xterm-256color' },
    });

    proc.onData((data) => {
      appendTail(data);
      try { onProgress && onProgress(data); } catch {}
    });

    proc.onExit(({ exitCode }) => {
      if (settled) return;
      // 先等一次轮询结果，避免 OAuth 成功但进程先退出。
      setTimeout(async () => {
        const auth = await _probeClaudeAuth();
        if (auth.ok) finish({ ok: true, code: 0, tail });
        else finish({ ok: false, code: exitCode, tail: tail || auth.detail || 'claude auth login exited before login completed' });
      }, 1000);
    });

    const pollTimer = setInterval(async () => {
      const auth = await _probeClaudeAuth();
      if (auth.ok) {
        try { onProgress && onProgress(`\n[claude] ✓ 登录完成（${auth.detail}）\n`); } catch {}
        finish({ ok: true, code: 0, tail });
      }
    }, 3000);

    const timeoutTimer = setTimeout(() => {
      finish({ ok: false, code: -1, tail: tail || 'claude auth login timed out after 10 minutes' });
    }, 10 * 60 * 1000);
  });
}

module.exports = { installBrew, installNode, installPython312, installFfmpeg, installClaudeCli, installCodex, installXcodeCLT };
