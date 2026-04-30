// Claude session helpers extracted from main.js.
// 包含：
//   - parseContextMarkdown / fetchContextDetail（/context 解析）
//   - findClaudeJsonl（cwd-encoded path 查找）
//   - backupSessionJsonl / compactSession / restoreSessionFromBackup（auto-compact 管线）
//   - compactInFlight Set（防止同 session 并发 compact）

const path = require('path');
const fs = require('fs');
const VAULT_ROOT = require('../backend/vault-root');

const _CLAUDE_BIN = (() => {
  const { execSync } = require('child_process');
  try { return execSync('which claude', { encoding: 'utf-8' }).trim(); } catch {}
  const candidates = [
    path.join(process.env.HOME || '', '.claude/local/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'claude';
})();

const SESSION_BACKUP_DIR = path.join(VAULT_ROOT, 'Pi', 'Log', 'claude-session-backup');
const compactInFlight = new Set();

function parseContextMarkdown(md) {
  const out = { model: null, total: 0, max: 200000, pct: 0, categories: [], memoryFiles: [], skills: [], raw_markdown: md };
  const parseNum = (n, unit) => {
    const v = parseFloat(n);
    const u = (unit || '').toLowerCase();
    return Math.round(u === 'k' ? v * 1000 : u === 'm' ? v * 1000000 : v);
  };
  const m1 = md.match(/\*\*Model:\*\*\s+(\S+)/);
  if (m1) out.model = m1[1];
  const m2 = md.match(/\*\*Tokens:\*\*\s+([\d.]+)([km]?)\s*\/\s*([\d.]+)([km]?)\s*\((\d+)%\)/i);
  if (m2) { out.total = parseNum(m2[1], m2[2]); out.max = parseNum(m2[3], m2[4]); out.pct = parseInt(m2[5]); }
  const catSec = md.split('Estimated usage by category')[1]?.split(/\n###\s/)[0] || '';
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*([\d.]+)([km]?)\s*\|\s*([\d.]+)%\s*\|\s*$/gmi;
  let row;
  while ((row = rowRe.exec(catSec)) !== null) {
    const name = row[1].trim();
    if (/^(category|-+)$/i.test(name)) continue;
    out.categories.push({ name, tokens: parseNum(row[2], row[3]), pct: parseFloat(row[4]) });
  }
  const memSec = md.split(/###\s+Memory Files/i)[1]?.split(/\n###\s/)[0] || '';
  const memRe = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)([km]?)\s*\|\s*$/gmi;
  let mrow;
  while ((mrow = memRe.exec(memSec)) !== null) {
    const type = mrow[1].trim();
    if (/^(type|-+)$/i.test(type)) continue;
    out.memoryFiles.push({ type, path: mrow[2].trim(), tokens: parseNum(mrow[3], mrow[4]) });
  }
  const skillSec = md.split(/###\s+Skills/i)[1]?.split(/\n###\s/)[0] || '';
  let srow;
  while ((srow = memRe.exec(skillSec)) !== null) {
    const name = srow[1].trim();
    if (/^(skill|-+)$/i.test(name)) continue;
    out.skills.push({ name, source: srow[2].trim(), tokens: parseNum(srow[3], srow[4]) });
  }
  return out;
}

function fetchContextDetail(claudeSid) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const args = ['-p', '/context', '--resume', claudeSid, '--fork-session', '--output-format', 'stream-json', '--verbose'];
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/opt/node/bin', '/usr/local/bin'];
    const envPath = (process.env.PATH || '/usr/bin:/bin');
    const fullPath = [...extraPaths, ...envPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');
    const env = { ...process.env, PATH: fullPath };
    if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDECODE;
    const proc = spawn(_CLAUDE_BIN, args, { cwd: VAULT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 20000);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', (e) => { clearTimeout(killer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      const lines = stdout.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]);
          if (ev.type === 'result' && ev.result) return resolve(parseContextMarkdown(ev.result));
        } catch {}
      }
      reject(new Error(stderr || `claude /context exit ${code}, no result`));
    });
  });
}

// Claude CLI 把 cwd 里所有非 [a-zA-Z0-9] 字符转成 `-`（含 `_`、`.`、`/`）。
// 只替换 `/` 会让含 `_` 的 VAULT_ROOT（如 `~/my_vault`）算成 `-Users-x-my_vault`，
// 而 Claude 实际目录是 `-Users-x-my-vault`，导致候选 existsSync 永远 false。
function findClaudeJsonl(sid) {
  const projectsBase = path.join(process.env.HOME || '', '.claude', 'projects');
  if (!fs.existsSync(projectsBase)) return null;
  const vaultEncoded = VAULT_ROOT.replace(/[^a-zA-Z0-9]/g, '-');
  for (const dir of [vaultEncoded, '-']) {
    const p = path.join(projectsBase, dir, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const dir of fs.readdirSync(projectsBase)) {
      const p = path.join(projectsBase, dir, `${sid}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function backupSessionJsonl(sid) {
  const src = findClaudeJsonl(sid);
  if (!src) throw new Error(`session JSONL not found: ${sid}`);
  if (!fs.existsSync(SESSION_BACKUP_DIR)) fs.mkdirSync(SESSION_BACKUP_DIR, { recursive: true });
  const ts = Date.now();
  const dst = path.join(SESSION_BACKUP_DIR, `${sid}-${ts}.jsonl`);
  fs.copyFileSync(src, dst);
  return { backupPath: dst, ts, sizeBefore: fs.statSync(src).size, sourcePath: src };
}

function compactSession(claudeSid) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const args = ['-p', '/compact', '--resume', claudeSid, '--output-format', 'stream-json', '--verbose'];
    const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/opt/node/bin', '/usr/local/bin'];
    const envPath = (process.env.PATH || '/usr/bin:/bin');
    const fullPath = [...extraPaths, ...envPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');
    const env = { ...process.env, PATH: fullPath };
    if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDECODE;
    const proc = spawn(_CLAUDE_BIN, args, { cwd: VAULT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 300000);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', (e) => { clearTimeout(killer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(stderr || `claude /compact exit ${code}`));
      const lines = stdout.split('\n').filter(l => l.trim());
      let resultEvent = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const ev = JSON.parse(lines[i]); if (ev.type === 'result') { resultEvent = ev; break; } } catch {}
      }
      resolve({ duration_ms: resultEvent?.duration_ms || null, session_id: resultEvent?.session_id || claudeSid });
    });
  });
}

function restoreSessionFromBackup(sid, backupPath) {
  if (!fs.existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  if (!backupPath.startsWith(SESSION_BACKUP_DIR)) throw new Error('backup path outside backup dir');
  const dst = findClaudeJsonl(sid);
  if (!dst) throw new Error(`cannot locate target JSONL for sid ${sid}`);
  fs.copyFileSync(backupPath, dst);
  return { restored: true, sizeAfter: fs.statSync(dst).size };
}

module.exports = {
  parseContextMarkdown,
  fetchContextDetail,
  findClaudeJsonl,
  backupSessionJsonl,
  compactSession,
  restoreSessionFromBackup,
  compactInFlight,
  SESSION_BACKUP_DIR,
};
