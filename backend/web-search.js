/**
 * Web Search — DuckDuckGo HTML 搜索结果提取
 *
 * 无需 API key，解析 DuckDuckGo HTML 页面获取搜索结果。
 * 返回结构化的 { title, url, snippet } 列表。
 *
 * 使用 curl 子进程（Node.js 在 Electron 沙盒中 HTTPS 不可靠）。
 */

const { execFile } = require('child_process');

const DDG_URL = 'https://html.duckduckgo.com/html/';

async function webSearch(query, { maxResults = 8, timeout = 8000 } = {}) {
  if (!query || !query.trim()) return [];

  try {
    const html = await ddgFetch(query, timeout);
    return parseResults(html, maxResults);
  } catch (err) {
    console.warn('[web-search] error:', err.message);
    return [];
  }
}

function ddgFetch(query, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutSec = Math.ceil(timeout / 1000);
    execFile('curl', [
      '-s', DDG_URL,
      '-d', `q=${encodeURIComponent(query)}`,
      '--max-time', String(timeoutSec),
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    ], { maxBuffer: 1024 * 1024, timeout: timeout + 2000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      if (!stdout) return reject(new Error('empty response'));
      resolve(stdout);
    });
  });
}

function parseResults(html, maxResults) {
  const results = [];

  // Title+URL: <a class="result__a" href="URL">Title</a>
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippet: <a class="result__snippet" href="...">Snippet</a>
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [];
  let m;
  while ((m = resultRegex.exec(html)) !== null) {
    links.push({ rawUrl: m[1], titleHtml: m[2] });
  }

  const snippets = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push(m[1]);
  }

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    let url = links[i].rawUrl;

    // DuckDuckGo wraps URLs: //duckduckgo.com/l/?uddg=ENCODED_URL
    if (url.includes('uddg=')) {
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
    }
    if (!url.startsWith('http')) continue;

    const title = cleanHtml(links[i].titleHtml);
    const snippet = snippets[i] ? cleanHtml(snippets[i]) : '';

    if (title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function cleanHtml(s) {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function formatResultsForPrompt(results) {
  if (!results.length) return '';
  const lines = results.map((r, i) =>
    `${i + 1}. [${r.title}](${r.url})${r.snippet ? '\n   ' + r.snippet : ''}`
  );
  return `## 网络搜索结果\n\n${lines.join('\n\n')}`;
}

/**
 * classifyQuery — 智能判断用户输入是否需要网络搜索
 *
 * 返回 { needsSearch: boolean, reason: string }
 *
 * 策略：
 * - 命令/导航/问候/简短回复 → 不搜索
 * - 时效性关键词（新闻/价格/天气/最新/今天） → 搜索
 * - 本地/商户关键词（附近/推荐/哪里/餐厅） → 搜索
 * - 产品/比较关键词（对比/评测/哪个好/vs） → 搜索
 * - 纯知识/概念问题（什么是/原理/解释） → 不搜索
 * - 编程/技术问题（代码/函数/bug/error） → 不搜索
 * - 默认：较长的问句 → 搜索，其余 → 不搜索
 */
/**
 * classifyQuery — 决定是否需要 web 搜索
 *
 * 原则：默认不搜索。Pi 有 PiOS 上下文（manifest + cards + SYSTEM.md），
 * 能回答大多数问题。只在用户明确要求搜索时才搜。
 *
 * AI 自己判断：如果 AI 回答时发现缺少信息，会告诉用户，用户可以说"搜一下"。
 */
function classifyQuery(text) {
  const cleaned = text.trim();
  if (cleaned.length < 3) return { needsSearch: false, reason: 'too-short' };

  // 用户明确要求搜索 → 搜
  if (/^(?:搜索|搜一下|搜 |search |google |百度 |查一下|帮我[搜查]|去[搜查])/i.test(cleaned))
    return { needsSearch: true, reason: 'explicit-search' };

  // 消息中包含"搜一下""查一下"等搜索意图
  if (/(?:帮我搜|帮我查|搜一下|查一下|search for|look up|搜搜看)/i.test(cleaned))
    return { needsSearch: true, reason: 'explicit-search' };

  // 默认不搜索 — AI 从 PiOS 上下文 + 自身知识回答
  return { needsSearch: false, reason: 'default-no-search' };
}

/**
 * categorizeResults — 将搜索结果按类型分组（视频/新闻/其他）
 *
 * 基于域名模式识别：
 * - videos: YouTube, Vimeo, Bilibili, Dailymotion, TikTok 等
 * - news: 主流新闻站点 + 含 /news/ 路径的 URL
 * - all: 全部结果（含 videos/news）
 */
const VIDEO_DOMAINS = /(?:youtube\.com|youtu\.be|vimeo\.com|bilibili\.com|dailymotion\.com|tiktok\.com|twitch\.tv|v\.qq\.com|iqiyi\.com|youku\.com)/i;
const NEWS_DOMAINS = /(?:reuters\.com|apnews\.com|bbc\.com|bbc\.co\.uk|cnn\.com|nytimes\.com|theguardian\.com|washingtonpost\.com|bloomberg\.com|cnbc\.com|foxnews\.com|nbcnews\.com|abcnews\.go\.com|news\.yahoo\.com|thehill\.com|politico\.com|xinhuanet\.com|chinadaily\.com\.cn|thepaper\.cn|163\.com\/news|sina\.com\.cn\/news|36kr\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com)/i;

function categorizeResults(results) {
  const videos = [];
  const news = [];

  for (const r of results) {
    try {
      const hostname = new URL(r.url).hostname;
      const pathname = new URL(r.url).pathname;
      if (VIDEO_DOMAINS.test(hostname)) {
        videos.push(r);
      } else if (NEWS_DOMAINS.test(hostname) || /\/news\//i.test(pathname)) {
        news.push(r);
      }
    } catch { /* skip invalid URLs */ }
  }

  return { all: results, videos, news };
}

// Backward-compatible wrapper
function isSearchQuery(text) {
  return classifyQuery(text).needsSearch;
}


module.exports = { webSearch, formatResultsForPrompt, isSearchQuery, classifyQuery, categorizeResults };
