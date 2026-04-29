/**
 * Browsing Memory System
 *
 * Auto-extracts valuable information from visited pages,
 * stores as markdown in Pi/Memory/browsing/,
 * and provides search for chat context injection.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT_PATH = require('./vault-root');
const MEMORY_DIR = path.join(VAULT_PATH, 'Pi', 'Memory', 'browsing');
const INDEX_FILE = path.join(MEMORY_DIR, '_index.json');
const DWELL_THRESHOLD_MS = 30000; // 30 seconds
const MAX_MEMORIES = 500;

// PII patterns to filter out
const PII_PATTERNS = [
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,           // phone numbers
  /\b\d{15,18}\b/g,                              // ID card numbers
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // credit card numbers
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // emails
  /\b(?:password|passwd|密码|pwd)\s*[:=]\s*\S+/gi, // passwords
  /\b(?:api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, // API keys
];

// URLs to skip (not worth memorizing)
const SKIP_URL_PATTERNS = [
  /^about:/,
  /^chrome:/,
  /^file:/,
  /google\.com\/search/,
  /duckduckgo\.com\/\?q=/,
  /bing\.com\/search/,
  /baidu\.com\/s\?/,
  /localhost/,
  /127\.0\.0\.1/,
  /\.(pdf|zip|tar|gz|exe|dmg|pkg)$/i,
];

// Track active tab dwell times
const dwellTimers = new Map(); // tabId -> { url, startTime, timer }

function ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch {
    return { memories: [] };
  }
}

function saveIndex(index) {
  ensureDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function urlHash(url) {
  return crypto.createHash('md5').update(url).digest('hex').substring(0, 10);
}

function shouldSkipUrl(url) {
  return SKIP_URL_PATTERNS.some(p => p.test(url));
}

function filterPII(text) {
  let cleaned = text;
  for (const pattern of PII_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[FILTERED]');
  }
  return cleaned;
}

function extractKeyInfo(title, url, text) {
  // Extract headings
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const headings = lines.filter(l => l.length < 100 && l.length > 3).slice(0, 10);

  // Extract first meaningful paragraph (>50 chars)
  const paragraphs = [];
  let current = '';
  for (const line of lines) {
    if (line.length > 50) {
      paragraphs.push(line);
      if (paragraphs.length >= 3) break;
    }
  }

  // Extract key facts: numbers, dates, names in context
  const factLines = lines.filter(l =>
    /\d{4}/.test(l) || /\$[\d,.]+/.test(l) || /\d+%/.test(l)
  ).slice(0, 5);

  return {
    headings: headings.slice(0, 8),
    summary: paragraphs.join('\n\n').substring(0, 1500),
    keyFacts: factLines,
  };
}

function generateTags(title, url, text) {
  const tags = new Set();
  const combined = `${title} ${text}`.toLowerCase();

  // Domain as tag
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    tags.add(domain);
  } catch {}

  // Topic detection
  const topicKeywords = {
    'tech': ['ai', 'machine learning', 'programming', 'software', 'api', 'code', 'github', 'developer'],
    'finance': ['stock', 'investment', 'trading', 'fund', 'market', 'financial', '股票', '投资', '基金'],
    'business': ['startup', 'company', 'revenue', 'growth', 'product', '公司', '创业', '营收'],
    'ecommerce': ['amazon', 'shopify', 'product', 'seller', 'listing', '电商', '卖家', '亚马逊'],
    'health': ['health', 'sleep', 'exercise', 'medical', '健康', '睡眠', '运动'],
    'news': ['news', 'breaking', 'report', 'announced', '新闻', '报道'],
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(k => combined.includes(k))) {
      tags.add(topic);
    }
  }

  return [...tags].slice(0, 5);
}

/**
 * Start tracking dwell time for a page.
 * Call when a page finishes loading or tab becomes active.
 */
function startDwellTracking(tabId, url, extractFn) {
  // Clear existing timer for this tab
  stopDwellTracking(tabId);

  if (!url || shouldSkipUrl(url)) return;

  // Check if we already have a recent memory for this URL
  const index = loadIndex();
  const existing = index.memories.find(m => m.url === url);
  if (existing) {
    const hoursSince = (Date.now() - new Date(existing.date).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) return; // Don't re-memorize within 24h
  }

  const timer = setTimeout(async () => {
    dwellTimers.delete(tabId);
    try {
      const pageData = await extractFn();
      if (pageData && pageData.text && pageData.text.length > 200) {
        await saveMemory(pageData.title, pageData.url, pageData.text);
      }
    } catch (err) {
      console.warn('[browsing-memory] extraction failed:', err.message);
    }
  }, DWELL_THRESHOLD_MS);

  dwellTimers.set(tabId, { url, startTime: Date.now(), timer });
}

