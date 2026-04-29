// Scratch Pad — 零摩擦输入面
// 文件命名：{ISO秒}-{nanoid6}.md，frontmatter 含 pi_visible / pi_ingested / pi_routed_to
// diary-engine Step 1D（P2 改造后）会扫这个目录做接住

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const crypto = require('crypto');
const VAULT_ROOT = require('./vault-root');

function getOwnerName() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pios', 'config.json'), 'utf-8'));
    if (cfg.owner_name) return cfg.owner_name;
  } catch {}
  return 'User';
}

function getScratchDir() {
  return path.join(VAULT_ROOT, getOwnerName(), 'Scratch');
}

function getAttachDir() {
  return path.join(getScratchDir(), 'attachments');
}

function ensureDirs() {
  const scratchDir = getScratchDir();
  const attachDir = getAttachDir();
  if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
  if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });
}

function nanoid6() {
  return crypto.randomBytes(4).toString('base64url').slice(0, 6);
}

function isoSec(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function newFilename() {
  return `${isoSec()}-${nanoid6()}.md`;
}

// 原子写迁到 lib/atomic-write helper（2026-04-28 集中化）
const { writeAtomic: atomicWrite } = require('./lib/atomic-write');

function extractTitle(content) {
  if (!content) return '';
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 80);
  const firstLine = content.split('\n').find(l => l.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : '';
}

function parseOne(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: fm, content } = matter(raw);
    const filename = path.basename(filePath);
    const stat = fs.statSync(filePath);
    return {
      filename,
      created: fm.created || null,
      pi_visible: fm.pi_visible !== false,
      pi_ingested: fm.pi_ingested || null,
      pi_routed_to: fm.pi_routed_to || null,
      tags: fm.tags || [],
      title: extractTitle(content) || filename.replace(/\.md$/, ''),
      preview: content.replace(/^\s+/, '').slice(0, 200),
      content,
      mtime: Math.floor(stat.mtimeMs / 1000),
      size: stat.size,
    };
  } catch (e) {
    return null;
  }
}

function list() {
  ensureDirs();
  const scratchDir = getScratchDir();
  const files = fs.readdirSync(scratchDir).filter(f => f.endsWith('.md') && f !== 'README.md');
  const items = files.map(f => parseOne(path.join(scratchDir, f))).filter(Boolean);
  items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return items;
}

function read(filename) {
  if (!isValidFilename(filename)) throw new Error('invalid filename');
  const p = path.join(getScratchDir(), filename);
  if (!fs.existsSync(p)) return null;
  return parseOne(p);
}

function isValidFilename(f) {
  return typeof f === 'string' && /^[\w:.-]+\.md$/.test(f) && !f.includes('..') && !f.includes('/');
}

function create({ content = '', pi_visible = true, tags = [] } = {}) {
  ensureDirs();
  const filename = newFilename();
  const fm = {
    created: new Date().toISOString(),
    pi_visible: !!pi_visible,
    pi_ingested: null,
    pi_routed_to: null,
    tags: Array.isArray(tags) ? tags : [],
  };
  const full = matter.stringify(content || '', fm);
  atomicWrite(path.join(getScratchDir(), filename), full);
  return { ok: true, filename };
}

function update({ filename, content, pi_visible, tags } = {}) {
  if (!isValidFilename(filename)) throw new Error('invalid filename');
  const p = path.join(getScratchDir(), filename);
  if (!fs.existsSync(p)) throw new Error('not found');
  const raw = fs.readFileSync(p, 'utf-8');
  const { data: fm, content: oldContent } = matter(raw);
  const newFm = { ...fm };
  if (typeof pi_visible === 'boolean') newFm.pi_visible = pi_visible;
  if (Array.isArray(tags)) newFm.tags = tags;
  const newContent = typeof content === 'string' ? content : oldContent;
  atomicWrite(p, matter.stringify(newContent, newFm));
  return { ok: true };
}

function remove({ filename } = {}) {
  if (!isValidFilename(filename)) throw new Error('invalid filename');
  const p = path.join(getScratchDir(), filename);
  if (!fs.existsSync(p)) return { ok: true };
  fs.unlinkSync(p);
  return { ok: true };
}

// 粘贴截图：dataUrl 形如 "data:image/png;base64,iVBOR..."
// 写入 attachments/{baseFilename}-{nanoid4}.{ext}
// 返回相对路径，让 UI 插入 ![](attachments/xxx.png) 到便签
function attach({ filename, dataUrl } = {}) {
  if (!isValidFilename(filename)) throw new Error('invalid filename');
  if (typeof dataUrl !== 'string') throw new Error('dataUrl required');
  const m = dataUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
  if (!m) throw new Error('unsupported dataUrl');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) throw new Error('image too large (>10MB)');
  ensureDirs();
  const base = filename.replace(/\.md$/, '');
  const suffix = crypto.randomBytes(2).toString('hex');
  const attachName = `${base}-${suffix}.${ext}`;
  fs.writeFileSync(path.join(getAttachDir(), attachName), buf);
  return { ok: true, path: `attachments/${attachName}` };
}

module.exports = { list, read, create, update, remove, attach, getScratchDir, getAttachDir };
