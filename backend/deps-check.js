/**
 * deps-check.js — 检测 PiOS 需要的外部系统依赖
 *
 * 4 项：Homebrew、Node.js 18+、Python 3.12、Claude CLI（含 auth）
 * Setup Wizard 第 0 页用。读操作安全可重复调。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const HOME = os.homedir();
const BREW_BIN_CANDIDATES = [
  '/opt/homebrew/bin/brew',   // Apple Silicon 标准
  '/usr/local/bin/brew',      // Intel / legacy
  `${HOME}/homebrew/bin/brew`, // 用户自建
];
const PY312_BIN_CANDIDATES = [
  '/opt/homebrew/opt/python@3.12/bin/python3.12',
  '/usr/local/opt/python@3.12/bin/python3.12',
];
// Xcode CLT 装完后 /Library/Developer/CommandLineTools/usr/bin/git 存在
const XCODE_CLT_PROBE = '/Library/Developer/CommandLineTools/usr/bin/git';

function _execQuiet(cmd, timeoutMs = 3000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 用 login shell 跑命令，拿用户 .zshrc/.bash_profile 的 PATH */
function _execAllowFailure(cmd, timeoutMs = 3000) {
  const res = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const combined = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return combined || null;
}

/**
 * 找命令的绝对路径，先直接扫常见位置（不走 shell，零开销），再兜底 login shell command -v。
 * PiOS Electron 子进程的 PATH 是系统默认（不含 ~/.claude/local /opt/homebrew 等），
 * 直接 `which xxx` / `execSync('xxx --version')` 会找不到用户装在这些路径的工具。
 */
function _findCmd(cmd) {
  const probes = [
    `/opt/homebrew/bin/${cmd}`,
    `/opt/homebrew/sbin/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/usr/local/sbin/${cmd}`,
    `${HOME}/.claude/local/${cmd}`,
    `${HOME}/.npm-global/bin/${cmd}`,
    `${HOME}/.volta/bin/${cmd}`,
    `${HOME}/.nvm/versions/node/latest/bin/${cmd}`,
    `/usr/bin/${cmd}`,
  ];
  for (const p of probes) {
    if (fs.existsSync(p)) return p;
  }
  // 兜底：login shell
  const r = _execAllowFailure(`command -v ${cmd} 2>/dev/null`, 2000);
  if (r && r.startsWith('/')) return r.split('\n')[0].trim();
  return null;
}

function checkXcodeCLT() {
  if (!fs.existsSync(XCODE_CLT_PROBE)) {
    return { ok: false, detail: '未装 Xcode Command Line Tools（Homebrew 的前置）' };
  }
  return { ok: true, detail: 'Xcode CLT 已装' };
}

function checkBrew() {
  const brew = BREW_BIN_CANDIDATES.find(p => fs.existsSync(p)) || _findCmd('brew');
  if (!brew) return { ok: false, detail: '未找到 brew 命令（扫了 /opt/homebrew、/usr/local、用户 shell PATH）' };
  const v = _execAllowFailure(`"${brew}" --version 2>/dev/null`);
  return { ok: true, detail: v ? v.split('\n')[0] : `Homebrew @ ${brew}` };
}

function checkNode() {
  const node = _findCmd('node');
  if (!node) return { ok: false, detail: '未找到 node 命令（装完 Homebrew 后 `brew install node`）' };
  const v = _execAllowFailure(`"${node}" --version 2>/dev/null`);
  if (!v) return { ok: false, detail: `找到 ${node} 但跑不起来` };
  const major = parseInt(v.replace(/^v/, '').split('.')[0], 10);
  if (!(major >= 18)) return { ok: false, detail: `Node ${v} 版本过低（需要 ≥18）` };
  return { ok: true, detail: `Node ${v}` };
}

function checkPython312() {
  const py = PY312_BIN_CANDIDATES.find(p => fs.existsSync(p)) || _findCmd('python3.12');
  if (!py) return { ok: false, detail: '未找到 Python 3.12（NPC 语音需要，装完 brew 后 `brew install python@3.12`）' };
  const v = _execAllowFailure(`"${py}" --version 2>/dev/null`);
  // 确认 PyYAML 可用（pios-tick.sh / pios-installer 都要 import yaml）
  const hasYaml = _execAllowFailure(`"${py}" -c 'import yaml' 2>/dev/null; echo $?`);
  if (hasYaml && hasYaml.trim() !== '0') {
    return { ok: false, detail: `${v || 'Python 3.12'} 已装但缺 PyYAML（scheduler 需要）`, stage: 'missing_pyyaml' };
  }
  return { ok: true, detail: v || `Python 3.12 @ ${py}` };
}

function checkFfmpeg() {
  const bin = _findCmd('ffmpeg') || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : null) || (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : null);
  if (!bin) return { ok: false, detail: '未找到 ffmpeg（F5 语音识别需要把 webm 转 wav）', stage: 'missing' };
  const v = _execAllowFailure(`"${bin}" -version 2>/dev/null | head -1`);
  return { ok: true, detail: v || `ffmpeg @ ${bin}` };
}

function checkCodex() {
  const bin = _findCmd('codex');
  if (!bin) return { ok: false, detail: '未找到 codex 命令（装法：npm install -g @openai/codex 或 brew install --cask codex）', stage: 'missing' };
  const v = _execAllowFailure(`"${bin}" --version 2>/dev/null`);
  return { ok: true, detail: v ? v.split('\n')[0] : `Codex @ ${bin}` };
}

function checkClaude() {
  const bin = _findCmd('claude');
  if (!bin) return { ok: false, detail: '未找到 claude 命令（扫了 /opt/homebrew、~/.claude/local、用户 shell PATH）', stage: 'missing' };
  const v = _execAllowFailure(`"${bin}" --version 2>/dev/null`);
  const authStatus = _execAllowFailure(`"${bin}" auth status 2>&1`, 8000);
  if (!authStatus) {
    return { ok: false, detail: 'Claude CLI 已装，但登录状态检查失败', stage: 'auth_unknown' };
  }

  const jsonMatch = authStatus.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.loggedIn) {
        const parts = [];
        if (parsed.emailAddress) parts.push(parsed.emailAddress);
        if (parsed.authMethod) parts.push(parsed.authMethod);
        return {
          ok: true,
          detail: parts.length ? `Claude CLI 已登录（${parts.join(' · ')}）` : (v || bin),
          stage: 'ready',
        };
      }
    } catch {}
  }

  return {
    ok: false,
    detail: 'Claude CLI 已装，但还没登录',
    stage: 'auth_missing',
    install_label: '登录',
    version: v || bin,
  };
}

/** 一次性返回全部项状态（顺序即依赖顺序：CLT → Brew → Node/Python → Claude 或 Codex）*/
function check() {
  return {
    xcode_clt: checkXcodeCLT(),
    brew: checkBrew(),
    node: checkNode(),
    python312: checkPython312(),
    ffmpeg: checkFfmpeg(),
    claude: checkClaude(),
    codex: checkCodex(),
  };
}

/** 前 5 项必装；Claude / Codex 至少一个 ok 就行（PiOS agent 能回退任一 runtime） */
function allOk(status) {
  const coreOk = status.xcode_clt.ok && status.brew.ok && status.node.ok && status.python312.ok && status.ffmpeg.ok;
  const aiOk = status.claude.ok || (status.codex && status.codex.ok);
  return coreOk && aiOk;
}

module.exports = { check, checkXcodeCLT, checkBrew, checkNode, checkPython312, checkFfmpeg, checkClaude, checkCodex, allOk };