/**
 * Stop dwell tracking for a tab (navigated away or closed).
 */
function stopDwellTracking(tabId) {
  const entry = dwellTimers.get(tabId);
  if (entry) {
    clearTimeout(entry.timer);
    dwellTimers.delete(tabId);
  }
}

/**
 * Save a browsing memory.
 */
async function saveMemory(title, url, text) {
  ensureDir();

  const filtered = filterPII(text);
  const { headings, summary, keyFacts } = extractKeyInfo(title, url, filtered);
  const tags = generateTags(title, url, filtered);
  const date = new Date().toISOString().split('T')[0];
  const hash = urlHash(url);
  const filename = `${date}-${hash}.md`;
  const filepath = path.join(MEMORY_DIR, filename);

  // Build markdown content
  const content = `---
url: ${url}
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
tags: [${tags.join(', ')}]
---

# ${title}

**Source**: ${url}
**Visited**: ${new Date().toISOString()}

## Key Points

${headings.map(h => `- ${h}`).join('\n')}

## Summary

${summary || '(Page content too short for summary)'}

${keyFacts.length ? `## Key Facts\n\n${keyFacts.map(f => `- ${f}`).join('\n')}` : ''}
`.trimEnd() + '\n';

  fs.writeFileSync(filepath, content);

  // Update index
  const index = loadIndex();
  // Remove old entry for same URL if exists
  index.memories = index.memories.filter(m => m.url !== url);
  index.memories.push({
    file: filename,
    url,
    title,
    date,
    tags,
    headingSample: headings.slice(0, 3).join(' | '),
  });

  // Trim to max
  if (index.memories.length > MAX_MEMORIES) {
    const removed = index.memories.splice(0, index.memories.length - MAX_MEMORIES);
    for (const r of removed) {
      try { fs.unlinkSync(path.join(MEMORY_DIR, r.file)); } catch {}
    }
  }

  saveIndex(index);
  console.log(`[browsing-memory] saved: ${filename} (${tags.join(', ')})`);
  return filename;
}

/**
 * Search memories by keywords. Returns relevant memory excerpts.
 */
function searchMemories(query, maxResults = 3) {
  const index = loadIndex();
  if (!index.memories.length) return [];

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  // Score each memory by relevance
  const scored = index.memories.map(m => {
    let score = 0;
    const searchable = `${m.title} ${m.tags.join(' ')} ${m.headingSample || ''}`.toLowerCase();

    for (const word of queryWords) {
      if (searchable.includes(word)) score += 2;
      if (m.tags.some(t => t.includes(word))) score += 3;
      if (m.title.toLowerCase().includes(word)) score += 2;
    }

    // Recency bonus (last 7 days get a boost)
    const daysSince = (Date.now() - new Date(m.date).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) score += 1;
    if (daysSince < 1) score += 1;

    return { ...m, score };
  }).filter(m => m.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);

  // Load actual content for top results
  return top.map(m => {
    try {
      const content = fs.readFileSync(path.join(MEMORY_DIR, m.file), 'utf-8');
      // Extract summary section
      const summaryMatch = content.match(/## Summary\n\n([\s\S]*?)(?=\n## |$)/);
      return {
        title: m.title,
        url: m.url,
        date: m.date,
        tags: m.tags,
        summary: summaryMatch ? summaryMatch[1].trim().substring(0, 500) : '',
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Format search results for injection into chat context.
 */
function formatMemoriesForChat(memories) {
  if (!memories.length) return '';
  return '\n\n[浏览记忆]\n' + memories.map(m =>
    `- **${m.title}** (${m.date}): ${m.summary.substring(0, 200)}${m.summary.length > 200 ? '...' : ''}\n  来源: ${m.url}`
  ).join('\n');
}

/**
 * List all memories (for UI display).
 */
function listMemories(limit = 50) {
  const index = loadIndex();
  return index.memories.slice(-limit).reverse().map(m => ({
    file: m.file,
    title: m.title,
    url: m.url,
    date: m.date,
    tags: m.tags,
  }));
}

/**
 * Delete a specific memory.
 */
function deleteMemory(filename) {
  const index = loadIndex();
  index.memories = index.memories.filter(m => m.file !== filename);
  saveIndex(index);
  try {
    fs.unlinkSync(path.join(MEMORY_DIR, filename));
  } catch {}
}

module.exports = {
  startDwellTracking,
  stopDwellTracking,
  saveMemory,
  searchMemories,
  formatMemoriesForChat,
  listMemories,
  deleteMemory,
};
