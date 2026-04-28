// Profile 认知层 — Cognition Layer (P4)
// Owner Profile 文件展示 + pending-updates 审批
// 权限隔离：pipeline agent 只写 .pending-updates.json；真正改 Profile md 由 PiBrowser 前端 IPC 触发

const fs = require('fs');
const path = require('path');
const os = require('os');
const matter = require('gray-matter');
const VAULT_ROOT = require('./vault-root');

const OWNER = (() => {
  try {
    const yaml = require('js-yaml');
    const m = yaml.load(fs.readFileSync(path.join(VAULT_ROOT, 'Pi', 'Config', 'pios.yaml'), 'utf-8'));
    return m.owner || 'User';
  } catch { return 'User'; }
})();

const PROFILE_DIR = path.join(VAULT_ROOT, OWNER, 'Profile');
const PENDING_PATH = path.join(PROFILE_DIR, '.pending-updates.json');
const ARCHIVE_DIR = path.join(PROFILE_DIR, 'archive');

// ── helpers ──

function ensureDirs() {
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function readPending() {
  try {
    const raw = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'));
    // Defensive: if agent wrote a bare array instead of {version, items}, wrap it
    if (Array.isArray(raw)) return { version: 1, updated_at: null, items: raw };
    return raw;
  } catch {
    return { version: 1, updated_at: null, items: [] };
  }
}

function savePendingAtomic(data) {
  data.updated_at = new Date().toISOString();
  const tmp = path.join(os.tmpdir(), `pending-updates.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, PENDING_PATH);
}

function backupFile(name) {
  ensureDirs();
  const src = path.join(PROFILE_DIR, name);
  if (!fs.existsSync(src)) return;
  const today = new Date().toLocaleDateString('sv-SE');
  const dest = path.join(ARCHIVE_DIR, `${today}-${name}`);
  // only one backup per day per file
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
  }
}

function saveProfileAtomic(name, content) {
  const target = path.join(PROFILE_DIR, name);
  const tmp = path.join(os.tmpdir(), `profile.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, target);
}

// ── public API ──

/** GET /pios/profile — list all profile files + pending items */
function loadProfile() {
  const files = [];
  if (fs.existsSync(PROFILE_DIR)) {
    for (const f of fs.readdirSync(PROFILE_DIR)) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      const fp = path.join(PROFILE_DIR, f);
      const stat = fs.statSync(fp);
      const raw = fs.readFileSync(fp, 'utf-8');
      const firstLine = raw.split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('#')) || '';
      files.push({
        name: f,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
        preview: firstLine.slice(0, 120),
      });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const pending = readPending();
  const pendingItems = (pending.items || []).filter(it => it.status === 'pending');
  return { files, pending: pendingItems, pendingUpdatedAt: pending.updated_at, ownerName: OWNER };
}

/** GET /pios/profile/file?name=X — read single profile md */
function loadProfileFile(name) {
  if (!name || name.includes('..') || name.includes('/')) throw new Error('Invalid file name');
  const fp = path.join(PROFILE_DIR, name);
  if (!fs.existsSync(fp)) throw new Error(`File not found: ${name}`);
  return { name, content: fs.readFileSync(fp, 'utf-8'), mtime: fs.statSync(fp).mtime.toISOString() };
}

/** POST /pios/profile/approve — { id } */
function approveDiff(id) {
  const data = readPending();
  const item = (data.items || []).find(it => it.id === id);
  if (!item) throw new Error(`Diff not found: ${id}`);
  if (item.status !== 'pending') throw new Error(`Diff already ${item.status}`);

  // backup before modify
  backupFile(item.file);

  // read profile, apply diff
  const fp = path.join(PROFILE_DIR, item.file);
  if (!fs.existsSync(fp)) throw new Error(`Profile file not found: ${item.file}`);
  let content = fs.readFileSync(fp, 'utf-8');

  if (item.old && content.includes(item.old)) {
    content = content.replace(item.old, item.new);
  } else if (item.type === 'add' || !item.old) {
    // append to section or end
    if (item.section) {
      const sectionHeader = new RegExp(`^##\\s+${item.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
      const match = sectionHeader.exec(content);
      if (match) {
        // find end of section (next ## or EOF)
        const afterHeader = content.slice(match.index + match[0].length);
        const nextSection = afterHeader.search(/\n##\s/);
        const insertPos = nextSection >= 0
          ? match.index + match[0].length + nextSection
          : content.length;
        content = content.slice(0, insertPos) + '\n' + item.new + '\n' + content.slice(insertPos);
      } else {
        content += '\n\n## ' + item.section + '\n\n' + item.new + '\n';
      }
    } else {
      content += '\n' + item.new + '\n';
    }
  } else {
    // old text not found — still mark applied but note mismatch
    item.apply_note = 'old text not found in file, appended new text';
    content += '\n' + item.new + '\n';
  }

  saveProfileAtomic(item.file, content);
  item.status = 'applied';
  item.applied_at = new Date().toISOString();
  savePendingAtomic(data);
  return { ok: true, id, file: item.file };
}

/** POST /pios/profile/reject — { id } */
function rejectDiff(id) {
  const data = readPending();
  const item = (data.items || []).find(it => it.id === id);
  if (!item) throw new Error(`Diff not found: ${id}`);
  if (item.status !== 'pending') throw new Error(`Diff already ${item.status}`);
  item.status = 'rejected';
  item.rejected_at = new Date().toISOString();
  savePendingAtomic(data);
  return { ok: true, id };
}

/** POST /pios/profile/approve-all */
function approveAll() {
  const data = readPending();
  const pendings = (data.items || []).filter(it => it.status === 'pending');
  const results = [];
  for (const item of pendings) {
    try {
      results.push(approveDiff(item.id));
    } catch (e) {
      results.push({ ok: false, id: item.id, error: e.message });
    }
  }
  return { results, applied: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
}

/** POST /pios/profile/save — { name, content } direct manual edit */
function saveProfile(name, content) {
  if (!name || name.includes('..') || name.includes('/')) throw new Error('Invalid file name');
  backupFile(name);
  saveProfileAtomic(name, content);
  return { ok: true, name };
}

module.exports = {
  loadProfile,
  loadProfileFile,
  approveDiff,
  rejectDiff,
  approveAll,
  saveProfile,
  PROFILE_DIR,
  PENDING_PATH,
};
