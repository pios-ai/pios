// PiBrowser — 前端逻辑

let currentMode = 'chat'; // 'chat' | 'browser'
let threadId = null;
let terminalContext = null;
let sidebarCollapsed = false;
let currentEngine = 'auto'; // 'auto' | 'codex' | 'gpt' | 'claude'
let currentModel = 'sonnet'; // 'sonnet' | 'opus' | 'haiku'
let cleanMode = false; // 匿名对话：不注入个人上下文

function updateCleanModeUI() {
  // 所有 + 按钮
  document.querySelectorAll('.sidebar-plus-btn').forEach(btn => {
    btn.textContent = cleanMode ? '🔒' : '+';
  });
  // 输入框样式
  [chatInput, sidebarInput].forEach(input => {
    if (!input) return;
    input.placeholder = cleanMode ? '匿名对话 · 不带上下文' : '有问题，尽管问';
    const row = input.closest('#sidebar-input-row, #chat-input-row');
    if (row) row.style.borderColor = cleanMode ? '#ff8c42' : '';
  });
  // 菜单勾选
  document.querySelectorAll('#sidebar-clean-status, #chat-clean-status').forEach(s => {
    s.textContent = cleanMode ? '✓' : '';
  });
}
// 关键事件落盘 → Pi/Log/pibrowser-debug.log，让后端/开发者不开 DevTools 也能读
// 不抛错、不 await —— fire-and-forget；失败仅 console.warn
function _debugLog(tag, obj) {
  const msg = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const line = `${tag} ${msg}`;
  try { console.log(line); } catch {}
  // GET + query string —— main.js 的本地 server 那段路由是 GET-only 块
  try {
    fetch(`http://127.0.0.1:17891/pi/debug-log?msg=${encodeURIComponent(line)}`);
  } catch {}
}

const MAIN_SESSION_ID = 'pi-main'; // 常驻主会话 — Pi 的持续对话
let currentSession = null;
let pageContext = null; // 自动感知的页面上下文 { title, url, text }

// DOM
const chatFullscreen = document.getElementById('chat-fullscreen');
const welcomeHero = document.getElementById('welcome-hero');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const sidebar = document.getElementById('sidebar');
const sidebarMessagesSlot = document.getElementById('sidebar-messages-slot');
const sidebarMessages = chatMessages; // 共享同一个消息容器

// 移动共享消息容器到 sidebar 或 fullscreen
const chatMessagesParent = chatMessages.parentNode; // 原始位置（chat-fullscreen）
const pageContextBar = document.getElementById('page-context-bar');
const pageContextTitle = document.getElementById('page-context-title');
const pageContextFavicon = document.getElementById('page-context-favicon');
const pageContextCardFavicon = document.getElementById('page-context-card-favicon');
const pageContextCardTitle = document.getElementById('page-context-card-title');
const pageContextCardDomain = document.getElementById('page-context-card-domain');
const privacyLock = document.getElementById('privacy-lock');
const sidebarInputArea = document.getElementById('sidebar-input-area');
const chatInputArea = document.getElementById('chat-input-area');

function moveChatMessagesTo(target) {
  if (target === 'sidebar' && sidebarMessagesSlot) {
    sidebarMessagesSlot.parentNode.insertBefore(chatMessages, sidebarMessagesSlot);
    if (pageContextBar && sidebarInputArea) {
      const firstChild = sidebarInputArea.firstElementChild;
      if (firstChild !== pageContextBar) sidebarInputArea.insertBefore(pageContextBar, firstChild);
    }
  } else if (target === 'fullscreen' && chatMessagesParent) {
    const hero = chatMessagesParent.querySelector('#welcome-hero');
    if (hero) hero.after(chatMessages);
    else chatMessagesParent.prepend(chatMessages);
    if (pageContextBar && chatInputArea) {
      const firstChild = chatInputArea.firstElementChild;
      if (firstChild !== pageContextBar) chatInputArea.insertBefore(pageContextBar, firstChild);
    }
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
const sidebarInput = document.getElementById('sidebar-input');
const sidebarSend = document.getElementById('sidebar-send');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarExpand = document.getElementById('sidebar-expand');
const btnAskPi = document.getElementById('btn-ask-pi');
const addressBar = document.getElementById('address-bar');
const urlInput = document.getElementById('url-input');
const topbarTitle = document.getElementById('topbar-title');
const btnBackToChat = document.getElementById('btn-back-to-chat');
const terminalBanner = document.getElementById('terminal-context-banner');
const clearContext = document.getElementById('clear-context');
const tabBar = document.getElementById('tab-bar');
const tabList = document.getElementById('tab-list');
const newTabBtn = document.getElementById('new-tab-btn');
const btnPin = document.getElementById('btn-pin');
const btnGoBack = document.getElementById('btn-go-back');
const btnGoForward = document.getElementById('btn-go-forward');
const btnReload = document.getElementById('btn-reload');
const loadingBar = document.getElementById('loading-bar');
const btnBookmark = document.getElementById('btn-bookmark');
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findClose = document.getElementById('find-close');
const downloadToast = document.getElementById('download-toast');

// Markdown 配置
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: false, gfm: true });
}

// 消息渲染
function formatTime(date) {
  const d = date || new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function exitWelcomeState() {
  if (welcomeHero) {
    welcomeHero.classList.add('hidden');
  }
}

function enterWelcomeState() {
  if (welcomeHero) {
    welcomeHero.classList.remove('hidden');
  }
}

// ── 搜索结果来源提取 ──
function extractSources(text) {
  const sources = [];
  const seen = new Set();
  // Match markdown links: [title](url)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = linkRegex.exec(text)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      sources.push({ title: m[1], url, domain });
    } catch { /* skip invalid URLs */ }
  }
  return sources;
}

function buildSourceStrip(items) {
  const strip = document.createElement('div');
  strip.className = 'source-cards';
  items.forEach((src, i) => {
    const card = document.createElement('div');
    card.className = 'source-card';
    card.title = src.url;
    card.addEventListener('click', () => {
      if (window.pi && window.pi.navigate) {
        window.pi.navigate(src.url);
      } else {
        window.open(src.url, '_blank');
      }
    });
    const header = document.createElement('div');
    header.className = 'source-card-header';
    const domain = src.domain || (() => { try { return new URL(src.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const favicon = document.createElement('img');
    favicon.className = 'source-card-favicon';
    favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    favicon.onerror = () => { favicon.style.display = 'none'; };
    const domainEl = document.createElement('span');
    domainEl.className = 'source-card-domain';
    domainEl.textContent = domain;
    header.appendChild(favicon);
    header.appendChild(domainEl);
    const title = document.createElement('div');
    title.className = 'source-card-title';
    title.textContent = src.title;
    if (src.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'source-card-snippet';
      snippet.textContent = src.snippet.substring(0, 80);
      card.appendChild(header);
      card.appendChild(title);
      card.appendChild(snippet);
    } else {
      const idx = document.createElement('div');
      idx.className = 'source-card-index';
      idx.textContent = (i + 1).toString();
      card.appendChild(header);
      card.appendChild(title);
      card.appendChild(idx);
    }
    strip.appendChild(card);
  });
  return strip;
}

function renderSourceCards(sources, contentEl, categorized) {
  if (!sources.length) return;

  // Wrapper for tabs + cards
  const wrapper = document.createElement('div');
  wrapper.className = 'source-results';

  // Determine tab counts from backend categorized data
  const videoItems = categorized && categorized.videos ? categorized.videos : [];
  const newsItems = categorized && categorized.news ? categorized.news : [];

  // Tab bar — show count badges for non-empty categories
  const tabBarEl = document.createElement('div');
  tabBarEl.className = 'source-tabs';
  const tabs = [
    { key: 'all', label: '全部', icon: '🔗', count: sources.length },
    { key: 'videos', label: '视频', icon: '▶️', count: videoItems.length },
    { key: 'news', label: '新闻', icon: '📰', count: newsItems.length }
  ];
  tabs.forEach(t => {
    const tab = document.createElement('button');
    tab.className = 'source-tab' + (t.key === 'all' ? ' active' : '');
    tab.dataset.tab = t.key;
    const badge = t.count > 0 && t.key !== 'all' ? ` <span class="source-tab-badge">${t.count}</span>` : '';
    tab.innerHTML = `<span class="source-tab-icon">${t.icon}</span>${t.label}${badge}`;
    tab.addEventListener('click', () => {
      tabBarEl.querySelectorAll('.source-tab').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      wrapper.querySelectorAll('.source-tab-panel').forEach(p => {
        p.classList.toggle('hidden', p.dataset.panel !== t.key);
      });
    });
    tabBarEl.appendChild(tab);
  });
  wrapper.appendChild(tabBarEl);

  // "全部" panel — source cards strip (from AI response links)
  const allPanel = document.createElement('div');
  allPanel.className = 'source-tab-panel';
  allPanel.dataset.panel = 'all';
  allPanel.appendChild(buildSourceStrip(sources));
  wrapper.appendChild(allPanel);

  // Videos panel
  const videosPanel = document.createElement('div');
  videosPanel.className = 'source-tab-panel hidden';
  videosPanel.dataset.panel = 'videos';
  if (videoItems.length) {
    videosPanel.appendChild(buildSourceStrip(videoItems));
  } else {
    const empty = document.createElement('div');
    empty.className = 'source-tab-empty';
    empty.textContent = '暂无视频结果';
    videosPanel.appendChild(empty);
  }
  wrapper.appendChild(videosPanel);

  // News panel
  const newsPanel = document.createElement('div');
  newsPanel.className = 'source-tab-panel hidden';
  newsPanel.dataset.panel = 'news';
  if (newsItems.length) {
    newsPanel.appendChild(buildSourceStrip(newsItems));
  } else {
    const empty = document.createElement('div');
    empty.className = 'source-tab-empty';
    empty.textContent = '暂无新闻结果';
    newsPanel.appendChild(empty);
  }
  wrapper.appendChild(newsPanel);

  contentEl.insertBefore(wrapper, contentEl.firstChild);
}

function addFootnotes(html, sources) {
  if (!sources.length) return html;
  // Replace markdown-rendered links that match sources with footnote badges
  sources.forEach((src, i) => {
    const num = i + 1;
    // Match <a> tags pointing to the source URL
    const escapedUrl = src.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aRegex = new RegExp(`<a[^>]*href="${escapedUrl}"[^>]*>[^<]*</a>`, 'g');
    html = html.replace(aRegex, (match) => {
      return `${match}<span class="source-footnote" data-source-idx="${i}" title="${src.domain}">${num}</span>`;
    });
  });
  return html;
}

// 把 AI 回复里出现的本地图片路径（由 codex image_gen / 其它 tool 生成）渲染成 inline 预览。
// 支持两种形态：marked 生成的 <a href="...png"> 链接，以及没被 linkify 的裸绝对路径。
// 点击走 showImageFullscreen lightbox，不让 electron 主窗口 navigate 到 file://。
const _IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)(\?[^\s"'<>]*)?$/i;
function inlineLocalImages(html) {
  // 1) <a href="file:///abs/path.png"> 或 <a href="/abs/path.png">
  html = html.replace(
    /<a\s+[^>]*href="(file:\/\/)?(\/[^"?#]+?\.(?:png|jpe?g|gif|webp|svg|bmp))(\?[^"]*)?(#[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, _scheme, absPath, _q, _h, label) => {
      const safe = absPath.replace(/"/g, '&quot;');
      const cap = (label || absPath).replace(/</g, '&lt;');
      return `<span class="inline-img-wrap"><img class="inline-gen-image" src="file://${safe}" data-local-path="${safe}" alt="${cap}" /><a class="inline-img-caption" href="#" data-local-path="${safe}">${cap}</a></span>`;
    }
  );
  // 2) 裸绝对路径：必须不在 "/' ` > 后面（避开属性值/已有链接/代码块里）
  html = html.replace(
    /(^|[^"'`>\w/])(\/[A-Za-z0-9._\-\/~]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?=[\s<.,;:!?]|$)/gi,
    (_m, pre, absPath) => {
      const safe = absPath.replace(/"/g, '&quot;');
      return `${pre}<span class="inline-img-wrap"><img class="inline-gen-image" src="file://${safe}" data-local-path="${safe}" alt="${safe}" /><a class="inline-img-caption" href="#" data-local-path="${safe}">${safe}</a></span>`;
    }
  );
  return html;
}

function normalizeInlineImageSrc(src) {
  if (!src) return src;
  if (/^\/[A-Za-z0-9._\-\/~]+\.(png|jpe?g|gif|webp|svg|bmp)([?#].*)?$/i.test(src)) {
    return `file://${src}`;
  }
  return src;
}

function replaceBrokenImage(img) {
  if (!img || img.dataset.brokenHandled === '1') return;
  img.dataset.brokenHandled = '1';
  const rawSrc = img.getAttribute('src') || img.src || '';
  const alt = img.getAttribute('alt') || '图片';
  const box = document.createElement('span');
  box.className = 'inline-img-broken';

  const title = document.createElement('span');
  title.className = 'inline-img-broken-title';
  title.textContent = `${alt} 加载失败`;
  box.appendChild(title);

  const detail = document.createElement('span');
  detail.className = 'inline-img-broken-detail';
  if (/^(attachment:|sandbox:|blob:)/i.test(rawSrc)) {
    detail.textContent = '这类临时附件 URL 不能跨会话打开，需要重新生成或落盘为本地文件。';
  } else {
    detail.textContent = rawSrc || '没有可用图片地址';
  }
  box.appendChild(detail);

  img.replaceWith(box);
}

function enhanceInlineImages(root) {
  if (!root) return;
  root.querySelectorAll('img').forEach(img => {
    const rawSrc = img.getAttribute('src') || '';
    const normalized = normalizeInlineImageSrc(rawSrc);
    if (normalized && normalized !== rawSrc) img.setAttribute('src', normalized);

    const src = img.getAttribute('src') || '';
    if (/^(file:\/\/|data:image\/|https?:\/\/|\/)/i.test(src) || _IMAGE_EXT_RE.test(src)) {
      img.classList.add('inline-gen-image');
      if (src.startsWith('file://')) {
        try { img.dataset.localPath = decodeURIComponent(src.replace(/^file:\/\//, '')); } catch { /* ignore */ }
      }
      img.style.cursor = 'zoom-in';
    }

    img.onerror = () => replaceBrokenImage(img);
    setTimeout(() => {
      if (img.isConnected && img.complete && img.naturalWidth === 0) replaceBrokenImage(img);
    }, 0);
  });
}

function handleAssistantContentClick(e, sources) {
  const img = e.target.closest('.inline-gen-image');
  if (img) {
    e.preventDefault();
    e.stopPropagation();
    showImageFullscreen(img.currentSrc || img.src);
    return true;
  }
  const cap = e.target.closest('.inline-img-caption');
  if (cap) {
    e.preventDefault();
    e.stopPropagation();
    const p = cap.dataset.localPath;
    if (p) showImageFullscreen(`file://${p}`);
    return true;
  }
  const fn = e.target.closest('.source-footnote');
  if (fn) {
    e.preventDefault();
    e.stopPropagation();
    const idx = parseInt(fn.dataset.sourceIdx, 10);
    if (sources?.[idx]) {
      if (window.pi && window.pi.navigate) {
        window.pi.navigate(sources[idx].url);
      } else {
        window.open(sources[idx].url, '_blank');
      }
    }
    return true;
  }
  return false;
}

// Temporary storage for search results from backend (set before addMessage, cleared after)
let _pendingSearchResults = null;

function addMessage(container, role, text, options = {}) {
  // Exit welcome state when first message arrives in main chat
  if (container === chatMessages) exitWelcomeState();

  const msg = document.createElement('div');
  msg.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'message-label';
  const msgDate = options.timestamp ? new Date(options.timestamp) : new Date();
  // AI 消息：显示该条回复所用的引擎徽章（Claude / Auto / Codex / GPT） + 模型
  // 来源优先级：options.engine → currentSession.actualEngine → currentSession.engine
  // model 只认 options.model（session 级无 per-message model，避免污染历史消息）
  let engineBadge = '';
  if (role === 'ai') {
    const eng = options.engine || currentSession?.actualEngine || currentSession?.engine || null;
    const labelMap = { claude: 'Claude', codex: 'Codex', gpt: 'GPT', auto: 'Auto', exec: 'Claude', agent: 'Agent' };
    const engLabel = labelMap[eng] || null;
    if (engLabel) {
      engineBadge = ` <span class="msg-engine-badge" title="这条回复由 ${engLabel} 生成">${engLabel}</span>`;
    }
    // 模型 badge：仅 Claude / exec / codex / agent 分支且显式传了 model 时显示
    if (options.model && (eng === 'claude' || eng === 'exec' || eng === 'codex' || eng === 'agent')) {
      let mdlLabel = options.model;
      if (typeof ENGINE_MODELS !== 'undefined') {
        for (const list of Object.values(ENGINE_MODELS)) {
          const hit = list.find(m => m.id === options.model);
          if (hit) { mdlLabel = hit.label; break; }
        }
      }
      engineBadge += ` <span class="msg-engine-badge" title="模型 ${mdlLabel}">${mdlLabel}</span>`;
    }
  }
  label.innerHTML = `${role === 'user' ? 'You' : 'Pi'}${engineBadge} <span class="msg-time" title="${msgDate.toLocaleString()}">${formatTime(msgDate)}</span>`;

  const content = document.createElement('div');
  content.className = 'message-content';

  if (role === 'ai') {
    // Extract source links for search result cards
    const sources = extractSources(text);

    // Render <say> parts with 🔊 visual marker, rest as markdown
    const parts = text.split(/(<say(?:\s+voice="\w+")?\s*>[\s\S]*?<\/say>)/g);
    for (const part of parts) {
      const sayMatch = part.match(/^<say(?:\s+voice="\w+")?\s*>([\s\S]*?)<\/say>$/);
      if (sayMatch) {
        const voice = document.createElement('div');
        voice.className = 'voice-line';
        voice.innerHTML = '<span class="voice-icon" title="这段会被朗读">🔊</span> ' + sayMatch[1].trim();
        content.appendChild(voice);
      } else if (part.trim()) {
        const screen = document.createElement('div');
        screen.className = 'screen-line';
        if (typeof marked !== 'undefined') {
          let html = marked.parse(part.trim());
          html = addFootnotes(html, sources);
          html = inlineLocalImages(html);
          screen.innerHTML = html;
          enhanceInlineImages(screen);
        } else {
          screen.textContent = part.trim();
        }
        content.appendChild(screen);
      }
    }

    // Render source cards strip above the text content (if any sources found)
    renderSourceCards(sources, content, _pendingSearchResults);
    _pendingSearchResults = null; // consume

    // Footnote / inline image click → 自己处理，避免主窗口导航到坏图片 URL。
    content.addEventListener('click', (e) => {
      handleAssistantContentClick(e, sources);
    });

    // 复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制回复';
    copyBtn.addEventListener('click', () => {
      const plain = text.replace(/<say(?:\s+voice="\w+")?\s*>[\s\S]*?<\/say>/g, '').trim();
      navigator.clipboard.writeText(plain);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    });
    content.appendChild(copyBtn);
  } else {
    content.textContent = text;
    // 用户消息：如果有注入来源，在气泡上方显示来源 pill
    // 附件 chips
    if (options.attachments && options.attachments.length) {
      const row = document.createElement('div');
      row.className = 'msg-attachments';
      options.attachments.forEach(f => {
        const chip = document.createElement('div');
        chip.className = 'msg-attach-chip';
        if (f.isImage) {
          chip.innerHTML = `<img src="data:image/${f.ext};base64,${f.base64}"><span>${f.name}</span>`;
          const imgEl = chip.querySelector('img');
          imgEl.style.cursor = 'pointer';
          imgEl.addEventListener('click', (e) => {
            e.stopPropagation();
            showImageFullscreen(imgEl.src);
          });
        } else {
          chip.innerHTML = `<span>${fileIcon(f.ext)}</span><span>${f.name}</span>`;
        }
        row.appendChild(chip);
      });
      msg.appendChild(row);
    }
    // 页面注入来源 pill
    if (options.injectedPage) {
      const { title, url, favicon } = options.injectedPage;
      const src = document.createElement('div');
      src.className = 'msg-page-source';
      const domain = url ? (() => { try { return new URL(url).hostname; } catch { return ''; } })() : '';
      src.title = url || '';
      if (favicon) {
        const fi = document.createElement('img');
        fi.src = favicon;
        fi.onerror = () => fi.style.display = 'none';
        src.appendChild(fi);
      }
      const t = document.createElement('span');
      t.textContent = title || domain;
      src.appendChild(t);
      msg.appendChild(src);
    }
  }

  msg.appendChild(label);
  msg.appendChild(content);

  // 方案 B：重建 exec-activity DOM（来自 msg.steps[]，重启后恢复折叠的工具步骤）
  if (role === 'ai' && options.steps && Array.isArray(options.steps) && options.steps.length > 0) {
    const replayActivity = document.createElement('div');
    replayActivity.className = 'exec-activity v2 collapsed';
    // 状态行：显示"✓ N 个步骤"
    const replayStatus = document.createElement('div');
    replayStatus.className = 'exec-status-line';
    const doneIcon = document.createElement('span');
    doneIcon.className = 'exec-done-icon';
    doneIcon.textContent = '✓';
    const doneLabel = document.createElement('span');
    doneLabel.className = 'exec-current exec-done';
    doneLabel.textContent = `${options.steps.length} 个步骤`;
    replayStatus.appendChild(doneIcon);
    replayStatus.appendChild(doneLabel);
    replayStatus.addEventListener('click', () => replayActivity.classList.toggle('collapsed'));
    replayActivity.appendChild(replayStatus);
    // 历史区：一个折叠组列出所有步骤
    const replayHistory = document.createElement('div');
    replayHistory.className = 'exec-history';
    const group = document.createElement('details');
    group.className = 'exec-step-group';
    const summary = document.createElement('summary');
    summary.className = 'exec-step-group-summary';
    summary.textContent = `${options.steps.length} 个工具调用`;
    group.appendChild(summary);
    for (const step of options.steps) {
      const stepEl = document.createElement('div');
      stepEl.className = 'exec-step';
      const iconEl = document.createElement('span');
      iconEl.className = 'exec-icon';
      iconEl.textContent = step.icon || '🔧';
      const descEl = document.createElement('span');
      descEl.className = 'exec-desc';
      descEl.textContent = step.desc || '';
      stepEl.appendChild(iconEl);
      stepEl.appendChild(descEl);
      group.appendChild(stepEl);
    }
    replayHistory.appendChild(group);
    replayActivity.appendChild(replayHistory);
    container.appendChild(replayActivity);
  }

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return content;
}

// ── 对话 Session 管理 ──
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function clearChat() {
  chatMessages.innerHTML = '';
  sidebarMessages.innerHTML = '';
  terminalOutput.innerHTML = '';
  terminalPanel.style.display = 'none';
  threadId = null;
  // v2：不再在这里 resetClaude()，因为切 session 也会调 clearChat，
  // 调了会打断单例 client 的其他 session（v1 时代的 bug，v2 per-session client 下也要避免）
  audioQueue.interrupt();
  continuousMode = false;
  const headerSpan = document.querySelector('#terminal-header > span');
  headerSpan.textContent = '执行过程';
  headerSpan.style.color = '';
}

function _renderTaskOutcomeBanner(session) {
  if (!session || session.origin !== 'task') return;
  const status = session.runStatus || null;
  if (!['failed', 'degraded', 'zombie', 'timeout'].includes(status)) return;
  const banner = document.createElement('div');
  banner.className = `task-outcome-banner ${status}`;
  if (status === 'failed') {
    const bits = ['任务失败'];
    if (session.exitCode != null) bits.push(`exit ${session.exitCode}`);
    if (session.finishedAt) bits.push(`结束于 ${session.finishedAt}`);
    banner.textContent = bits.join(' · ');
  } else if (status === 'degraded') {
    const bits = ['任务已降级完成'];
    if (session.fallbackFrom && session.engine) bits.push(`${session.fallbackFrom} → ${session.engine}`);
    if (session.fallbackReason) bits.push(`原因: ${session.fallbackReason}`);
    if (session.finishedAt) bits.push(`结束于 ${session.finishedAt}`);
    banner.textContent = bits.join(' · ');
  } else if (status === 'zombie') {
    const bits = ['进程失联'];
    bits.push('adapter 心跳已停 90s+，可能 OOM/SIGKILL/hang');
    if (session.finishedAt) bits.push(`最后心跳约 ${session.finishedAt}`);
    banner.textContent = bits.join(' · ');
  } else if (status === 'timeout') {
    const bits = ['任务超时被强制终止'];
    if (session.exitCode != null) bits.push(`exit ${session.exitCode}`);
    if (session.finishedAt) bits.push(`结束于 ${session.finishedAt}`);
    banner.textContent = bits.join(' · ');
  }
  chatMessages.appendChild(banner);
}

async function createSession() {
  currentSession = {
    id: generateId(),
    title: '新对话',
    permissionLevel: 'full',
    engine: currentEngine,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    threadId: null,
    claudeSessionId: null,
    messages: []
  };
  _rememberSessionOrigin(currentSession.id, currentSession.origin, { hasSessionObject: true });
  clearChat();
  // v2：不再在这里 resetGPT/resetClaude —— 新 session 本来就是空的，
  // 不需要重置别的正在跑的 session 的 CLI 状态
  threadId = null;
  await window.pi.sessionSave(currentSession);
  _updateSessionIndicator(currentSession);
  _syncPermBtn();
  _updateTokenUsageUI({ inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
  // v2：新 session 没有 in-flight，应用空 UI 状态（隐藏 stop 按钮等）
  if (typeof applyUIStateFor === 'function') applyUIStateFor(currentSession.id);
  renderSessionList();
}

/**
 * 分支会话：创建新 session 并预填任务内容，不切换过去，在侧边栏可见。
 * @param {string} title - 会话标题（30字以内）
 * @param {string} taskText - 预填的第一条用户消息
 * @returns {object} 新创建的 session
 */
async function forkSession(title, taskText) {
  const newSession = {
    id: generateId(),
    title: title.substring(0, 30),
    permissionLevel: 'full',
    engine: 'claude',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    threadId: null,
    claudeSessionId: null,
    messages: [{
      role: 'user',
      content: taskText,
      engine: 'claude',
      timestamp: new Date().toISOString(),
    }],
  };
  _rememberSessionOrigin(newSession.id, newSession.origin, { hasSessionObject: true });
  await window.pi.sessionSave(newSession);
  renderSessionList();
  return newSession;
}

function _updateSessionIndicator(session) {
  const els = [document.getElementById('chat-session-indicator'), document.getElementById('sidebar-session-indicator')];
  const bars = [document.getElementById('chat-header-bar'), document.getElementById('sidebar-header-bar')];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const bar = bars[i];
    if (!el) continue;
    if (!session) {
      el.style.display = 'none';
      if (bar) bar.style.display = 'none';
      continue;
    }
    const isMain = session.id === MAIN_SESSION_ID;
    const isTask = session.origin === 'task';
    el.style.display = '';
    if (bar) bar.style.display = '';
    el.classList.toggle('is-pi-main', isMain);
    if (isMain) {
      el.innerHTML = '<span class="indicator-badge">Pi</span>Talk to Pi — 常驻对话';
    } else if (isTask) {
      el.innerHTML = `⚙ ${session.title || session.id}`;
    } else {
      el.innerHTML = session.title || '新对话';
    }
  }
}

// Gate 式并发控制：不串行化（上一次 load 慢会卡死后续切换），改为"最新赢"
// —— 每次 loadSession 并发执行，但在关键 step 前检查 _loadSessionLatestRequestedId。
// 如果已经不是最新请求，静默 return 放弃渲染（最新那次会接手）。
let _loadSessionLatestRequestedId = null;
async function loadSession(id) {
  _loadSessionLatestRequestedId = id;
  return _loadSessionImpl(id);
}

async function _loadSessionImpl(id) {
  let session = await window.pi.sessionLoad(id);
  if (!session) return; // 不存在的 session，调用方自己处理
  // 又一道闸：如果这次 load 在 sessionLoad 期间用户已经又切走了，不要污染 UI
  if (_loadSessionLatestRequestedId !== id) return;
  _rememberSessionOrigin(id, session.origin, { hasSessionObject: true });
  currentSession = session;
  // 更新聊天界面的 session 指示器
  _updateSessionIndicator(session);
  _syncPermBtn();
  // 更新 token 用量显示（从 uiState 读取当前 session 的累计值）
  const _loadSt = _uiStates.get(id);
  _updateTokenUsageUI(_loadSt ? _loadSt.tokenUsage : { inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
  clearChat();
  _renderTaskOutcomeBanner(session);
  if (session.messages.length === 0) {
    enterWelcomeState();
  } else {
    exitWelcomeState();
    for (const msg of session.messages) {
      // 过滤 handlePiEvent 写的后台任务留档（role:'ai', silent:true）——那是活动流不是对话
      if (msg.silent === true || msg.engine === 'silent') continue;
      const role = msg.role === 'user' ? 'user' : 'ai';
      addMessage(chatMessages, role, msg.content, { injectedPage: msg.injectedPage, attachments: msg.attachments, timestamp: msg.timestamp, engine: msg.engine, model: msg.model, steps: msg.steps });
    }
  }
  if (session.engine) setEngine(session.engine);
  if (session.model) setModel(session.model);
  threadId = session.threadId || null;
  // Restore GPT conversation history from session
  if (session.messages.length > 0 && window.pi.restoreGPT) {
    window.pi.restoreGPT(session.messages);
  }
  // 刀 3: 正在跑的 task session，loadSession 时就创建 activity DOM 占位
  // 让 RunSessionAdapter 的 live tool/text 事件有地方着陆
  const taskRunning = session.origin === 'task' && _sessionListStore.get(id)?.running;
  if (taskRunning) {
    const st = _getUIState(id);
    st.status = 'running';
    if (!st.activityEl) createV2ActivityForSession(id, chatMessages);
    exitWelcomeState();
  }
  // v2：把目标 session 的 UI 状态应用到全局按钮和 activity DOM
  if (typeof applyUIStateFor === 'function') {
    const st = _uiStates.get(id);
    if (st && st.activityEl) exitWelcomeState();
    applyUIStateFor(id);
  }
  // 切到这个 session = 用户看到了它的消息 → 清 unread
  _sessionListStore.clearUnread(id);
  // tick 6: 切换视图必须重渲左侧列表 —— 更新 active 高亮、刷新 title 等。
  // store 的自动订阅只 cover running/unread 这两种状态变化，
  // "哪个 session 当前被查看"是单独的维度，由这里负责触发。
  renderSessionList();
}

let _sidebarRefreshTimer = null;
function _setVisibleThreadIdForSession(sessionId, nextThreadId) {
  if (!sessionId || currentSession?.id !== sessionId) return false;
  threadId = nextThreadId || null;
  if (currentSession) currentSession.threadId = threadId;
  return true;
}

async function saveCurrentSession() {
  if (!currentSession) return;
  currentSession.updated = new Date().toISOString();
  currentSession.engine = currentEngine;
  currentSession.model = currentModel;
  currentSession.threadId = threadId;
  await window.pi.sessionSave(currentSession);
  // 防抖刷新左侧边栏
  if (sessionSidebarOpen && !_sidebarRefreshTimer) {
    _sidebarRefreshTimer = setTimeout(() => { _sidebarRefreshTimer = null; renderSessionList(); }, 1000);
  }
}

const _sessionMetaPatchState = new Map();

function _queueSessionMetaPatch(sid, patch) {
  if (!sid || !patch || Object.keys(patch).length === 0) return;
  const existing = _sessionMetaPatchState.get(sid) || { patch: {}, timer: null };
  Object.assign(existing.patch, patch);
  if (existing.timer) {
    _sessionMetaPatchState.set(sid, existing);
    return;
  }
  existing.timer = setTimeout(async () => {
    const state = _sessionMetaPatchState.get(sid);
    if (!state) return;
    _sessionMetaPatchState.delete(sid);
    const nextPatch = state.patch || {};
    if (currentSession && currentSession.id === sid) {
      Object.assign(currentSession, nextPatch);
      try { await saveCurrentSession(); } catch (e) { console.warn('[session-meta-patch] save current failed:', e); }
      return;
    }
    try {
      const bg = await window.pi.sessionLoad(sid);
      if (!bg) return;
      Object.assign(bg, nextPatch);
      bg.updated = new Date().toISOString();
      await window.pi.sessionSave(bg);
    } catch (e) {
      console.warn('[session-meta-patch] save bg failed:', e);
    }
  }, 300);
  _sessionMetaPatchState.set(sid, existing);
}

// ── 左侧会话列表（ChatGPT 风格） ──
const sessionSidebar = document.getElementById('session-sidebar');
const btnSessionSidebar = document.getElementById('btn-session-sidebar');
let sessionSidebarOpen = true; // 默认打开

function toggleSessionSidebar() {
  sessionSidebarOpen = !sessionSidebarOpen;
  sessionSidebar.classList.toggle('collapsed', !sessionSidebarOpen);
  document.body.classList.toggle('sidebar-open', sessionSidebarOpen);
  if (sessionSidebarOpen) {
    window.pi.sessionSidebarOpen();
    renderSessionList();
  } else {
    window.pi.sessionSidebarClose();
  }
}

btnSessionSidebar?.addEventListener('click', toggleSessionSidebar);

// BrowserView 获焦时关闭会话列表
// 分支会话创建后自动刷新侧边栏
window.pi.onSessionsRefresh(() => { renderSessionList(); });

window.pi.onSessionSidebarClose(() => {
  if (!sessionSidebarOpen) return;
  sessionSidebarOpen = false;
  sessionSidebar.classList.add('collapsed');
  document.body.classList.remove('sidebar-open');
  window.pi.sessionSidebarClose(); // 通知 main 重新布局 BrowserView
});

// Tab 切换 → 自动切换绑定的 Session
window.pi.onTabSessionSwitch(async (sessionId) => {
  if (currentSession && currentSession.id === sessionId) return; // 同一个 session，不重载
  const existing = await window.pi.sessionLoad(sessionId);
  if (!existing) {
    // 新 tab：折叠侧边栏，只在内存里建 session，发第一条消息才保存
    currentSession = { id: sessionId, title: '新对话', engine: currentEngine, messages: [], threadId: null, created: new Date().toISOString(), updated: new Date().toISOString() };
    clearChat();
    _updateSessionIndicator(currentSession);
    window.pi.resetGPT();
    window.pi.resetClaude();
    threadId = null;
    enterWelcomeState();
    collapseSidebar();
  } else {
    await loadSession(sessionId);
  }
});

// Home 页深链接：打开指定 conversationId 的会话
window.pi.onOpenConversation(async (conversationId) => {
  const session = await window.pi.sessionLoad(conversationId);
  if (!session) {
    // 友好提示，不白屏
    addMessage(chatMessages, 'ai', `⚠️ 会话 "${conversationId}" 不存在或已被删除。`, {});
    return;
  }
  await loadSession(conversationId);
});

// Plugin 激活：Home 点"激活"按钮 → main.js 收到 IPC → 转发到这里
// 我们 fork 一条新 session（标题如"激活 WeChat"）+ 把 activate.md 当 firstUserMessage 发给 Pi
// Pi 收到一段"激活 X 的完整说明"，按里面的成功标准 + 阶段节奏带用户走完
window.pi.onPluginActivation(async ({ pluginId, title, firstUserMessage }) => {
  try {
    // 1. 创建空 session（不用 forkSession——它会预填消息，跟 sendMessage 流程冲突）
    await createSession();
    // 2. 改 session 标题为 "激活 X"，让用户在 sidebar 看得清
    if (currentSession) {
      currentSession.title = title || `激活 ${pluginId}`;
      currentSession.permissionLevel = 'full';   // 激活要跑 Bash + Write，给 full
      try { await window.pi.sessionSave(currentSession); } catch {}
      _updateSessionIndicator(currentSession);
      renderSessionList();
    }
    // 3. 把 activate.md 当 user message 发出去，Pi 立刻开始执行
    //    sendMessage 支持 options.text 直接传文本（不读 input.value）
    sendMessage(chatInput, chatMessages, { text: firstUserMessage });
  } catch (e) {
    console.error('[plugin-activation] failed:', e);
    addMessage(chatMessages, 'ai', `⚠️ 激活 ${pluginId} 失败：${e.message}`, {});
  }
});

// 初始状态：会话列表默认关闭
sessionSidebarOpen = false;
sessionSidebar.classList.add('collapsed');
document.body.classList.remove('sidebar-open');

// 时间分组辅助
function _getSessionGroup(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 7);
  const month = new Date(today); month.setDate(today.getDate() - 30);
  if (d >= today) return '今天';
  if (d >= yesterday) return '昨天';
  if (d >= week) return '近 7 天';
  if (d >= month) return '近 30 天';
  return '更早';
}

// 格式化会话时间标签（紧凑显示）
function _formatSessionTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= today) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function _buildSessionItem(s) {
  const isMain = s.id === MAIN_SESSION_ID;
  const isTask = s.origin === 'task';
  const item = document.createElement('div');
  // 读 store 决定状态类（active 是当前视图态；running/unread 是 store 态）
  const listSt = (typeof _sessionListStore !== 'undefined') ? _sessionListStore.get(s.id) : null;
  const classes = ['session-item'];
  if (currentSession && s.id === currentSession.id) classes.push('active');
  if (isMain) classes.push('main-session');
  if (isTask) classes.push('task-session');
  if (listSt?.running) classes.push('running');
  if (s.runStatus === 'failed') classes.push('failed');
  if (s.runStatus === 'degraded') classes.push('degraded');
  if (s.runStatus === 'zombie') classes.push('zombie');
  if (s.runStatus === 'timeout') classes.push('timeout');
  if (listSt?.unread) classes.push('unread');
  item.className = classes.join(' ');
  item.dataset.sessionId = s.id;
  if (!isMain) {
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/session-id', s.id);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
  }
  const archiveBtn = isMain ? '' : '<span class="session-archive" title="归档">✕</span>';
  // 状态 pill：running 脉冲点 / zombie 灰停 / timeout 橙警 / failed/degraded / unread
  // fallbackFrom 有值时给 degraded pill 加 tooltip 显示降级链路
  const fallbackTip = s.fallbackFrom ? ` (${s.fallbackFrom}→${s.runtime || '?'}: ${s.fallbackReason || s.fallback_reason || '?'})` : '';
  const pillHtml = (s.runStatus === 'zombie')
    ? '<span class="session-status-pill zombie" title="进程失联（adapter 心跳已停）"></span>'
    : (s.runStatus === 'timeout')
      ? '<span class="session-status-pill timeout" title="任务超时被自动终止"></span>'
    : (listSt?.running)
    ? '<span class="session-status-pill running" title="正在回复"></span>'
    : (s.runStatus === 'failed')
      ? '<span class="session-status-pill failed" title="执行失败"></span>'
      : (s.runStatus === 'degraded')
        ? `<span class="session-status-pill degraded" title="降级完成${fallbackTip}"></span>`
    : (listSt?.unread)
      ? '<span class="session-status-pill unread" title="未读回复"></span>'
      : '';
  // task session 前缀一个齿轮图标做视觉区分（不用色块，色盲安全）
  const taskIcon = isTask ? '<span class="session-task-icon" title="后台任务">⚙</span>' : '';
  // 显示标题：如果是"新对话"且有消息，用时间戳兜底，避免一堆"新对话"无法区分
  let displayTitle = s.title || '新对话';
  if (displayTitle === '新对话' && s.messageCount > 0 && !isMain) {
    displayTitle = '对话 ' + new Date(s.updated).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 时间标签
  const timeLabel = !isMain && s.updated
    ? `<span class="session-item-time">${_formatSessionTime(s.updated)}</span>`
    : '';
  item.innerHTML = `${pillHtml}${taskIcon}<span class="session-item-title">${escapeHtml(displayTitle)}</span>${timeLabel}${archiveBtn}`;
  item.addEventListener('click', async (e) => {
    if (e.target.classList.contains('session-archive')) return;
    if (currentMode === 'browser' || currentMode === 'chat-with-tabs') {
      // 浏览器模式：展开侧边栏，确保全屏聊天关闭
      chatFullscreen.classList.remove('active');
      sidebar.style.display = 'flex';
      sidebarCollapsed = false;
      window.pi.sidebarExpand();
    } else {
      // 聊天模式：确保全屏聊天打开，侧边栏关闭
      chatFullscreen.classList.add('active');
      sidebar.style.display = 'none';
    }
    await loadSession(s.id);
  });
  // 右键菜单（重命名 + 归档）— 主会话不可改名/归档
  if (!isMain) {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _showSessionContextMenu(e.clientX, e.clientY, s, item);
    });
  }
  const archiveEl = item.querySelector('.session-archive');
  if (archiveEl) {
    archiveEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newActiveId = await window.pi.sessionArchive(s.id);
      if (currentSession && currentSession.id === s.id) {
        if (newActiveId) await loadSession(newActiveId);
        else await loadSession(MAIN_SESSION_ID);
      }
      await renderSessionList();
    });
  }
  return item;
}

// 分组折叠状态（内存，不持久化）—— 后台任务默认折叠，二级子分组也默认折叠
const _collapsedGroups = new Set(['tasks']);
const _expandedOnce = new Set(); // 用户手动展开过的子分组，不再自动折叠

// 自定义右键菜单
async function _showSessionContextMenu(x, y, session, itemEl) {
  // 移除旧菜单
  document.querySelectorAll('.session-ctx-menu').forEach(el => el.remove());
  const groups = await window.pi.groupsList();
  const menu = document.createElement('div');
  menu.className = 'session-ctx-menu';

  // 构建分组子菜单
  let groupHtml = '';
  if (session.groupId) {
    groupHtml += `<div class="ctx-item" data-action="ungroup">↩ 移出分组</div>`;
  }
  if (groups.length) {
    const otherGroups = groups.filter(g => g.id !== session.groupId);
    if (otherGroups.length) {
      groupHtml += otherGroups.map(g =>
        `<div class="ctx-item" data-action="move-group" data-group-id="${g.id}">📁 ${escapeHtml(g.name)}</div>`
      ).join('');
    }
  }
  groupHtml += `<div class="ctx-item" data-action="new-group">+ 新建分组并移入</div>`;

  menu.innerHTML = `
    <div class="ctx-item" data-action="rename">✏️ 重命名</div>
    <div class="ctx-separator"></div>
    ${groupHtml}
    <div class="ctx-separator"></div>
    <div class="ctx-item" data-action="archive">📦 归档</div>
    <div class="ctx-item ctx-danger" data-action="delete">🗑 删除</div>
  `;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  // 边界修正
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';

  const close = () => menu.remove();
  menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
    close();
    _inlineRenameSession(session, itemEl);
  });
  menu.querySelector('[data-action="archive"]').addEventListener('click', async () => {
    close();
    const newActiveId = await window.pi.sessionArchive(session.id);
    if (currentSession && currentSession.id === session.id) {
      if (newActiveId) await loadSession(newActiveId);
      else await loadSession(MAIN_SESSION_ID);
    }
    await renderSessionList();
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    close();
    if (!confirm(`永久删除「${session.title}」？不可恢复。`)) return;
    await window.pi.sessionDelete(session.id);
    if (currentSession && currentSession.id === session.id) {
      await loadSession(MAIN_SESSION_ID);
    }
    await renderSessionList();
  });
  const ungroupEl = menu.querySelector('[data-action="ungroup"]');
  if (ungroupEl) {
    ungroupEl.addEventListener('click', async () => {
      close();
      await window.pi.sessionSetGroup(session.id, null);
      await renderSessionList();
    });
  }
  menu.querySelectorAll('[data-action="move-group"]').forEach(el => {
    el.addEventListener('click', async () => {
      close();
      await window.pi.sessionSetGroup(session.id, el.dataset.groupId);
      await renderSessionList();
    });
  });
  menu.querySelector('[data-action="new-group"]').addEventListener('click', async () => {
    close();
    const name = prompt('新建分组名称');
    if (!name || !name.trim()) return;
    const g = await window.pi.groupCreate(name.trim());
    await window.pi.sessionSetGroup(session.id, g.id);
    await renderSessionList();
  });
  setTimeout(() => {
    const dismiss = (e) => { if (!menu.contains(e.target)) { close(); document.removeEventListener('click', dismiss); } };
    document.addEventListener('click', dismiss);
  }, 0);
}

// Inline 重命名
function _inlineRenameSession(session, itemEl) {
  const titleEl = itemEl.querySelector('.session-item-title');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = session.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const val = input.value.trim();
    if (val && val !== session.title) {
      await window.pi.sessionRename(session.id, val);
      if (currentSession && currentSession.id === session.id) currentSession.title = val;
    }
    await renderSessionList();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = session.title; input.blur(); }
  });
}

// 分组 header 右键菜单
function _showGroupContextMenu(x, y, group) {
  document.querySelectorAll('.session-ctx-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'session-ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" data-action="rename">✏️ 重命名</div>
    <div class="ctx-item ctx-danger" data-action="delete">🗑 删除分组</div>
  `;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  const close = () => menu.remove();
  menu.querySelector('[data-action="rename"]').addEventListener('click', async () => {
    close();
    const name = prompt('重命名分组', group.name);
    if (name && name.trim() && name !== group.name) {
      await window.pi.groupRename(group.id, name.trim());
      await renderSessionList();
    }
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    close();
    if (!confirm(`删除分组「${group.name}」？会话不会被删除，会回到时间分组。`)) return;
    await window.pi.groupDelete(group.id);
    _collapsedGroups.delete('custom-' + group.id);
    await renderSessionList();
  });
  setTimeout(() => {
    const dismiss = (e) => { if (!menu.contains(e.target)) { close(); document.removeEventListener('click', dismiss); } };
    document.addEventListener('click', dismiss);
  }, 0);
}

function _buildGroupHeader(label, key, opts = {}) {
  const header = document.createElement('div');
  header.className = 'session-group-header' + (opts.custom ? ' custom' : '');
  // 后台任务二级子分组默认折叠（首次出现时自动加入 collapsed set）
  if (key.startsWith('task-sub-') && !_collapsedGroups.has(key) && !_expandedOnce.has(key)) {
    _collapsedGroups.add(key);
  }
  const collapsed = _collapsedGroups.has(key);
  header.innerHTML = `<span class="group-arrow">${collapsed ? '▸' : '▾'}</span> ${escapeHtml(label)}`;
  if (opts.count !== undefined) {
    header.innerHTML += `<span class="group-count">${opts.count}</span>`;
  }
  header.addEventListener('click', () => {
    if (_collapsedGroups.has(key)) {
      _collapsedGroups.delete(key);
      _expandedOnce.add(key); // 用户手动展开，后续不再自动折叠
    } else {
      _collapsedGroups.add(key);
    }
    renderSessionList();
  });
  // 自定义分组支持 drop 和右键
  if (opts.custom && opts.group) {
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _showGroupContextMenu(e.clientX, e.clientY, opts.group);
    });
    header.addEventListener('dragover', (e) => { e.preventDefault(); header.classList.add('drag-over'); });
    header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
    header.addEventListener('drop', async (e) => {
      e.preventDefault();
      header.classList.remove('drag-over');
      const sid = e.dataTransfer.getData('text/session-id');
      if (sid) {
        await window.pi.sessionSetGroup(sid, opts.group.id);
        await renderSessionList();
      }
    });
  }
  // 时间分组支持 drop（移出自定义分组）
  if (!opts.custom) {
    header.addEventListener('dragover', (e) => { e.preventDefault(); header.classList.add('drag-over'); });
    header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
    header.addEventListener('drop', async (e) => {
      e.preventDefault();
      header.classList.remove('drag-over');
      const sid = e.dataTransfer.getData('text/session-id');
      if (sid) {
        await window.pi.sessionSetGroup(sid, null);
        await renderSessionList();
      }
    });
  }
  return { header, collapsed };
}

async function renderSessionList() {
  const [list, customGroups] = await Promise.all([
    window.pi.sessionsList(),
    window.pi.groupsList()
  ]);
  // tick 8: 同步 main 进程对 task running 状态的认知到 store。
  // store._patch 自动 dedupe，不会触发无限循环。这是数据流的核心：
  // run record file → sessions:list → store → applyUIStateFor → banner + pill
  _syncRunningStateFromList(list);
  // 启动 15s 低频自动刷新（幂等，多次调用只起一次 timer）
  _startListAutoRefresh();
  const container = document.getElementById('session-list');
  if (!container) return;
  container.innerHTML = '';

  // 1. Pi 主会话置顶
  const main = list.find(s => s.id === MAIN_SESSION_ID);
  if (main) container.appendChild(_buildSessionItem(main));

  const rest = list.filter(s => s.id !== MAIN_SESSION_ID).sort((a, b) => new Date(b.updated) - new Date(a.updated));

  // tick 5: 2a. 后台任务分组 —— s.origin === 'task' 的 session 收集到这里
  // 位置在主会话之后、自定义分组之前。running 的 task 排在最前。
  // 内部按 taskId 再分组，每组显示最新一条，其余折叠。
  const taskSessions = rest.filter(s => s.origin === 'task');
  if (taskSessions.length > 0) {
    // 按 running 优先 + updated 倒序
    taskSessions.sort((a, b) => {
      const ra = _sessionListStore.get(a.id)?.running ? 1 : 0;
      const rb = _sessionListStore.get(b.id)?.running ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return new Date(b.updated) - new Date(a.updated);
    });
    const runningCount = taskSessions.filter(s => _sessionListStore.get(s.id)?.running).length;
    const countLabel = runningCount > 0 ? `${runningCount}/${taskSessions.length}` : taskSessions.length;
    const { header, collapsed } = _buildGroupHeader('⚙ 后台任务', 'tasks', { count: countLabel });
    container.appendChild(header);
    if (!collapsed) {
      // 按 taskId 分组，保持整体排序（running 优先）
      const taskGroups = new Map(); // taskId → [sessions]
      for (const s of taskSessions) {
        const key = s.taskId || s.title.split(' ')[0] || 'other';
        if (!taskGroups.has(key)) taskGroups.set(key, []);
        taskGroups.get(key).push(s);
      }
      for (const [taskName, items] of taskGroups) {
        if (items.length === 1) {
          container.appendChild(_buildSessionItem(items[0]));
        } else {
          // 子分组：显示任务名 + 数量，可折叠
          const subKey = 'task-sub-' + taskName;
          const subRunning = items.filter(s => _sessionListStore.get(s.id)?.running).length;
          const subLabel = subRunning > 0 ? `${subRunning}/${items.length}` : items.length;
          const { header: subHeader, collapsed: subCollapsed } = _buildGroupHeader(taskName, subKey, { count: subLabel });
          subHeader.classList.add('task-sub-group');
          container.appendChild(subHeader);
          if (!subCollapsed) {
            for (const s of items) container.appendChild(_buildSessionItem(s));
          }
        }
      }
    }
  }

  // 2b. 自定义分组（只包含 chat session —— task session 已经被分组拿走）
  for (const g of customGroups) {
    const items = rest.filter(s => s.groupId === g.id && s.origin !== 'task');
    const { header, collapsed } = _buildGroupHeader(g.name, 'custom-' + g.id, { custom: true, group: g, count: items.length });
    container.appendChild(header);
    if (!collapsed) {
      for (const s of items) container.appendChild(_buildSessionItem(s));
    }
  }

  // 新建分组按钮（inline 输入）
  const addGroupBtn = document.createElement('div');
  addGroupBtn.className = 'session-add-group';
  addGroupBtn.textContent = '+ 新建分组';
  addGroupBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 替换为 inline input
    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.placeholder = '分组名称';
    input.style.width = '100%';
    input.style.margin = '2px 4px';
    addGroupBtn.replaceWith(input);
    input.focus();
    const commit = async () => {
      const val = input.value.trim();
      if (val) {
        await window.pi.groupCreate(val);
      }
      await renderSessionList();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.value = ''; input.blur(); }
    });
  });
  container.appendChild(addGroupBtn);

  // 3. 无分组的会话 → 时间分组（task session 已被 2a 拿走，这里排除）
  const ungrouped = rest.filter(s => !s.groupId && s.origin !== 'task');
  const timeGroups = {};
  for (const s of ungrouped) {
    const g = _getSessionGroup(s.updated);
    if (!timeGroups[g]) timeGroups[g] = [];
    timeGroups[g].push(s);
  }
  const groupOrder = ['今天', '昨天', '近 7 天', '近 30 天', '更早'];
  for (const gName of groupOrder) {
    if (!timeGroups[gName] || !timeGroups[gName].length) continue;
    const { header, collapsed } = _buildGroupHeader(gName, 'time-' + gName, { count: timeGroups[gName].length });
    container.appendChild(header);
    if (!collapsed) {
      for (const s of timeGroups[gName]) container.appendChild(_buildSessionItem(s));
    }
  }
}

// 订阅在 _sessionListStore 定义之后注册（见 v2 块），此处是占位说明

// 搜索会话
const sessionSearch = document.getElementById('session-search');
if (sessionSearch) {
  sessionSearch.addEventListener('input', () => {
    const q = sessionSearch.value.trim().toLowerCase();
    document.querySelectorAll('#session-list .session-item').forEach(item => {
      const title = item.querySelector('.session-item-title')?.textContent.toLowerCase() || '';
      item.style.display = title.includes(q) ? '' : 'none';
    });
  });
}

// 归档区（固定底部）
const archiveBtn = document.getElementById('session-archive-btn');
const archiveListEl = document.getElementById('session-archive-list');
if (archiveBtn && archiveListEl) {
  archiveBtn.addEventListener('click', async () => {
    if (archiveListEl.style.display !== 'none') {
      archiveListEl.style.display = 'none';
      archiveBtn.textContent = '📦 归档';
      return;
    }
    const archived = await window.pi.sessionsListArchived();
    if (!archived.length) { archiveBtn.textContent = '📦 归档（空）'; return; }
    archiveBtn.textContent = '📦 归档 ▾';
    const clearBtn = document.getElementById('session-archive-clear');
    if (clearBtn) clearBtn.style.display = 'inline';
    archiveListEl.innerHTML = '';
    archiveListEl.style.display = 'block';
    for (const s of archived.reverse()) {
      const row = document.createElement('div');
      row.className = 'session-item archived';
      row.innerHTML = `<span class="session-item-title">${escapeHtml(s.title)}</span><span class="session-item-time">${new Date(s.updated).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span><span class="session-unarchive" title="恢复">↩</span><span class="session-real-delete" title="永久删除">🗑</span>`;
      row.querySelector('.session-unarchive').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.pi.sessionUnarchive(s.id);
        await renderSessionList();
        archiveBtn.click(); // 刷新归档列表
        archiveBtn.click();
      });
      row.querySelector('.session-real-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`永久删除「${s.title}」？不可恢复。`)) return;
        await window.pi.sessionDelete(s.id);
        archiveBtn.click(); archiveBtn.click(); // 刷新
      });
      row.addEventListener('click', async (e) => {
        if (e.target.closest('.session-unarchive, .session-real-delete')) return;
        await loadSession(s.id);
      });
      archiveListEl.appendChild(row);
    }
  });
}

// 归档清空
const archiveClearBtn = document.getElementById('session-archive-clear');
if (archiveClearBtn) {
  archiveClearBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('清空所有归档会话？不可恢复。')) return;
    await window.pi.sessionDeleteArchived();
    if (archiveListEl) { archiveListEl.innerHTML = ''; archiveListEl.style.display = 'none'; }
    if (archiveBtn) archiveBtn.textContent = '📦 归档';
    archiveClearBtn.style.display = 'none';
  });
}

// 带截图的用户消息
function addUserMessageWithScreenshot(container, text, base64Img, injectedPage, attachments) {
  const msg = document.createElement('div');
  msg.className = 'message user';
  const label = document.createElement('div');
  label.className = 'message-label';
  const now = new Date();
  label.innerHTML = `You <span class="msg-time" title="${now.toLocaleString()}">${formatTime(now)}</span>`;
  if (injectedPage) {
    const src = document.createElement('div');
    src.className = 'msg-page-source';
    if (injectedPage.favicon) {
      const fav = document.createElement('img');
      fav.src = injectedPage.favicon;
      fav.onerror = () => { fav.style.display = 'none'; };
      src.appendChild(fav);
    }
    const t = document.createElement('span');
    t.textContent = injectedPage.title || injectedPage.url;
    src.appendChild(t);
    msg.appendChild(src);
  }
  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = text;
  const img = document.createElement('img');
  img.className = 'chat-screenshot';
  img.src = `data:image/png;base64,${base64Img}`;
  img.addEventListener('click', () => showImageFullscreen(img.src));
  content.appendChild(img);
  // 渲染其余附件 chips（PDF、文本等）
  if (attachments && attachments.length) {
    const row = document.createElement('div');
    row.className = 'msg-attachments';
    attachments.forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'msg-attach-chip';
      chip.innerHTML = `<span>${fileIcon(f.ext)}</span><span>${f.name}</span>`;
      row.appendChild(chip);
    });
    content.appendChild(row);
  }
  msg.appendChild(label);
  msg.appendChild(content);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// 图片全屏查看
function showImageFullscreen(src) {
  window.pi.panelOpen(); // 移除 BrowserView 避免 native 层遮挡
  const overlay = document.createElement('div');
  overlay.className = 'img-fullscreen-overlay';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  // 关闭按钮（右上角 ×），ESC 键同样关闭
  const closeBtn = document.createElement('button');
  closeBtn.className = 'img-fullscreen-close';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭 (Esc)';
  overlay.appendChild(closeBtn);
  const close = () => {
    overlay.remove();
    window.pi.panelClose();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => { if (e.target !== img) close(); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

let abortCurrentRequest = null;  // 取消当前请求 (renderer 侧本地 abort 回调，GPT 流式用)
// 刀 2 step 6b: `stopCurrentRequest` 全局已删 —— stop 按钮按 session 走 `sessionBusInterrupt`

function showTyping(container) {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = 'typing';
  const text = document.createElement('span');
  text.textContent = 'Pi 思考中...';
  const stopBtn = document.createElement('button');
  stopBtn.className = 'typing-stop-btn';
  stopBtn.textContent = '停止';
  stopBtn.addEventListener('click', () => {
    if (abortCurrentRequest) abortCurrentRequest();
  });
  el.appendChild(text);
  el.appendChild(stopBtn);
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function removeTyping() {
  const el = document.getElementById('typing');
  if (el) el.remove();
  abortCurrentRequest = null;
}

// ── Terminal Panel ──
const terminalPanel = document.getElementById('terminal-panel');
const terminalOutput = document.getElementById('terminal-output');
const terminalClear = document.getElementById('terminal-clear');
const sidebarTerminal = document.getElementById('sidebar-terminal');
const sidebarTerminalOutput = document.getElementById('sidebar-terminal-output');
const sidebarClaudeStop = document.getElementById('sidebar-claude-stop');

function termAppend(cls, text) {
  const d = document.createElement('div');
  d.className = 'term-' + cls;
  d.textContent = text;
  // 刀 2 step 6b: `!_execActivityEl` 的 inline activity guard 移除
  // （全局 activity 系统已删，v2 per-session activity 不影响 term panel 展开决策）
  if (terminalPanel.style.display === 'none') terminalPanel.style.display = 'flex';
  terminalOutput.appendChild(d);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
  if (currentMode === 'browser' || currentMode === 'chat-with-tabs') {
    const d2 = d.cloneNode(true);
    sidebarTerminalOutput.appendChild(d2);
    sidebarTerminalOutput.scrollTop = sidebarTerminalOutput.scrollHeight;
  }
}

const claudeStopBtn = document.getElementById('claude-stop');

terminalClear.addEventListener('click', () => {
  terminalOutput.innerHTML = '';
  terminalPanel.style.display = 'none';
});

// 刀 2: 底部 Claude stop 按钮 → 通过 bus interrupt 当前 session
// （老路径 stopClaude 留作 preload 兼容层，这里不再直接调）
claudeStopBtn.addEventListener('click', () => {
  const sid = currentSession?.id;
  if (sid) window.pi.sessionBusInterrupt(sid).catch(() => {});
  claudeStopBtn.style.display = 'none';
  sidebarClaudeStop.style.display = 'none';
  termAppend('err', '⏹ 已停止');
});

sidebarClaudeStop.addEventListener('click', () => {
  const sid = currentSession?.id;
  if (sid) window.pi.sessionBusInterrupt(sid).catch(() => {});
  claudeStopBtn.style.display = 'none';
  sidebarClaudeStop.style.display = 'none';
  termAppend('err', '⏹ 已停止');
});

// ── Engine Toggle ──
const ENGINE_LABELS = { auto: 'Auto', codex: 'Codex', gpt: 'GPT', claude: 'Claude', agent: 'Agent', clean: 'Clean' };
const engineDropdownBtn = document.getElementById('engine-dropdown-btn'); // legacy, hidden
const engineDropdownMenu = document.getElementById('engine-dropdown-menu'); // legacy, hidden

// 常驻引擎按钮
const sidebarEngineBtn = document.getElementById('sidebar-engine-btn');
const sidebarEnginePopup = document.getElementById('sidebar-engine-popup');
const chatEngineBtn = document.getElementById('chat-engine-btn');
const chatEnginePopup = document.getElementById('chat-engine-popup');
const chatPermBtn = document.getElementById('chat-perm-btn'); // legacy hidden
const headerPermBtn = document.getElementById('header-perm-btn');
const sidebarHeaderPermBtn = document.getElementById('sidebar-header-perm-btn');
const headerEngineBtn = document.getElementById('header-engine-btn');
const headerEnginePopup = document.getElementById('header-engine-popup');
const sidebarHeaderEngineBtn = document.getElementById('sidebar-header-engine-btn');

// 权限开关
function _syncPermBtn() {
  const level = currentSession?.permissionLevel || 'full';
  const text = level === 'safe' ? 'Safe' : 'Full';
  const title = level === 'safe'
    ? '权限级别：Safe（只读工具，点击切换）'
    : '权限级别：Full（完全权限，点击切换）';
  [headerPermBtn, sidebarHeaderPermBtn].forEach(btn => {
    if (!btn) return;
    btn.dataset.level = level;
    btn.textContent = text;
    btn.title = title;
  });
}
function _onPermClick() {
  if (!currentSession) return;
  currentSession.permissionLevel = currentSession.permissionLevel === 'full' ? 'safe' : 'full';
  _syncPermBtn();
  saveCurrentSession();
}
headerPermBtn?.addEventListener('click', _onPermClick);
sidebarHeaderPermBtn?.addEventListener('click', _onPermClick);

// ── Model 选择 ──
const headerModelBtn = document.getElementById('header-model-btn');
const headerModelPopup = document.getElementById('header-model-popup');
const sidebarHeaderModelBtn = document.getElementById('sidebar-header-model-btn');
const sidebarHeaderModelPopup = document.getElementById('sidebar-header-model-popup');
const _allModelBtns = [headerModelBtn, sidebarHeaderModelBtn];
const _allModelPopups = [headerModelPopup, sidebarHeaderModelPopup];

// 每个引擎有自己的模型列表：{ id, label, desc }[]，第一个为默认
// Claude 列表来自 2026-04-21 实测（详见 Pi Memory feedback_claude_models_tested.md）
// 实测能跑：sonnet/opus/haiku（alias），opus[1m]（1M 变种），claude-opus-4-7（全名），
//          claude-opus-4-7[1m]（最新 1M）
// 实测不能跑：sonnet[1m]（需开 extra usage 付费，owner 账号跑不了，已移除）
const CLAUDE_MODELS = [
  { id: 'claude-opus-4-7',       label: 'Opus 4.7',        desc: '最新·最强推理' },
  { id: 'claude-opus-4-7[1m]',   label: 'Opus 4.7 1M',     desc: '最新·百万上下文' },
  { id: 'opus',                  label: 'Opus',            desc: '4.6 稳定版' },
  { id: 'opus[1m]',              label: 'Opus 1M',         desc: '4.6·百万上下文' },
  { id: 'sonnet',                label: 'Sonnet',          desc: '4.6 快速平衡' },
  { id: 'haiku',                 label: 'Haiku',           desc: '4.5 轻量快速' },
];
const ENGINE_MODELS = {
  claude: CLAUDE_MODELS,
  auto: CLAUDE_MODELS,
  codex: [
    { id: 'gpt-5.5',          label: 'GPT-5.5',       desc: '最强 agentic' },
    { id: 'gpt-5.4',          label: 'GPT-5.4',       desc: '稳定' },
    { id: 'gpt-5.4-mini',     label: 'GPT-5.4 Mini',  desc: '轻量快速' },
    { id: 'gpt-5.3-codex',    label: 'GPT-5.3 Codex', desc: '代码专精' },
    { id: 'gpt-5.2',          label: 'GPT-5.2',       desc: '通用' },
  ],
  gpt: [
    { id: 'gpt-5.5',          label: 'GPT-5.5',       desc: '最强 agentic' },
    { id: 'gpt-5.4',          label: 'GPT-5.4',       desc: '稳定' },
    { id: 'gpt-5.4-mini',     label: 'GPT-5.4 Mini',  desc: '轻量快速' },
    { id: 'gpt-5.2',          label: 'GPT-5.2',       desc: '通用' },
  ],
};

function _getModelsForEngine(engine) {
  return ENGINE_MODELS[engine] || ENGINE_MODELS.claude;
}

function _rebuildModelPopups() {
  const models = _getModelsForEngine(currentEngine);
  _allModelPopups.forEach(popup => {
    if (!popup) return;
    popup.innerHTML = '';
    models.forEach(m => {
      const div = document.createElement('div');
      div.className = 'model-opt' + (m.id === currentModel ? ' active' : '');
      div.dataset.model = m.id;
      div.innerHTML = `${m.label} <span class="eng-desc">${m.desc}</span>`;
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        setModel(m.id);
        _allModelPopups.forEach(p => { if (p) p.style.display = 'none'; });
      });
      popup.appendChild(div);
    });
  });
}

// 去前缀 / 去 [1m] 标签，得到可比较的短形式：
//   "claude-opus-4-7[1m]" → "opus-4-7"
//   "opus[1m]"            → "opus"
//   "opus"                → "opus"
function _modelShortForm(s) {
  if (!s) return null;
  return String(s).replace(/^claude-/, '').replace(/\[1m\]$/, '');
}
function _modelFamily(s) {
  const short = _modelShortForm(s);
  return short ? short.split('-')[0] : null;
}
// selected 和 actual 的比较规则：
//   - selected 是 alias（opus/sonnet/haiku）→ 只比 family（alias 会自动指向最新版）
//   - selected 是 full name → 精确到 family-version
function _modelMatches(selected, actualFull) {
  if (!actualFull) return true; // 没实测数据，不报警
  const selShort = _modelShortForm(selected);
  const actShort = _modelShortForm(actualFull);
  if (['opus', 'sonnet', 'haiku'].includes(selShort)) {
    return _modelFamily(selected) === _modelFamily(actualFull);
  }
  return selShort === actShort;
}
// 把 API 返回的完整 model 名映射到 ENGINE_MODELS 里的显示 label（若无匹配，回退到短形式）
function _labelForActualModel(actualFull) {
  if (!actualFull) return null;
  const actShort = _modelShortForm(actualFull);
  const hit = CLAUDE_MODELS.find(m => {
    const mShort = _modelShortForm(m.id);
    return mShort === actShort || _modelFamily(m.id) === _modelFamily(actualFull) && ['opus', 'sonnet', 'haiku'].includes(mShort);
  });
  if (hit) return hit.label + (actualFull.endsWith('[1m]') && !hit.id.endsWith('[1m]') ? ' 1M' : '');
  // 没命中：生成通用 label "Opus 4.7"
  const parts = actShort.split('-');
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const ver = parts.slice(1).join('.');
  return ver ? `${family} ${ver}` : family;
}

function _syncModelBtn() {
  const autoMode = currentEngine === 'auto';
  const actual = currentSession?.actualModel || null;
  const models = _getModelsForEngine(currentEngine);
  const found = models.find(m => m.id === currentModel);
  const selectedLabel = found ? found.label : currentModel;
  const actualLabel = _labelForActualModel(actual);
  const match = _modelMatches(currentModel, actual);
  const mismatch = !match && !!actual;
  const shown = actualLabel || selectedLabel;
  const text = mismatch ? `${shown} ⚠ ▾` : `${shown} ▾`;
  const title = mismatch
    ? `当前在跑 ${actualLabel}；你选的是 ${selectedLabel}，下一条消息会切过去`
    : `${shown}`;
  _allModelBtns.forEach(btn => {
    if (!btn) return;
    // Auto 模式：模型由 Pi 自行决定，pill 完全隐藏（不让用户困惑于 Sonnet/GPT-5 等字眼）
    btn.style.display = autoMode ? 'none' : '';
    btn.textContent = text;
    btn.dataset.model = currentModel;
    btn.title = title;
    btn.classList.toggle('model-mismatch', !autoMode && !!mismatch);
  });
}
function setModel(model) {
  currentModel = model;
  _syncModelBtn();
  _allModelPopups.forEach(popup => {
    if (!popup) return;
    popup.querySelectorAll('.model-opt').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.model === model);
    });
  });
  if (currentSession) {
    currentSession.model = model;
    saveCurrentSession();
  }
}
// 统一绑定所有 model pill + popup 对
function _setupModelPill(btn, popup) {
  if (!btn || !popup) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Auto 模式：pill 只是"实际路由引擎"的显示，不开下拉
    if (currentEngine === 'auto') return;
    const isOpen = popup.style.display !== 'none';
    _allModelPopups.forEach(p => { if (p) p.style.display = 'none'; });
    if (!isOpen) popup.style.display = 'block';
  });
}
_setupModelPill(headerModelBtn, headerModelPopup);
_setupModelPill(sidebarHeaderModelBtn, sidebarHeaderModelPopup);
_rebuildModelPopups();
// 启动时立刻跑一次：HTML 初始是硬编码 "Sonnet ▾"，Auto 模式要把它隐藏掉
_syncModelBtn();

// Pill 文案：非 Auto 显示 `Pi {Label} ▾`；Auto + 有最近路由结果显示 `Pi Auto → {Actual} ▾`
function _syncEngineBtn() {
  const selected = currentEngine;
  const rawActual = currentSession?.actualEngine || null;
  // exec 是 auto→claude 的内部标签，pill 上呈现为 Claude
  const actual = rawActual === 'exec' ? 'claude' : rawActual;
  const selLabel = ENGINE_LABELS[selected] || selected;
  const text = (selected === 'auto' && actual && actual !== 'auto')
    ? `Pi Auto → ${ENGINE_LABELS[actual] || actual} ▾`
    : `Pi ${selLabel} ▾`;
  [headerEngineBtn, sidebarHeaderEngineBtn].forEach(btn => {
    if (btn) btn.textContent = text;
  });
}

function setEngine(engine) {
  currentEngine = engine;
  window.pi.switchEngine(engine);
  terminalPanel.style.display = 'none';
  threadId = null;
  const label = ENGINE_LABELS[engine] || engine;
  // 更新所有引擎按钮标签
  document.querySelectorAll('#sidebar-engine-label, #chat-engine-label').forEach(el => {
    el.textContent = label;
  });
  // 用户手切非 Auto → 清掉上次 auto 路由的残留，避免 pill 显示错
  if (currentSession && currentSession.actualEngine && engine !== 'auto') {
    currentSession.actualEngine = null;
  }
  _syncEngineBtn();
  // 更新下拉选项 active 状态
  document.querySelectorAll('#sidebar-engine-popup .engine-opt, #chat-engine-popup .engine-opt, #header-engine-popup .engine-opt').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.eng === engine);
  });
  // 切引擎 → 重建模型列表 + 重置到该引擎的默认模型
  const models = _getModelsForEngine(engine);
  const validIds = models.map(m => m.id);
  if (!validIds.includes(currentModel)) {
    currentModel = models[0].id;
  }
  _rebuildModelPopups();
  _syncModelBtn();
}

/** Auto 模式：根据消息内容决定实际引擎 */
function autoRouteEngine(text) {
  const t = text.toLowerCase();
  if (/claude|代码|code|文件|修改|修复|fix|bug|编辑|重构|refactor|deploy|部署|服务器|server|shell|bash|terminal|ssh|排查|检查|调试|debug|运行|执行|安装|install|配置|config|日志|log|进程|process|cron|task|脚本|script|git|commit|push|pull|npm|pip|docker|kill|restart|重启/.test(t)) return 'claude';
  return 'gpt';
}

// 引擎弹出菜单：点击按钮切换显示
function setupEnginePill(btn, popup) {
  if (!btn || !popup) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = popup.style.display !== 'none';
    // 先关闭所有引擎弹窗
    [sidebarEnginePopup, chatEnginePopup].forEach(p => { if (p) p.style.display = 'none'; });
    if (!isOpen) popup.style.display = 'block';
  });
  popup.querySelectorAll('.engine-opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const eng = opt.dataset.eng;
      agentMode = false;
      setEngine(eng);
      updateAgentUI && updateAgentUI();
      popup.style.display = 'none';
    });
  });
}
setupEnginePill(sidebarEngineBtn, sidebarEnginePopup);
setupEnginePill(chatEngineBtn, chatEnginePopup);
setupEnginePill(headerEngineBtn, headerEnginePopup);
// sidebar header engine button shares the header popup（简化：点击切换引擎，无独立弹窗）
sidebarHeaderEngineBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  // 复用 header engine popup（移动到 sidebar button 下方）
  if (headerEnginePopup) {
    const isOpen = headerEnginePopup.style.display !== 'none';
    headerEnginePopup.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      // 重新定位到 sidebar button 下方
      sidebarHeaderEngineBtn.parentElement.appendChild(headerEnginePopup);
    }
  }
});

// 点击外部关闭
document.addEventListener('click', () => {
  [sidebarEnginePopup, chatEnginePopup, headerEnginePopup, headerModelPopup].forEach(p => { if (p) p.style.display = 'none'; });
});

// ── Agent Mode ──
const btnAgent = document.getElementById('btn-agent');
const agentPanel = document.getElementById('agent-panel');
const agentPlan = document.getElementById('agent-plan');
const agentLog = document.getElementById('agent-log');
const agentStopBtn = document.getElementById('agent-stop-btn');
const agentConfirmBar = document.getElementById('agent-confirm-bar');
const agentConfirmText = document.getElementById('agent-confirm-text');
const agentConfirmYes = document.getElementById('agent-confirm-yes');
const agentConfirmNo = document.getElementById('agent-confirm-no');
const agentStatusText = document.getElementById('agent-status-text');
const agentStatusIcon = document.getElementById('agent-status-icon');
let agentMode = false;
let agentRunning = false;
let agentSteps = [];
let agentCurrentStep = 0;

function updateAgentUI() {
  if (agentMode) {
    chatInput.placeholder = '描述任务，Agent 会自主执行（如："搜索 XX 并对比前 3 个结果"）';
    if (engineDropdownBtn) engineDropdownBtn.innerHTML = 'Pi Agent <span class="dropdown-arrow">▾</span>';
  } else {
    chatInput.placeholder = 'Talk to Pi...';
    agentPanel.style.display = 'none';
  }
}

agentStopBtn.addEventListener('click', () => {
  window.pi.stopAgent();
  agentRunning = false;
  agentStatusText.textContent = '已停止';
  agentStatusIcon.textContent = '⏹';
});

agentConfirmYes.addEventListener('click', () => {
  window.pi.agentConfirm(true);
  agentConfirmBar.style.display = 'none';
});

agentConfirmNo.addEventListener('click', () => {
  window.pi.agentConfirm(false);
  agentConfirmBar.style.display = 'none';
});

function renderAgentPlan() {
  if (agentSteps.length === 0) { agentPlan.innerHTML = ''; return; }
  const ol = document.createElement('ol');
  agentSteps.forEach((step, i) => {
    const li = document.createElement('li');
    li.textContent = step;
    if (i + 1 < agentCurrentStep) li.className = 'agent-step-done';
    else if (i + 1 === agentCurrentStep) li.className = 'agent-step-active';
    ol.appendChild(li);
  });
  agentPlan.innerHTML = '';
  agentPlan.appendChild(ol);
}

function agentLogAppend(cls, text) {
  const div = document.createElement('div');
  div.className = `agent-log-${cls}`;
  div.textContent = text;
  agentLog.appendChild(div);
  agentLog.scrollTop = agentLog.scrollHeight;
}

// Agent event stream
window.pi.onAgentEvent((ev) => {
  if (ev.type === 'plan') {
    agentSteps = ev.steps.map(s => s.replace(/^\d+\.\s*/, ''));
    agentCurrentStep = 0;
    renderAgentPlan();
    agentStatusText.textContent = `计划就绪（${agentSteps.length} 步），等待确认...`;
    agentStatusIcon.textContent = '📋';
  } else if (ev.type === 'step') {
    agentCurrentStep = ev.current;
    renderAgentPlan();
    agentStatusText.textContent = `执行步骤 ${ev.current}/${agentSteps.length}`;
    agentStatusIcon.textContent = '⚡';
  } else if (ev.type === 'tool') {
    agentLogAppend('tool', ev.content);
  } else if (ev.type === 'text') {
    agentLogAppend('text', ev.content.substring(0, 200));
  } else if (ev.type === 'voice') {
    agentLogAppend('text', `🗣 ${ev.content}`);
  } else if (ev.type === 'confirm') {
    agentConfirmText.textContent = `⚠ ${ev.action}`;
    agentConfirmBar.style.display = 'flex';
    agentStatusText.textContent = '等待确认';
    agentStatusIcon.textContent = '⏸';
  } else if (ev.type === 'result') {
    const resultDiv = document.createElement('div');
    resultDiv.className = 'agent-log-result';
    resultDiv.innerHTML = `<strong>✅ 结果</strong><div class="agent-result-content">${ev.content.replace(/\n/g, '<br>')}</div>`;
    agentLog.appendChild(resultDiv);
    agentLog.scrollTop = agentLog.scrollHeight;
  } else if (ev.type === 'done') {
    agentRunning = false;
    agentStatusText.textContent = '完成';
    agentStatusIcon.textContent = '✅';
    // Mark all steps done
    agentCurrentStep = agentSteps.length + 1;
    renderAgentPlan();
  } else if (ev.type === 'cancelled') {
    agentRunning = false;
    agentStatusText.textContent = '已取消';
    agentStatusIcon.textContent = '⏹';
  }
});

async function sendAgentTask(text, messagesContainer) {
  agentRunning = true;
  agentSteps = [];
  agentCurrentStep = 0;
  agentPlan.innerHTML = '';
  agentLog.innerHTML = '';
  agentConfirmBar.style.display = 'none';
  agentPanel.style.display = 'flex';
  agentStatusText.textContent = '规划中...';
  agentStatusIcon.textContent = '🤖';

  addMessage(messagesContainer, 'user', `🤖 Agent: ${text}`);
  if (currentSession) {
    currentSession.messages.push({ role: 'user', content: text, engine: 'agent', timestamp: new Date().toISOString() });
    saveCurrentSession();
  }

  try {
    const result = await window.pi.sendAgent(text);
    if (result.error) {
      addMessage(messagesContainer, 'ai', `Agent 错误: ${result.error}`);
    } else if (result.content) {
      addMessage(messagesContainer, 'ai', result.content, { engine: 'agent', model: currentModel });
      if (currentSession) {
        currentSession.messages.push({ role: 'ai', content: result.content, engine: 'agent', model: currentModel, timestamp: new Date().toISOString() });
        saveCurrentSession();
      }
    }
  } catch (err) {
    addMessage(messagesContainer, 'ai', `Agent 执行失败: ${err.message}`);
  }
  agentRunning = false;
}

// Cmd+E 切换引擎
window.pi.onEngineToggle(() => {
  if (agentMode) { agentMode = false; setEngine('auto'); }
  else {
    const cycle = ['auto', 'gpt', 'claude', 'clean'];
    const idx = cycle.indexOf(currentEngine);
    setEngine(cycle[(idx + 1) % cycle.length]);
  }
  updateAgentUI();
});

// 刀 2 step 6b: 全局 `_execActivityEl` 单活动系统 + `onClaudeEvent` 监听已删。
// 所有活动 DOM 都在 `_uiStates.get(sid).activityEl` 按 session 管理（见下方 v2 区）。
// 老路径 `pi:claude` handler 同步从 main.js 删除，`claude:event` 广播不再发。

// ── SessionBus v2（刀 1 — tick 3：加 session list state store）───────
// 每个 session 的 UI 状态都是独立的一等公民，切 session 时完整 swap；
// stop 按钮 / 输入框 / activity DOM / 流事件都按 sessionId 路由。
// 会话列表状态（running / unread）走单一 store，事件驱动，不再散点刷新。
// Cards/active/pibrowser-session-model-v2.md
// 刀 2 step 6b: `USE_SESSION_BUS_V2` feature flag 已删 —— bus 是唯一路径

// ── Session List State Store ─────────────────────────────────────────
// 单一数据源：每个 session 在列表上显示什么状态，都由这个 store 说了算。
// 写入点严格收敛：running 由 createV2Activity/finish/bus-state 写，
// unread 由 addAI bg 分支写，clear-unread 由 loadSession 写。
// UI 只读，通过 subscribe 被动响应，不到处散调 renderSessionList()。
const _sessionListStore = {
  _state: new Map(), // sid -> { running: bool, unread: bool, lastActivityAt: number }
  _listeners: new Set(),
  _DEFAULT: Object.freeze({ running: false, unread: false, lastActivityAt: 0, origin: null }),

  get(sid) {
    return this._state.get(sid) || this._DEFAULT;
  },

  _patch(sid, patch) {
    const old = this._state.get(sid) || { ...this._DEFAULT };
    const next = { ...old, ...patch };
    // 只在真的变化时 emit，避免循环（origin 变化不触发 re-render）
    if (old.running === next.running && old.unread === next.unread) {
      // 静默更新 origin 等非 UI 字段
      if (next.origin !== old.origin) this._state.set(sid, next);
      return;
    }
    this._state.set(sid, next);
    this._emit();
  },

  setRunning(sid, running) {
    this._patch(sid, { running: !!running, lastActivityAt: Date.now() });
  },

  markUnread(sid) {
    this._patch(sid, { unread: true, lastActivityAt: Date.now() });
  },

  clearUnread(sid) {
    this._patch(sid, { unread: false });
  },

  forget(sid) {
    if (!this._state.has(sid)) return;
    this._state.delete(sid);
    this._emit();
  },

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },

  _emit() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.warn('[sessionListStore] listener error:', e); }
    }
  },
};

const _sessionOriginCache = new Map(); // sid -> 'task' | 'chat'
const _sessionOriginPending = new Map(); // sid -> Promise<'task' | 'chat' | null>

function _normalizeSessionOrigin(origin, hasSessionObject = false) {
  if (origin === 'task') return 'task';
  if (origin) return 'chat';
  return hasSessionObject ? 'chat' : null;
}

function _rememberSessionOrigin(sid, origin, { hasSessionObject = false } = {}) {
  if (!sid) return null;
  const normalized = _normalizeSessionOrigin(origin, hasSessionObject);
  if (normalized) _sessionOriginCache.set(sid, normalized);
  return normalized;
}

function _getKnownSessionOrigin(sid) {
  if (!sid) return null;
  if (currentSession?.id === sid) {
    return _rememberSessionOrigin(sid, currentSession.origin, { hasSessionObject: true });
  }
  const cached = _sessionOriginCache.get(sid);
  if (cached) return cached;
  const storeOrigin = _sessionListStore.get(sid)?.origin || null;
  if (storeOrigin) return _rememberSessionOrigin(sid, storeOrigin);
  return null;
}

async function _resolveSessionOrigin(sid) {
  const known = _getKnownSessionOrigin(sid);
  if (known) return known;
  if (_sessionOriginPending.has(sid)) return _sessionOriginPending.get(sid);
  const pending = (async () => {
    try {
      const session = await window.pi.sessionLoad(sid);
      return _rememberSessionOrigin(sid, session?.origin, { hasSessionObject: !!session });
    } catch (e) {
      console.warn('[session-origin] resolve failed:', e.message);
      return null;
    } finally {
      _sessionOriginPending.delete(sid);
    }
  })();
  _sessionOriginPending.set(sid, pending);
  return pending;
}

// 订阅 session list store：状态变化自动重渲列表（debounced）
// 这是"不打补丁"的核心：running/unread 变化不再靠散落的 renderSessionList() 调用。
// 任何写入 store 的地方都会经由这个订阅触发一次（100ms debounce 折叠 burst）。
let _sessionListRefreshTimer = null;
_sessionListStore.subscribe(() => {
  if (_sessionListRefreshTimer) return;
  _sessionListRefreshTimer = setTimeout(() => {
    _sessionListRefreshTimer = null;
    // renderSessionList 是 async，但 fire-and-forget 不 await —— 订阅回调保持同步
    renderSessionList().catch((e) => console.warn('[sessionListStore] render error:', e));
  }, 100);
});

// tick 9 删除了 tick 8 的 _sendBusy re-entry guard 和 _flashInputBlocked。
// 因为 rolling interjection 是想要的能力 —— 用户应该能随时发新消息抢占当前回复，
// 不应该被拦截。多发问题用 (a) 立即清输入框 (b) adapter 内部 cancellation token
// 序列化 spawn 来解决，不再用前端 guard 硬阻塞。
//
// ── tick 8: 后台 task running 状态自动同步到 store ─────────────────────
// 没点过的 task session 在 sessions:list 里有 entry，但 store 不知道它在跑（因为
// 没有 onSessionOpen 触发 setRunning）。这里在每次 renderSessionList 拿到列表后，
// 用 main 进程返回的 entry.running 字段 upsert 到 store。
// store._patch 自动 dedupe，不会触发无限循环。
function _syncRunningStateFromList(list) {
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    // 同步 origin 到 store（text 事件路由需要区分 chat/task）
    if (entry.origin) {
      _rememberSessionOrigin(entry.id, entry.origin);
      _sessionListStore._patch(entry.id, { origin: entry.origin });
    }
    if (entry.origin === 'task' && typeof entry.running === 'boolean') {
      _sessionListStore.setRunning(entry.id, entry.running);
    }
  }
}

// ── tick 8: 低频 15s 刷新 —— 让新启动的 task 自动出现，状态变化被刷到 ────
// 这不是 polling 的回归：tick 4 删的是"3s 拽 currentSession 的 hijack 轮询"，
// 这里只是低频列表刷新，不切 currentSession，不重渲消息区，纯左侧列表层
let _autoRefreshTimer = null;
function _startListAutoRefresh() {
  if (_autoRefreshTimer) return;
  _autoRefreshTimer = setInterval(() => {
    renderSessionList().catch(() => {});
  }, 15000);
}
// 在第一次 renderSessionList 调用后启动（init IIFE 末尾会触发）

// Map<sessionId, UIState>：每个 session 的运行态 + 活动 DOM + stop 绑定
// v2 SessionBus 的所有 session（交互 / task）都走这个 map；agent mode 独立
// 在 agentPanel 里维护 plan/log DOM，不进 _uiStates。
const _uiStates = new Map();

// 不可见 session 的 activity DOM 寄存处（切走时 move 到这里，切回再 move 回 chatMessages）
// 用 DOM move 而不是 detach，确保事件监听和动画状态保留
const _activityStage = document.createElement('div');
_activityStage.id = 'v2-activity-stage';
_activityStage.style.display = 'none';
document.body.appendChild(_activityStage);

function _getUIState(sid) {
  let s = _uiStates.get(sid);
  if (!s) {
    s = {
      status: 'idle',       // 'idle' | 'running' — 交互 Claude send 的状态
      requestId: null,
      activityEl: null,     // 可能 attach 在 chatMessages 或 _activityStage
      stepCount: 0,
      lastText: '',
      voiceEventCount: 0,
      queuedSends: [],
      drainingQueue: false,
      tokenUsage: { inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, // 累计 token 用量（input=未命中 cache，cacheCreate=新写 cache 1.25x，cacheRead=命中 cache 0.1x）
      pendingSteps: [],     // 方案 B：旁路积累本轮 tool steps，text 事件时写入 msg.steps[]
    };
    _uiStates.set(sid, s);
  }
  return s;
}

const DEFAULT_CONTEXT_WINDOW = 200000; // fallback；session 首次活跃后会从 /context 拿真实 window

function _isLikelyCodexSession(session) {
  if (!session) return false;
  const engine = String(session.engine || '').toLowerCase();
  const actual = String(session.actualModel || '').toLowerCase();
  const selected = String(session.model || '').toLowerCase();
  if (engine === 'codex') return true;
  if (actual.includes('codex') || actual.startsWith('gpt-')) return true;
  if (selected.includes('codex') || selected.startsWith('gpt-')) return true;
  if (session.threadId && !session.claudeSessionId) return true;
  return false;
}

function _getEffectiveContextWindowForSession(session) {
  if (!session) return DEFAULT_CONTEXT_WINDOW;
  const actual = session.actualModel || '';
  const selected = session.model || '';
  if (/\[1m\]$/.test(actual) || /\[1m\]$/.test(selected)) return 1000000;
  return session.contextWindow || DEFAULT_CONTEXT_WINDOW;
}

// Effective context window：优先级
//   1. actualModel 是 [1m] 变种 → 强制 1M（最可靠信号，不用等 /context 拉取）
//   2. currentSession.contextWindow（/pi/context-detail 解析到的）
//   3. fallback 200k
// 这样 owner 选了 Opus 4.7 1M，自动压缩阈值就按 70% × 1M = 700k，不会在 200k 就触发。
function _getEffectiveContextWindow() {
  return _getEffectiveContextWindowForSession(currentSession);
}

function _formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// 纯计算 —— 所有 UI 展示数据源。抽出来方便单测。
// tokenUsage: { inputTokens, cacheCreateTokens, cacheReadTokens, outputTokens, sessionOutputSum }
// window: 实际 context window 大小（session 缓存，未知时 fallback 200k）
// 返回的 contextFill = input + cc + cr（本轮发给 API 的总 context）。不含 output —— output
// 是生成物，占的是下一轮的 input 位置，不占本轮 context window。
function _computeTokenDisplay(tokenUsage, windowSize) {
  const inp = tokenUsage.inputTokens || 0;
  const cc = tokenUsage.cacheCreateTokens || 0;
  const cr = tokenUsage.cacheReadTokens || 0;
  const out = tokenUsage.outputTokens || 0;
  const sessionOut = tokenUsage.sessionOutputSum || 0;
  const contextFill = inp + cc + cr;
  const winSize = windowSize || DEFAULT_CONTEXT_WINDOW;
  const hitPct = contextFill > 0 ? Math.round((cr / contextFill) * 1000) / 10 : 0;
  const fillPct = winSize > 0 ? Math.round((contextFill / winSize) * 1000) / 10 : 0;
  const barPct = Math.min(100, fillPct);
  const barClass = fillPct > 80 ? 'critical' : fillPct > 60 ? 'warn' : '';
  return { contextFill, winSize, hitPct, fillPct, barPct, barClass, inp, cc, cr, out, sessionOut };
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 9; // svg circle r=9 → ~56.549

function _updateTokenUsageUI(tokenUsage) {
  const win = _getEffectiveContextWindow();
  const d = _computeTokenDisplay(tokenUsage, win);
  const hitLabel = d.contextFill > 0 ? ` · ⚡${Math.round(d.hitPct)}%` : '';
  const labelText = `${_formatTokenCount(d.contextFill)} / ${_formatTokenCount(d.winSize)}${hitLabel}`;
  const tooltip = [
    `Context fill: ${_formatTokenCount(d.contextFill)} / ${_formatTokenCount(d.winSize)} (${d.fillPct}%)`,
    `Input 拆分（本轮）:`,
    `  未命中 cache: ${_formatTokenCount(d.inp)} (1×)`,
    `  Cache 写入:   ${_formatTokenCount(d.cc)} (1.25×)`,
    `  Cache 命中:   ${_formatTokenCount(d.cr)} (0.1×)`,
    `  → 命中率: ${d.hitPct}% ${d.hitPct < 30 ? '⚠ 烧钱' : d.hitPct > 70 ? '✓ 省' : ''}`,
    `Output（本轮）: ${_formatTokenCount(d.out)}`,
    `Session output 累计: ${_formatTokenCount(d.sessionOut)}`,
    ``,
    `（点击看详细 breakdown）`,
  ].join('\n');
  // 圆环填充：stroke-dashoffset 从 C（0%）到 0（100%）
  const ringOffset = RING_CIRCUMFERENCE * (1 - d.barPct / 100);

  const targets = [
    { d: 'token-usage-display', t: 'token-usage-text', r: 'token-usage-ring' },
    { d: 'sidebar-token-usage-display', t: 'sidebar-token-usage-text', r: 'sidebar-token-usage-ring' },
  ];
  for (const { d: id, t, r } of targets) {
    const display = document.getElementById(id);
    const text = document.getElementById(t);
    const ring = document.getElementById(r);
    if (!display || !text || !ring) continue;
    if (d.contextFill === 0) { display.style.display = 'none'; continue; }
    display.style.display = 'flex';
    text.textContent = labelText;
    ring.style.strokeDashoffset = ringOffset;
    ring.setAttribute('class', 'ring-fill' + (d.barClass ? ' ' + d.barClass : ''));
    display.title = tooltip;
  }
}

// 暴露给 node 单测：不影响浏览器里的全局作用域
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _computeTokenDisplay, _formatTokenCount, DEFAULT_CONTEXT_WINDOW };
}

// ── Context Detail 弹窗 ────────────────────────────────────────────────
function _formatTokenCountCompact(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

async function _openContextDetail() {
  const overlay = document.getElementById('ctx-detail-overlay');
  const body = document.getElementById('ctx-detail-body');
  if (!overlay || !body) return;
  try { await window.pi.setModalOverlay(true); } catch {}
  overlay.style.display = 'flex';

  const session = currentSession;
  if (!session) {
    body.innerHTML = '<div class="ctx-error">当前没有可用会话</div>';
    return;
  }

  const useClaudeDetail = Boolean(session.claudeSessionId) && !_isLikelyCodexSession(session);
  if (!useClaudeDetail) {
    body.innerHTML = _renderCodexContextDetail(session, _getUIState(session.id)?.tokenUsage);
    return;
  }

  // 秒出：如果 session 里有新鲜缓存（<20s），直接渲染，然后静默刷新
  const cached = session._ctxDetailCache;
  const cacheAge = session._ctxLastFetchAt ? Date.now() - session._ctxLastFetchAt : Infinity;
  if (cached && cacheAge < CTX_DETAIL_REFRESH_MS * 2) {
    body.innerHTML = _renderContextDetail(cached);
    // 后台异步刷新（2s 后更新，用户已看到数据不感知延迟）
    _maybeFetchContextWindow(session.id).then(() => {
      if (overlay.style.display !== 'none' && currentSession?.id === session.id && currentSession?._ctxDetailCache) {
        body.innerHTML = _renderContextDetail(currentSession._ctxDetailCache);
      }
    });
    return;
  }

  body.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">首次加载约 2s…</div>';
  const sid = session.claudeSessionId || '';
  const qs = sid ? `?sid=${encodeURIComponent(sid)}` : '';
  try {
    const r = await fetch('http://127.0.0.1:17891/pi/context-detail' + qs + (qs ? '&' : '?') + 't=' + Date.now());
    const data = await r.json();
    if (!data.ok) {
      body.innerHTML = `<div class="ctx-error">${data.error || '加载失败'}</div>`;
      return;
    }
    if (currentSession?.id === session.id) {
      currentSession._ctxDetailCache = data;
      currentSession._ctxLastFetchAt = Date.now();
    }
    body.innerHTML = _renderContextDetail(data);
  } catch (e) {
    body.innerHTML = `<div class="ctx-error">网络错误: ${e.message}</div>`;
  }
}

function _renderCodexContextDetail(session, tokenUsage) {
  const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const usage = tokenUsage || {};
  const windowSize = _getEffectiveContextWindowForSession(session);
  const d = _computeTokenDisplay(usage, windowSize);
  const model = session?.actualModel || session?.model || session?.engine || 'codex';
  const rows = [
    ['Input (uncached)', d.inp],
    ['Cache create', d.cc],
    ['Cache read', d.cr],
    ['Output (last step)', d.out],
    ['Session output sum', d.sessionOut],
  ];
  return `
    <div class="ctx-summary">
      <strong>${esc(model)}</strong> · ${_formatTokenCountCompact(d.contextFill)} / ${_formatTokenCountCompact(d.winSize)} (${d.fillPct}%)
    </div>
    <div class="ctx-section-title">Current usage</div>
    <table>
      ${rows.map(([label, value]) => `<tr><td>${esc(label)}</td><td>${_formatTokenCountCompact(value || 0)}</td><td></td></tr>`).join('')}
      <tr><td>Cache hit rate</td><td>${d.hitPct}%</td><td></td></tr>
    </table>
    <div class="ctx-section-title">Notes</div>
    <div style="color:#aaa;font-size:13px;line-height:1.6;">
      这是 Codex 的实时 usage 视图，不再误用 Claude 的 <code>/context</code> breakdown。<br>
      当前只展示 PiBrowser 已接到的 usage 字段；按类别的 system prompt / skills / memory files 明细暂未接通。
    </div>
  `;
}

function _renderContextDetail(d) {
  const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const rows = (items, cols) => items.map(it => `<tr>${cols.map(c => `<td>${c(it)}</td>`).join('')}</tr>`).join('');
  let html = '';
  html += `<div class="ctx-summary"><strong>${esc(d.model || 'claude')}</strong> · ${_formatTokenCountCompact(d.total)} / ${_formatTokenCountCompact(d.max)} (${d.pct}%)${d.cached ? ' · <span style="color:#888">缓存' + Math.round(30) + 's</span>' : ''}</div>`;
  if (d.categories && d.categories.length) {
    html += `<div class="ctx-section-title">By category</div>`;
    html += `<table>${rows(d.categories, [
      c => esc(c.name),
      c => _formatTokenCountCompact(c.tokens),
      c => c.pct.toFixed(1) + '%',
    ])}</table>`;
  }
  if (d.memoryFiles && d.memoryFiles.length) {
    html += `<div class="ctx-section-title">Memory files</div>`;
    html += `<table>${rows(d.memoryFiles, [
      m => `<span style="color:#aaa">${esc(m.type)}</span> <span class="ctx-path">${esc(m.path.replace(/^\/Users\/\w+/, '~'))}</span>`,
      m => _formatTokenCountCompact(m.tokens),
      () => '',
    ])}</table>`;
  }
  if (d.skills && d.skills.length) {
    html += `<div class="ctx-section-title">Skills (${d.skills.length})</div>`;
    html += `<table>${rows(d.skills, [
      s => `${esc(s.name)} <span style="color:#888;font-size:10.5px">(${esc(s.source)})</span>`,
      s => _formatTokenCountCompact(s.tokens),
      () => '',
    ])}</table>`;
  }
  return html;
}

function _closeContextDetail() {
  const overlay = document.getElementById('ctx-detail-overlay');
  if (overlay) overlay.style.display = 'none';
  // 关 modal 时恢复 BrowserView（被 _openContextDetail 临时 remove 掉了）
  try { window.pi.setModalOverlay(false); } catch {}
}

// Session 级 context detail 预取：拿 window size + 把完整 breakdown 缓存到 session 上。
// - 防止分母 200k / 1M 错判
// - 让点击"详情"按钮秒出（从 _ctxDetailCache 直接渲染，不等 spawn claude）
// 20 秒节流：usage 事件很频繁，但后端 30s 缓存＋这里 20s 节流，保证最多 2 秒内点击都命中
const _windowFetchInFlight = new Set();
const CTX_DETAIL_REFRESH_MS = 20000;
async function _maybeFetchContextWindow(sid) {
  if (!currentSession || currentSession.id !== sid) return;
  if (_isLikelyCodexSession(currentSession)) return;
  const claudeSid = currentSession.claudeSessionId;
  if (!claudeSid) return;
  const lastAt = currentSession._ctxLastFetchAt || 0;
  if (currentSession.contextWindow && Date.now() - lastAt < CTX_DETAIL_REFRESH_MS) return;
  if (_windowFetchInFlight.has(claudeSid)) return;
  _windowFetchInFlight.add(claudeSid);
  try {
    const r = await fetch(`http://127.0.0.1:17891/pi/context-detail?sid=${encodeURIComponent(claudeSid)}&t=${Date.now()}`);
    const data = await r.json();
    if (data.ok && currentSession?.claudeSessionId === claudeSid) {
      // ⚠ 不再用 data.max 写 currentSession.contextWindow。
      // /pi/context-detail 跑的是 `claude -p /context --resume --fork-session`，
      // headless `-p` 下 CLI 用自己当前默认模型的 window，不是这个 session 选的模型。
      // 实测：选 Opus 4.7（200k）的 session 被写成 1000000；选 Opus 4.7[1m]（1M）
      // 的 session 被写成 200000。双向污染。
      // 改为：window 大小完全由 model 后缀 `[1m]` 判断（见 _getEffectiveContextWindowForSession）。
      // data 仅用于 breakdown 详情缓存，不参与 window 计算。
      if (data.max) _debugLog('[contextWindow]', `/context 返回 max=${data.max}（仅供参考，不写入 session；session model=${currentSession.model}，window 以 [1m] 后缀为准）`);
      currentSession._ctxLastFetchAt = Date.now();
      currentSession._ctxDetailCache = data;
    }
  } catch (e) {
    console.warn('[contextWindow] fetch failed:', e.message);
  } finally {
    _windowFetchInFlight.delete(claudeSid);
  }
}

// ── Auto-compact：达 70% context window 自动压缩 ──────────────────────
const AUTO_COMPACT_PCT = 0.70; // context fill >= 70% of actual window 触发
// Floor：headless -p 模式下 CLI 不自动压，PiBrowser 必须替身；但曾出现 contextWindow
// 被污染到 ~77k 导致 fill=54k 就误触发（2026-04-24 NYC 教训）。150k 硬地板挡住所有
// 低 fill 的噪声——真要压也得是真的 fill 逼近上限。
const AUTO_COMPACT_FLOOR = 150000;
const AUTO_COMPACT_MIN_INTERVAL = 5 * 60 * 1000;
const AUTO_COMPACT_CANCEL_WINDOW = 10 * 1000;
const _compactState = new Map();

function _maybeAutoCompact(sid, tokenUsage) {
  if (!currentSession || currentSession.id !== sid) return;
  if (!currentSession.claudeSessionId) return;
  // 走 _getEffectiveContextWindow —— 1M 变种靠 actualModel/selected 直接认出 1M，
  // 不必等 /pi/context-detail 回来，避免"1M session 一进来就按 200k 触发"。
  const win = _getEffectiveContextWindow();
  const contextFill = (tokenUsage.inputTokens || 0) + (tokenUsage.cacheCreateTokens || 0) + (tokenUsage.cacheReadTokens || 0);
  // 每次 usage 事件都落一条（节制：只在 fill >= 50k 时落，避免低流量 session 淹日志）
  if (contextFill >= 50000) {
    _debugLog('[auto-compact-check]', `sid=${sid} fill=${contextFill} win=${win} model=${currentSession.model} actualModel=${currentSession.actualModel} floor=${AUTO_COMPACT_FLOOR} pct=${AUTO_COMPACT_PCT} → ${contextFill < AUTO_COMPACT_FLOOR ? 'below floor' : contextFill < win * AUTO_COMPACT_PCT ? 'below pct' : 'GATE PASS'}`);
  }
  if (contextFill < AUTO_COMPACT_FLOOR) {
    // 重置 spike 计数：低 fill 一进来就清，要求"连续高"
    const stReset = _compactState.get(sid);
    if (stReset && stReset.spikeCount) { stReset.spikeCount = 0; _compactState.set(sid, stReset); }
    return;
  }
  if (contextFill < win * AUTO_COMPACT_PCT) {
    const stReset = _compactState.get(sid);
    if (stReset && stReset.spikeCount) { stReset.spikeCount = 0; _compactState.set(sid, stReset); }
    return;
  }
  // Spike 防护：单一 usage 事件可能瞬间报巨大 cache_read（实测 09:42 出现过 309k 单点突刺、
  // 紧跟一个 56k 正常事件），不该靠它触发 compact。要求连续 ≥2 个事件都过门。
  const st = _compactState.get(sid) || {};
  st.spikeCount = (st.spikeCount || 0) + 1;
  _compactState.set(sid, st);
  if (st.spikeCount < 2) {
    _debugLog('[auto-compact]', `gate pass #${st.spikeCount} (need 2 consecutive): sid=${sid} fill=${contextFill} win=${win}`);
    return;
  }
  _debugLog('[auto-compact]', `gate passed (#${st.spikeCount} consecutive): sid=${sid} fill=${contextFill} win=${win} model=${currentSession?.model} actualModel=${currentSession?.actualModel} (floor=${AUTO_COMPACT_FLOOR}, pct=${AUTO_COMPACT_PCT})`);
  if (st.running || st.cancelTimer) return;
  if (st.lastCompactAt && Date.now() - st.lastCompactAt < AUTO_COMPACT_MIN_INTERVAL) return;
  _promptAutoCompact(sid, contextFill, win);
}

function _promptAutoCompact(sid, contextFill, win) {
  const claudeSid = currentSession?.claudeSessionId;
  if (!claudeSid) return;
  const pct = Math.round((contextFill / win) * 100);
  const toast = _showCompactToast({
    text: `上下文已 ${_formatTokenCount(contextFill)} / ${_formatTokenCount(win)}（${pct}%），10 秒后自动压缩`,
    actions: [{ label: '取消', handler: () => _cancelAutoCompact(sid) }, { label: '立即压缩', handler: () => _fireCompact(sid, claudeSid) }],
    countdown: AUTO_COMPACT_CANCEL_WINDOW,
  });
  const st = _compactState.get(sid) || {};
  st.cancelTimer = setTimeout(() => {
    st.cancelTimer = null;
    _fireCompact(sid, claudeSid);
  }, AUTO_COMPACT_CANCEL_WINDOW);
  st.toastEl = toast;
  _compactState.set(sid, st);
}

function _cancelAutoCompact(sid) {
  const st = _compactState.get(sid);
  if (!st) return;
  if (st.cancelTimer) { clearTimeout(st.cancelTimer); st.cancelTimer = null; }
  if (st.toastEl) { st.toastEl.remove(); st.toastEl = null; }
  // 取消后，为避免每轮都再提示，记一个"最近取消时间"当软防抖
  st.lastCompactAt = Date.now();
  _compactState.set(sid, st);
  _showCompactToast({ text: '已取消本次自动压缩（5 分钟内不再提示）', timeout: 3000 });
}

function _applyCompactInputLock(locked) {
  const placeholder = locked ? '正在压缩历史，稍候…' : 'Talk to Pi...';
  if (chatInput) { chatInput.disabled = locked; chatInput.placeholder = placeholder; }
  if (sidebarInput) { sidebarInput.disabled = locked; sidebarInput.placeholder = placeholder; }
  if (sendBtn) sendBtn.disabled = locked;
  if (sidebarSend) sidebarSend.disabled = locked;
}

async function _fireCompact(sid, claudeSid) {
  const st = _compactState.get(sid) || {};
  if (st.cancelTimer) { clearTimeout(st.cancelTimer); st.cancelTimer = null; }
  if (st.toastEl) { st.toastEl.remove(); st.toastEl = null; }
  st.running = true;
  _compactState.set(sid, st);
  if (currentSession?.id === sid) _applyCompactInputLock(true);
  // 在 toast 里写出 session 名字，避免 toast 全局浮动 + 多 session 并发时认错谁在压
  const sessLabel = (() => {
    try {
      const sess = (typeof _sessionListStore !== 'undefined' && _sessionListStore.getAll)
        ? _sessionListStore.getAll().find(s => s.id === sid) : null;
      return sess?.name || sess?.id || sid;
    } catch { return sid; }
  })();
  _debugLog('[auto-compact]', `fire: sid=${sid} claudeSid=${claudeSid} label="${sessLabel}"`);
  const progressToast = _showCompactToast({
    text: `正在压缩「${sessLabel}」历史…约 1 分钟，期间请勿对该 session 发消息`,
    persistent: true,
  });
  // 无论成功/失败/网络错，结束时都会设 lastCompactAt 触发 5min 冷却，防止失败后的每轮重试风暴
  const finishWith = (patch) => {
    const cur = _compactState.get(sid) || {};
    Object.assign(cur, { running: false, lastCompactAt: Date.now() }, patch);
    _compactState.set(sid, cur);
    if (currentSession?.id === sid) _applyCompactInputLock(false);
  };
  try {
    const url = `http://127.0.0.1:17891/pi/session-compact?sid=${encodeURIComponent(claudeSid)}&t=${Date.now()}`;
    const r = await fetch(url);
    const data = await r.json();
    progressToast.remove();
    if (!data.ok) {
      _showCompactToast({ text: `压缩失败：${data.error || '未知错误'}（5 分钟内不再尝试）`, timeout: 10000 });
      finishWith({});
      return;
    }
    // 注意：/compact 不会 truncate JSONL 文件，而是在末尾追加一条 summary 消息。
    // 所以 "sizeBefore → sizeAfter" 对"压缩效果"没意义（文件会微增）。
    // 真实效果要看下一轮 API 调用的 input_tokens 是否显著下降（UI 会自动反映）。
    _showCompactToast({
      text: `✓ 压缩完成 · ${Math.round((data.duration_ms || 0) / 1000)}s · 下一条消息验证效果`,
      actions: [{ label: '还原', handler: () => _restoreSession(sid, claudeSid, data.backupPath) }],
      timeout: 30000,
    });
    finishWith({ lastBackup: data.backupPath });
  } catch (e) {
    progressToast.remove();
    _showCompactToast({ text: `压缩网络错误：${e.message}（5 分钟内不再尝试）`, timeout: 10000 });
    finishWith({});
  }
}

async function _restoreSession(sid, claudeSid, backupPath) {
  try {
    const url = `http://127.0.0.1:17891/pi/session-restore?sid=${encodeURIComponent(claudeSid)}&backup=${encodeURIComponent(backupPath)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.ok) _showCompactToast({ text: '✓ 已还原到压缩前', timeout: 4000 });
    else _showCompactToast({ text: `还原失败：${data.error}`, timeout: 8000 });
  } catch (e) {
    _showCompactToast({ text: `还原错误：${e.message}`, timeout: 8000 });
  }
}

function _showCompactToast({ text, actions = [], countdown, timeout, persistent }) {
  let container = document.getElementById('compact-toast-stack');
  if (!container) {
    container = document.createElement('div');
    container.id = 'compact-toast-stack';
    container.style.cssText = 'position:fixed;top:60px;right:20px;z-index:1800;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.style.cssText = 'background:#2a2d33;color:#eee;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);box-shadow:0 8px 24px rgba(0,0,0,0.4);font-size:13px;max-width:340px;pointer-events:auto;';
  const textEl = document.createElement('div');
  textEl.textContent = text;
  el.appendChild(textEl);
  if (countdown) {
    const cd = document.createElement('div');
    cd.style.cssText = 'margin-top:6px;height:2px;background:rgba(255,255,255,0.08);border-radius:1px;overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:100%;background:#5b9cf5;transition:width ' + countdown + 'ms linear;';
    cd.appendChild(fill);
    el.appendChild(cd);
    requestAnimationFrame(() => { fill.style.width = '0%'; });
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-top:8px;display:flex;gap:8px;justify-content:flex-end;';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.textContent = a.label;
      btn.style.cssText = 'background:rgba(91,156,245,0.15);color:#5b9cf5;border:1px solid rgba(91,156,245,0.4);border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;';
      btn.onclick = () => { a.handler(); el.remove(); };
      row.appendChild(btn);
    }
    el.appendChild(row);
  }
  container.appendChild(el);
  if (!persistent && !actions.length) {
    setTimeout(() => el.remove(), timeout || 4000);
  } else if (timeout) {
    setTimeout(() => el.remove(), timeout);
  }
  return el;
}

// 绑定点击：两份 token-usage-display + close 按钮 + overlay 空白
document.addEventListener('DOMContentLoaded', () => {
  for (const id of ['token-usage-display', 'sidebar-token-usage-display']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', _openContextDetail);
  }
  const closeBtn = document.getElementById('ctx-detail-close');
  if (closeBtn) closeBtn.addEventListener('click', _closeContextDetail);
  const overlay = document.getElementById('ctx-detail-overlay');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeContextDetail(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _closeContextDetail();
  });
});

function _renderActivityCurrent(sid, baseText = null) {
  const st = _getUIState(sid);
  if (typeof baseText === 'string') st.lastText = baseText;
  if (!st.activityEl) return;
  const currentSpan = st.activityEl.querySelector('.exec-current');
  if (!currentSpan) return;
  const queueCount = st.queuedSends?.length || 0;
  const base = (typeof baseText === 'string' ? baseText : st.lastText) || '正在思考...';
  currentSpan.textContent = queueCount > 0 ? `${base}（已排队 ${queueCount} 条）` : base;
}

async function _drainQueuedSend(sid, engineOverride) {
  const st = _getUIState(sid);
  if (st.drainingQueue || !st.queuedSends.length) return;

  // 把所有排队消息合并为一条发送（用户消息已各自保存，AI 通过 --resume 看到全部上下文）
  const all = st.queuedSends.splice(0);
  const engine = engineOverride || all[0].engine || 'claude';
  const last = all[all.length - 1];

  // 合并文本：多条消息用换行分隔，让 AI 一次性看到
  const mergedText = all.map(q => q.options.text || q.options.preparedFullMessage || '').join('\n\n');

  // 恢复所有排队消息的附件（解决图片丢失 bug）
  const allAttachments = all.flatMap(q => q.options.attachments || []);
  if (allAttachments.length) pendingAttachments.push(...allAttachments);

  st.drainingQueue = true;
  _renderActivityCurrent(sid, '处理排队消息');
  try {
    await sendMessage(last.input, last.container, {
      ...last.options,
      text: mergedText,
      preparedFullMessage: null, // 强制重新构建 fullMessage
      skipUserRender: true,
      skipQueue: true,
      targetSessionId: sid,
      engineOverride: engine,
    });
  } finally {
    st.drainingQueue = false;
    _renderActivityCurrent(sid);
    // 如果 drain 期间又有新消息排队，继续处理
    if (st.queuedSends.length > 0) {
      setTimeout(() => _drainQueuedSend(sid, engineOverride), 0);
    }
  }
}
// 向后兼容
const _drainQueuedCodexSend = (sid) => _drainQueuedSend(sid, 'codex');

// tick 8: taskId/taskRefreshTimer 已被删除 ——
// task running 状态完全由 sessions:list → store 这条数据流驱动，
// 不再有 per-session polling 这种 stateful 副作用。
function forgetUIState(sid) {
  if (!_uiStates.has(sid)) return;
  _uiStates.delete(sid);
  if (typeof _sessionListStore !== 'undefined') _sessionListStore.forget(sid);
}

// 创建活动 DOM（不碰老的 _exec* 全局）
function _formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}:${String(rem).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function createV2ActivityForSession(sid, container) {
  const activity = document.createElement('div');
  activity.className = 'exec-activity v2';
  activity.dataset.sessionId = sid;
  const statusLine = document.createElement('div');
  statusLine.className = 'exec-status-line';
  statusLine.innerHTML = '<span class="exec-spinner"></span><span class="exec-current">正在思考...</span><span class="exec-timer">0s</span>';
  activity.appendChild(statusLine);
  const history = document.createElement('div');
  history.className = 'exec-history';
  activity.appendChild(history);
  statusLine.addEventListener('click', () => activity.classList.toggle('collapsed'));
  container.appendChild(activity);
  container.scrollTop = container.scrollHeight;

  const st = _getUIState(sid);
  st.activityEl = activity;
  st.stepCount = 0;
  st.lastText = '';
  st.voiceEventCount = 0;
  // 计时器
  st._timerStart = Date.now();
  st._timerId = setInterval(() => {
    const timerSpan = activity.querySelector('.exec-timer');
    if (timerSpan) timerSpan.textContent = _formatElapsed(Date.now() - st._timerStart);
  }, 1000);
  // 单点更新：running 状态写入 store，UI 自动跟进
  _sessionListStore.setRunning(sid, true);
  return activity;
}

// 标记 session 的活动为完成（换 ✓ 图标），释放 state 让下次 send 新建一份
function finishV2Activity(sid) {
  const st = _uiStates.get(sid);
  if (!st) return;
  // 停止计时器
  if (st._timerId) { clearInterval(st._timerId); st._timerId = null; }
  const elapsed = st._timerStart ? _formatElapsed(Date.now() - st._timerStart) : '';
  if (st.activityEl) {
    const statusLine = st.activityEl.querySelector('.exec-status-line');
    if (statusLine) {
      const timerHtml = elapsed ? `<span class="exec-timer done">${elapsed}</span>` : '';
      statusLine.innerHTML = st.stepCount > 0
        ? `<span class="exec-done-icon">✓</span><span class="exec-current exec-done">${st.stepCount} 个步骤</span>${timerHtml}`
        : `<span class="exec-done-icon">✓</span><span class="exec-current exec-done">完成</span>${timerHtml}`;
    }
    // 完成后自动折叠步骤历史，点击可再展开
    st.activityEl.classList.add('collapsed');
    // 如果活动 DOM 当前在 stage（用户在别的 session），清理掉避免内存泄漏
    if (st.activityEl.parentElement === _activityStage) {
      _activityStage.removeChild(st.activityEl);
    }
    // 活动在 chatMessages 的话（用户正看着这个 session），留着给用户看完成状态
    st.activityEl = null;
  }
  st.status = 'idle';
  st.requestId = null;
  st.stepCount = 0;
  st.lastText = '';
  // 单点更新：running 状态清零
  _sessionListStore.setRunning(sid, false);
}

function failV2Activity(sid, reason = '执行失败') {
  const st = _uiStates.get(sid);
  if (!st) return;
  if (st._timerId) { clearInterval(st._timerId); st._timerId = null; }
  const elapsed = st._timerStart ? _formatElapsed(Date.now() - st._timerStart) : '';
  if (st.activityEl) {
    const statusLine = st.activityEl.querySelector('.exec-status-line');
    if (statusLine) {
      const safeReason = String(reason || '执行失败').replace(/[<>]/g, '');
      const timerHtml = elapsed ? `<span class="exec-timer done">${elapsed}</span>` : '';
      statusLine.innerHTML = `<span class="exec-done-icon" style="color:#ff8c42">⚠</span><span class="exec-current exec-done" style="color:#ff8c42">${safeReason}</span>${timerHtml}`;
    }
    st.activityEl.classList.add('collapsed');
    if (st.activityEl.parentElement === _activityStage) {
      _activityStage.removeChild(st.activityEl);
    }
    st.activityEl = null;
  }
  st.status = 'idle';
  st.requestId = null;
  st.stepCount = 0;
  st.lastText = '';
  _sessionListStore.setRunning(sid, false);
}

// 切到某个 session 时调用：把所有 activity DOM move 到正确位置 + 同步 stop 按钮状态
function applyUIStateFor(sid) {
  // 1. 遍历所有 session 的 activity DOM，决定放哪
  for (const [otherSid, otherSt] of _uiStates) {
    if (!otherSt.activityEl) continue;
    if (otherSid === sid) {
      // 该 session 当前可见 → activity 应该在 chatMessages
      if (otherSt.activityEl.parentElement !== chatMessages) {
        chatMessages.appendChild(otherSt.activityEl);
      }
    } else {
      // 其他 session → activity 移到 stage
      if (otherSt.activityEl.parentElement !== _activityStage) {
        _activityStage.appendChild(otherSt.activityEl);
      }
    }
  }

  // 2. stop 按钮：按目标 session 的 running 状态决定
  const st = _uiStates.get(sid);
  const running = st?.status === 'running';
  if (chatStopBtn) {
    chatStopBtn.style.display = running ? 'flex' : 'none';
    chatStopBtn.onclick = running
      ? () => { try { window.pi.sessionBusInterrupt(sid); } catch {} }
      : null;
  }
  if (sidebarStopBtn) {
    sidebarStopBtn.style.display = running ? 'flex' : 'none';
    sidebarStopBtn.onclick = running
      ? () => { try { window.pi.sessionBusInterrupt(sid); } catch {} }
      : null;
  }
  // 老的 claude-stop 按钮在 v2 下彻底不用
  if (claudeStopBtn) claudeStopBtn.style.display = 'none';
  if (sidebarClaudeStop) sidebarClaudeStop.style.display = 'none';

  // 3. 输入框永远 enabled（Claude Code 式允许插话）
  if (chatInput) chatInput.disabled = false;
  if (sidebarInput) sidebarInput.disabled = false;

  // 3.5 压缩历史中的 session：强制锁输入框 + 发送按钮（覆盖上一步的 enabled）
  if (_compactState.get(sid)?.running) _applyCompactInputLock(true);

  // 4. 如果有 running session 的活动 DOM 被 move 回来，滚到底
  if (running) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 5. tick 4: live banner 随 session 切换同步（读目标 session 的 taskId）
  if (typeof updateLiveBanner === 'function') updateLiveBanner();
}

// 按 sessionId 路由流事件到对应 session 的 activity DOM（不管它当前是否可见）
window.pi.onSessionBusEvent((payload) => {
  if (!payload || !payload.sessionId) return;
  const sid = payload.sessionId;
  // Debug: log all event types
  if (payload.type !== 'state' && payload.type !== 'delta') {
    console.log(`[bus-event] type=${payload.type} sid=${sid?.substring(0,12)} raw=${!!payload.raw}`);
  }

  // 刀 3: replay 事件 —— 历史通常已通过 sessions.json messages 渲染，跳过。
  // 例外：task session 首次物化（messages 还空）时，bus 的 replay text 事件是
  // "打开 running task 看见历史" 的唯一来源；不放行 UI 只剩 spinner。
  // 只放行 text（语义等同 assistant 消息，持久化后不会重复），其它 replay 仍丢。
  if (payload.replay === true) {
    if (payload.type !== 'text') return;
    const sess = currentSession && currentSession.id === sid ? currentSession : null;
    const empty = sess && (!sess.messages || sess.messages.length === 0);
    if (!empty) return;
    // 穿透到下面 text 分支，_handleTaskTextEvent 把文本写进 messages 并渲染
  }

  // state 事件：bus 是权威 source，镜像写入 store
  if (payload.type === 'state') {
    _sessionListStore.setRunning(sid, payload.state === 'running');
    return;
  }

  // 刀 2: GPT 流式 delta 事件 —— 路由到 session 的 onDelta 回调
  if (payload.type === 'delta') {
    const dSt = _uiStates.get(sid);
    if (dSt && dSt.onDelta) dSt.onDelta(payload.content || '');
    return;
  }

  if (payload.type === 'voice') {
    const txt = (payload.content || '').trim();
    if (!txt) return;
    const st = _getUIState(sid);
    st.voiceEventCount = (st.voiceEventCount || 0) + 1;
    Promise.resolve(playTTS(txt)).catch(() => {});
    if (st.activityEl) {
      st.stepCount++;
      _renderActivityCurrent(sid, txt.substring(0, 80));
      // <say> 内容放在 activity 顶层（不在 exec-history 里），折叠时仍然可见
      const sayBlock = document.createElement('div');
      sayBlock.className = 'exec-say-block';
      sayBlock.textContent = txt;
      st.activityEl.appendChild(sayBlock);
      // 之后的工具步骤将进入新的折叠组
      st._currentStepGroup = null;
      // <say> 是天然断点：如果有排队消息，立即打断当前请求让 AI 吸收新输入
      if (st.queuedSends && st.queuedSends.length > 0) {
        console.log(`[voice-break] ${st.queuedSends.length} queued msg(s), interrupting to absorb`);
        window.pi.sessionBusInterrupt(sid).catch(() => {});
      }
    }
    return;
  }

  // Token usage 事件：累加并更新 header bar 显示
  if (payload.type === 'usage') {
    console.log('[token-usage] received usage event:', JSON.stringify(payload));
    const raw = payload.raw;
    if (raw) {
      const st = _getUIState(sid);
      // input 系列 + 本轮 output 都取最新值（一个 user turn 有多个 assistant step，
      // 每个 step 都会发 usage 事件，所以取"最后一个 step"的值代表当前状态）。
      // sessionOutputSum 累加所有 step 的输出，用来显示"这个 session 一共生成了多少"。
      st.tokenUsage.inputTokens = raw.input_tokens || 0;
      st.tokenUsage.cacheCreateTokens = raw.cache_creation_input_tokens || 0;
      st.tokenUsage.cacheReadTokens = raw.cache_read_input_tokens || 0;
      st.tokenUsage.outputTokens = raw.output_tokens || 0;
      st.tokenUsage.sessionOutputSum = (st.tokenUsage.sessionOutputSum || 0) + (raw.output_tokens || 0);
      const sessionMetaPatch = {};
      if (raw.model_context_window) {
        const prev = currentSession?.id === sid ? currentSession.contextWindow : undefined;
        if (prev !== raw.model_context_window) {
          _debugLog('[contextWindow]', `usage event raw.model_context_window=${raw.model_context_window} (prev=${prev}, sid=${sid}, session.model=${currentSession?.model}, raw.model=${raw.model})`);
        }
        sessionMetaPatch.contextWindow = raw.model_context_window;
      }
      // 记录"实际运行的 model"（区别于 UI 里用户选的 currentModel）——
      // Claude CLI `--resume` 继承 session 初始化时的 model，用户切换 pill 不生效，
      // 这里必须让 UI 显示真实在跑的那个。过滤 <synthetic>（compact 生成的占位 model）。
      if (raw.model && raw.model !== '<synthetic>') {
        sessionMetaPatch.actualModel = raw.model;
      }
      if (Object.keys(sessionMetaPatch).length > 0) {
        if (currentSession && currentSession.id === sid) {
          Object.assign(currentSession, sessionMetaPatch);
          if (sessionMetaPatch.actualModel && typeof _syncModelBtn === 'function') _syncModelBtn();
        }
        _queueSessionMetaPatch(sid, sessionMetaPatch);
      }
      _maybeFetchContextWindow(sid);
      // 只更新当前可见 session 的 UI
      if (currentSession && currentSession.id === sid) {
        _updateTokenUsageUI(st.tokenUsage);
      }
      // Auto-compact 阈值检查（140k = 70%）
      _maybeAutoCompact(sid, st.tokenUsage);
    }
    return;
  }

  const _handleChatTextEvent = (txt) => {
    const st = _uiStates.get(sid);
    if (st?.activityEl) {
      _renderActivityCurrent(sid, txt.substring(0, 200));
    }
  };

  const _handleTaskTextEvent = (txt) => {
    _rememberSessionOrigin(sid, 'task');
    // 方案 B：从 pendingSteps 快照本轮 tool steps，随 ai 消息一起持久化
    const _taskSt = _uiStates.get(sid);
    const _pendingStepsSnapshot = (_taskSt?.pendingSteps && _taskSt.pendingSteps.length > 0)
      ? _taskSt.pendingSteps.slice()
      : null;
    if (_taskSt?.pendingSteps) _taskSt.pendingSteps = [];
    if (currentSession?.id === sid) {
      const _tEng = currentSession.engine || 'claude';
      const _tMdl = currentSession.model || null;
      addMessage(chatMessages, 'ai', txt, { engine: _tEng, model: _tMdl, steps: _pendingStepsSnapshot });
      if (currentSession.messages) {
        const _tMsg = { role: 'ai', content: txt, engine: _tEng, timestamp: new Date().toISOString() };
        if (_tMdl) _tMsg.model = _tMdl;
        if (_pendingStepsSnapshot) _tMsg.steps = _pendingStepsSnapshot;
        currentSession.messages.push(_tMsg);
        saveCurrentSession();
      }
    } else {
      _sessionListStore.markUnread(sid);
      (async () => {
        try {
          const bg = await window.pi.sessionLoad(sid);
          if (bg) {
            _rememberSessionOrigin(sid, bg.origin, { hasSessionObject: true });
            bg.messages = bg.messages || [];
            const _bgEng = bg.engine || 'claude';
            const _bgMdl = bg.model || null;
            const _bgMsg = { role: 'ai', content: txt, engine: _bgEng, timestamp: new Date().toISOString() };
            if (_bgMdl) _bgMsg.model = _bgMdl;
            if (_pendingStepsSnapshot) _bgMsg.steps = _pendingStepsSnapshot;
            bg.messages.push(_bgMsg);
            await window.pi.sessionSave(bg);
          }
        } catch (e) { console.warn('[bus-event text->bg]', e.message); }
      })();
    }
    const st = _uiStates.get(sid);
    // 守卫：背景 session 的 activity DOM 不要在用户可见容器里更新
    // 如果 activityEl 还残留在 chatMessages（loadSession race 窗口），强制 move 到隐藏 stage
    if (st?.activityEl) {
      if (currentSession?.id !== sid && st.activityEl.parentElement === chatMessages) {
        _activityStage.appendChild(st.activityEl);
      }
      _renderActivityCurrent(sid, txt.substring(0, 200));
    }
  };

  // 刀 3: task session 的 text 事件 —— 把 assistant 文本作为新消息追加，并存盘。
  // 仅对 task session（origin='task'）生效。chat session 的回复通过 sendMessage 的
  // return path（addAI）处理，如果这里也处理就会双重写入 → 重复消息。
  if (payload.type === 'text') {
    const txt = (payload.content || '').trim();
    if (!txt) return;
    const knownOrigin = _getKnownSessionOrigin(sid);
    if (knownOrigin === 'task') {
      _handleTaskTextEvent(txt);
      return;
    }
    if (knownOrigin === 'chat') {
      _handleChatTextEvent(txt);
      return;
    }
    // 列表 store 还没同步 origin 时，回退到持久化 session record 判定。
    // 对 task session，宁可等一次异步 load 也不要把首批文本当成 chat 丢掉。
    _resolveSessionOrigin(sid).then((origin) => {
      if (origin === 'task') _handleTaskTextEvent(txt);
      else _handleChatTextEvent(txt);
    });
    return;
  }

  // 刀 3: done 事件
  // chat session: 不在这里 finishV2Activity —— sendMessage return path 负责（它还要 addAI）。
  // 如果这里也 finish，用户会在 AI 消息出现之前看到 "✓ 完成"。
  // task session: 在这里 finish（task 的回复通过 bus text 事件写入，没有 return path）。
  if (payload.type === 'done') {
    const knownOrigin = _getKnownSessionOrigin(sid);
    if (knownOrigin === 'task') {
      finishV2Activity(sid);
    } else if (!knownOrigin) {
      _resolveSessionOrigin(sid).then((origin) => {
        if (origin === 'task') finishV2Activity(sid);
      });
    }
    _sessionListStore.setRunning(sid, false);
    return;
  }

  // 刀 3: readonly 事件 —— RunSessionAdapter 说这个 session 不能 send
  // （reason: 'remote' 跨机 / 'no-jsonl' 老 run）
  if (payload.type === 'readonly') {
    const st = _getUIState(sid);
    st.readonly = { reason: payload.reason, host: payload.host, message: payload.content || '' };
    if (currentSession?.id === sid) updateLiveBanner();
    return;
  }

  // 刀 3: user-echo 事件 —— sendMessage 已经在本地渲染 user 气泡了，
  // 而 jsonl tail 也会把它作为 user-echo 抛出来（resume 子进程写到同一个文件）。
  // 为避免双份 user 气泡，这里直接跳过 user-echo。
  // (trade-off: 如果外部进程/另一个 PiBrowser 往同一个 session 写 user msg，本机看不到
  // 那个 user 气泡 —— 该场景目前不常见。)
  if (payload.type === 'user-echo') return;

  // tool / error 事件：更新 activity DOM
  const st = _uiStates.get(sid);
  if (!st || !st.activityEl) return; // 没在追踪这个 session 或已 finish
  // 守卫：背景 session 的 activity DOM 不能残留在 chatMessages（loadSession race 窗口）
  // step 仍要 push 到 history（用户切回时一次性看到累积），但物理上必须在隐藏 stage
  if (currentSession?.id !== sid && st.activityEl.parentElement === chatMessages) {
    _activityStage.appendChild(st.activityEl);
  }
  const activityEl = st.activityEl;
  const currentSpan = activityEl.querySelector('.exec-current');
  const history = activityEl.querySelector('.exec-history');

  if (payload.type === 'tool') {
    const match = (payload.content || '').match(/^(\S+)\s+(.*)/);
    const icon = match ? match[1] : '🔧';
    const desc = match ? match[2] : payload.content || '';
    st.stepCount++;
    // 方案 B：旁路写入 pendingSteps，text 事件时随 ai 消息持久化
    if (!st.pendingSteps) st.pendingSteps = [];
    st.pendingSteps.push({ icon, desc: desc.substring(0, 300) });
    _renderActivityCurrent(sid, desc);
    if (history) {
      // 工具步骤放进可折叠组（两个 <say> 之间的步骤归一组）
      if (!st._currentStepGroup) {
        const group = document.createElement('details');
        group.className = 'exec-step-group';
        const summary = document.createElement('summary');
        summary.className = 'exec-step-group-summary';
        summary.textContent = '工具调用';
        group.appendChild(summary);
        history.appendChild(group);
        st._currentStepGroup = group;
      }
      const step = document.createElement('div');
      step.className = 'exec-step';
      step.innerHTML = `<span class="exec-icon">${icon}</span><span class="exec-desc">${desc}</span>`;
      st._currentStepGroup.appendChild(step);
      // 更新 summary 显示步骤数
      const stepsInGroup = st._currentStepGroup.querySelectorAll('.exec-step').length;
      st._currentStepGroup.querySelector('summary').textContent = `${stepsInGroup} 个工具调用`;
    }
  } else if (payload.type === 'error') {
    if (isRecoverableCodexThreadError(payload.content || '')) {
      _renderActivityCurrent(sid, '会话断开，正在重连');
      return;
    }
    st.stepCount++;
    _renderActivityCurrent(sid, '⚠️ ' + (payload.content || ''));
    const knownOrigin = _getKnownSessionOrigin(sid);
    if (knownOrigin === 'task') {
      failV2Activity(sid, payload.content || '执行失败');
    } else if (!knownOrigin) {
      _resolveSessionOrigin(sid).then((origin) => {
        if (origin === 'task') failV2Activity(sid, payload.content || '执行失败');
      });
    }
  }

  // 如果活动 DOM 当前在 chatMessages（用户可见），滚到底
  if (activityEl.parentElement === chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

// v2 audio listener 在 onClaudeAudio 附近注册（依赖 audioQueue 已初始化）

function parseCodexResponse(text) {
  const sayRegex = /<say(?:\s+voice="\w+")?\s*>([\s\S]*?)<\/say>/g;
  const voiceParts = [];
  let match;
  while ((match = sayRegex.exec(text)) !== null) {
    const v = match[1].trim();
    if (v) voiceParts.push(v);
  }
  const say = voiceParts.join('，');
  const show = text.replace(/<\/?say(?:\s+voice="\w+")?\s*>/g, '').trim();
  return { say, show };
}

function isRecoverableCodexThreadError(message) {
  const msg = String(message || '');
  return msg.includes('Session not found for thread_id')
    || msg.includes('Session not found')
    || /thread[_\s-]?id/i.test(msg);
}

// ── 打通 Codex/Claude/GPT 上下文 ──
function injectCrossEngineContext(message) {
  if (!currentSession || currentSession.messages.length === 0) return message;
  const msgs = currentSession.messages;
  const hasOther = msgs.some(m => m.engine && m.engine !== currentEngine);
  if (!hasOther) return message;
  // 取最近 10 条消息构建上下文摘要
  const recent = msgs.slice(-10);
  const engineLabel = { codex: 'Codex', gpt: 'GPT', claude: 'Claude' };
  const lines = recent.map(m => {
    const eng = engineLabel[m.engine || 'codex'] || m.engine;
    const who = m.role === 'user' ? 'User' : `Pi(${eng})`;
    const content = m.content.replace(/<say(?:\s+voice="\w+")?\s*>[\s\S]*?<\/say>/g, '').trim();
    return `${who}: ${content.substring(0, 300)}`;
  });
  const others = [...new Set(msgs.filter(m => m.engine && m.engine !== currentEngine).map(m => engineLabel[m.engine] || m.engine))];
  return `[对话上下文 — 之前的交互包含 ${others.join('/')}，请延续对话]\n${lines.join('\n')}\n\n[当前问题]\n${message}`;
}

// 发送消息
async function sendMessage(input, messagesContainer, options = {}) {
  const text = (options.text ?? input.value).trim();
  if (!text) return;
  // 压缩历史进行中：禁止发送（输入框虽被 disable，但快捷键/程序化调用兜底）
  const _compactSid = options.targetSessionId || currentSession?.id;
  if (_compactSid && _compactState.get(_compactSid)?.running) {
    _showCompactToast({ text: '正在压缩历史，稍候再发…', timeout: 3000 });
    return;
  }
  const displayText = (options.displayText ?? text).trim() || text;
  const titleText = (options.titleText ?? displayText).trim() || text;
  const usesProvidedText = Object.prototype.hasOwnProperty.call(options, 'text');
  const skipUserRender = !!options.skipUserRender;
  const requestedEngine = options.engineOverride || currentEngine;

  // tick 9: 立即同步清空输入框 —— 这是用户感知的第一动作。
  // 之前 input.value = '' 在 1876 行（早返回之后）是错的，
  // 在 silent interrupt 的 await 期间用户看着自己的字还在那里，以为没发出去。
  if (!usesProvidedText) {
    input.value = '';
    input.style.height = 'auto';
  }

  // 刀 2 step 6b: stop 按钮点击路径走 bus interrupt，不再清全局 stopCurrentRequest

  // sidebar 输入路由规则：消息发到当前 active 的 session，不强制跳转 pi-main。
  // 用户创建了新会话就应该对着新会话说话，强制 pi-main 会导致新会话永远空白。
  const _forcePiMain = false;
  const sendSid = options.targetSessionId || (_forcePiMain ? MAIN_SESSION_ID : (currentSession?.id));

  // ─── 早返回路径（命令拦截、URL 导航等）──
  // 这些路径不真发消息，提前 return。input 已在上面清空。

  // Agent Mode 拦截
  if (agentMode && !agentRunning) {
    sendAgentTask(text, messagesContainer);
    return;
  }

  // 检测是否是 URL（只有明确的 URL 才导航，其他都问 Pi）
  if (currentMode === 'chat' && isURL(text)) {
    window.pi.navigate(text);
    return;
  }

  // 智能命令：/open xxx → 打开网页，/search xxx → Google 搜索
  if (text.startsWith('/open ')) {
    window.pi.navigate(text.slice(6).trim());
    return;
  }
  if (text.startsWith('/search ')) {
    window.pi.navigate(`https://www.google.com/search?q=${encodeURIComponent(text.slice(8).trim())}`);
    return;
  }

  // 中文/英文命令拦截（不经过 AI，直接执行）
  const CMD_PATTERNS = [
    { re: /^(打开|open)\s+(.+)/i, fn: (m) => window.pi.navigate(m[2].trim()) },
    { re: /^(搜索|搜|search)\s+(.+)/i, fn: (m) => window.pi.navigate(`https://www.google.com/search?q=${encodeURIComponent(m[2].trim())}`) },
    { re: /^(后退|返回|back)$/i, fn: () => window.pi.goBack() },
    { re: /^(前进|forward)$/i, fn: () => window.pi.goForward() },
    { re: /^(刷新|refresh|reload)$/i, fn: () => window.pi.reload() },
    { re: /^(新标签|new tab)(.*)$/i, fn: (m) => window.pi.newTab(m[2]?.trim() || undefined) },
  ];
  for (const { re, fn } of CMD_PATTERNS) {
    const m = text.match(re);
    if (m) { fn(m); return; }
  }

  // 刀 3: readonly session 早返回 —— 远程或老 run 的 task session 不能 send
  if (currentSession?.origin === 'task') {
    const _st = _uiStates.get(currentSession.id);
    if (_st?.readonly) {
      const msg = _st.readonly.reason === 'remote'
        ? `远程任务（${_st.readonly.host}）只读。请 SSH 到 ${_st.readonly.host} 手动接管。`
        : `此 session 只读（${_st.readonly.message || '无 jsonl'}）。`;
      addMessage(messagesContainer, 'ai', msg);
      return;
    }
  }

  // ─── tick 9: rolling interjection 视觉收尾 ───────────
  // 不再 silent interrupt（adapter 内部会自动处理）。renderer 这里只负责 UI 收尾：
  // 如果当前 session 有 in-flight activity，标记为"已被打断"，让出位置给新 activity。
  // 老 activity 的 DOM 留在 chat 里作为历史，不删。
  // _forcePiMain 时不打断 currentSession（消息发到 pi-main，不影响当前 task session）
  const queueInsteadOfInterrupt = !options.skipQueue
    && (requestedEngine === 'codex' || requestedEngine === 'claude')
    && !!sendSid
    && _getUIState(sendSid).status === 'running';

  if (currentSession && !_forcePiMain && !queueInsteadOfInterrupt) {
    const _sid = currentSession.id;
    const _st = _uiStates.get(_sid);
    if (_st?.activityEl) {
      const statusLine = _st.activityEl.querySelector('.exec-status-line');
      if (statusLine) {
        statusLine.innerHTML = '<span class="exec-done-icon">⊘</span><span class="exec-current exec-done">被新消息打断</span>';
      }
      _st.activityEl.classList.add('interrupted');
      _st.activityEl = null;
      _st.status = 'idle';
      _st.stepCount = 0;
      _sessionListStore.setRunning(_sid, false);
    }
  }

  // ─── tick 9: 立即同步显示 user bubble + 创建 activity DOM ───────
  // 这是用户感知的核心：input 清空 + user bubble 显示 + spinner 显示
  // 全部发生在任何 await 之前。后面的 page-context 抓取、screenshot 保存等
  // async 工作都在用户已经看到反馈之后进行。
  const _isBrowserMode = !cleanMode && (currentMode === 'browser' || currentMode === 'chat-with-tabs');
  const _isPiosPage = pageContext && /pios-home|localhost:17891|127\.0\.0\.1:17891/i.test(pageContext.url || '');
  const _injectedPagePreview = (_isBrowserMode && pageContext && !_isPiosPage)
    ? { title: pageContext.title, url: pageContext.url, favicon: pageContext.favicon || '' }
    : null;
  const _attachmentsPreview = [...pendingAttachments];
  // 清掉 pending —— 后续如果用户再点附件，是新一批
  if (_attachmentsPreview.length) {
    pendingAttachments = [];
    renderAttachmentChips();
  }

  if (messagesContainer === chatMessages && !skipUserRender) exitWelcomeState();
  if (!skipUserRender) addMessage(messagesContainer, 'user', displayText, { injectedPage: _injectedPagePreview, attachments: _attachmentsPreview });
  if (!skipUserRender && _forcePiMain && currentSession?.id !== MAIN_SESSION_ID) {
    // sidebar → 保存用户消息到 pi-main（异步，不阻塞 UI）
    (async () => {
      try {
        const pmSession = await window.pi.sessionLoad(MAIN_SESSION_ID);
        if (pmSession) {
          pmSession.messages.push({ role: 'user', content: text, engine: currentEngine, timestamp: new Date().toISOString() });
          await window.pi.sessionSave(pmSession);
        }
      } catch (e) { console.warn('[sidebar->pi-main] save user msg failed:', e); }
    })();
  } else if (!skipUserRender && currentSession) {
    if (currentSession.messages.length === 0 && currentSession.id !== MAIN_SESSION_ID) {
      // 只在 title 还是默认值时自动用消息首行覆盖，避免盖掉调用方显式设的 title
      // （例如 Call Pi 的 NYC:xxx）
      if (!currentSession.title || currentSession.title === '新对话') {
        currentSession.title = titleText.substring(0, 30);
      }
    }
    currentSession.messages.push({
      role: 'user', content: text, engine: currentEngine,
      timestamp: new Date().toISOString(),
      injectedPage: _injectedPagePreview, attachments: _attachmentsPreview,
    });
    saveCurrentSession();
  }

  // 同时立即创建 activity DOM —— 用户立刻看到 "正在思考..." spinner
  // 注意：只对显式 Claude 路径前置创建。Auto 模式默认走 GPT，GPT 自己有
  // 流式 streamMsg 给用户即时反馈；只有 Auto 路由到 Claude 时才会创建 activity。
  const _earlySid = sendSid;
  if (currentEngine === 'claude' && _earlySid && messagesContainer === chatMessages) {
    const _st = _getUIState(_earlySid);
    _st.status = 'running';
    if (!_st.activityEl) createV2ActivityForSession(_earlySid, messagesContainer);
    if (currentSession?.id === _earlySid) applyUIStateFor(_earlySid);
  }

  // Fork 会话：把预填的任务消息拼进 prompt，让 Claude 看到完整上下文
  // 检测方式：session 里有且仅有 user 消息（没有 AI 回复过），且第一条不是当前发的
  let fullMessage = options.preparedFullMessage || text;
  if (!options.preparedFullMessage && currentSession) {
    const allMsgs = currentSession.messages || [];
    const hasAiReply = allMsgs.some(m => m.role === 'ai');
    const priorUserMsgs = allMsgs.filter(m => m.role === 'user' && m.content !== text);
    if (!hasAiReply && priorUserMsgs.length > 0) {
      const context = priorUserMsgs.map(m => m.content).join('\n\n');
      fullMessage = `【重要：这是一个分支任务会话。忽略系统通知和待办事项，只执行下面的任务。不要巡检汇报。】\n\n[任务背景]\n${context}\n\n[当前指令]\n${text}`;
    }
  }

  if (!options.preparedFullMessage && terminalContext) {
    fullMessage = `[终端上下文]\n${terminalContext}\n\n[问题]\n${text}`;
    terminalContext = null;
    terminalBanner.style.display = 'none';
  }

  // 如果在浏览器模式，自动注入页面上下文（匿名模式跳过）
  // Token 节流：同一 URL 且 5min 内只在首轮注入全文，后续用紧凑承接标记
  // （页面全文已在 JSONL 历史里，--resume 时 Claude 自然读到，重复注入等于每轮都让整段历史重放）
  const isBrowserMode = !cleanMode && (currentMode === 'browser' || currentMode === 'chat-with-tabs');
  const isPiosPage = pageContext && /pios-home|localhost:17891|127\.0\.0\.1:17891/i.test(pageContext.url || '');
  const _hasForkContext = fullMessage !== text && (fullMessage.includes('[任务背景]') || fullMessage.startsWith('【重要：'));
  const PAGE_REFRESH_MS = 5 * 60 * 1000;
  const _lastPageUrl = currentSession?._lastInjectedPageUrl || null;
  const _lastPageAt = currentSession?._lastInjectedPageAt || 0;
  const _pageFresh = (url) => url && url === _lastPageUrl && (Date.now() - _lastPageAt) < PAGE_REFRESH_MS;
  const _markInjected = (url) => {
    if (currentSession) {
      currentSession._lastInjectedPageUrl = url;
      currentSession._lastInjectedPageAt = Date.now();
    }
  };
  if (!options.preparedFullMessage && !_hasForkContext && isBrowserMode && isPiosPage) {
    // PiOS Home：注入结构化系统数据
    if (_pageFresh('__pios_home__')) {
      const elapsed = Math.floor((Date.now() - _lastPageAt) / 60000);
      fullMessage = `[PiOS Home | ${elapsed}分钟前已同步系统状态]\n\n[问题]\n${text}`;
    } else {
      try {
        const [overview, notifs] = await Promise.all([
          window.pi.piosOverview(),
          fetch('http://127.0.0.1:17891/pios/notifications?limit=8').then(r => r.json()).catch(() => []),
        ]);
        const now = new Date();
        const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
        const parts = [`[PiOS 系统状态] ${dateStr} ${timeStr}`];
        if (overview) {
          parts.push(`统计: ${overview.cards.active} 活跃卡片, ${overview.cards.inbox} 收件箱, ${overview.cards.decisions} 待决策`);
          parts.push(`Agents: ${overview.agents.active}/${overview.agents.total} 活跃`);
          if (overview.decisions.length > 0) {
            parts.push('待决策: ' + overview.decisions.map(d => `${d.title}`).join('; '));
          }
        }
        if (notifs && notifs.length > 0) {
          parts.push('\n最近通知:');
          for (const n of notifs.slice(0, 8)) {
            const t = n.timestamp ? new Date(n.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
            parts.push(`  ${t} ${n.text || n.body || ''}`);
          }
        }
        fullMessage = parts.join('\n') + `\n\n[问题]\n${text}`;
        _markInjected('__pios_home__');
      } catch (e) {
        console.warn('[pios-context]', e.message);
      }
    }
  } else if (!options.preparedFullMessage && isBrowserMode && pageContext && !isPiosPage) {
    if (_pageFresh(pageContext.url)) {
      fullMessage = `[当前页面: ${pageContext.title}（承接上文）]\n\n[问题]\n${text}`;
    } else {
      fullMessage = `[当前页面: ${pageContext.title}]\nURL: ${pageContext.url}\n以下是页面全文摘要（已自动提取，无需截图）:\n${pageContext.text.substring(0, 3000)}\n\n[问题]\n${text}`;
      _markInjected(pageContext.url);
    }
  } else if (!options.preparedFullMessage && isBrowserMode && !isPiosPage) {
    const page = await window.pi.getPageContent();
    if (page && !/pios-home|localhost:17891|127\.0\.0\.1:17891/i.test(page.url || '')) {
      if (_pageFresh(page.url)) {
        fullMessage = `[当前页面: ${page.title}（承接上文）]\n\n[问题]\n${text}`;
      } else {
        fullMessage = `[当前页面: ${page.title}]\nURL: ${page.url}\n以下是页面全文摘要（已自动提取，无需截图）:\n${page.text.substring(0, 3000)}\n\n[问题]\n${text}`;
        _markInjected(page.url);
      }
    }
  }

  // tick 9: injectedPage 和 attachmentsSnapshot 都已经在顶部 sync 阶段计算过
  // （_injectedPagePreview / _attachmentsPreview），这里直接复用，不再重复读
  // pendingAttachments / pageContext。
  const injectedPage = _injectedPagePreview;
  const attachmentsSnapshot = _attachmentsPreview;
  if (!options.preparedFullMessage && attachmentsSnapshot.length) {
    const parts = attachmentsSnapshot.map(f => {
      if (f.isImage) return `[附件图片: ${f.name}]`;
      if (f.content) {
        const label = f.isPDF ? 'PDF' : f.isExcel ? 'Excel/表格' : f.isWord ? 'Word文档' : '文件';
        const fmt = f.isExcel ? '' : '```\n';
        const fmtEnd = f.isExcel ? '' : '\n```';
        return `[附件${label}: ${f.name}]\n${fmt}${f.content.substring(0, 60000)}${fmtEnd}`;
      }
      if (f.isPDF && f.filePath) return `[附件 PDF: ${f.filePath}（请用 Read 工具读取此路径）]`;
      if (f.filePath) return `[附件文件: ${f.filePath}（${formatFileSize(f.size)}，格式暂不支持提取内容）]`;
      return `[附件: ${f.name}（${formatFileSize(f.size)}，格式暂不支持）]`;
    });
    fullMessage = parts.join('\n\n') + '\n\n' + fullMessage;
  }

  // 处理图片附件
  const imageAttachments = options.preparedFullMessage ? [] : attachmentsSnapshot.filter(f => f.isImage && f.base64);
  // 为 Claude 保存图片到临时文件（Claude 用 Read 工具读取）
  const imagePaths = [];
  for (const img of imageAttachments) {
    try {
      const p = await window.pi.saveScreenshot(img.base64);
      if (p) imagePaths.push(p);
    } catch {}
  }
  // tick 9: user bubble + session push 已经在顶部 sync 完成（用 _injectedPagePreview
  // 和 _attachmentsPreview snapshot），这里不再重复 addMessage / push messages。

  // 打通上下文
  fullMessage = injectCrossEngineContext(fullMessage);

  const btn = messagesContainer === chatMessages ? sendBtn : sidebarSend;
  const stopBtn = messagesContainer === chatMessages ? chatStopBtn : sidebarStopBtn;

  const patchSendSession = async (patch) => {
    if (!sendSid || !patch) return;
    if (currentSession?.id === sendSid && currentSession) {
      Object.assign(currentSession, patch);
      if (Object.prototype.hasOwnProperty.call(patch, 'threadId')) {
        _setVisibleThreadIdForSession(sendSid, patch.threadId);
      }
      await saveCurrentSession();
      return;
    }
    try {
      const bg = await window.pi.sessionLoad(sendSid);
      if (!bg) return;
      Object.assign(bg, patch);
      await window.pi.sessionSave(bg);
    } catch (e) {
      console.warn('[sendMessage] patch session failed:', e);
    }
  };

  const addAI = (text, patch = null) => {
    // 方案 B：从 pendingSteps 快照本轮 tool steps，随 ai 消息一起持久化
    const _aiSt = _uiStates.get(sendSid);
    const _aiStepsSnapshot = (_aiSt?.pendingSteps && _aiSt.pendingSteps.length > 0)
      ? _aiSt.pendingSteps.slice()
      : null;
    if (_aiSt?.pendingSteps) _aiSt.pendingSteps = [];
    if (currentSession?.id !== sendSid) {
      // 用户已切换会话：把回复存入原会话，切回来时 loadSession 会显示
      // 同时标记 unread —— 单点写入 store，左侧列表自动跟进
      _sessionListStore.markUnread(sendSid);
      (async () => {
        try {
          const bg = await window.pi.sessionLoad(sendSid);
          if (bg) {
            if (patch) Object.assign(bg, patch);
            const _bgMdl = (replyEngine === 'claude' || replyEngine === 'exec') ? currentModel : null;
            const _bgMsg = { role: 'ai', content: text, engine: replyEngine, timestamp: new Date().toISOString() };
            if (_bgMdl) _bgMsg.model = _bgMdl;
            if (_aiStepsSnapshot) _bgMsg.steps = _aiStepsSnapshot;
            bg.messages.push(_bgMsg);
            await window.pi.sessionSave(bg);
          }
        } catch (e) { console.warn('[addAI] bg session save failed:', e); }
      })();
      return;
    }
    const _fgMdl = (replyEngine === 'claude' || replyEngine === 'exec') ? currentModel : null;
    addMessage(messagesContainer, 'ai', text, { engine: replyEngine, model: _fgMdl, steps: _aiStepsSnapshot });
    if (currentSession) {
      if (patch) Object.assign(currentSession, patch);
      const _fgMsg = { role: 'ai', content: text, engine: replyEngine, timestamp: new Date().toISOString() };
      if (_fgMdl) _fgMsg.model = _fgMdl;
      if (_aiStepsSnapshot) _fgMsg.steps = _aiStepsSnapshot;
      currentSession.messages.push(_fgMsg);
      saveCurrentSession();
    }
    notifyIfHidden(text);
  };

  // 刀 2 step 6b: stop 按钮 / input / activity 全由 `applyUIStateFor` 按 session 接管。
  // 删除的老补丁：`_v2ClaudeDirect` 特判、60s `safetyTimer` 兜底、全局 `stopCurrentRequest`。
  // 所有引擎（claude/gpt/auto）都走 SessionBus，stop 直接调 `sessionBusInterrupt(sendSid)`。
  const restoreBtn = () => {
    const v2Running = currentSession && _uiStates.get(currentSession.id)?.status === 'running';
    if (!v2Running) {
      if (chatStopBtn) chatStopBtn.style.display = 'none';
      if (sidebarStopBtn) sidebarStopBtn.style.display = 'none';
    }
    chatInput.disabled = false;
    sidebarInput.disabled = false;
  };
  // GPT/Auto 路径：chatStopBtn/sidebarStopBtn 显示 + 点击 wire 到 bus interrupt
  // （Claude 路径由 applyUIStateFor 管理，不经这里）
  if (currentEngine !== 'claude') {
    if (chatStopBtn) chatStopBtn.style.display = 'flex';
    if (sidebarStopBtn) sidebarStopBtn.style.display = 'flex';
    const stopFn = () => {
      if (abortCurrentRequest) abortCurrentRequest();
      if (sendSid) { try { window.pi.sessionBusInterrupt(sendSid); } catch {} }
      restoreBtn();
    };
    if (chatStopBtn) chatStopBtn.onclick = stopFn;
    if (sidebarStopBtn) sidebarStopBtn.onclick = stopFn;
  }

  // Claude 引擎：追加所有图片路径供 Read 工具读取
  if (imagePaths.length) {
    fullMessage += '\n\n' + imagePaths.map((p, i) => `[图片${i + 1}已保存到 ${p}，请用 Read 工具查看]`).join('\n');
  }

  // Auto 模式：默认走 GPT，GPT 自己判断是否转 Claude
  let effectiveEngine = requestedEngine;
  if (requestedEngine === 'auto') effectiveEngine = 'gpt';
  let replyEngine = effectiveEngine;
  // Auto：pill 从 "Pi Auto ▾" 切到 "Pi Auto → GPT ▾"，命中 <<CLAUDE>> 后再改 Claude
  if (requestedEngine === 'auto' && currentSession?.id === sendSid) {
    currentSession.actualEngine = 'gpt';
    _syncEngineBtn();
  }
  // 匿名模式：走 GPT clean 路径（任何引擎都可以）
  const isClean = cleanMode;

  if (effectiveEngine === 'claude') {
    // ── Claude Code: inline activity 接管显示 ──
    terminalPanel.style.display = 'none';
    if (messagesContainer === chatMessages) exitWelcomeState();

    // v2 path: 活动 DOM 和 stop 按钮都 per-session
    const st = _getUIState(sendSid);

    // 排队逻辑：Claude 引擎也支持消息排队，用户可随时输入不打断
    if (queueInsteadOfInterrupt) {
      st.queuedSends.push({
        input, container: messagesContainer, engine: 'claude',
        options: { text, displayText, titleText, preparedFullMessage: fullMessage, attachments: [..._attachmentsPreview] },
      });
      _renderActivityCurrent(sendSid, st.lastText || '继续思考中');
      return;
    }

    st.status = 'running';
    // tick 8: reuse activity if silent interrupt already created one
    if (!st.activityEl) createV2ActivityForSession(sendSid, messagesContainer);
    if (currentSession?.id === sendSid) applyUIStateFor(sendSid);

    try {
      // 刀 3: task session 走 RunSessionAdapter，不能 forget+attach。
      // chat session：只在首次或切引擎时 attach，不要每条消息都 forget
      // （forget 会销毁 ClaudeCodeClient + _sessionId → 丢失 --resume → 丢记忆）。
      if (currentSession?.origin !== 'task') {
        await window.pi.sessionBusEnsure(sendSid, 'claude', {
          claudeSessionId: currentSession?.claudeSessionId || null,
        });
      }
      let result = await window.pi.sessionBusSend(sendSid, fullMessage, {
        permissionLevel: currentSession?.permissionLevel || 'full',
        model: currentModel,
      });
      // tick 9: rolling interjection — 被打断时的处理
      if (result && result.aborted) {
        // voice-break 或排队触发的中断：正常结束 activity，保存部分回复
        if (st.queuedSends.length > 0) {
          // 有排队消息 → 安静结束当前 activity，drain 会接续
          finishV2Activity(sendSid);
          if (result.claudeSessionId && currentSession?.id === sendSid) {
            currentSession.claudeSessionId = result.claudeSessionId;
            saveCurrentSession();
          }
          if (result.content) addAI(result.content);
        }
        // 否则是外部抢占，不 finish 不 addAI（旧行为）
      } else {
        // 刀 3: task session 的 send 是 fire-and-forget（RunSessionAdapter spawn 了 resume 子进程），
        // 没有同步的 result.content —— 文本和 tool 调用通过 bus 事件流进来，addAI 由 onSessionBusEvent 处理。
        // 所以这里只在非 task session 时 finish activity + addAI。
        if (currentSession?.origin !== 'task') {
          // 有排队消息时不 finish activity（drain 会复用）
          if (st.queuedSends.length === 0) finishV2Activity(sendSid);
          else _renderActivityCurrent(sendSid, '继续处理已排队消息');
          // 保存 claudeSessionId —— 下次 send 时 client.run() 会用 --resume 续接上下文
          if (result.claudeSessionId && currentSession?.id === sendSid) {
            currentSession.claudeSessionId = result.claudeSessionId;
            saveCurrentSession();
          }
          if (result.error) {
            addAI(`错误: ${result.error}`);
          } else if (result.content) {
            addAI(result.content);
          } else {
            // Claude CLI 返回空内容（可能 CLI 启动失败、auth 问题、进程被杀）
            // 不要让用户只看到 "✓ 完成" 却没有任何回复
            console.warn('[sendMessage] Claude returned empty content, result:', JSON.stringify(result));
            addAI('（Pi 没有回复内容，可能 Claude 进程异常退出。请重试。）');
          }
        }
      }
    } catch (err) {
      finishV2Activity(sendSid);
      addAI(`执行失败: ${err.message}`);
    } finally {
      input.disabled = false;
      btn.disabled = false;
      if (currentSession?.id === sendSid) applyUIStateFor(sendSid);
      else restoreBtn();
      input.focus();
      // 排队消息自动排水：当前回复完成后处理下一条
      if (st.queuedSends.length > 0) {
        _drainQueuedSend(sendSid, 'claude');
      }
    }
  } else if (effectiveEngine === 'gpt') {
    // ── GPT Direct: 流式直连 ChatGPT backend API ──
    let aborted = false;
    // Create streaming message DOM upfront
    if (messagesContainer === chatMessages) exitWelcomeState();
    const streamMsg = document.createElement('div');
    streamMsg.className = 'message ai';
    const streamLabel = document.createElement('div');
    streamLabel.className = 'message-label';
    const now = new Date();
    streamLabel.innerHTML = `Pi <span class="msg-engine-badge" title="这条回复由 GPT 生成">GPT</span> <span class="msg-time" title="${now.toLocaleString()}">${formatTime(now)}</span>`;
    const streamContent = document.createElement('div');
    streamContent.className = 'message-content';
    streamContent.innerHTML = '<span class="streaming-cursor">▍</span>';
    streamMsg.appendChild(streamLabel);
    streamMsg.appendChild(streamContent);
    messagesContainer.appendChild(streamMsg);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    let streamText = '';
    let deltaNum = 0;
    let spokenSayTags = 0;
    let claudeRouted = false;
    // rAF 批量渲染：多个 delta 攒到下一帧再渲染，避免 DOM 抖动
    let _pendingDeltaRender = false;
    let _deltaRafId = 0;
    const _flushDeltaRender = () => {
      _deltaRafId = 0;
      if (!_pendingDeltaRender || aborted || claudeRouted) return;
      _pendingDeltaRender = false;
      // TTS 检测
      const sayMatches = [...streamText.matchAll(/<say(?:\s+voice="(\w+)")?\s*>([\s\S]*?)<\/say>/g)];
      if (sayMatches.length > spokenSayTags) {
        for (let i = spokenSayTags; i < sayMatches.length; i++) {
          const preset = sayMatches[i][1];
          const sayContent = sayMatches[i][2].trim();
          if (sayContent) playTTS(sayContent, preset);
        }
        spokenSayTags = sayMatches.length;
      }
      const cursor = '<span class="streaming-cursor">▍</span>';
      if (typeof marked !== 'undefined') {
        streamContent.innerHTML = marked.parse(streamText) + cursor;
      } else {
        streamContent.textContent = streamText;
      }
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    };

    const deltaHandler = (delta) => {
      deltaNum++;
      if (aborted || claudeRouted) return;
      if (currentSession?.id !== sendSid) return;
      streamText += delta;
      // Auto 模式：检测 <<CLAUDE>> 路由标记
      if (currentEngine === 'auto' && deltaNum <= 8 && /^[\s]*<{1,2}(CLAUDE|EXEC)>{1,2}/i.test(streamText.trim())) {
        claudeRouted = true;
        // 立即隐藏流式消息，避免 <<EXEC>> 闪现
        streamMsg.style.display = 'none';
        // 等 1.5s 让 GPT 把 <say> 交接语也吐完，再处理路由
        // 继续收集 delta（更新 onDelta 让 streamText 继续累积 <say> 内容）
        gptSt.onDelta = (d) => { streamText += d; };
        setTimeout(() => {
          if (currentSession?.id !== sendSid) { gptSt.onDelta = null; restoreBtn(); return; }
          window.pi.sessionBusInterrupt(sendSid).catch(() => {});
          gptSt.onDelta = null;
          // 提取 GPT 的 <say> 交接语（如果有）
          const sayMatch = streamText.match(/<say>([\s\S]*?)<\/say>/);
          const handoffText = sayMatch ? sayMatch[1].trim() : '';
          // 如果没有 <say>，提取路由标记后的纯文本作为交接语
          let fallbackText = '';
          if (!handoffText) {
            fallbackText = streamText.replace(/^[\s]*<{1,2}(CLAUDE|EXEC)>{1,2}/i, '').replace(/<\/?say>/g, '').trim();
          }
          // 删掉 GPT 的流式消息
          streamMsg.remove();
          // 显示交接语
          const displayText = handoffText || fallbackText;
          if (displayText) {
            // 2026-04-22 串台修：DOM 渲染和数据 push 都要用 sendSid 守卫，否则 owner 切了会话
            // 这段交接语会"闪"在当前打开的会话里（addMessage 渲染到共享 DOM 节点 chatMessages）。
            // 守卫后：数据写回原会话，DOM 仅在还停留在原会话时渲染；切回去 loadSession 会重渲。
            const _msg = { role: 'ai', content: displayText, engine: 'gpt', timestamp: new Date().toISOString() };
            if (currentSession?.id === sendSid) {
              addMessage(messagesContainer, 'ai', displayText, { engine: 'gpt' });
              currentSession.messages.push(_msg);
              saveCurrentSession();
            } else {
              _sessionListStore.markUnread(sendSid);
              (async () => {
                try {
                  const bg = await window.pi.sessionLoad(sendSid);
                  if (bg) { bg.messages.push(_msg); await window.pi.sessionSave(bg); }
                } catch (e) { console.warn('[handoff save] bg session save failed:', e); }
              })();
            }
            playTTS(displayText);
          }
          // 创建 inline activity block（v2 per-session）
          const st = _getUIState(sendSid);
          st.status = 'running';
          // tick 8: reuse if silent interrupt or earlier code already created
          if (!st.activityEl) createV2ActivityForSession(sendSid, messagesContainer);
          if (currentSession?.id === sendSid) applyUIStateFor(sendSid);
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
          // 转给执行引擎
          (async () => {
          if (currentSession?.id !== sendSid) { restoreBtn(); return; }
          effectiveEngine = 'claude';
          // Auto 路由命中 → pill 改 "Pi Auto → Claude ▾"
          if (currentSession?.id === sendSid) {
            currentSession.actualEngine = 'claude';
            _syncEngineBtn();
          }
          const se = document.getElementById('status-engine');
          if (se) se.textContent = 'Auto ⚡';
          terminalPanel.style.display = 'none';
          try {
            // 构建包含对话历史的上下文，让执行引擎知道要做什么
            let contextParts = [];
            if (currentSession && currentSession.messages.length > 0) {
              const recent = currentSession.messages.slice(-6);
              for (const m of recent) {
                const role = m.role === 'user' ? 'User' : 'Assistant';
                contextParts.push(`${role}: ${m.content}`);
              }
            }
            const imgNote = imagePaths.length ? '\n' + imagePaths.map((p, i) => `[图片${i + 1}已保存到 ${p}，请用 Read 工具查看]`).join('\n') : '';
            const claudeMsg = contextParts.length > 0
              ? `以下是最近的对话上下文：\n${contextParts.join('\n')}\n\n用户最新请求：${text}${imgNote}`
              : text + imgNote;
            // 刀 2: auto→claude 走 SessionBus；ensure 会在引擎不同时自动 forget+reattach
            await window.pi.sessionBusEnsure(sendSid, 'claude', {
              claudeSessionId: currentSession?.claudeSessionId || null,
            });
            let result = await window.pi.sessionBusSend(sendSid, claudeMsg, {
              permissionLevel: currentSession?.permissionLevel || 'full',
              model: currentModel,
            });
            // tick 9: rolling interjection — 如果是被新 send 抢占的，老 result 不写消息
            if (result && result.aborted) {
              // 不调 finishV2Activity，不 addMessage
            } else {
              finishV2Activity(sendSid);
              if (result.claudeSessionId && currentSession?.id === sendSid) {
                currentSession.claudeSessionId = result.claudeSessionId;
                saveCurrentSession();
              }
              if (result.error) {
                // 2026-04-22 串台修：错误消息也用 sendSid 守卫，不匹配就不渲染 DOM
                if (currentSession?.id === sendSid) {
                  addMessage(messagesContainer, 'ai', `错误: ${result.error}`);
                } else {
                  _sessionListStore.markUnread(sendSid);
                }
              } else if (result.content) {
                // 去掉和交接语重复的开头
                let finalContent = result.content;
                if (displayText && finalContent.startsWith(displayText)) {
                  finalContent = finalContent.substring(displayText.length).trim();
                }
                if (finalContent) {
                  // 2026-04-22 串台修：DOM 渲染和数据 push 都要用 sendSid 守卫，否则 owner 切了会话
                  // 这段回复会"闪"在当前打开的会话里（addMessage 渲染到共享 DOM 节点 chatMessages）。
                  // 守卫后：数据写回原会话，DOM 仅在还停留在原会话时渲染；切回去 loadSession 会重渲。
                  const _execMsg = { role: 'ai', content: finalContent, engine: 'exec', model: currentModel, timestamp: new Date().toISOString() };
                  if (currentSession?.id === sendSid) {
                    addMessage(messagesContainer, 'ai', finalContent, { engine: 'exec', model: currentModel });
                    currentSession.messages.push(_execMsg);
                    saveCurrentSession();
                  } else {
                    _sessionListStore.markUnread(sendSid);
                    (async () => {
                      try {
                        const bg = await window.pi.sessionLoad(sendSid);
                        if (bg) { bg.messages.push(_execMsg); await window.pi.sessionSave(bg); }
                      } catch (e) { console.warn('[exec save] bg session save failed:', e); }
                    })();
                  }
                }
              }
            }
          } catch (err) {
            finishV2Activity(sendSid);
            addAI(`执行失败: ${err.message}`);
          } finally {
            if (se) se.textContent = 'Auto';
            input.disabled = false;
            if (currentSession?.id === sendSid) applyUIStateFor(sendSid);
            else restoreBtn();
          }
        })();
        }, 1500);
        return;
      }
      // rAF 节流：攒到下一帧再渲染
      _pendingDeltaRender = true;
      if (!_deltaRafId) _deltaRafId = requestAnimationFrame(_flushDeltaRender);
    };
    // 刀 2: 把 deltaHandler 存入 _uiStates，让 onSessionBusEvent 的 'delta' 分支调用
    const gptSt = _getUIState(sendSid);
    gptSt.onDelta = deltaHandler;

    abortCurrentRequest = () => {
      aborted = true;
      window.pi.sessionBusInterrupt(sendSid).catch(() => {});
      streamContent.querySelector('.streaming-cursor')?.remove();
      if (!streamText) streamContent.textContent = '已停止';
      gptSt.onDelta = null;
      input.disabled = false;
      btn.disabled = false;
      restoreBtn();
      input.focus();
    };

    try {
      // 刀 2: 切换到 SessionBus 路径（替代 sendGPT 老路径）
      // ensure 在引擎不同时自动 forget+reattach，相同时复用
      await window.pi.sessionBusEnsure(sendSid, 'gpt');
      const result = await window.pi.sessionBusSend(sendSid, fullMessage, {
        engine: 'gpt',
        history: currentSession?.messages,
        images: imageAttachments.map(f => f.base64),
        clean: isClean,
        auto: currentEngine === 'auto',
      });
      if (aborted || claudeRouted) return;
      // Finalize streaming message in-place (avoid IPC race with DOM replace)
      streamContent.querySelector('.streaming-cursor')?.remove();
      const finalText = result.error ? `错误: ${result.error}` : (result.content || streamText);
      if (result.error) {
        streamContent.textContent = finalText;
      } else {
        // Re-render with final markdown + source cards + copy button
        streamContent.innerHTML = '';
        const sources = extractSources(finalText);
        const parts = finalText.split(/(<say(?:\s+voice="\w+")?\s*>[\s\S]*?<\/say>)/g);
        for (const part of parts) {
          const sayMatch = part.match(/^<say(?:\s+voice="\w+")?\s*>([\s\S]*?)<\/say>$/);
          if (sayMatch) {
            const voice = document.createElement('div');
            voice.className = 'voice-line';
            voice.innerHTML = '<span class="voice-icon" title="这段会被朗读">🔊</span> ' + sayMatch[1].trim();
            streamContent.appendChild(voice);
          } else if (part.trim()) {
            const screen = document.createElement('div');
            screen.className = 'screen-line';
            if (typeof marked !== 'undefined') {
              let html = marked.parse(part.trim());
              html = addFootnotes(html, sources);
              html = inlineLocalImages(html);
              screen.innerHTML = html;
              enhanceInlineImages(screen);
            } else {
              screen.textContent = part.trim();
            }
            streamContent.appendChild(screen);
          }
        }
        _pendingSearchResults = result.searchResults || null;
        renderSourceCards(sources, streamContent, _pendingSearchResults);
        _pendingSearchResults = null;
        streamContent.addEventListener('click', (e) => {
          handleAssistantContentClick(e, sources);
        });
        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'msg-copy-btn';
        copyBtn.textContent = '复制';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(finalText.replace(/<say(?:\s+voice="\w+")?\s*>[\s\S]*?<\/say>/g, '').trim());
          copyBtn.textContent = '已复制';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
        });
        streamContent.appendChild(copyBtn);
        // Save to session — 用 sendSid，防止会话切换时存到错误的 session
        if (currentSession?.id === sendSid) {
          currentSession.messages.push({ role: 'ai', content: finalText, engine: 'gpt', timestamp: new Date().toISOString() });
          saveCurrentSession();
          notifyIfHidden(finalText);
        } else {
          // 用户已切换会话，把回复存入原会话
          (async () => {
            try {
              const bg = await window.pi.sessionLoad(sendSid);
              if (bg) {
                bg.messages.push({ role: 'ai', content: finalText, engine: 'gpt', timestamp: new Date().toISOString() });
                await window.pi.sessionSave(bg);
              }
            } catch (e) { console.warn('[GPT save] bg session save failed:', e); }
          })();
        }
        // 共享容器，不需要同步
      }
    } catch (err) {
      if (aborted || claudeRouted) return;
      streamContent.querySelector('.streaming-cursor')?.remove();
      if (!streamText) streamContent.textContent = `GPT 错误: ${err.message}`;
    } finally {
      if (!claudeRouted) {
        gptSt.onDelta = null; // 刀 2: 清掉 bus delta 路由
        abortCurrentRequest = null;
        input.disabled = false;
        restoreBtn();
        input.focus();
      }
    }
  } else {
    // ── Codex: 聊天模式 + 🗣手口分离 ──
    let aborted = false;
    const st = _getUIState(sendSid);
    if (queueInsteadOfInterrupt) {
      st.queuedSends.push({
        input,
        container: messagesContainer,
        options: {
          text,
          displayText,
          titleText,
          preparedFullMessage: fullMessage,
          attachments: [..._attachmentsPreview],
        },
      });
      _renderActivityCurrent(sendSid, st.lastText || '继续思考中');
      return;
    }
    st.voiceEventCount = 0;
    st.status = 'running';
    if (!st.activityEl) createV2ActivityForSession(sendSid, currentSession?.id === sendSid ? messagesContainer : _activityStage);
    if (currentSession?.id === sendSid) applyUIStateFor(sendSid);
    // 取 sendSid 对应 session 元数据，避免背景发送时偷用 currentSession 的 threadId/model/permissionLevel
    const _sendSession = currentSession?.id === sendSid
      ? currentSession
      : ((await window.pi.sessionLoad(sendSid)) || {});
    abortCurrentRequest = () => {
      aborted = true;
      st.queuedSends = [];
      if (sendSid) { try { window.pi.sessionBusInterrupt(sendSid); } catch {} }
      finishV2Activity(sendSid);
      addMessage(messagesContainer, 'ai', '已停止');
      input.disabled = false;
      btn.disabled = false;
      restoreBtn();
      input.focus();
    };
    const retryCodexAfterThreadReset = async () => {
      _setVisibleThreadIdForSession(sendSid, null);
      await patchSendSession({ threadId: null });
      try { window.pi.sessionBusForget(sendSid); } catch {}
      _renderActivityCurrent(sendSid, '会话断开，正在重连');
      let retryMsg = fullMessage;
      if (_sendSession.messages?.length > 0) {
        const recent = _sendSession.messages.slice(-8);
        const history = recent.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.substring(0, 300)}`).join('\n');
        retryMsg = `[之前的对话记录]\n${history}\n\n[当前消息]\n${fullMessage}`;
      }
      await window.pi.sessionBusEnsure(sendSid, 'codex');
      return await window.pi.sessionBusSend(sendSid, retryMsg, {
        engine: 'codex',
        model: _sendSession.model || currentModel,
        permissionLevel: _sendSession.permissionLevel || 'full',
      });
    };
    try {
      await window.pi.sessionBusEnsure(sendSid, 'codex', {
        codexThreadId: _sendSession.threadId || null,
      });
      const result = await window.pi.sessionBusSend(sendSid, fullMessage, {
        engine: 'codex',
        model: _sendSession.model || currentModel,
        permissionLevel: _sendSession.permissionLevel || 'full',
      });
      if (aborted) return;
      if (result?.aborted) return;

      if (result.error) {
        // thread 过期时自动重置并重试，注入最近对话历史保持上下文
        if (isRecoverableCodexThreadError(result.error)) {
          const retry = await retryCodexAfterThreadReset();
          if (!retry.error && !retry.aborted) {
            const nextThreadId = retry.codexThreadId || null;
            if (st.queuedSends.length === 0) finishV2Activity(sendSid);
            else _renderActivityCurrent(sendSid, '继续处理已排队消息');
            _setVisibleThreadIdForSession(sendSid, nextThreadId);
            addAI(retry.content, { threadId: nextThreadId });
            const { say } = parseCodexResponse(retry.content);
            if ((st.voiceEventCount || 0) === 0 && say) playTTS(say);
          } else if (!retry.aborted) {
            if (st.queuedSends.length === 0) finishV2Activity(sendSid);
            else _renderActivityCurrent(sendSid, '继续处理已排队消息');
            addAI(`错误: ${retry.error}`);
          }
        } else {
          if (st.queuedSends.length === 0) finishV2Activity(sendSid);
          else _renderActivityCurrent(sendSid, '继续处理已排队消息');
          addAI(`错误: ${result.error}`);
        }
      } else {
        const nextThreadId = result.codexThreadId || _sendSession.threadId || null;
        if (st.queuedSends.length === 0) finishV2Activity(sendSid);
        else _renderActivityCurrent(sendSid, '继续处理已排队消息');
        _setVisibleThreadIdForSession(sendSid, nextThreadId);
        addAI(result.content, { threadId: nextThreadId });
        const { say } = parseCodexResponse(result.content);
        if ((st.voiceEventCount || 0) === 0 && say) playTTS(say);
      }
    } catch (err) {
      if (aborted) return;
      // Session 过期也可能作为 exception 抛出
      if (err.message && isRecoverableCodexThreadError(err.message)) {
        const retry = await retryCodexAfterThreadReset();
        if (!retry.error && !retry.aborted) {
          const nextThreadId = retry.codexThreadId || null;
          if (st.queuedSends.length === 0) finishV2Activity(sendSid);
          else _renderActivityCurrent(sendSid, '继续处理已排队消息');
          _setVisibleThreadIdForSession(sendSid, nextThreadId);
          addAI(retry.content, { threadId: nextThreadId });
          const { say } = parseCodexResponse(retry.content);
          if ((st.voiceEventCount || 0) === 0 && say) playTTS(say);
        } else if (!retry.aborted) {
          if (st.queuedSends.length === 0) finishV2Activity(sendSid);
          else _renderActivityCurrent(sendSid, '继续处理已排队消息');
          addAI(`错误: ${retry.error}`);
        }
      } else {
        if (st.queuedSends.length === 0) finishV2Activity(sendSid);
        else _renderActivityCurrent(sendSid, '继续处理已排队消息');
        addAI(`连接失败: ${err.message}`);
      }
    } finally {
      abortCurrentRequest = null;
      input.disabled = false;
      restoreBtn();
      if (!aborted && st.queuedSends.length > 0) {
        _drainQueuedCodexSend(sendSid);
      }
    }
  }

  input.focus();
}

function isURL(text) {
  // 支持 http://, https://, www., localhost:port, IP:port
  if (/^(https?:\/\/|www\.)/.test(text)) return true;
  if (/^localhost(:\d+)?(\/.*)?$/.test(text)) return true;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/.*)?$/.test(text)) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}(\/.*)?$/.test(text) && !text.includes(' ');
}

// === 模式切换 ===
window.pi.onModeChange((mode) => {
  currentMode = mode;
  // 快捷小窗回调
  if (window.pi._onModeChangeOnce) {
    const cb = window.pi._onModeChangeOnce;
    window.pi._onModeChangeOnce = null;
    setTimeout(cb, 50);
  }
  // tab-bar(40) + topbar(44) = 84px; 聊天模式只有 topbar(44)
  const hasTabBar = mode === 'browser' || mode === 'chat-with-tabs';
  document.documentElement.style.setProperty('--topbar-offset', hasTabBar ? '88px' : '48px');
  if (btnBackToBrowser) btnBackToBrowser.style.display = 'none';
  if (mode === 'browser') {
    chatFullscreen.classList.remove('active');
    sidebar.style.display = 'flex';
    sidebarCollapsed = false;
    addressBar.style.display = 'flex';
    tabBar.style.display = 'flex';
    topbarTitle.style.display = 'none';
    sidebarExpand.style.display = 'none';
    // 浏览器模式：隐藏会话侧边栏，显示所有导航按钮
    sessionSidebarOpen = false;
    sessionSidebar.classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
    window.pi.sessionSidebarClose();
    // 移动共享消息容器到 sidebar
    moveChatMessagesTo('sidebar');
    btnPin.style.display = 'none';
    btnGoBack.style.display = '';
    btnGoForward.style.display = '';
    btnReload.style.display = '';
    btnBookmark.style.display = '';
    // 询问 Pi 按钮：浏览器模式始终可见（Atlas 风格）
    if (btnAskPi) { btnAskPi.style.display = ''; btnAskPi.textContent = '询问 Pi'; btnAskPi.title = '询问 Pi (Cmd+Shift+.)'; }
  } else if (mode === 'chat-with-tabs') {
    chatFullscreen.classList.add('active');
    sidebar.style.display = 'none';
    moveChatMessagesTo('fullscreen');
    addressBar.style.display = 'flex';
    tabBar.style.display = 'flex';
    topbarTitle.style.display = 'none';
    sidebarExpand.style.display = 'none';
    findBar.style.display = 'none';
    // chat-with-tabs：隐藏会话侧边栏
    sessionSidebarOpen = false;
    sessionSidebar.classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
    window.pi.sessionSidebarClose();
    btnPin.style.display = 'none';
    btnGoBack.style.display = '';
    btnGoForward.style.display = '';
    btnReload.style.display = '';
    btnBookmark.style.display = '';
    // 询问 Pi：全屏聊天时显示，点击回到浏览器
    if (btnAskPi) { btnAskPi.style.display = ''; btnAskPi.textContent = '回到浏览器'; btnAskPi.title = '回到浏览器 (Cmd+Shift+.)'; }
  } else {
    chatFullscreen.classList.add('active');
    sidebar.style.display = 'none';
    moveChatMessagesTo('fullscreen');
    addressBar.style.display = 'flex';
    tabBar.style.display = 'none';
    topbarTitle.style.display = 'none';
    sidebarExpand.style.display = 'none';
    findBar.style.display = 'none';
    // 聊天模式：恢复会话侧边栏，清除页面上下文
    if (sessionSidebarOpen) {
      sessionSidebar.classList.remove('collapsed');
      document.body.classList.add('sidebar-open');
    }
    pageContext = null;
    if (pageContextBar) pageContextBar.style.display = 'none';
    btnPin.style.display = 'none';
    btnGoBack.style.display = 'none';
    btnGoForward.style.display = 'none';
    btnReload.style.display = 'none';
    btnBookmark.style.display = 'none';
    // 顶栏按钮：隐藏（纯聊天无标签页，没有浏览器可回）
    if (btnAskPi) btnAskPi.style.display = 'none';
  }
});

// === 导航状态 ===
window.pi.onNavState((state) => {
  btnGoBack.disabled = !state.canGoBack;
  btnGoForward.disabled = !state.canGoForward;
});

window.pi.onLoading((loading) => {
  if (loading) {
    loadingBar.classList.add('active');
  } else {
    loadingBar.classList.remove('active');
  }
});

// 加载失败提示
window.pi.onLoadError((err) => {
  appendMessage('system', `⚠️ 页面加载失败: ${err.error} (${err.code})\n${err.url}`);
});

btnGoBack.addEventListener('click', () => window.pi.goBack());
btnGoForward.addEventListener('click', () => window.pi.goForward());
btnReload.addEventListener('click', () => window.pi.reload());

// 置顶当前 tab
let currentActiveTabId = null;
btnPin.addEventListener('click', () => {
  if (currentActiveTabId != null) window.pi.pinTab(currentActiveTabId);
});

// === Tab 更新 ===
let cachedTabs = [];
window.pi.onTabsUpdated((tabs) => {
  cachedTabs = tabs;
  // 记录活跃 tab ID，用于从全屏返回浏览器
  const active = tabs.find(t => t.active);
  if (active) _lastActiveTabId = active.id;
  tabList.innerHTML = '';
  // 置顶的排前面
  const sorted = [...tabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  sorted.forEach(tab => {
    if (tab.active) currentActiveTabId = tab.id;
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.active ? ' active' : '') + (tab.pinned ? ' pinned' : '');
    // Favicon
    const faviconHtml = tab.favicon
      ? `<img class="tab-favicon" src="${tab.favicon}" onerror="this.outerHTML='&lt;svg class=&quot;tab-favicon&quot; width=&quot;16&quot; height=&quot;16&quot; viewBox=&quot;0 0 16 16&quot; fill=&quot;none&quot;&gt;&lt;circle cx=&quot;8&quot; cy=&quot;8&quot; r=&quot;6.5&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.2&quot;/&gt;&lt;ellipse cx=&quot;8&quot; cy=&quot;8&quot; rx=&quot;3&quot; ry=&quot;6.5&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.2&quot;/&gt;&lt;line x1=&quot;1.5&quot; y1=&quot;8&quot; x2=&quot;14.5&quot; y2=&quot;8&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.2&quot;/&gt;&lt;/svg&gt;'">`
      : '';
    if (tab.isHome) {
      // Home tab: house icon, no close
      el.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="pointer-events:none;"><path d="M3 13V7l5-4 5 4v6H9V9H7v4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    } else if (tab.pinned) {
      // Pinned: only favicon, no title, no close
      el.innerHTML = faviconHtml || `<span class="tab-title" style="max-width:20px;">${escapeHtml((tab.title || 'P')[0])}</span>`;
    } else {
      el.innerHTML = `${faviconHtml}<span class="tab-title">${escapeHtml(tab.title || 'New Tab')}</span><button class="tab-close" data-id="${tab.id}">×</button>`;
    }
    el.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) window.pi.switchTab(tab.id);
    });
    // Right-click → native context menu (不被 BrowserView 遮挡)
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.pi.showTabMenu(tab.id, e.clientX, e.clientY);
    });
    const closeBtn = el.querySelector('.tab-close');
    if (closeBtn) closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.pi.closeTab(tab.id);
    });
    // 拖拽排序
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(tab.id));
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('tab-dragging'), 0);
    });
    el.addEventListener('dragend', () => el.classList.remove('tab-dragging'));
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('tab-drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('tab-drag-over');
      const dragId = parseInt(e.dataTransfer.getData('text/plain'));
      if (!isNaN(dragId) && dragId !== tab.id) window.pi.reorderTab(dragId, tab.id);
    });
    tabList.appendChild(el);
  });
});

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}


// Tab 右键菜单
function showTabContextMenu(tab, x, y) {
  // 移除已有菜单
  document.querySelectorAll('.tab-context-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.innerHTML = `
    <div class="ctx-item" data-action="pin">${tab.pinned ? '取消置顶' : '置顶标签页'}</div>
    <div class="ctx-item" data-action="duplicate">复制标签页</div>
    <div class="ctx-item ctx-separator" data-action="close">关闭</div>
    <div class="ctx-item" data-action="close-others">关闭其他</div>
  `;
  document.body.appendChild(menu);
  menu.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      if (action === 'pin') window.pi.pinTab(tab.id);
      else if (action === 'duplicate') window.pi.newTab(tab.url);
      else if (action === 'close') window.pi.closeTab(tab.id);
      else if (action === 'close-others') {
        cachedTabs.forEach(t => { if (t.id !== tab.id && !t.pinned) window.pi.closeTab(t.id); });
      }
      menu.remove();
    });
  });
  // 点击其他地方关闭
  setTimeout(() => {
    document.addEventListener('click', function handler() {
      menu.remove();
      document.removeEventListener('click', handler);
    });
  }, 0);
}

// === URL 导航 ===
window.pi.onNavigate(async (url) => {
  // 内部页面显示友好名称
  if (/127\.0\.0\.1:17891\/home|localhost:17891\/home/i.test(url)) {
    urlInput.value = 'PiOS Home';
  } else {
    urlInput.value = url;
  }
  // Home / 内部页面：强制清掉 pageContext，避免旧 tab 的页面残留在 chip 和 prompt 注入里
  if (/pios-home|127\.0\.0\.1:17891|localhost:17891/i.test(url)) {
    pageContext = null;
    if (pageContextBar) pageContextBar.style.display = 'none';
  }
  // 更新书签按钮状态
  try {
    const bookmarks = await window.pi.bookmarksList();
    btnBookmark.textContent = bookmarks.some(b => b.url === url) ? '★' : '☆';
  } catch {}
});

// === 页面上下文自动感知 ===
const quickActions = document.getElementById('quick-actions');

function updatePageContextPill(ctx) {
  if (!pageContextBar) return;
  const isInternal = ctx && /pios-home|localhost:17891|127\.0\.0\.1:17891/i.test(ctx.url || '');
  if (ctx && ctx.title && !isInternal) {
    pageContextTitle.textContent = ctx.title;
    // favicon
    const faviconUrl = ctx.favicon || (ctx.url ? `https://www.google.com/s2/favicons?domain=${new URL(ctx.url).hostname}&sz=32` : '');
    [pageContextFavicon, pageContextCardFavicon].forEach(el => {
      if (!el) return;
      if (faviconUrl) { el.src = faviconUrl; el.style.display = 'inline-block'; el.onerror = () => { el.style.display = 'none'; }; }
      else el.style.display = 'none';
    });
    // card
    if (pageContextCardTitle) pageContextCardTitle.textContent = ctx.title;
    if (pageContextCardDomain && ctx.url) {
      try { pageContextCardDomain.textContent = new URL(ctx.url).hostname; } catch { pageContextCardDomain.textContent = ''; }
    }
    if (privacyLock) privacyLock.style.display = 'none';
    pageContextBar.style.display = 'inline-flex';
  } else {
    pageContextBar.style.display = 'none';
  }
}

window.pi.onPageContext((ctx) => {
  pageContext = ctx;
  updatePageContextPill(ctx);
});

// 关闭注入：清除 pageContext，隐藏 pill
const pageContextCloseBtn = document.getElementById('page-context-close');
if (pageContextCloseBtn) {
  pageContextCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pageContext = null;
    if (pageContextBar) pageContextBar.style.display = 'none';
  });
}

// === 隐私控制 ===
const incognitoToggle = document.getElementById('incognito-toggle');
const privacySiteToggle = document.getElementById('privacy-site-toggle');
let currentPrivacyInvisible = false;
let currentIncognito = false;

// Listen for privacy status from main process
window.pi.onPrivacyStatus((status) => {
  currentPrivacyInvisible = status.invisible;
  currentIncognito = status.incognito;
  updatePrivacyUI();
});

function updatePrivacyUI() {
  // Lock icon in page context bar
  if (privacyLock) {
    privacyLock.style.display = currentPrivacyInvisible ? 'inline' : 'none';
  }
  // Incognito button state
  if (incognitoToggle) {
    incognitoToggle.classList.toggle('active', currentIncognito);
    incognitoToggle.textContent = currentIncognito ? '🕶' : '👁';
    incognitoToggle.title = currentIncognito ? '隐身模式开启中' : '隐身模式';
  }
  // Site toggle button
  if (privacySiteToggle) {
    privacySiteToggle.classList.toggle('active', currentPrivacyInvisible && !currentIncognito);
    privacySiteToggle.textContent = currentPrivacyInvisible ? '🔒' : '🔓';
    privacySiteToggle.title = currentPrivacyInvisible ? '此站点 AI 不可见' : '此站点 AI 可见';
  }
  // Body class for incognito mode styling
  document.body.classList.toggle('incognito-active', currentIncognito);
  // Hide quick actions when invisible
  if (currentPrivacyInvisible) {
    if (quickActions) quickActions.style.display = 'none';
    if (pageContextBar) {
      pageContextTitle.textContent = '私密';
      pageContextBar.style.display = 'inline-flex';
      if (privacyLock) privacyLock.style.display = 'inline';
    }
  }
}

// Incognito toggle
if (incognitoToggle) {
  incognitoToggle.addEventListener('click', async () => {
    currentIncognito = !currentIncognito;
    await window.pi.privacyIncognito(currentIncognito);
    updatePrivacyUI();
  });
}

// Per-site toggle
if (privacySiteToggle) {
  privacySiteToggle.addEventListener('click', async () => {
    // Get current URL from address bar
    const urlInput = document.getElementById('url-input');
    const url = urlInput ? urlInput.value : '';
    if (!url) return;
    try {
      const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname;
      if (currentPrivacyInvisible && !currentIncognito) {
        await window.pi.privacyRemove(hostname);
      } else if (!currentIncognito) {
        await window.pi.privacyAdd(hostname);
      }
      // Re-check status
      const invisible = await window.pi.privacyCheck(url.startsWith('http') ? url : 'https://' + url);
      currentPrivacyInvisible = invisible;
      updatePrivacyUI();
    } catch {}
  });
}

// Privacy panel rendering
async function renderPrivacyPanel() {
  const domainList = document.getElementById('privacy-domain-list');
  const emptyNotice = document.getElementById('panel-empty-privacy');
  const incognitoCheckbox = document.getElementById('panel-incognito-toggle');
  const addInput = document.getElementById('privacy-add-input');
  const addBtn = document.getElementById('privacy-add-btn');

  // Incognito checkbox
  const isIncognito = await window.pi.privacyIncognito();
  if (incognitoCheckbox) incognitoCheckbox.checked = isIncognito;

  // Domain list
  const domains = await window.pi.privacyList();
  if (!domainList) return;

  if (domains.length === 0) {
    domainList.innerHTML = '';
    if (emptyNotice) emptyNotice.style.display = 'block';
    return;
  }
  if (emptyNotice) emptyNotice.style.display = 'none';
  domainList.innerHTML = domains.map(d => `
    <div class="privacy-domain-item">
      <span>🔒 ${d}</span>
      <button class="privacy-domain-remove" data-domain="${d}" title="移除">✕</button>
    </div>
  `).join('');

  // Remove buttons
  domainList.querySelectorAll('.privacy-domain-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.pi.privacyRemove(btn.dataset.domain);
      await renderPrivacyPanel();
    });
  });

  // Add domain
  if (addBtn && addInput) {
    addBtn.onclick = async () => {
      const domain = addInput.value.trim();
      if (domain) {
        await window.pi.privacyAdd(domain);
        addInput.value = '';
        await renderPrivacyPanel();
      }
    };
    addInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) addBtn.click();
    };
  }

  // Incognito toggle in panel
  if (incognitoCheckbox) {
    incognitoCheckbox.onchange = async () => {
      await window.pi.privacyIncognito(incognitoCheckbox.checked);
      currentIncognito = incognitoCheckbox.checked;
      updatePrivacyUI();
    };
  }
}

// ── Talk to Pi（从 Home 页面触发，进入常驻主会话） ──
window.pi.onTalkToPi(async (text) => {
  // 默认进主会话，不新建
  if (!currentSession || currentSession.id !== MAIN_SESSION_ID) {
    await loadSession(MAIN_SESSION_ID);
  }
  setEngine('auto');
  exitWelcomeState();
  chatInput.value = text;
  sendMessage(chatInput, chatMessages);
});

// ── Call Pi（Home Things Need You 右上角按钮）——
// 每次都开一条新会话（不进 pi-main），title = NYC:{filename}，归到 "Things Need You" 分组。
// browser 模式（Home 是 BrowserView）：拉出右边栏，不切全屏聊天，消息走 sidebarInput。
// 其它模式兜底到 chatInput。
const CALL_PI_GROUP_NAME = 'Things Need You';
window.pi.onCallPi(async ({ text, title, engine }) => {
  await createSession();
  // title：显式设（不 substring，长了让 UI 自己 ellipsis），要在 sendMessage 之前保存
  // 否则 sendMessage 的首条消息逻辑会读到空 title 然后拿消息首行填——守卫已加，但这里
  // 还是要保证 currentSession.title 已经是 TNY:xxx。
  if (currentSession && title) {
    currentSession.title = title;
    try { await window.pi.sessionSave(currentSession); } catch {}
    _updateSessionIndicator(currentSession);
  }
  // 归到 "Things Need You" 分组（找不到就新建一次，后续复用）
  try {
    const groups = await window.pi.groupsList();
    let tnyGroup = (groups || []).find(g => g.name === CALL_PI_GROUP_NAME);
    if (!tnyGroup) tnyGroup = await window.pi.groupCreate(CALL_PI_GROUP_NAME);
    if (tnyGroup && currentSession) {
      // 关键：同步把 groupId 写到 in-memory currentSession。否则后续任何
      // saveCurrentSession 都会用 groupId=undefined 的 session 对象覆盖（尽管 backend
      // merge 会用 prev.groupId 兜底，但这里主动同步，避免 race）
      currentSession.groupId = tnyGroup.id;
      await window.pi.sessionSetGroup(currentSession.id, tnyGroup.id);
      try { await window.pi.sessionSave(currentSession); } catch {}
    }
  } catch (e) { console.warn('[call-pi] group assign failed:', e); }

  setEngine(engine || 'claude');
  exitWelcomeState();

  const useSidebar = (currentMode === 'browser');
  if (useSidebar && sidebarCollapsed) expandSidebar();

  const input = useSidebar ? sidebarInput : chatInput;
  const messages = useSidebar ? sidebarMessages : chatMessages;
  input.value = text;
  // 关键：显式锚定 targetSessionId = 刚建的新会话 id，不让 sendMessage 内部
  // `sendSid = currentSession?.id` 捕获时受任何 race 影响（2026-04-22 跨 session 串台教训）
  const targetSid = currentSession?.id;
  sendMessage(input, messages, targetSid ? { targetSessionId: targetSid } : undefined);
  renderSessionList();
});

// ── Pi 主动说话（系统事件 or 全局气泡，main.js 已保存到主会话，renderer 只负责显示） ──
window.pi.onPiProactive(async (msg) => {
  const text = msg.text || '';
  if (!text) return;
  // handlePiEvent 的后台任务留档带 silent:true —— 不在 Talk to Pi 里弹泡，那是活动流不是对话
  if (msg.silent === true) { renderSessionList(); return; }

  // 如果当前就在主会话，直接显示新消息
  if (currentSession && currentSession.id === MAIN_SESSION_ID) {
    exitWelcomeState();
    // 气泡对话会带 userText
    if (msg.userText) addMessage(chatMessages, 'user', msg.userText);
    addMessage(chatMessages, 'ai', text, { engine: msg.engine || 'gpt', model: msg.model || null });
    const updated = await window.pi.sessionLoad(MAIN_SESSION_ID);
    if (updated) currentSession = updated;
  }
  renderSessionList();
});

// Task session 打开（tick 8 重写）：把所有 stateful 副作用（polling、setRunning、
// banner 设置）全部删掉，简化成"只调 loadSession"。从 PiOS Home 点和从会话列表
// 点走完全相同的代码路径，状态由 sessions:list → store 这条数据流被动驱动。
window.pi.onSessionOpen(async (sessionId, engine) => {
  if (engine) setEngine(engine);
  if (currentMode === 'browser' || currentMode === 'chat-with-tabs') {
    sidebar.style.display = 'flex';
    sidebarExpand.style.display = 'none';
    sidebarCollapsed = false;
  }
  await loadSession(sessionId);
  sidebarMessages.scrollTop = sidebarMessages.scrollHeight;
  // 不再 polling，不再手动 setRunning，不再操作 banner。
  // running 状态由 sessions:list 同步进 store；banner 由 applyUIStateFor 触发的
  // updateLiveBanner 读 currentSession.origin + store.running 决定。
});

// tick 8: banner 从读 _uiStates.taskId 改成读 currentSession.origin + store.running。
// 这意味着两条入口（loadSession 和 onSessionOpen）走完全相同的状态来源 ——
// session 是不是 task origin 由 sessions.json 的 origin 字段决定（持久），
// 是不是正在跑由 store 决定（短暂）。两者都由数据流驱动，没有 stateful 副作用。
function updateLiveBanner() {
  let banner = document.getElementById('live-session-banner');
  if (!currentSession) { if (banner) banner.style.display = 'none'; return; }

  const ensureBanner = () => {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'live-session-banner';
    const inputArea = document.getElementById('sidebar-input-area');
    if (inputArea) inputArea.parentElement.insertBefore(banner, inputArea);
    else { const parent = sidebarMessages.parentElement; parent.insertBefore(banner, sidebarMessages); }
    return banner;
  };

  // 刀 3: readonly 优先 —— 远程 / 老 run 的 session 不能 send
  const st = _uiStates.get(currentSession.id);
  const readonly = st?.readonly;
  if (readonly) {
    const b = ensureBanner();
    // 橙色调，和 running 蓝色区分（色盲安全）
    b.style.cssText = 'padding:8px 16px;background:rgba(255,140,66,0.10);border-bottom:1px solid rgba(255,140,66,0.25);font-size:12px;color:#ff8c42;text-align:center;flex-shrink:0;';
    if (readonly.reason === 'remote') {
      b.innerHTML = `<b>🔒 远程任务</b> —— 运行在 <b>${readonly.host}</b>，本机只读（发消息不生效；要接管请 SSH 到 ${readonly.host}）`;
    } else {
      b.innerHTML = `<b>🔒 只读</b> —— ${readonly.message || '此 session 不支持插话'}`;
    }
    b.style.display = 'block';
    // 输入框也 disable
    if (chatInput) chatInput.placeholder = readonly.reason === 'remote' ? '远程任务只读' : '此 session 只读';
    if (sidebarInput) sidebarInput.placeholder = readonly.reason === 'remote' ? '远程任务只读' : '此 session 只读';
    return;
  }

  // 正在跑的 task session：蓝色 running 提示
  const isTaskRunning = currentSession.origin === 'task'
    && _sessionListStore.get(currentSession.id)?.running;
  if (isTaskRunning) {
    const taskId = currentSession.taskId || currentSession.id;
    const b = ensureBanner();
    b.style.cssText = 'padding:8px 16px;background:rgba(74,158,255,0.12);border-bottom:1px solid rgba(74,158,255,0.2);font-size:12px;color:#4a9eff;text-align:center;flex-shrink:0;';
    b.innerHTML = `<span style="animation:pulse 1.5s ease infinite;display:inline-block">●</span> 后台任务进行中 — <b>${taskId}</b>（直接发消息可接管）`;
    b.style.display = 'block';
    // 恢复 placeholder
    if (chatInput) chatInput.placeholder = 'Talk to Pi...';
    if (sidebarInput) sidebarInput.placeholder = 'Talk to Pi...';
  } else {
    if (banner) banner.style.display = 'none';
    if (chatInput) chatInput.placeholder = 'Talk to Pi...';
    if (sidebarInput) sidebarInput.placeholder = 'Talk to Pi...';
  }
}

// 页面上下文清除已在 onModeChange 的 chat 分支中处理

// === 页面内搜索 ===
window.pi.onShowFind(() => {
  findBar.style.display = 'flex';
  findInput.value = '';
  findInput.focus();
});

findInput.addEventListener('input', () => {
  window.pi.findInPage(findInput.value);
});

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    findBar.style.display = 'none';
    window.pi.findInPage('');
  }
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    window.pi.findInPage(findInput.value);
  }
});

findClose.addEventListener('click', () => {
  findBar.style.display = 'none';
  window.pi.findInPage('');
});

// === 书签（地址栏☆按钮）===
btnBookmark.addEventListener('click', async () => {
  const url = urlInput.value;
  if (!url) return;
  const activeTab = cachedTabs.find(t => t.active);
  const title = (activeTab && activeTab.title) || url;
  if (btnBookmark.textContent === '★') {
    // 已收藏 → 取消收藏
    await window.pi.bookmarksRemove(url);
    btnBookmark.textContent = '☆';
  } else {
    await window.pi.bookmarksAdd({ title, url });
    btnBookmark.textContent = '★';
  }
});

// === 面板（书签/历史/下载）===
const panelOverlay = document.getElementById('panel-overlay');
const panelClose = document.getElementById('panel-close');
const panelTabs = document.querySelectorAll('.panel-tab');
const btnPanel = document.getElementById('btn-panel');
const bookmarksList = document.getElementById('bookmarks-list');
const historyList = document.getElementById('history-list');
const downloadsList = document.getElementById('downloads-list');
let downloadRecords = [];

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff/60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)} 小时前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

async function openPanel(tab) {
  window.pi.panelOpen(); // 隐藏 BrowserView，否则 native 层遮挡面板
  panelOverlay.style.display = 'flex';
  panelTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.panel-section').forEach(s => s.classList.remove('active'));
  document.getElementById(`panel-${tab}`).classList.add('active');

  if (tab === 'bookmarks') await renderBookmarks();
  if (tab === 'history') await renderHistory();
  if (tab === 'downloads') renderDownloads();
  if (tab === 'privacy') await renderPrivacyPanel();
  if (tab === 'pios') await renderPiOSPanel();
}

function closePanel() {
  panelOverlay.style.display = 'none';
  window.pi.panelClose(); // 恢复 BrowserView
}

async function renderBookmarks() {
  const bookmarks = await window.pi.bookmarksList();
  const empty = document.getElementById('panel-empty-bookmarks');
  if (bookmarks.length === 0) {
    bookmarksList.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  bookmarksList.innerHTML = bookmarks.map(b => `
    <div class="panel-item" data-url="${escapeHtml(b.url)}">
      <span class="panel-item-title">${escapeHtml(b.title)}</span>
      <span class="panel-item-url">${escapeHtml(b.url)}</span>
      <button class="panel-item-delete" data-url="${escapeHtml(b.url)}" title="删除">✕</button>
    </div>
  `).join('');
  bookmarksList.querySelectorAll('.panel-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('panel-item-delete')) return;
      window.pi.navigate(el.dataset.url);
      closePanel();
    });
  });
  bookmarksList.querySelectorAll('.panel-item-delete').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.pi.bookmarksRemove(el.dataset.url);
      await renderBookmarks();
    });
  });
}

async function renderHistory() {
  const history = await window.pi.historyList();
  const empty = document.getElementById('panel-empty-history');
  const clearBtn = document.getElementById('history-clear-btn');
  if (history.length === 0) {
    historyList.innerHTML = '';
    empty.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'block';

  // 按日期分组：今天 / 昨天 / 更早
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  const groups = { '今天': [], '昨天': [], '更早': [] };
  for (const h of history) {
    const dStr = new Date(h.visited).toDateString();
    if (dStr === todayStr) groups['今天'].push(h);
    else if (dStr === yesterdayStr) groups['昨天'].push(h);
    else groups['更早'].push(h);
  }

  let html = '';
  for (const [label, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    html += `<div class="history-date-group">${label}</div>`;
    html += items.map(h => `
      <div class="panel-item" data-url="${escapeHtml(h.url)}">
        <span class="panel-item-title">${escapeHtml(h.title)}</span>
        <span class="panel-item-time">${formatTime(h.visited)}</span>
        <button class="panel-item-delete" data-url="${escapeHtml(h.url)}" title="删除">✕</button>
      </div>
    `).join('');
  }
  historyList.innerHTML = html;

  historyList.querySelectorAll('.panel-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('panel-item-delete')) return;
      window.pi.navigate(el.dataset.url);
      closePanel();
    });
  });
  historyList.querySelectorAll('.panel-item-delete').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.pi.historyRemove(el.dataset.url);
      await renderHistory();
    });
  });
}

function renderDownloads() {
  const empty = document.getElementById('panel-empty-downloads');
  if (downloadRecords.length === 0) {
    downloadsList.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  downloadsList.innerHTML = downloadRecords.map(d => `
    <div class="panel-item">
      <span class="panel-item-title">${escapeHtml(d.name)}</span>
      <span class="panel-item-time">${formatTime(d.time)}</span>
    </div>
  `).join('');
}

btnPanel.addEventListener('click', () => openPanel('bookmarks'));
panelClose.addEventListener('click', closePanel);
panelOverlay.addEventListener('click', (e) => {
  if (e.target === panelOverlay) closePanel();
});
panelTabs.forEach(tab => {
  tab.addEventListener('click', () => openPanel(tab.dataset.tab));
});

// 清空历史按钮
document.getElementById('history-clear-btn')?.addEventListener('click', async () => {
  await window.pi.historyClear();
  await renderHistory();
});

// Cmd+Y 打开历史
window.pi.onShowHistory(() => openPanel('history'));
// Cmd+D 书签提示
window.pi.onBookmarkPrompt(async (data) => {
  await window.pi.bookmarksAdd(data);
  btnBookmark.textContent = '★';
  setTimeout(() => { btnBookmark.textContent = '☆'; }, 2000);
});

// === 下载通知 ===
window.pi.onDownload((info) => {
  downloadRecords.unshift({ name: info.name, path: info.path, time: new Date().toISOString() });
  downloadToast.textContent = `下载完成: ${info.name}`;
  downloadToast.style.display = 'block';
  setTimeout(() => { downloadToast.style.display = 'none'; }, 4000);
});

// === 终端上下文 ===
window.pi.onTerminalContext((text) => {
  terminalContext = text;
  terminalBanner.style.display = 'flex';
  const input = currentMode === 'chat' ? chatInput : sidebarInput;
  input.focus();
});

// === 事件绑定 ===
sendBtn.addEventListener('click', () => sendMessage(chatInput, chatMessages));
// sidebarSend hidden — mic button toggles to send when input has text
const sidebarMicSend = document.querySelector('.sidebar-mic-send');
if (sidebarMicSend) {
  // 输入变化时切换 🎤 ↔ ↑
  sidebarInput.addEventListener('input', () => {
    if (sidebarInput.value.trim()) {
      sidebarMicSend.textContent = '↑';
      sidebarMicSend.title = '发送';
      sidebarMicSend.classList.add('send-mode');
    } else {
      sidebarMicSend.textContent = '🎤';
      sidebarMicSend.title = '按住说话';
      sidebarMicSend.classList.remove('send-mode');
    }
  });
  // 点击时：有文字→发送，无文字→录音
  sidebarMicSend.addEventListener('click', () => {
    if (sidebarInput.value.trim()) {
      sendMessage(sidebarInput, sidebarMessages);
      sidebarMicSend.textContent = '🎤';
      sidebarMicSend.title = '按住说话';
      sidebarMicSend.classList.remove('send-mode');
    }
    // 无文字时走原有的 mic 录音逻辑（mic-btn class 已绑定）
  });
}

// Sidebar + 按钮菜单
const sidebarPlusBtn = document.getElementById('sidebar-plus-btn');
const sidebarPlusMenu = document.getElementById('sidebar-plus-menu');
if (sidebarPlusBtn && sidebarPlusMenu) {
  sidebarPlusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebarPlusMenu.style.display = sidebarPlusMenu.style.display === 'none' ? 'block' : 'none';
  });
  sidebarPlusMenu.querySelectorAll('.plus-item').forEach(item => {
    item.addEventListener('click', async () => {
      sidebarPlusMenu.style.display = 'none';
      const action = item.dataset.action;
      if (action === 'attach') {
        pickAndAttach();
      } else if (action === 'screenshot') {
        const btn = document.getElementById('sidebar-screenshot');
        if (btn) btn.click();
      } else if (action === 'agent') {
        agentMode = !agentMode;
        if (agentMode) setEngine('claude');
        updateAgentUI();
      } else if (action === 'search') {
        sidebarInput.value = '搜索：';
        sidebarInput.focus();
      } else if (action === 'engine') {
        // 子菜单处理，不在这里关闭 + 菜单
        return;
      } else if (action === 'tts') {
        const tts = document.getElementById('sidebar-tts');
        if (tts) tts.checked = !tts.checked;
        const mainTts = document.getElementById('tts-enabled');
        if (mainTts) mainTts.checked = !mainTts.checked;
        const status = document.getElementById('sidebar-tts-status');
        if (status) status.textContent = (tts?.checked) ? '✓' : '';
      } else if (action === 'clean') {
        cleanMode = !cleanMode;
        updateCleanModeUI();
        if (cleanMode) { createSession(); exitWelcomeState(); }
      } else if (action === 'clear-history') {
        if (!currentSession) return;
        if (!confirm('确定清空当前会话的所有聊天记录？此操作不可恢复。')) return;
        currentSession.messages = [];
        currentSession.threadId = null;
        currentSession.claudeSessionId = null;
        clearChat();
        window.pi.resetGPT();
        enterWelcomeState();
        await window.pi.sessionSave(currentSession);
        renderSessionList();
      }
    });
  });
  document.addEventListener('click', () => { sidebarPlusMenu.style.display = 'none'; });

  // 引擎子菜单
  document.querySelectorAll('.plus-engine-opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      setEngine(opt.dataset.eng);
      document.querySelectorAll('.plus-engine-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      sidebarPlusMenu.style.display = 'none';
    });
  });
}

// Fullscreen: mic/send toggle
const chatMicSend = document.querySelector('.chat-mic-send');
if (chatMicSend) {
  chatInput.addEventListener('input', () => {
    if (chatInput.value.trim()) {
      chatMicSend.textContent = '↑';
      chatMicSend.title = '发送';
      chatMicSend.classList.add('send-mode');
    } else {
      chatMicSend.textContent = '🎤';
      chatMicSend.title = '按住说话';
      chatMicSend.classList.remove('send-mode');
    }
  });
  chatMicSend.addEventListener('click', () => {
    if (chatInput.value.trim()) {
      sendMessage(chatInput, chatMessages);
      chatMicSend.textContent = '🎤';
      chatMicSend.title = '按住说话';
      chatMicSend.classList.remove('send-mode');
    }
  });
}

// Fullscreen + menu
const chatPlusBtn = document.getElementById('chat-plus-btn');
const chatPlusMenu = document.getElementById('chat-plus-menu');
if (chatPlusBtn && chatPlusMenu) {
  chatPlusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chatPlusMenu.style.display = chatPlusMenu.style.display === 'none' ? 'block' : 'none';
  });
  chatPlusMenu.querySelectorAll('.plus-item').forEach(item => {
    item.addEventListener('click', async () => {
      chatPlusMenu.style.display = 'none';
      const action = item.dataset.action;
      if (action === 'attach') { pickAndAttach(); }
      else if (action === 'screenshot') { document.getElementById('screenshot-btn')?.click(); }
      else if (action === 'agent') { agentMode = !agentMode; if (agentMode) setEngine('claude'); updateAgentUI(); }
      else if (action === 'engine') return; // submenu handles
      else if (action === 'tts') {
        const tts = document.getElementById('tts-enabled');
        if (tts) tts.checked = !tts.checked;
        const s = document.getElementById('chat-tts-status');
        if (s) s.textContent = tts?.checked ? '✓' : '';
      } else if (action === 'clean') {
        cleanMode = !cleanMode;
        updateCleanModeUI();
        if (cleanMode) { createSession(); exitWelcomeState(); }
      } else if (action === 'clear-history') {
        if (!currentSession) return;
        if (!confirm('确定清空当前会话的所有聊天记录？此操作不可恢复。')) return;
        currentSession.messages = [];
        currentSession.threadId = null;
        currentSession.claudeSessionId = null;
        clearChat();
        window.pi.resetGPT();
        enterWelcomeState();
        await window.pi.sessionSave(currentSession);
        renderSessionList();
      }
    });
  });
  chatPlusMenu.querySelectorAll('.plus-engine-opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      setEngine(opt.dataset.eng);
      chatPlusMenu.querySelectorAll('.plus-engine-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      chatPlusMenu.style.display = 'none';
    });
  });
  document.addEventListener('click', () => { chatPlusMenu.style.display = 'none'; });
}

// Stop buttons
const chatStopBtn = document.getElementById('chat-stop-btn');
const sidebarStopBtn = document.getElementById('sidebar-stop-btn');

chatInput.addEventListener('keydown', (e) => {
  // IME 守卫：打中文拼音时 Enter 用于选候选词，别抢走送消息
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendMessage(chatInput, chatMessages);
  }
});

sidebarInput.addEventListener('keydown', (e) => {
  // IME 守卫：同 chatInput
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendMessage(sidebarInput, sidebarMessages);
  }
});

// 自动调整输入框高度
[chatInput, sidebarInput].forEach(input => {
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  });
});

// ── 图片输入：粘贴 / 拖拽 / 文件选择 ──
const _TEXT_EXT_R = new Set(['txt','md','js','ts','jsx','tsx','py','go','java','c','cpp','h','css','html','json','yaml','yml','sh','rb','rs','kt','swift','toml','ini','env','csv','xml']);

function handleImageFile(file) {
  if (!file) return;
  const name = file.name || `image-${Date.now()}.png`;
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'png';
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    pendingAttachments.push({ name, ext, size: file.size || 0, isImage: true, base64, content: null, filePath: null, isPDF: false });
    renderAttachmentChips();
  };
  reader.readAsDataURL(file);
}

async function handleNonImageFile(file) {
  if (!file) return;
  const name = file.name || 'file';
  const filePath = file.path || null; // Electron exposes file.path for drag-drop; empty for paste
  // Always use main process: supports PDF text extraction regardless of path availability
  const reader = new FileReader();
  reader.onload = async () => {
    const arrayBuffer = reader.result;
    if (filePath && window.pi.processFilePaths) {
      // Path available (drag-drop): let main read from disk
      const results = await window.pi.processFilePaths([filePath]);
      if (results && results.length) {
        pendingAttachments.push(...results);
        renderAttachmentChips();
        return;
      }
    }
    // No path (paste) or path failed: send buffer to main
    if (window.pi.parseFileBuffer) {
      const result = await window.pi.parseFileBuffer(name, arrayBuffer);
      if (result) {
        pendingAttachments.push(result);
        renderAttachmentChips();
        return;
      }
    }
    // Final fallback
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    pendingAttachments.push({ name, ext, size: file.size, isImage: false, isPDF: ext === 'pdf', content: null, base64: null, filePath });
    renderAttachmentChips();
  };
  reader.readAsArrayBuffer(file);
}

// 粘贴（Cmd+V）：图片 + 文件
[chatInput, sidebarInput].forEach(input => {
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let handled = false;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        handled = true;
        if (file.type.startsWith('image/')) {
          handleImageFile(file);
        } else {
          handleNonImageFile(file);
        }
      }
    }
  });
});

// 拖拽：图片 + 任意文件
[chatInputArea, sidebarInputArea].forEach(area => {
  if (!area) return;
  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.style.outline = '2px dashed var(--accent)';
    area.style.outlineOffset = '-2px';
  });
  area.addEventListener('dragleave', () => {
    area.style.outline = '';
    area.style.outlineOffset = '';
  });
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.style.outline = '';
    area.style.outlineOffset = '';
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        handleImageFile(file);
      } else {
        handleNonImageFile(file);
      }
    }
  });
});

// 地址栏
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    window.pi.navigate(urlInput.value);
  }
});

// 回到聊天模式（侧边栏展开按钮）
const btnExpandChat = document.getElementById('btn-expand-chat');
if (btnExpandChat) {
  btnExpandChat.addEventListener('click', () => {
    syncSidebarToMain();
    window.pi.backToChat();
  });
}

// 全屏聊天 → 回到浏览器/侧边栏模式
const btnBackToBrowser = document.getElementById('btn-back-to-browser');
let _lastActiveTabId = null;

if (btnBackToBrowser) {
  btnBackToBrowser.addEventListener('click', () => {
    // 切换回最后活跃的标签页（触发 browser 模式）
    if (_lastActiveTabId) {
      window.pi.switchTab(_lastActiveTabId);
    } else {
      // 没有记录的 tab，打开 PiOS Home
      window.pi.navigate('http://127.0.0.1:17891/home');
    }
  });
}

// syncSidebarToMain / restoreSidebarMessages 不再需要（共享容器）
function syncSidebarToMain() {}
function restoreSidebarMessages() {}

// 新标签页按钮
newTabBtn.addEventListener('click', () => {
  window.pi.newTab();
});

// 对话 session 管理按钮（左侧边栏里的 +）
document.getElementById('new-session-btn')?.addEventListener('click', async () => {
  await createSession();
  showWelcome();
});

// 侧边栏折叠/展开
function collapseSidebar() {
  if (currentMode !== 'browser' && currentMode !== 'chat-with-tabs') return;
  sidebar.style.display = 'none';
  sidebarCollapsed = true;
  window.pi.sidebarCollapse();
}

function expandSidebar() {
  if (currentMode !== 'browser' && currentMode !== 'chat-with-tabs') return;
  sidebar.style.display = 'flex';
  sidebarCollapsed = false;
  window.pi.sidebarExpand();
}

sidebarToggle.addEventListener('click', collapseSidebar);

// "询问 Pi" 按钮：Atlas 风格
if (btnAskPi) {
  btnAskPi.addEventListener('click', () => {
    if (currentMode === 'chat' || currentMode === 'chat-with-tabs') {
      // 全屏聊天 → 回到浏览器
      if (_lastActiveTabId) {
        window.pi.switchTab(_lastActiveTabId);
      } else {
        window.pi.navigate('http://127.0.0.1:17891/home');
      }
    } else if (sidebarCollapsed) {
      expandSidebar();
    } else {
      collapseSidebar();
    }
  });
}

// Sidebar ··· 菜单
const sidebarMenuBtn = document.getElementById('sidebar-menu-btn');
const sidebarMenuDropdown = document.getElementById('sidebar-menu-dropdown');
if (sidebarMenuBtn && sidebarMenuDropdown) {
  sidebarMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebarMenuDropdown.style.display = sidebarMenuDropdown.style.display === 'none' ? 'block' : 'none';
  });
  sidebarMenuDropdown.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      sidebarMenuDropdown.style.display = 'none';
      const action = item.dataset.action;
      if (action === 'sessions') {
        sessionSidebarOpen = !sessionSidebarOpen;
        sessionSidebar.classList.toggle('collapsed', !sessionSidebarOpen);
        document.body.classList.toggle('sidebar-open', sessionSidebarOpen);
        if (sessionSidebarOpen) window.pi.sessionSidebarOpen(); else window.pi.sessionSidebarClose();
      } else if (action === 'expand') { syncSidebarToMain(); window.pi.backToChat(); }
      else if (action === 'incognito') { const t = document.getElementById('incognito-toggle'); if (t) t.click(); }
      else if (action === 'privacy') { const t = document.getElementById('privacy-site-toggle'); if (t) t.click(); }
      else if (action === 'summarize' || action === 'translate') {
        const prompt = action === 'summarize' ? '请总结这个页面的内容' : '请翻译这个页面';
        if (sidebarInput) { sidebarInput.value = prompt; sidebarSend.click(); }
      }
    });
  });
  document.addEventListener('click', () => { sidebarMenuDropdown.style.display = 'none'; });
}

// Sidebar 新对话按钮
const sidebarNewChat = document.getElementById('sidebar-new-chat');
if (sidebarNewChat) {
  sidebarNewChat.addEventListener('click', async () => {
    await createSession();
    // Clear sidebar messages
    if (sidebarMessages) sidebarMessages.innerHTML = '';
  });
}

// Sidebar overlay 模式 — 窗口太窄时 sidebar 浮在内容上方
window.pi.onSidebarOverlay?.((isOverlay) => {
  sidebar.classList.toggle('overlay', isOverlay);
});

// ── 侧边栏 TTS ──
const sidebarEngineToggle = document.getElementById('sidebar-engine-toggle');
const sidebarTts = document.getElementById('sidebar-tts');

// Sidebar 会话列表按钮
const sidebarSessionsBtn = document.getElementById('sidebar-sessions-btn');
if (sidebarSessionsBtn) {
  sidebarSessionsBtn.addEventListener('click', () => {
    sessionSidebarOpen = !sessionSidebarOpen;
    sessionSidebar.classList.toggle('collapsed', !sessionSidebarOpen);
    document.body.classList.toggle('sidebar-open', sessionSidebarOpen);
    if (sessionSidebarOpen) window.pi.sessionSidebarOpen();
    else window.pi.sessionSidebarClose();
  });
}

// 会话列表关闭按钮
const sessionSidebarCloseBtn = document.getElementById('session-sidebar-close');
if (sessionSidebarCloseBtn) {
  sessionSidebarCloseBtn.addEventListener('click', () => {
    sessionSidebarOpen = false;
    sessionSidebar.classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
    window.pi.sessionSidebarClose();
  });
}

setTimeout(() => {
  const mainTts = document.getElementById('tts-enabled');
  if (sidebarTts && mainTts) {
    sidebarTts.checked = mainTts.checked;
    sidebarTts.addEventListener('change', () => { mainTts.checked = sidebarTts.checked; });
    mainTts.addEventListener('change', () => { sidebarTts.checked = mainTts.checked; });
  }
}, 0);

// 侧边栏拖拽调宽
(() => {
  const dragHandle = document.getElementById('sidebar-drag');
  if (!dragHandle) return;
  let dragging = false;
  dragHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    dragHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const maxW = Math.floor(window.innerWidth * 0.6);
    const newWidth = Math.max(200, Math.min(maxW, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px');
    window.pi.sidebarResize(newWidth);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    dragHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// Cmd+Shift+. 切换侧边栏
window.pi.onSidebarToggle(() => {
  if (currentMode === 'chat' || currentMode === 'chat-with-tabs') {
    // 全屏聊天 → 回到浏览器模式
    if (_lastActiveTabId) {
      window.pi.switchTab(_lastActiveTabId);
    } else {
      window.pi.navigate('http://127.0.0.1:17891/home');
    }
  } else if (sidebarCollapsed) {
    expandSidebar();
  } else {
    collapseSidebar();
  }
});

// Cmd+\ 切换全屏聊天
window.pi.onChatFullscreenToggle(() => {
  if (currentMode === 'chat' || currentMode === 'chat-with-tabs') {
    // 全屏聊天 → 回到浏览器模式（保持 currentSession 不变）。
    // 不能用 switchTab：它发 session:switchToTab 会把 sidebar 选的 session 换成 tab 的 ghost UUID。
    if (currentMode === 'chat-with-tabs') {
      window.pi.restoreFromFullscreen();
    } else {
      window.pi.navigate('http://127.0.0.1:17891/home');
    }
  } else {
    // 浏览器模式 → 进入全屏聊天
    window.pi.backToChat();
  }
});

// Cmd+Shift+B 切换会话列表
window.pi.onSessionSidebarToggle(() => {
  toggleSessionSidebar();
});

// Cmd+Shift+H 回到 Home
window.pi.onNavigateHome(() => {
  window.pi.navigate('http://127.0.0.1:17891/home');
});

// Cmd+P Talk to Pi（切到主会话）
window.pi.onShortcutTalkToPi(async () => {
  await loadSession(MAIN_SESSION_ID);
});

// Cmd+N 新建会话
window.pi.onNewSession(async () => {
  await createSession();
  exitWelcomeState();
});

// Cmd+Shift+K 清空会话内容
window.pi.onClearChat(() => {
  clearChat();
});

// Cmd+I 插入/解绑当前页面上下文
window.pi.onTogglePageContext(() => {
  if (pageContext) {
    // 已绑定 → 解绑
    pageContext = null;
    if (pageContextBar) pageContextBar.style.display = 'none';
  } else {
    // 未绑定 → 请求 main 注入当前 tab 页面上下文
    window.pi.requestPageContext();
  }
});

// Cmd+Shift+V 语音输入
window.pi.onVoiceToggle(() => {
  const mic = currentMode === 'browser' ? sidebarMic : micBtn;
  toggleRecording(mic);
});

// Cmd+/ 查看快捷键
window.pi.onShowShortcutHelp(() => {
  const existing = document.getElementById('shortcut-help-overlay');
  if (existing) { existing.remove(); window.pi.panelClose(); return; }
  window.pi.panelOpen(); // 移除 BrowserView 避免 native 层遮挡
  const overlay = document.createElement('div');
  overlay.id = 'shortcut-help-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `<div style="background:var(--bg-primary,#1e1e2e);border-radius:12px;padding:24px 32px;max-width:420px;width:90%;color:var(--text-primary,#cdd6f4);font-size:13px;line-height:1.8;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
    <h3 style="margin:0 0 12px;font-size:15px;">⌨️ 快捷键</h3>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="opacity:0.6">⌘\\</td><td>全屏聊天 ↔ 浏览器</td></tr>
      <tr><td style="opacity:0.6">⌘⇧B</td><td>会话列表</td></tr>
      <tr><td style="opacity:0.6">⌘⇧H</td><td>回到 Home</td></tr>
      <tr><td style="opacity:0.6">⌘P</td><td>Talk to Pi</td></tr>
      <tr><td style="opacity:0.6">⌘N</td><td>新建会话</td></tr>
      <tr><td style="opacity:0.6">⌘⇧K</td><td>清空会话</td></tr>
      <tr><td style="opacity:0.6">⌘I</td><td>插入/解绑页面</td></tr>
      <tr><td style="opacity:0.6">⌘⇧V</td><td>语音输入</td></tr>
      <tr><td style="opacity:0.6">⌘⇧.</td><td>切换侧边栏</td></tr>
      <tr><td style="opacity:0.6">⌘⇧J</td><td>快捷小窗（全局）</td></tr>
      <tr><td style="opacity:0.6">⌘J</td><td>问 Pi (页面内容)</td></tr>
      <tr><td style="opacity:0.6">⌘E</td><td>切换引擎</td></tr>
      <tr><td style="opacity:0.6">⌘K</td><td>命令面板</td></tr>
      <tr><td style="opacity:0.6">⌘L</td><td>地址栏</td></tr>
      <tr><td style="opacity:0.6">⌘T</td><td>新标签页</td></tr>
      <tr><td style="opacity:0.6">⌘W</td><td>关闭标签页</td></tr>
      <tr><td style="opacity:0.6">⌃⌘F</td><td>全屏</td></tr>
      <tr><td style="opacity:0.6">c</td><td>新建卡片（Home，交给 Pi）</td></tr>
      <tr><td style="opacity:0.6">t</td><td>新建 TODO（Home，自己做）</td></tr>
      <tr><td style="opacity:0.6">⌘/</td><td>此帮助</td></tr>
    </table>
    <p style="margin:12px 0 0;opacity:0.4;font-size:11px;">点击任意处关闭</p>
  </div>`;
  overlay.addEventListener('click', () => { overlay.remove(); window.pi.panelClose(); });
  document.body.appendChild(overlay);
});

// 快捷小窗发送 — main.js 已切到聊天模式，直接发
// 分支会话：外部可调用（Claude Code exec_js / PiOS Home）
window._forkSession = forkSession;

window._quickSend = async (text) => {
  if (!text) return;
  await createSession();
  exitWelcomeState();
  chatInput.value = text;
  sendMessage(chatInput, chatMessages);
};

// 备用：IPC 触发（保留兼容）
window.pi.onQuickInput(() => { toggleQuickInput(); });

function toggleQuickInput() {
  let bar = document.getElementById('quick-input-bar');
  if (bar) { bar.remove(); return; }
  // 半透明背景
  const overlay = document.createElement('div');
  overlay.id = 'quick-input-bar';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;justify-content:center;padding-top:15vh;';
  // 浮动输入条（Claude 风格）
  const box = document.createElement('div');
  box.style.cssText = 'width:620px;max-width:90%;background:var(--bg-light,#2a2a2a);border:1px solid var(--border,#444);border-radius:24px;padding:12px 20px;box-shadow:0 8px 40px rgba(0,0,0,0.5);display:flex;align-items:center;gap:12px;height:auto;';
  // Pi 图标
  const icon = document.createElement('span');
  icon.textContent = '✦';
  icon.style.cssText = 'font-size:20px;color:var(--accent-blue);flex-shrink:0;';
  // 输入框
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '有问题，尽管问';
  input.style.cssText = 'flex:1;background:none;border:none;color:var(--text,#fff);font-size:15px;outline:none;font-family:inherit;';
  // 发送按钮
  const send = document.createElement('button');
  send.textContent = '↑';
  send.style.cssText = 'width:32px;height:32px;border-radius:50%;border:none;background:var(--accent-blue);color:white;font-size:16px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;';
  box.appendChild(icon);
  box.appendChild(input);
  box.appendChild(send);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  input.focus();
  // 关闭
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    overlay.remove();
    // 确保聊天区可见
    chatFullscreen.classList.add('active');
    exitWelcomeState();
    chatInput.value = text;
    sendMessage(chatInput, chatMessages);
  }
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { overlay.remove(); return; }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  });
}

// Cmd+L 聚焦地址栏
window.pi.onUrlFocus(() => {
  if (urlInput) {
    urlInput.focus();
    urlInput.select();
  }
});

// Tab 切换快捷键
window.pi.onTabNext(() => {
  if (cachedTabs.length < 2) return;
  const idx = cachedTabs.findIndex(t => t.active);
  const next = cachedTabs[(idx + 1) % cachedTabs.length];
  window.pi.switchTab(next.id);
});

window.pi.onTabPrev(() => {
  if (cachedTabs.length < 2) return;
  const idx = cachedTabs.findIndex(t => t.active);
  const prev = cachedTabs[(idx - 1 + cachedTabs.length) % cachedTabs.length];
  window.pi.switchTab(prev.id);
});

window.pi.onTabSwitchByIndex((idx) => {
  if (idx === 8) {
    // Cmd+9 = 最后一个 tab
    if (cachedTabs.length > 0) window.pi.switchTab(cachedTabs[cachedTabs.length - 1].id);
  } else if (idx < cachedTabs.length) {
    window.pi.switchTab(cachedTabs[idx].id);
  }
});

// 清除终端上下文
clearContext.addEventListener('click', () => {
  terminalContext = null;
  terminalBanner.style.display = 'none';
});

// ── 快捷操作栏（使用缓存的 pageContext，秒级响应） ──
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    // 优先使用缓存的页面上下文（自动感知），fallback 到按需获取
    const page = pageContext || await window.pi.getPageContent();
    if (!page) return;

    const prompts = {
      summarize: `请用中文总结以下页面的要点（3-5个bullet point）：\n\n标题: ${page.title}\nURL: ${page.url}\n\n${page.text.substring(0, 4000)}`,
      translate: `请把以下页面内容翻译成中文（保持格式）：\n\n${page.text.substring(0, 4000)}`,
      card: `根据以下页面内容，帮我创建一张 Vault 卡片。用 YAML frontmatter 格式，包含 type/status/priority/parent/created 字段。\n\n标题: ${page.title}\nURL: ${page.url}\n\n${page.text.substring(0, 3000)}`,
      extract: `从以下页面提取关键信息（人名、公司、数字、日期、联系方式、核心观点）：\n\n标题: ${page.title}\nURL: ${page.url}\n\n${page.text.substring(0, 4000)}`,
    };

    const prompt = prompts[action];
    if (!prompt) return;

    try {
      await sendMessage(sidebarInput, sidebarMessages, {
        text: prompt,
        displayText: `[${btn.textContent.trim()}]`,
        titleText: `[${btn.textContent.trim()}]`,
      });
    } catch (err) {
      addMessage(sidebarMessages, 'ai', `失败: ${err.message}`);
    }
  });
});

// ── 状态栏 ──
const statusEngine = document.getElementById('status-engine');
const statusVoice = document.getElementById('status-voice');
const statusConn = document.getElementById('status-conn');

function updateStatusBar() {
  if (statusEngine) statusEngine.textContent = currentEngine === 'codex' ? 'Codex' : 'Claude';
  if (statusConn) { statusConn.className = 'connected'; statusConn.textContent = '●'; }
}
updateStatusBar();

// ══════════════════════════════════════════
// ── AudioQueue: 顺序播放，防重叠，支持打断 ──
// ══════════════════════════════════════════
class AudioQueue {
  constructor() {
    this._ctx = null;
    this._queue = [];       // decoded AudioBuffer[]
    this._currentSrc = null;
    this._playing = false;
    this._onIdle = null;    // callback when queue drains
  }

  async _ensureCtx() {
    if (!this._ctx) this._ctx = new AudioContext();
    if (this._ctx.state === 'suspended') await this._ctx.resume();
    return this._ctx;
  }

  get isPlaying() { return this._playing; }

  set onIdle(fn) { this._onIdle = fn; }

  async enqueue(arrayBuf) {
    if (!ttsEnabled.checked) return;
    try {
      const ctx = await this._ensureCtx();
      // decodeAudioData detaches the buffer, so copy first
      const copy = arrayBuf.slice ? arrayBuf.slice(0) : arrayBuf;
      const decoded = await ctx.decodeAudioData(copy);
      this._queue.push(decoded);
      if (!this._playing) this._playNext();
    } catch (e) { console.warn('[AudioQueue] decode failed:', e); }
  }

  async _playNext() {
    if (this._queue.length === 0) {
      const wasPlaying = this._playing;
      this._playing = false;
      this._currentSrc = null;
      if (wasPlaying) { try { window.pi?.ttsPlaybackState?.(false); } catch {} }
      if (this._onIdle) this._onIdle();
      return;
    }
    const wasPlaying = this._playing;
    this._playing = true;
    if (!wasPlaying) { try { window.pi?.ttsPlaybackState?.(true); } catch {} }
    const ctx = await this._ensureCtx();
    const buf = this._queue.shift();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => this._playNext();
    this._currentSrc = src;
    src.start();
  }

  interrupt() {
    this._queue = [];
    if (this._currentSrc) {
      try { this._currentSrc.stop(); } catch {}
      this._currentSrc = null;
    }
    const wasPlaying = this._playing;
    this._playing = false;
    if (wasPlaying) { try { window.pi?.ttsPlaybackState?.(false); } catch {} }
  }
}

const audioQueue = new AudioQueue();

// 从 main process 接收 TTS 播放/打断（全局气泡用）
window.pi.onTTSPlay((buf) => {
  if (buf && buf.byteLength > 100) audioQueue.enqueue(buf);
});
window.pi.onTTSInterrupt(() => audioQueue.interrupt());

// 通知 TTS：main 只传 text，renderer 自己本地调 voiceTTS 拿 buffer 播（和对话 TTS 同路径）
// 2026-04-19：原 main→IPC→renderer 传 buffer 的路在 onTTSPlay 检查里 skip（无声），
// 换成这条"main 只传 text"的路确保和对话 TTS 一样有声。
window.pi.onNotifySpeak(async (text) => {
  // DEBUG 埋点
  try { window.pi.debugTrace('renderer', `onNotifySpeak ENTRY text="${String(text||'').slice(0,40)}" ttsEnabled=${ttsEnabled?.checked}`); } catch {}
  if (!text || !text.trim()) {
    try { window.pi.debugTrace('renderer', 'onNotifySpeak EARLY RETURN empty text'); } catch {}
    return;
  }
  try {
    const buf = await window.pi.voiceTTS(text, 'calm');
    try { window.pi.debugTrace('renderer', `voiceTTS returned buf=${!!buf} byteLength=${buf?.byteLength} type=${buf?.constructor?.name}`); } catch {}
    if (buf && buf.byteLength > 100) {
      audioQueue.enqueue(buf);
      try { window.pi.debugTrace('renderer', 'enqueue SUCCESS'); } catch {}
    } else {
      try { window.pi.debugTrace('renderer', `enqueue SKIPPED buf=${!!buf} byteLength=${buf?.byteLength}`); } catch {}
    }
  } catch (e) {
    try { window.pi.debugTrace('renderer', `voiceTTS THREW: ${e.message}`); } catch {}
    console.warn('[notify:speak] TTS failed:', e);
  }
});

// ── Voice: Recording + ASR + TTS ──
const micBtn = document.getElementById('mic-btn');
const sidebarMic = document.getElementById('sidebar-mic');
const voiceStatus = document.getElementById('voice-status');
const sidebarVoiceStatus = document.getElementById('sidebar-voice-status');
const ttsEnabled = document.getElementById('tts-enabled');
const clearChatBtn = document.getElementById('clear-chat-btn');

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let asrProcessing = false; // 防抖：ASR 处理中禁止重复录音
let vadNode = null;        // VAD AudioWorklet
let vadStream = null;      // mic stream for VAD
let autoListenTimer = null;
let continuousMode = false; // Pi 说完后自动监听
let vadSpeechConfirmed = false; // VAD 确认有真正语音（连续 300ms+）

function setVoiceStatus(msg) {
  voiceStatus.style.display = msg ? 'block' : 'none';
  voiceStatus.textContent = msg;
  sidebarVoiceStatus.style.display = msg ? 'block' : 'none';
  sidebarVoiceStatus.textContent = msg;
}

async function startRecording(micButton, autoListen = false) {
  if (asrProcessing) return; // 防抖

  // 语音打断：用户开始说话 → 停止 TTS 播放
  if (audioQueue.isPlaying) audioQueue.interrupt();
  if (autoListenTimer) { clearTimeout(autoListenTimer); autoListenTimer = null; }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      cleanupVAD();
      stream.getTracks().forEach(t => t.stop());
      if (audioChunks.length === 0) { setVoiceStatus(''); return; }

      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const arrayBuf = await blob.arrayBuffer();

      asrProcessing = true;
      setVoiceStatus('识别中...');
      try {
        const result = await window.pi.voiceASR(new Uint8Array(arrayBuf));
        if (result && result.text && result.text.trim()) {
          setVoiceStatus('');
          const input = currentMode === 'chat' ? chatInput : sidebarInput;
          const container = currentMode === 'chat' ? chatMessages : sidebarMessages;
          // 语音触发 sendMessage，sendMessage 内部会自动打断正在运行的请求
          input.value = result.text.trim();
          continuousMode = true; // 开启连续对话
          sendMessage(input, container);
        } else {
          // 静默处理 too_short / too_quiet / hallucination（不打扰用户）
          const silent = ['too_short', 'too_quiet', 'hallucination'];
          if (result?.error && silent.includes(result.error)) {
            setVoiceStatus('');
          } else {
            setVoiceStatus(result?.error ? `识别失败: ${result.error}` : '没听清，再说一次');
            setTimeout(() => setVoiceStatus(''), 3000);
          }
          continuousMode = false;
        }
      } finally {
        asrProcessing = false;
      }
    };

    // 启动 VAD（静音自动停录 + 音量可视化）
    setupVAD(stream, micButton);

    mediaRecorder.start();
    isRecording = true;
    micButton.classList.add('recording');
    setVoiceStatus(autoListen ? '在听...' : '正在录音...');

    // 自动监听模式：2秒内没检测到真正语音就取消
    if (autoListen) {
      vadSpeechConfirmed = false;
      autoListenTimer = setTimeout(() => {
        if (isRecording && !vadSpeechConfirmed) {
          // 没检测到真正语音（连续 300ms），静默取消
          audioChunks = [];
          stopRecording(micButton);
          setVoiceStatus('');
          continuousMode = false;
        }
      }, 2000);
    }
  } catch (err) {
    setVoiceStatus('麦克风不可用: ' + err.message);
    setTimeout(() => setVoiceStatus(''), 3000);
  }
}

// ── VAD: AnalyserNode 方案（不需要 AudioWorklet）──
const VAD_THRESHOLD = 0.04;       // RMS 阈值（提高以减少噪音误触发）
const VAD_SPEECH_MIN_MS = 500;    // 连续 500ms 才算真正语音
const VAD_SILENCE_MS = 2000;      // 语音后 2s 静音 → 自动停录
let vadAnimFrame = null;

function setupVAD(stream, micButton) {
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    // 不连 destination — AnalyserNode 不需要连也能工作

    const dataArray = new Float32Array(analyser.fftSize);
    let speechStartTime = 0;
    let silenceStartTime = 0;

    function tick() {
      if (!isRecording) return;
      analyser.getFloatTimeDomainData(dataArray);

      // 计算 RMS
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
      const rms = Math.sqrt(sum / dataArray.length);

      // 音量可视化
      const scale = 1 + Math.min(rms * 15, 0.4);
      micButton.style.transform = `scale(${scale})`;

      const now = performance.now();

      if (rms > VAD_THRESHOLD) {
        silenceStartTime = 0;
        if (speechStartTime === 0) {
          speechStartTime = now;
        } else if (!vadSpeechConfirmed && (now - speechStartTime > VAD_SPEECH_MIN_MS)) {
          vadSpeechConfirmed = true;
          if (autoListenTimer) { clearTimeout(autoListenTimer); autoListenTimer = null; }
          setVoiceStatus('正在录音...');
        }
      } else {
        speechStartTime = 0;
        if (vadSpeechConfirmed) {
          if (silenceStartTime === 0) {
            silenceStartTime = now;
          } else if (now - silenceStartTime > VAD_SILENCE_MS) {
            // 2s 静音 → 自动停录
            stopRecording(micButton);
            return; // 不再 requestAnimationFrame
          }
        }
      }

      vadAnimFrame = requestAnimationFrame(tick);
    }

    vadAnimFrame = requestAnimationFrame(tick);
    vadStream = { ctx, source, analyser };
  } catch (e) {
    console.warn('[VAD] setup failed (non-critical):', e.message);
  }
}

function cleanupVAD() {
  if (vadAnimFrame) { cancelAnimationFrame(vadAnimFrame); vadAnimFrame = null; }
  if (vadStream) {
    try { vadStream.analyser.disconnect(); } catch {}
    try { vadStream.source.disconnect(); } catch {}
    try { vadStream.ctx.close(); } catch {}
    vadStream = null;
  }
  micBtn.style.transform = '';
  sidebarMic.style.transform = '';
}

function stopRecording(micButton) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  isRecording = false;
  micButton.classList.remove('recording');
}

function toggleRecording(micButton) {
  if (isRecording) {
    stopRecording(micButton);
  } else {
    startRecording(micButton);
  }
}

micBtn.addEventListener('click', () => toggleRecording(micBtn));
sidebarMic.addEventListener('click', () => toggleRecording(sidebarMic));

// Space-bar-to-talk: hold Space when not typing in an input
let spaceHeld = false;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !spaceHeld && !isInputFocused() && !asrProcessing) {
    e.preventDefault();
    spaceHeld = true;
    const mic = currentMode === 'browser' ? sidebarMic : micBtn;
    if (!isRecording) startRecording(mic);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHeld) {
    spaceHeld = false;
    const mic = currentMode === 'browser' ? sidebarMic : micBtn;
    if (isRecording) stopRecording(mic);
  }
});
function isInputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// Escape 取消一切（录音、连续对话、Codex 请求、Claude 执行）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (isRecording) {
      audioChunks = [];
      const mic = currentMode === 'browser' ? sidebarMic : micBtn;
      stopRecording(mic);
      setVoiceStatus('');
    }
    if (abortCurrentRequest) abortCurrentRequest();
    // 刀 2: Escape 走 bus interrupt 当前 session（不管是 claude/gpt/codex）
    if (currentSession?.id) window.pi.sessionBusInterrupt(currentSession.id).catch(() => {});
    continuousMode = false;
    if (autoListenTimer) { clearTimeout(autoListenTimer); autoListenTimer = null; }
    audioQueue.interrupt();
  }
});

// ── TTS: 完整 buffer 播放（通过 AudioQueue）──

// Play text via TTS API (Codex mode)
async function playTTS(text, preset) {
  if (!ttsEnabled.checked || !text || text.length < 2) return;
  try {
    const buf = await window.pi.voiceTTS(text, preset);
    if (buf && buf.byteLength > 100) audioQueue.enqueue(buf);
  } catch (e) { console.warn('[voice] TTS failed:', e); }
}

// Claude audio events → AudioQueue
window.pi.onClaudeAudio((buf) => {
  audioQueue.enqueue(buf);
});

// SessionBus v2 audio：所有 session 的语音都播
// 旧逻辑用 `sessionId === currentSession?.id` 过滤后台 session 的音频，但这会把
// 后台 task（pi-triage / sense-maker / 连续执行 agent 等）的 <say> 语音静音 —
// 派大星 bubble 依然会显示文字（_npcSpeak 是 session-agnostic），就出现"字有音没有"的割裂。
// AudioQueue 本身已经串行播放、不会叠声；让所有 session 的 <say> 统一走 Patrick 这把嗓子。
window.pi.onSessionBusAudio((sessionId, buf) => {
  try { audioQueue.enqueue(buf); } catch (e) { console.warn('[bus-audio]', e); }
});

// 连续对话：Pi 说完后延迟 800ms 再开始听（避免扬声器尾音）
// auto-listen 关闭 — 只通过手动点击或按空格录音，避免环境噪音触发幻觉
audioQueue.onIdle = () => {};

// ── 截屏功能 ──
let pendingScreenshot = null; // base64 PNG string

// ── 文件附件 ──
let pendingAttachments = []; // [{ name, ext, size, content, isImage, base64 }]
const chatAttachmentsEl = document.getElementById('chat-attachments');
const sidebarAttachmentsEl = document.getElementById('sidebar-attachments');

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(0)}KB`;
  return `${(bytes/1024/1024).toFixed(1)}MB`;
}

function fileIcon(ext) {
  const map = {
    pdf: '📄', md: '📝', txt: '📝', js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
    py: '🐍', go: '🔵', json: '📋', html: '🌐', css: '🎨', sh: '⚙️', rb: '💎',
    xlsx: '📊', xls: '📊', xlsm: '📊', ods: '📊', csv: '📊', numbers: '📊',
    docx: '📃', doc: '📃', pptx: '📑', ppt: '📑',
  };
  return map[ext] || '📄';
}

function renderAttachmentChips() {
  [chatAttachmentsEl, sidebarAttachmentsEl].forEach(el => {
    if (!el) return;
    if (!pendingAttachments.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = '';
    pendingAttachments.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      if (f.isImage) {
        chip.innerHTML = `<img class="attach-thumb" src="data:image/${f.ext};base64,${f.base64}"><span class="attach-name">${f.name}</span><span class="attach-size">${formatFileSize(f.size)}</span><button class="attach-remove" data-i="${i}">×</button>`;
        const thumbEl = chip.querySelector('.attach-thumb');
        thumbEl.style.cursor = 'pointer';
        thumbEl.addEventListener('click', (e) => {
          e.stopPropagation();
          showImageFullscreen(thumbEl.src);
        });
      } else {
        chip.innerHTML = `<span class="attach-icon">${fileIcon(f.ext)}</span><span class="attach-name">${f.name}</span><span class="attach-size">${formatFileSize(f.size)}</span><button class="attach-remove" data-i="${i}">×</button>`;
      }
      chip.querySelector('.attach-remove').addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderAttachmentChips();
      });
      el.appendChild(chip);
    });
  });
}

async function pickAndAttach() {
  const files = await window.pi.pickFiles();
  if (!files || !files.length) return;
  pendingAttachments.push(...files);
  renderAttachmentChips();
}

const screenshotBtn = document.getElementById('screenshot-btn');
const sidebarScreenshot = document.getElementById('sidebar-screenshot');
const screenshotPreview = document.getElementById('screenshot-preview');
const screenshotPreviewImg = document.getElementById('screenshot-preview-img');
const screenshotPreviewClose = document.getElementById('screenshot-preview-close');

async function captureScreenshot() {
  try {
    const result = await window.pi.screenshot();
    if (result && result.image) {
      pendingAttachments.push({ name: '截图.png', ext: 'png', size: 0, isImage: true, base64: result.image, content: null, filePath: null, isPDF: false });
      renderAttachmentChips();
    }
  } catch (e) {
    console.warn('[screenshot] failed:', e);
  }
}

screenshotBtn?.addEventListener('click', captureScreenshot);
sidebarScreenshot?.addEventListener('click', captureScreenshot);
screenshotPreviewClose?.addEventListener('click', () => {
  pendingScreenshot = null;
  screenshotPreview.style.display = 'none';
});

// ── 清空对话 ──
clearChatBtn.addEventListener('click', async () => {
  await createSession();
  showWelcome();
});

function showWelcome() {
  enterWelcomeState();
}

// ══════════════════════════════════════════
// ── Command Palette (Cmd+K) ──
// ══════════════════════════════════════════
const cmdPalette = document.getElementById('command-palette');
const cmdPaletteInput = document.getElementById('cmd-palette-input');
const cmdPaletteResults = document.getElementById('cmd-palette-results');

const COMMANDS = [
  { name: '切换引擎', key: 'Cmd+E', action: () => { const c = ['auto','gpt','claude','clean']; setEngine(c[(c.indexOf(currentEngine)+1)%c.length]); } },
  { name: '新标签页', key: 'Cmd+T', action: () => window.pi.newTab() },
  { name: '清空对话', action: () => clearChatBtn.click() },
  { name: '导出对话为 Markdown', action: () => exportChat() },
  { name: '搜索对话', key: 'Cmd+Shift+F', action: () => openChatSearch() },
  { name: '书签管理', key: 'Cmd+D', action: () => openPanel('bookmarks') },
  { name: '历史记录', key: 'Cmd+Y', action: () => openPanel('history') },
  { name: '下载记录', action: () => openPanel('downloads') },
  { name: '重置 Claude 会话', action: () => { window.pi.resetClaude(); showToast('Claude 会话已重置'); } },
  { name: '总结当前页面', action: () => { const btn = document.querySelector('[data-action="summarize"]'); if (btn) btn.click(); } },
  { name: '翻译当前页面', action: () => { const btn = document.querySelector('[data-action="translate"]'); if (btn) btn.click(); } },
  { name: 'Google 搜索...', action: () => { chatInput.focus(); chatInput.value = '/search '; } },
  { name: '打开网址...', action: () => { chatInput.focus(); chatInput.value = '/open '; } },
];

function openCommandPalette() {
  cmdPalette.style.display = 'flex';
  cmdPaletteInput.value = '';
  renderPaletteResults('');
  cmdPaletteInput.focus();
}

function closeCommandPalette() {
  cmdPalette.style.display = 'none';
}

function renderPaletteResults(query) {
  const q = query.toLowerCase();
  const filtered = q ? COMMANDS.filter(c => c.name.toLowerCase().includes(q)) : COMMANDS;
  cmdPaletteResults.innerHTML = filtered.map((c, i) => `
    <div class="cmd-result${i === 0 ? ' active' : ''}" data-idx="${i}">
      <span>${escapeHtml(c.name)}</span>
      ${c.key ? `<span class="cmd-key">${c.key}</span>` : ''}
    </div>
  `).join('');
  cmdPaletteResults._filtered = filtered;
  cmdPaletteResults._activeIdx = 0;
}

cmdPaletteInput.addEventListener('input', () => renderPaletteResults(cmdPaletteInput.value));

cmdPaletteInput.addEventListener('keydown', (e) => {
  const items = cmdPaletteResults.querySelectorAll('.cmd-result');
  let idx = cmdPaletteResults._activeIdx || 0;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = Math.min(idx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = Math.max(idx - 1, 0);
  } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    const filtered = cmdPaletteResults._filtered || [];
    if (filtered[idx]) { closeCommandPalette(); filtered[idx].action(); }
    return;
  } else if (e.key === 'Escape') {
    closeCommandPalette();
    return;
  } else { return; }
  items.forEach((el, i) => el.classList.toggle('active', i === idx));
  cmdPaletteResults._activeIdx = idx;
});

cmdPaletteResults.addEventListener('click', (e) => {
  const el = e.target.closest('.cmd-result');
  if (!el) return;
  const filtered = cmdPaletteResults._filtered || [];
  const idx = parseInt(el.dataset.idx);
  if (filtered[idx]) { closeCommandPalette(); filtered[idx].action(); }
});

cmdPalette.addEventListener('click', (e) => {
  if (e.target === cmdPalette) closeCommandPalette();
});

window.pi.onCommandPalette(() => openCommandPalette());

// ══════════════════════════════════════════
// ── Export Chat as Markdown ──
// ══════════════════════════════════════════
const exportChatBtn = document.getElementById('export-chat-btn');

function exportChat() {
  const messages = chatMessages.querySelectorAll('.message');
  if (messages.length === 0) { showToast('没有对话可导出'); return; }
  const lines = [`# Pi 对话记录\n`, `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n`];
  messages.forEach(msg => {
    const isUser = msg.classList.contains('user');
    const content = msg.querySelector('.message-content');
    const text = content ? content.innerText.trim() : '';
    lines.push(`## ${isUser ? 'You' : 'Pi'}\n`);
    lines.push(text + '\n');
  });
  const md = lines.join('\n');
  navigator.clipboard.writeText(md).then(() => {
    showToast('对话已复制到剪贴板（Markdown 格式）');
  }).catch(() => {
    // Fallback: 下载文件
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pi-chat-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    showToast('已下载对话记录');
  });
}

exportChatBtn.addEventListener('click', exportChat);

// ══════════════════════════════════════════
// ── Search in Conversation (Cmd+Shift+F) ──
// ══════════════════════════════════════════
const chatSearchBar = document.getElementById('chat-search-bar');
const chatSearchInput = document.getElementById('chat-search-input');
const chatSearchCount = document.getElementById('chat-search-count');
const chatSearchClose = document.getElementById('chat-search-close');
let chatSearchMatches = [];
let chatSearchIdx = -1;

function openChatSearch() {
  chatSearchBar.style.display = 'flex';
  chatSearchInput.value = '';
  chatSearchCount.textContent = '';
  chatSearchInput.focus();
  clearSearchHighlights();
}

function closeChatSearch() {
  chatSearchBar.style.display = 'none';
  clearSearchHighlights();
  chatSearchMatches = [];
  chatSearchIdx = -1;
}

function clearSearchHighlights() {
  chatMessages.querySelectorAll('.search-highlight').forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

function performChatSearch(query) {
  clearSearchHighlights();
  chatSearchMatches = [];
  chatSearchIdx = -1;
  if (!query.trim()) { chatSearchCount.textContent = ''; return; }

  const q = query.toLowerCase();
  // Walk text nodes in chat messages
  const walker = document.createTreeWalker(chatMessages, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.toLowerCase().includes(q)) textNodes.push(node);
  }

  textNodes.forEach(tn => {
    const text = tn.textContent;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    if (parts.length <= 1) return;
    const frag = document.createDocumentFragment();
    parts.forEach(part => {
      if (part.toLowerCase() === q) {
        const span = document.createElement('span');
        span.className = 'search-highlight';
        span.textContent = part;
        chatSearchMatches.push(span);
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    });
    tn.parentNode.replaceChild(frag, tn);
  });

  chatSearchCount.textContent = chatSearchMatches.length > 0
    ? `${chatSearchMatches.length} 个匹配`
    : '无匹配';

  if (chatSearchMatches.length > 0) {
    chatSearchIdx = 0;
    chatSearchMatches[0].classList.add('active');
    chatSearchMatches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

chatSearchInput.addEventListener('input', () => performChatSearch(chatSearchInput.value));

chatSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeChatSearch(); return; }
  if (e.key === 'Enter' && chatSearchMatches.length > 0 && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    if (chatSearchMatches[chatSearchIdx]) chatSearchMatches[chatSearchIdx].classList.remove('active');
    chatSearchIdx = (chatSearchIdx + (e.shiftKey ? -1 : 1) + chatSearchMatches.length) % chatSearchMatches.length;
    chatSearchMatches[chatSearchIdx].classList.add('active');
    chatSearchMatches[chatSearchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    chatSearchCount.textContent = `${chatSearchIdx + 1}/${chatSearchMatches.length}`;
  }
});

chatSearchClose.addEventListener('click', closeChatSearch);
window.pi.onChatSearch(() => openChatSearch());

// ══════════════════════════════════════════
// ── Desktop Notifications ──
// ══════════════════════════════════════════
function notifyIfHidden(text) {
  // 对话回复不发系统通知
}

// ══════════════════════════════════════════
// ── Toast Notification Helper ──
// ══════════════════════════════════════════
const toastNotify = document.getElementById('toast-notify');

function showToast(msg, duration = 3000) {
  toastNotify.textContent = msg;
  toastNotify.style.display = 'block';
  setTimeout(() => { toastNotify.style.display = 'none'; }, duration);
}

// ── 主题切换 ──
const THEMES = ['dark', 'light', 'navy'];
const THEME_LABELS = { dark: '🌙', light: '☀️', navy: '🌊' };
const themeToggleBtn = document.getElementById('theme-toggle-btn');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pi-theme', theme);
  if (themeToggleBtn) themeToggleBtn.textContent = THEME_LABELS[theme] || '🌓';
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next);
}

themeToggleBtn?.addEventListener('click', cycleTheme);

// 恢复上次主题
const savedTheme = localStorage.getItem('pi-theme');
if (savedTheme && THEMES.includes(savedTheme)) setTheme(savedTheme);

// 启动：加载对话历史（Home tab 由 main.js tryCreateHomeTabs 创建）
(async () => {
  // 确保常驻主会话存在
  let mainSession = await window.pi.sessionLoad(MAIN_SESSION_ID);
  if (!mainSession) {
    mainSession = {
      id: MAIN_SESSION_ID,
      title: 'Talk to Pi',
      engine: 'auto',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      threadId: null,
      claudeSessionId: null,
      messages: [],
      isMain: true,
    };
    await window.pi.sessionSave(mainSession);
  }

  // 加载 active session；没有则加载主会话
  try {
    const activeId = await window.pi.sessionGetActive();
    if (activeId) {
      await loadSession(activeId);
    } else {
      await loadSession(MAIN_SESSION_ID);
      enterWelcomeState();
    }
  } catch {
    await loadSession(MAIN_SESSION_ID);
    enterWelcomeState();
  }

  // 安全检查：如果聊天区没有消息，强制显示欢迎页
  setTimeout(() => {
    const msgs = chatMessages.querySelectorAll('.message');
    if (msgs.length === 0) enterWelcomeState();
  }, 200);
})();

// ── PiOS Home ───────────────────────────────────────

// PiOS Home 相关变量和函数已移到独立页面 (http://127.0.0.1:17891/home)

// Home button → navigate to PiOS Home page (served by HTTP API)
document.getElementById('btn-pios-home')?.addEventListener('click', () => {
  window.pi.navigate('http://127.0.0.1:17891/home');
});

// ── PiOS Panel ──────────────────────────────────────

let piosActiveView = 'decisions';

// 子 tab 切换
document.querySelectorAll('.pios-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    piosActiveView = btn.dataset.view;
    document.querySelectorAll('.pios-subtab').forEach(b => b.classList.toggle('active', b.dataset.view === piosActiveView));
    document.querySelectorAll('.pios-view').forEach(v => v.classList.toggle('active', v.id === `pios-view-${piosActiveView}`));
  });
});

function formatSchedule(cron) {
  if (!cron) return '';
  if (cron.startsWith('*/')) return `every ${cron.split(' ')[0].slice(2)}min`;
  const parts = cron.split(' ');
  const h = parts[1], m = parts[0];
  const days = parts[4];
  let time = `${h}:${m.padStart(2, '0')}`;
  if (days === '*') return time;
  const dayMap = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };
  const dayStr = days.split(',').map(d => dayMap[d] || d).join('/');
  return `${dayStr} ${time}`;
}

async function renderPiOSPanel() {
  const emptyEl = document.getElementById('panel-empty-pios');
  try {
    const overview = await window.pi.piosOverview();
    if (!overview) { emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';

    // Stats
    document.getElementById('pios-stats').innerHTML = `
      <div class="pios-stat">
        <div class="pios-stat-value">${overview.agents.total}</div>
        <div class="pios-stat-label">Agents (${overview.agents.active} active)</div>
      </div>
      <div class="pios-stat">
        <div class="pios-stat-value">${overview.cards.active}</div>
        <div class="pios-stat-label">Cards (${overview.cards.inbox} inbox)</div>
      </div>
      <div class="pios-stat">
        <div class="pios-stat-value" style="color: ${overview.cards.ownerQueue > 0 ? 'var(--accent)' : 'var(--text)'}">${overview.cards.ownerQueue}</div>
        <div class="pios-stat-label">Review</div>
      </div>
    `;

    // Agents view
    renderPiOSAgents(overview.agents.list);

    // Projects view
    renderPiOSProjects(overview.projects);

    // Owner Queue view (replaces Decisions)
    renderOwnerQueue(overview.ownerQueue || []);

    // Plugins view
    renderPiOSPlugins(overview.plugins || []);

    // Runtimes view (load separately from credentials.json)
    window.pi.piosRuntimes().then(renderPiOSRuntimes).catch(() => renderPiOSRuntimes([]));

    // Restore active sub-tab
    document.querySelectorAll('.pios-subtab').forEach(b => b.classList.toggle('active', b.dataset.view === piosActiveView));
    document.querySelectorAll('.pios-view').forEach(v => v.classList.toggle('active', v.id === `pios-view-${piosActiveView}`));
  } catch (e) {
    console.error('[PiOS] render failed:', e);
    emptyEl.style.display = 'block';
    emptyEl.textContent = 'PiOS Engine error: ' + e.message;
  }
}

function renderPiOSAgents(agents) {
  const container = document.getElementById('pios-view-agents');
  container.innerHTML = agents.map(a => `
    <div class="pios-agent-item" data-agent="${a.id}">
      <span class="pios-agent-dot ${a.status}"></span>
      <span class="pios-agent-name">${a.display_name}</span>
      <span class="pios-agent-schedule">${formatSchedule(a.schedule)}</span>
      <button class="pios-agent-toggle ${a.status === 'active' ? 'on' : ''}" data-agent="${a.id}" data-status="${a.status}" title="${a.status === 'active' ? 'Pause' : 'Activate'}">${a.status === 'active' ? 'ON' : 'OFF'}</button>
      <button class="pios-agent-chat" data-agent="${a.id}" title="Talk to ${a.display_name}">Chat</button>
    </div>
  `).join('');

  // Toggle agent status
  container.querySelectorAll('.pios-agent-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const agentId = btn.dataset.agent;
      const newStatus = btn.dataset.status === 'active' ? 'paused' : 'active';
      await window.pi.piosUpdateAgentStatus(agentId, newStatus);
      await renderPiOSPanel();
    });
  });

  // Talk to agent — close panel, switch to chat with agent context
  container.querySelectorAll('.pios-agent-chat').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const agentId = btn.dataset.agent;
      const workspace = await window.pi.piosAgentWorkspace(agentId);
      if (!workspace) return;
      closePanel();
      // Inject agent context into chat input
      const input = document.getElementById('sidebar-input') || document.getElementById('chat-input');
      if (input) {
        input.value = `[Agent: ${workspace.display_name}] `;
        input.focus();
      }
    });
  });
}

function renderPiOSProjects(projects) {
  const container = document.getElementById('pios-view-projects');
  if (projects.length === 0) {
    container.innerHTML = '<div class="panel-empty">No projects</div>';
    return;
  }
  container.innerHTML = projects.map(p => {
    const pct = p.progress.total > 0 ? Math.round((p.progress.done / p.progress.total) * 100) : 0;
    return `
      <div class="pios-project-item">
        <div class="pios-project-header">
          <span class="pios-project-title">${p.title}</span>
          <span class="pios-project-count">${p.progress.done}/${p.progress.total}</span>
        </div>
        <div class="pios-progress-bar">
          <div class="pios-progress-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderOwnerQueue(items) {
  const container = document.getElementById('pios-view-decisions');
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="panel-empty">All clear. Nothing needs your attention.</div>';
    return;
  }

  const badgeLabel = { alert: '系统告警', respond: '需要回复', act: '需要操作', check: '需要验收' };

  container.innerHTML = items.map(d => {
    const staleClass = d.staleDays > 5 ? ' overdue' : '';
    const staleText = d.staleDays > 0 ? `${d.staleDays}d` : '';
    return `
    <div class="pios-queue-item" data-card="${d.filename}" data-type="${d.queueType}">
      <span class="pios-queue-badge" data-type="${d.queueType}">${badgeLabel[d.queueType] || d.reason}</span>
      <div style="flex:1;min-width:0">
        <div class="pios-queue-title">${d.title}</div>
        <div class="pios-queue-brief">${d.brief || ''}</div>
      </div>
      ${staleText ? `<span class="pios-queue-stale${staleClass}">${staleText}</span>` : ''}
      <span class="pios-queue-arrow">\u203A</span>
    </div>`;
  }).join('');

  // 点击展开详情 + 按类型渲染不同操作
  container.querySelectorAll('.pios-queue-item').forEach(el => {
    el.addEventListener('click', async () => {
      const filename = el.dataset.card;
      const queueType = el.dataset.type;

      // 折叠已展开的
      const existing = el.querySelector('.pios-queue-detail');
      if (existing) { existing.remove(); return; }
      container.querySelectorAll('.pios-queue-detail').forEach(d => d.remove());

      const card = await window.pi.piosReadCard(filename);
      if (!card) return;

      const detail = document.createElement('div');
      detail.className = 'pios-queue-detail';

      const contentHtml = `<div class="pios-queue-content">${card.content.substring(0, 600).replace(/\n/g, '<br>')}</div>`;
      let actionsHtml = '';

      if (queueType === 'respond') {
        actionsHtml = `
          <div class="pios-queue-actions">
            <input class="pios-queue-input" type="text" placeholder="回复内容..." />
            <button class="pios-queue-btn primary" data-action="respond-text">回复</button>
            <button class="pios-queue-btn ghost" data-action="defer">延期</button>
          </div>`;
      } else if (queueType === 'act') {
        const pr = card.frontmatter && card.frontmatter.permission_request;
        if (pr && pr.agent && pr.rule) {
          actionsHtml = `
            <div class="pios-queue-actions">
              <div class="pios-queue-brief" style="font-size:12px;color:var(--text-muted);margin-bottom:6px">⚡ 写入 <code>${pr.agent}</code> allow 规则：<code>${pr.rule}</code></div>
              <button class="pios-queue-btn primary" data-action="approve-permission">⚡ 批准并写入</button>
              <button class="pios-queue-btn ghost" data-action="defer">延期</button>
            </div>`;
        } else {
          actionsHtml = `
            <div class="pios-queue-actions">
              <button class="pios-queue-btn primary" data-action="done">✓ 已完成</button>
              <button class="pios-queue-btn ghost" data-action="defer">延期</button>
            </div>`;
        }
      } else if (queueType === 'check') {
        actionsHtml = `
          <div class="pios-queue-actions">
            <input class="pios-queue-input" type="text" placeholder="要修说明（驳回/通过可不填）..." />
            <button class="pios-queue-btn primary" data-action="approve">✓ 通过</button>
            <button class="pios-queue-btn warn" data-action="rework">要修</button>
            <button class="pios-queue-btn ghost" data-action="reject">驳回</button>
          </div>`;
      } else if (queueType === 'alert') {
        actionsHtml = `
          <div class="pios-queue-actions">
            <button class="pios-queue-btn primary" data-action="done">知道了</button>
            <button class="pios-queue-btn ghost" data-action="defer3">+3d</button>
          </div>`;
      }

      detail.innerHTML = contentHtml + actionsHtml;
      el.appendChild(detail);

      const input = detail.querySelector('.pios-queue-input');
      if (input) input.focus();

      // 按钮事件
      detail.querySelectorAll('.pios-queue-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const inputVal = input ? input.value.trim() : '';

          if (action === 'respond-text') {
            if (!inputVal) { input.style.borderColor = 'var(--accent)'; return; }
            await window.pi.piosRespondToOwner(filename, inputVal, { response_type: 'text' });
          } else if (action === 'done') {
            await window.pi.piosResolveDecision(filename, 'Owner completed action');
          } else if (action === 'approve') {
            await window.pi.piosRespondToOwner(filename, 'accept', { comment: inputVal || '' });
          } else if (action === 'rework') {
            if (!inputVal) { input.style.borderColor = 'var(--accent)'; input.placeholder = '说明要修什么...'; return; }
            await window.pi.piosRespondToOwner(filename, 'fix: ' + inputVal);
          } else if (action === 'reject') {
            await window.pi.piosRespondToOwner(filename, 'reject', { comment: inputVal || '' });
          } else if (action === 'approve-permission') {
            btn.disabled = true;
            btn.textContent = '写入中...';
            const result = await window.pi.piosApprovePermission(filename);
            if (result.ok) {
              btn.textContent = `已写入 ✓ (${result.rule})`;
            } else {
              btn.textContent = `写入失败: ${result.error}`;
              btn.style.opacity = '0.5';
              btn.disabled = false;
              return;
            }
          } else if (action === 'archive') {
            await window.pi.piosMoveCard(filename, 'archive');
          } else if (action === 'defer') {
            const until = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
            await window.pi.piosDeferCard(filename, until);
          } else if (action === 'defer3') {
            const until = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
            await window.pi.piosDeferCard(filename, until);
          } else if (action === 'defer7') {
            const until = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
            await window.pi.piosDeferCard(filename, until);
          }
          await renderPiOSPanel();
        });
      });

      // Enter 键提交
      if (input) {
        input.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
            e.stopPropagation();
            const primaryBtn = detail.querySelector('.pios-queue-btn.primary');
            if (primaryBtn) primaryBtn.click();
          }
        });
      }

      detail.addEventListener('click', (e) => e.stopPropagation());
    });
  });
}

// ── PiOS Setup Wizard ───────────────────────────────

// ── 光球孵化仪式（v0.1 无语音版） ─────────────────────
// 见 Cards/active/pios-hatching-onboarding.md
// v0.1：纯视觉 + 文字问答，不调 qwen-tts / _npcSpeak / pios:talk（Claude 还没登录）

const _HATCHING_NPC_META = {
  doraemon: { zh: '多啦A梦',   greet: '你好，我是多啦A梦。我们一起开始吧！' },
  patrick:  { zh: '派大星',     greet: '嗨嗨嗨！我是派大星！你叫啥名字呀？' },
  starlet:  { zh: '星仔',       greet: '嗨，我是星仔。准备好了吗？' },
  baymax:   { zh: '大白',       greet: '你好。我是大白，你的个人伴侣。' },
  kirby:    { zh: '卡比',       greet: '哈！我是卡比！' },
  totoro:   { zh: '龙猫',       greet: '嗷呜——（我是龙猫）' },
  slime:    { zh: '史莱姆',     greet: '嗨，我是史莱姆，请多关照！' },
  minion:   { zh: '小黄人',     greet: 'Banana! 我是小黄人！' },
  peppa:    { zh: '小猪佩奇',   greet: '你好，我是佩奇，这是我的 PiOS。' },
  shinchan: { zh: '蜡笔小新',   greet: '嘿嘿，我是小新。' },
  nailong:  { zh: '奶龙',       greet: '嗨，我是奶龙！' },
  trump:    { zh: 'Trump',      greet: "Hello, I'm Trump. Let's make your PiOS great." },
};
const _HATCHING_NPC_ORDER = ['doraemon','patrick','starlet','baymax','kirby','totoro','slime','minion','peppa','shinchan','nailong','trump'];

async function runHatchingCeremony() {
  const stage = document.getElementById('hatching-stage');
  if (!stage) return null;
  stage.hidden = false;

  const panels = {};
  stage.querySelectorAll('.hatching-panel').forEach(p => panels[p.dataset.panel] = p);
  const show = (name) => {
    Object.entries(panels).forEach(([k, el]) => { el.hidden = (k !== name); });
  };

  // ── Voice layer (v0.1: 系统 TTS + 浏览器 ASR，零依赖；v0.2 再接 _npcSpeak) ──
  let voiceOn = true; // 孵化进入时 deps 已装完 + qwen 已 ready（IIFE 顺序保证），所以默认 ON 走 qwen
  // 孵化 NPC 的声音不在前端硬编码，由 main.js 的 pios:qwen-tts-wav IPC 内部
  // 从 characters.yaml 查 NPC voice —— 保证孵化预览和 Home 里 Pi 说话用同一套音色
  let _hatchingNpc = null; // pickPanel 选中后设置，qwenSpeak 用它作 npcId 让 main 查 voice
  const voiceToggleBtn = document.getElementById('hatching-voice-toggle');
  const voiceOnLabel   = voiceToggleBtn.querySelector('.hatching-voice-on');
  const voiceOffLabel  = voiceToggleBtn.querySelector('.hatching-voice-off');
  const refreshVoiceToggle = () => {
    voiceToggleBtn.setAttribute('aria-pressed', String(voiceOn));
    voiceOnLabel.hidden  = !voiceOn;
    voiceOffLabel.hidden = voiceOn;
  };
  voiceToggleBtn.onclick = () => {
    voiceOn = !voiceOn;
    refreshVoiceToggle();
    if (!voiceOn && window.speechSynthesis) window.speechSynthesis.cancel();
  };
  refreshVoiceToggle();

  // 挑一个中文系统声音（macOS 常见：Ting-Ting / Mei-Jia / 美嘉）
  const pickVoice = () => {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    return voices.find(v => /zh-CN|zh_CN|cmn-Hans|Ting-Ting|Mei-Jia|美嘉|婷婷/i.test(v.lang + ' ' + v.name))
        || voices.find(v => /^zh/i.test(v.lang))
        || voices[0] || null;
  };
  // Safari/Chromium 首次 voices list 是空的，getVoices 在 voiceschanged 事件后才填
  if (window.speechSynthesis) {
    try { window.speechSynthesis.getVoices(); } catch (_) {}
    window.speechSynthesis.onvoiceschanged = () => { /* 触发一次即可 */ };
  }
  // 优先走 qwen-voice（owner 同款音色）；失败再 fallback webkit speechSynthesis（mac say）
  let _audioEl = null;
  let _hatchingTtsKilled = false; // 用户进 Q&A 后置 true；in-flight qwenSpeak 即使返回也不创建 Audio
  // 停掉所有正在播的孵化期 TTS——进 Q&A 时调，防止 NPC 试听 greet 拖到 askText 时还在响
  function _stopHatchingTts() {
    _hatchingTtsKilled = true;
    try { if (_audioEl) { _audioEl.pause(); _audioEl.currentTime = 0; _audioEl = null; } } catch {}
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
  }
  async function qwenSpeak(text) {
    if (!text) return false;
    if (_hatchingTtsKilled) return false; // 已进 Q&A 阶段，不要再播
    // 传 npcId 让 main 从 characters.yaml 查 voice（和 Home 里 Pi 说话用同一个 voice）
    let r;
    try { r = await window.pi.qwenTtsWav({ text, npcId: _hatchingNpc }); }
    catch { return false; }
    if (_hatchingTtsKilled) return false; // qwen 返回时已被 stop，丢弃 audio
    if (!r || !r.ok || !r.audio_b64) return false;
    return new Promise((resolve) => {
      try {
        if (_hatchingTtsKilled) { resolve(false); return; }
        if (_audioEl) { try { _audioEl.pause(); } catch {} }
        _audioEl = new Audio(`data:audio/wav;base64,${r.audio_b64}`);
        _audioEl.onended = () => resolve(true);
        _audioEl.onerror = () => resolve(true);
        _audioEl.play().catch(() => resolve(true));
        // 兜底超时
        setTimeout(() => resolve(true), Math.min(15000, Math.max(2000, text.length * 250)));
      } catch { resolve(true); }
    });
  }
  const speakTts = async (text) => {
    if (!voiceOn || !text) return;
    // 先 qwen
    const ok = await qwenSpeak(text);
    if (ok) return;
    // qwen 不可用 → fallback webkit（即 mac say）
    if (!window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'zh-CN';
      u.rate = 1.0; u.pitch = 1.0;
      window.speechSynthesis.speak(u);
      await new Promise((res) => {
        u.onend = () => res();
        u.onerror = () => res();
        setTimeout(res, Math.min(8000, Math.max(1200, text.length * 200)));
      });
    } catch {}
  };

  // ASR（webkitSpeechRecognition），可能没有权限/不存在 → 静默失败
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let recognizing = false;
  const micBtn = () => document.getElementById('hatching-chat-mic');
  const micStatus = () => document.getElementById('hatching-mic-status');
  const setMicStatus = (text) => {
    const el = micStatus();
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
  };
  const startAsr = (onResult) => {
    if (!SR) { setMicStatus('当前环境不支持语音输入，请打字'); return false; }
    if (recognizing) return false;
    try {
      recognizer = new SR();
      recognizer.lang = 'zh-CN';
      recognizer.interimResults = true;
      recognizer.continuous = false;
      recognizer.maxAlternatives = 1;
      recognizer.onresult = (e) => {
        let finalText = '', interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        onResult(finalText || interim, !!finalText);
      };
      recognizer.onerror = (ev) => {
        recognizing = false;
        micBtn()?.classList.remove('recording');
        const msg = ev.error === 'not-allowed' ? '没有麦克风权限，请打字'
                  : ev.error === 'no-speech'    ? '没听清，再试一次或打字'
                  : `语音识别失败（${ev.error}），请打字`;
        setMicStatus(msg);
      };
      recognizer.onend = () => {
        recognizing = false;
        micBtn()?.classList.remove('recording');
      };
      recognizer.start();
      recognizing = true;
      micBtn()?.classList.add('recording');
      setMicStatus('听你说…');
      return true;
    } catch (e) {
      recognizing = false;
      setMicStatus('语音识别初始化失败，请打字');
      return false;
    }
  };
  const stopAsr = () => {
    if (!recognizer || !recognizing) return;
    try { recognizer.stop(); } catch (_) {}
  };

  let skipFired = false;
  let skipResolve;
  const skipSignal = new Promise(res => { skipResolve = res; });
  document.getElementById('hatching-skip').onclick = () => {
    skipFired = true;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    stopAsr();
    skipResolve({ __skipped: true });
  };
  const raceSkip = async (p) => Promise.race([p, skipSignal]);

  // Panel 1: 光球脉冲
  show('orb');
  const r1 = await raceSkip(new Promise(res => {
    document.getElementById('hatching-orb').onclick = () => res('awoken');
  }));
  if (skipFired || r1?.__skipped) return null;

  // Panel 2: NPC 选择 — 点一张先 preview，再点别的换 ta，点"就选你"才确认
  show('pick');
  const grid = document.getElementById('hatching-npc-grid');
  const preview      = document.getElementById('hatching-pick-preview');
  const previewAvatar = document.getElementById('hatching-pick-preview-avatar');
  const previewName  = document.getElementById('hatching-pick-preview-name');
  const previewGreet = document.getElementById('hatching-pick-preview-greet');
  const confirmBtn   = document.getElementById('hatching-pick-confirm');
  grid.innerHTML = _HATCHING_NPC_ORDER.map(id => `
    <div class="hatching-npc-card" data-npc="${id}">
      <img src="../assets/characters/${id}.svg" alt="${id}" draggable="false">
      <div class="hatching-npc-name">${_HATCHING_NPC_META[id].zh}</div>
    </div>`).join('');
  let _previewing = null;
  const showPreview = (id) => {
    _previewing = id;
    _hatchingNpc = id; // 让 speakTts 用 ta 的 qwen 音色
    grid.querySelectorAll('.hatching-npc-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.npc === id);
    });
    const m = _HATCHING_NPC_META[id];
    previewAvatar.src = `../assets/characters/${id}.svg`;
    previewName.textContent = m.zh;
    previewGreet.textContent = m.greet;
    preview.hidden = false;
    // 触发"打招呼"动画：先 remove 再 add 强制 restart（同样 class 不会重播）
    previewAvatar.classList.remove('dance');
    // 读 offsetWidth 强制 reflow 让 class 重加触发动画
    void previewAvatar.offsetWidth;
    previewAvatar.classList.add('dance');
    // 试听一句（qwen 已 ready 则 owner 同款；未 ready 先走系统音）
    speakTts(m.greet);
  };
  const chosen = await raceSkip(new Promise(res => {
    grid.querySelectorAll('.hatching-npc-card').forEach(card => {
      card.onclick = () => showPreview(card.dataset.npc);
    });
    confirmBtn.onclick = () => {
      if (!_previewing) return;
      // cancel 任何 pending 试听（含 qwen audio + webkit）—— 否则 NPC greet 还会拖到 Q&A
      _stopHatchingTts();
      res(_previewing);
    };
  }));
  if (skipFired || chosen?.__skipped) return null;

  // 注：stick-npc 不在这里调 —— vault 还没建（installer 在点 Install 后才跑），
  // 现在调会写到不存在的 Pi/State/ 目录报 ENOENT。stick 延到 install 成功后。

  // 进入孵化动画前再杀一次 TTS——确保过渡到 Q&A 全静音
  _stopHatchingTts();

  // Panel 3: 孵化动画（2.4s）
  show('hatch');
  document.getElementById('hatching-npc-reveal').src = `../assets/characters/${chosen}.svg`;
  await new Promise(r => setTimeout(r, 2500));
  if (skipFired) return null;

  // Panel 4: 文字问答
  show('chat');
  const meta = _HATCHING_NPC_META[chosen];
  document.getElementById('hatching-chat-avatar').src = `../assets/characters/${chosen}.svg`;
  document.getElementById('hatching-chat-name').textContent = meta.zh;
  const stream   = document.getElementById('hatching-chat-stream');
  const inputBox = document.getElementById('hatching-chat-input-wrap');
  const input    = document.getElementById('hatching-chat-input');
  const sendBtn  = document.getElementById('hatching-chat-send');
  const chipsBox = document.getElementById('hatching-chat-chips');

  const bubble = (text, who) => {
    const d = document.createElement('div');
    d.className = `hatching-msg ${who}`;
    d.textContent = text;
    stream.appendChild(d);
    stream.scrollTop = stream.scrollHeight;
  };
  const npcSay = async (text) => {
    await new Promise(r => setTimeout(r, 200));
    if (skipFired) return;
    bubble(text, 'npc');
    // Setup 阶段不出声——TTS 冷启 + MLX 模型加载延迟太大体感很烂（owner 2026-04-25 拍掉）
    // NPC pick preview 的"试听"按钮还可以保留语音，但流程性问答不再 TTS
    // speakTts(text);
  };
  const askText = (prompt, placeholder = '') => raceSkip(new Promise(async (res) => {
    await npcSay(prompt);
    if (skipFired) return;
    input.value = '';
    input.placeholder = placeholder;
    inputBox.hidden = false;
    chipsBox.hidden = true;
    setMicStatus('');
    setTimeout(() => input.focus(), 30);
    const mic = micBtn();
    const done = () => {
      const v = input.value.trim();
      if (!v && !placeholder) return;
      const shown = v || placeholder;
      bubble(shown, 'user');
      inputBox.hidden = true;
      setMicStatus('');
      input.onkeydown = null;
      sendBtn.onclick = null;
      if (mic) mic.onclick = null;
      stopAsr();
      res(v);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(); };
    sendBtn.onclick = done;
    if (mic) {
      mic.onclick = () => {
        if (recognizing) { stopAsr(); return; }
        const ok = startAsr((text, isFinal) => {
          input.value = text;
          if (isFinal) setMicStatus('听到了 ✓');
        });
        if (!ok) return;
      };
    }
  }));
  const askChips = (prompt, options, { multi = false, confirmLabel = '就这些' } = {}) =>
    raceSkip(new Promise(async (res) => {
      await npcSay(prompt);
      if (skipFired) return;
      inputBox.hidden = true;
      chipsBox.innerHTML = options.map(o =>
        `<div class="hatching-chip" data-value="${o.value}">${o.label}</div>`
      ).join('') + (multi ? `<div class="hatching-chip confirm" data-confirm="1">${confirmLabel}</div>` : '');
      chipsBox.hidden = false;
      const selected = new Set();
      chipsBox.querySelectorAll('.hatching-chip').forEach(chip => {
        chip.onclick = () => {
          if (chip.dataset.confirm) {
            const picks = [...selected];
            const label = picks.length
              ? picks.map(v => options.find(o => o.value === v)?.label).join('、')
              : '（先不装）';
            bubble(label, 'user');
            chipsBox.hidden = true;
            res(picks);
            return;
          }
          if (multi) {
            const v = chip.dataset.value;
            if (selected.has(v)) { selected.delete(v); chip.classList.remove('selected'); }
            else { selected.add(v); chip.classList.add('selected'); }
          } else {
            const v = chip.dataset.value;
            bubble(chip.textContent, 'user');
            chipsBox.hidden = true;
            res(v);
          }
        };
      });
    }));

  await npcSay(meta.greet);
  if (skipFired) return null;

  const name = await askText('先告诉我，你叫什么？', '');
  if (skipFired || name?.__skipped) return null;
  const displayName = name || 'owner';

  const vaultRaw = await askText('Vault 放哪？回车走默认 ~/PiOS', '~/PiOS');
  if (skipFired || vaultRaw?.__skipped) return null;
  const vault = (vaultRaw && vaultRaw !== '~/PiOS') ? vaultRaw : '';

  // AI 引擎不再问——deps 装了哪个用哪个；插件不再问——core 默认装，wechat 默认装等激活
  await new Promise(r => setTimeout(r, 200));
  return { npc: chosen, name: displayName, vault };
}

(async function checkPiOSSetup() {
  const installed = await window.pi.piosIsInstalled();
  if (installed) return;

  // 流程顺序（2026-04-23 重排）：
  //   1. 显示 setup overlay，但只 #pios-setup-deps 区可见，form 主体藏起
  //   2. 用户走完 5 项 deps（CLT → Brew → Node → Python → Claude），全 ✓ 自动 fire depsReady
  //   3. 等 qwen-voice service ready（等 Python 装完 + venv 起 + MLX 模型加载，max 90s）
  //   4. 关 overlay → 跑光球孵化（此时 qwen 活，speakTts 走 qwen，是 owner 同款音色）
  //   5. 重开 overlay，form 主体 show + prefill 填好，deps 区 hide → 用户改/确认 → Install

  const overlay = document.getElementById('pios-setup-overlay');
  const formLabels = () => Array.from(document.querySelectorAll('#pios-setup-form > .pios-setup-label'));
  const installBtnEl = () => document.getElementById('setup-install');
  const depsBoxEl = () => document.getElementById('pios-setup-deps');
  const toggleFormBody = (visible) => {
    formLabels().forEach((l) => { l.style.display = visible ? '' : 'none'; });
    const ib = installBtnEl(); if (ib) ib.style.display = visible ? '' : 'none';
  };
  const toggleDepsBox = (visible) => {
    const d = depsBoxEl(); if (d) d.style.display = visible ? '' : 'none';
  };
  // 入场：只显示 deps 区
  overlay.style.display = 'flex';
  toggleFormBody(false);
  toggleDepsBox(true);

  // 默认 vault 路径
  const home = await window.pi.piosGetConfig(); // null if not installed
  document.getElementById('setup-vault').value = '';
  document.getElementById('setup-vault').placeholder = '~/PiOS';

  // depsReadyResolve: renderDeps 检测到 5 项全 ✓ 时 fire 一次
  let _depsReadyResolve = null;
  const depsReadyPromise = new Promise((res) => { _depsReadyResolve = res; });
  // 暴露给 renderDeps 用（在下面定义的闭包里）
  window.__depsReadyFire = () => { if (_depsReadyResolve) { _depsReadyResolve(); _depsReadyResolve = null; } };

  // 阶段 2-3 流程（异步）：装完 deps → 立刻进孵化，不阻塞等 qwen。
  // qwen 服务在 main 进程后台启动；孵化的 speakTts 每次调都先尝试 qwen，失败再 fallback webkit。
  // 这样 UX：deps 全 ✓ → 立刻看到光球。qwen 首句可能是系统语音，后面 ready 了就切 qwen。
  let _hatchingPrefill = null;
  (async () => {
    await depsReadyPromise; // 等用户走完全部 deps
    const depsLogEl = document.getElementById('deps-log');
    const showHint = (msg) => {
      if (!depsLogEl) return;
      depsLogEl.style.display = 'block';
      depsLogEl.textContent += `\n${msg}\n`;
      depsLogEl.scrollTop = depsLogEl.scrollHeight;
    };
    showHint('依赖全部 ✓，后台触发 qwen-voice 启动（不阻塞；头几句可能走系统语音，等模型加载完会自动切 owner 同款）…');
    // 不 await：让 main 进程后台 spawn，renderer 立刻继续
    try { window.pi.qwenEnsureStarted(); } catch {}
    // 稍等 600ms 让用户看到"✓ 装完成"动画，然后关 overlay → 孵化
    await new Promise((r) => setTimeout(r, 600));
    // 关 overlay → 跑孵化
    overlay.style.display = 'none';
    try {
      _hatchingPrefill = await runHatchingCeremony();
    } catch (e) {
      console.warn('[hatching] ceremony failed:', e);
    }
    const _hatchStage = document.getElementById('hatching-stage');
    if (_hatchStage) _hatchStage.hidden = true;
    // 重开 overlay：form 主体可见，deps 区藏起
    overlay.style.display = 'flex';
    toggleDepsBox(false);
    toggleFormBody(true);
    _applyHatchingPrefillImpl();
    // gate Install 按钮：deps 已全 ✓，按钮 enable
    const ib = installBtnEl(); if (ib) ib.disabled = false;
  })();

  // ── 从孵化仪式 prefill 填经典 wizard 表单（owner 在光球里已选过就不重填）────
  // 2026-04-25 简化：孵化只问 name + vault，AI 引擎和插件不再让用户选
  function _applyHatchingPrefillImpl() {
    if (!_hatchingPrefill || _hatchingPrefill.__skipped) return;
    const p = _hatchingPrefill;
    if (p.name)  document.getElementById('setup-name').value = p.name;
    if (p.vault) document.getElementById('setup-vault').value = p.vault;
  }

  // ── Step 0: 环境依赖检查 ─────────────────
  // 顺序 = 依赖顺序：CLT → Brew → Node/Python → AI Runtime。前置失败时后续项按钮 disabled。
  // Claude 和 Codex 是"二选一"（标 group: 'ai-runtime'）：装一个 PiOS 就能跑 agent（支持 runtime fallback）。
  const DEPS = [
    { key: 'xcode_clt', label: 'Xcode CLT',   hint: 'Homebrew 的前置，首次装 5-15 min' },
    { key: 'brew',      label: 'Homebrew',    hint: '/opt/homebrew/bin/brew' },
    { key: 'node',      label: 'Node.js 18+', hint: 'brew install node' },
    { key: 'python312', label: 'Python 3.12', hint: 'NPC 语音 + scheduler 需要（含 PyYAML）' },
    { key: 'ffmpeg',    label: 'ffmpeg',      hint: 'F5 语音识别需要（webm→wav 转换）' },
    { key: 'claude',    label: 'Claude CLI',  hint: 'npm -g + claude auth login',  group: 'ai-runtime' },
    { key: 'codex',     label: 'Codex CLI',   hint: 'npm -g + codex auth login（Claude 的替代，装任一个即可）', group: 'ai-runtime' },
  ];
  const depsListEl = document.getElementById('deps-list');
  const depsLogEl  = document.getElementById('deps-log');
  const depsLogToggle = document.getElementById('deps-log-toggle');
  const installBtn = document.getElementById('setup-install');
  let _depsInstalling = false;
  let _lastFailedKey = null;

  function ensureLogVisible() {
    if (depsLogEl.style.display === 'none' || !depsLogEl.style.display) {
      depsLogEl.style.display = 'block';
      if (depsLogToggle) depsLogToggle.textContent = '收起日志';
    }
  }
  function appendDepsLog(chunk) {
    ensureLogVisible();
    // Highlight phase marker lines (==> Phase Name) as structured subtask entries
    const lines = chunk.split('\n');
    let html = '';
    lines.forEach((line, i) => {
      const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (line.startsWith('==>')) {
        html += `<span class="deps-log-phase">${esc}</span>`;
      } else {
        html += esc;
      }
      if (i < lines.length - 1) html += '\n';
    });
    depsLogEl.innerHTML += html;
    depsLogEl.scrollTop = depsLogEl.scrollHeight;
  }
  function clearDepsLog() {
    depsLogEl.innerHTML = '';
    depsLogEl.style.display = 'none';
    if (depsLogToggle) depsLogToggle.textContent = '展开日志';
  }
  window.pi.onDepsProgress((which, chunk) => appendDepsLog(chunk));

  async function renderDeps() {
    const status = await window.pi.depsCheck();
    depsListEl.innerHTML = '';
    // 精确前置图（不是一刀切 "上面缺就全 disabled"）：
    //   brew         ← xcode_clt
    //   node         ← xcode_clt, brew
    //   python312    ← xcode_clt, brew   （侧支，NPC 语音；不拦 Claude/Codex）
    //   claude/codex ← xcode_clt, brew, node
    const BLOCKERS = {
      xcode_clt: [],
      brew:      ['xcode_clt'],
      node:      ['xcode_clt', 'brew'],
      python312: ['xcode_clt', 'brew'],
      ffmpeg:    ['xcode_clt', 'brew'],
      claude:    ['xcode_clt', 'brew', 'node'],
      codex:     ['xcode_clt', 'brew', 'node'],
    };
    const aiRuntimeOk = (status.claude && status.claude.ok) || (status.codex && status.codex.ok);
    // 核心 5 项：CLT / Brew / Node / Python / ffmpeg；全 ok 才能 Install
    const coreAllOk = status.xcode_clt.ok && status.brew.ok && status.node.ok && status.python312.ok && status.ffmpeg.ok;

    for (const d of DEPS) {
      const s = status[d.key] || { ok: false, detail: '未检测' };
      const isAiRow = d.group === 'ai-runtime';
      const prereqs = BLOCKERS[d.key] || [];
      const blockedBy = prereqs.filter((k) => !(status[k] && status[k].ok));
      const blocked = blockedBy.length > 0;
      const isFailedRecently = (_lastFailedKey === d.key);
      const btnLabel = isFailedRecently ? '重试' : (s.install_label || '装');
      // AI Runtime 组：另一个已装时本行显示"可选"徽章
      const counterpartOk = isAiRow && aiRuntimeOk && !s.ok;
      const btnDisabledAttr = blocked ? `disabled title="先装：${blockedBy.join(' / ')}"` : '';
      const skipBadge = counterpartOk ? ' <span class="deps-skip-badge">可选</span>' : '';
      const row = document.createElement('div');
      row.className = 'deps-row' + (counterpartOk ? ' deps-row-optional' : '');
      row.dataset.key = d.key;
      row.innerHTML = `
        <span class="deps-icon ${s.ok ? 'ok' : (counterpartOk ? 'opt' : 'miss')}">${s.ok ? '✓' : (counterpartOk ? '○' : '✗')}</span>
        <span class="deps-name">${d.label}${skipBadge}</span>
        <span class="deps-detail" title="${s.detail || d.hint}">${s.detail || d.hint}</span>
        ${s.ok ? '' : `<button class="deps-install-btn" data-install="${d.key}" ${btnDisabledAttr}>${btnLabel}</button>`}
      `;
      depsListEl.appendChild(row);
    }
    const allOk = coreAllOk && aiRuntimeOk;
    installBtn.disabled = !allOk;
    installBtn.title = allOk ? '' : (coreAllOk ? '再装 Claude 或 Codex 至少一个' : '请先把前 4 项（CLT/Brew/Node/Python）打 ✓');
    // 全 ✓ 时通知外层 IIFE 推进到 qwen-ready + 孵化阶段（一次性）
    if (allOk && typeof window.__depsReadyFire === 'function') {
      try { window.__depsReadyFire(); window.__depsReadyFire = null; } catch {}
    }
    return allOk;
  }

  depsListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-install]');
    if (!btn || btn.disabled || _depsInstalling) return;
    const which = btn.dataset.install;
    _depsInstalling = true;
    btn.disabled = true;
    btn.textContent = '装中…';
    clearDepsLog();
    ensureLogVisible();
    if (which === 'xcode_clt') {
      appendDepsLog('▶ 触发 Xcode Command Line Tools 系统对话框\n  会跳出 "软件要求" 窗口，点「安装」后等 5-15 min；期间不要关 PiOS\n');
    } else if (which === 'brew') {
      appendDepsLog('▶ 装 Homebrew\n  会弹 macOS 密码框请求管理员权限，输入本机登录密码即可\n');
    } else if (which === 'claude') {
      appendDepsLog('▶ 安装或登录 Claude CLI\n  若二进制已存在，PiOS 会直接拉起浏览器 OAuth，不需要切去 Terminal\n');
    } else {
      appendDepsLog(`▶ 开始装 ${which}\n`);
    }
    try {
      const r = await window.pi.depsInstall(which);
      if (r.ok) {
        _lastFailedKey = null;
        appendDepsLog(`\n✓ ${which} 装完成\n`);
      } else {
        _lastFailedKey = which;
        appendDepsLog(`\n✗ 失败 (exit ${r.code})\n`);
        appendDepsLog('提示：若因网络超时失败，检查网络后点「重试」。\n');
        if (which === 'claude') {
          appendDepsLog('（Claude CLI 需要浏览器 OAuth，若没自动打开，点「重试」手动完成。）\n');
        }
      }
    } catch (err) {
      _lastFailedKey = which;
      appendDepsLog(`\n[error] ${err.message}\n`);
    } finally {
      _depsInstalling = false;
      // brew install 完退出 0 后，symlink 到 /opt/homebrew/bin/<cmd> 可能还需要几百 ms；
      // 短轮询最多 1.8s 直到 check 真的 hit，避免用户还要手点"重新检查"
      for (let i = 0; i < 6; i++) {
        await renderDeps();
        const fresh = await window.pi.depsCheck();
        if (fresh && fresh[which] && fresh[which].ok) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });

  document.getElementById('deps-refresh').addEventListener('click', async () => {
    _lastFailedKey = null;
    clearDepsLog();
    await renderDeps();
  });
  if (depsLogToggle) {
    depsLogToggle.addEventListener('click', () => {
      const isHidden = depsLogEl.style.display === 'none' || !depsLogEl.style.display;
      if (isHidden) {
        if (!depsLogEl.textContent) return; // 空日志不展开
        depsLogEl.style.display = 'block';
        depsLogToggle.textContent = '收起日志';
      } else {
        depsLogEl.style.display = 'none';
        depsLogToggle.textContent = '展开日志';
      }
    });
  }

  // 入场即渲染
  await renderDeps();

  // ── Setup form submission ─────────────────
  document.getElementById('setup-install').addEventListener('click', async () => {
    // Gate：只有 deps 全 ✓ 才放行（后端 installer 本身不 block，但 UX 上防止误点）
    if (installBtn.disabled) return;
    const name = document.getElementById('setup-name').value.trim() || 'User';
    let vault = document.getElementById('setup-vault').value.trim();
    if (!vault) vault = undefined; // use default ~/PiOS

    // AI 引擎：不让用户选，deps-check 装了哪个就用哪个
    // （claude / codex 装了就 true，都没装根本走不到这；deps gate 已挡）
    const depsStatus = await window.pi.depsCheck();
    const runtimes = {
      'claude-cli': !!(depsStatus.claude && depsStatus.claude.ok),
      'codex-cli': !!(depsStatus.codex && depsStatus.codex.ok),
    };

    // 插件：core 三件 + browser + wechat 都默认装（不让用户选）
    // health / photos 产品不再支持
    // wechat 装完不自动激活，用户去 Plugins 页点"激活"进 AI 引导会话
    const plugins = ['vault', 'shell', 'web-search', 'browser', 'wechat'];

    const result = await window.pi.piosInstall({
      owner_name: name,
      vault_root: vault,
      runtimes,
      plugins,
    });

    if (result.ok) {
      // installer 装完 vault 骨架就绪，**现在**才安全地 stick 孵化选的 NPC
      // （pi-character.json 写到 Pi/State/，vault 装前 Pi/State/ 不存在）
      if (_hatchingPrefill && _hatchingPrefill.npc) {
        try { await window.pi.piosStickNpc(_hatchingPrefill.npc); }
        catch (e) { console.warn('[setup] piosStickNpc failed:', e); }
      }
      document.getElementById('pios-setup-form').style.display = 'none';
      document.getElementById('pios-setup-done').style.display = 'block';
      document.getElementById('pios-setup-done-msg').textContent = `Vault created at ${result.vault_root}`;
    }
  });

  document.getElementById('setup-start').addEventListener('click', async () => {
    overlay.style.display = 'none';
    // 通知 main 进程现在可以创建 Home BrowserView（之前被 gate 拦着，避免原生层盖住 setup overlay）
    try { await window.pi.piosSetupDone(); } catch {}
  });
})();

function renderPiOSRuntimes(runtimes) {
  const container = document.getElementById('pios-view-runtimes');
  if (!runtimes || runtimes.length === 0) {
    container.innerHTML = '<div class="panel-empty">No runtimes found</div>';
    return;
  }
  const fixCmds = {
    'codex-cli': 'openclaw auth login openai-codex',
    'openclaw': 'openclaw restart',
    'claude-cli': 'claude /login',
  };
  container.innerHTML = runtimes.map(r => {
    const isOk = r.status === 'ok';
    const isDown = r.status === 'down' || r.status === 'degraded';
    const statusColor = isOk ? 'var(--accent, #1e90ff)' : isDown ? '#e07b00' : '#aaa';
    const lastSuccessStr = r.last_success ? new Date(r.last_success).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const detail = isDown && r.error
      ? `<span style="color:#e07b00; font-size:11px; margin-left:8px;">${r.error}</span>`
      : `<span style="color:#888; font-size:11px; margin-left:8px;">last ok: ${lastSuccessStr}</span>`;
    const fixCmd = isDown ? fixCmds[r.id] : null;
    const canAutoRestart = isDown && r.id === 'openclaw';
    // 重新探活按钮：auth-based runtime 随时可点（不只在 down）——
    // 因为状态检测本身可能错（例：quota 提前恢复但 pios.yaml 还标 down），
    // 用户需要一个确定性的方式强制系统重新看一眼。
    const canRefreshAuth = (r.id === 'claude-cli' || r.id === 'codex-cli');
    const restartBtn = canAutoRestart
      ? `<button onclick="(function(btn){btn.disabled=true;btn.textContent='重启中…';window.pi.piosRuntimeRestart('openclaw').then(res=>{btn.textContent=res.ok?'✓ 已重启':'✗ 失败';setTimeout(()=>{btn.disabled=false;btn.textContent='重启 Gateway'},3000)}).catch(()=>{btn.textContent='✗ 失败';setTimeout(()=>{btn.disabled=false;btn.textContent='重启 Gateway'},3000)})})(this)"
          style="margin-left:auto; padding:1px 7px; font-size:10px; border:1px solid #1e90ff; background:transparent; color:#1e90ff; border-radius:3px; cursor:pointer; flex-shrink:0;">重启 Gateway</button>`
      : '';
    // 一键探活：claude-cli / codex-cli down 时跑 auth-manager check + auth-check.sh
    // 覆盖场景：quota 提前恢复 / 外部登录后系统未察觉 → 点一下按钮重新写 pios.yaml 状态
    const refreshBtn = canRefreshAuth
      ? `<button onclick="(function(btn){btn.disabled=true;const orig='重新探活';btn.textContent='探活中…';window.pi.piosRuntimeRefreshAuth('${r.id}').then(res=>{btn.textContent=res.ok?'✓ 已恢复':('✗ '+(res.status||'fail'));setTimeout(()=>{btn.disabled=false;btn.textContent=orig;window.pi.piosRuntimes().then(renderPiOSRuntimes).catch(()=>{})},1500)}).catch(e=>{btn.textContent='✗ 失败';setTimeout(()=>{btn.disabled=false;btn.textContent=orig},2000)})})(this)"
          style="margin-left:auto; padding:1px 7px; font-size:10px; border:1px solid #1e90ff; background:transparent; color:#1e90ff; border-radius:3px; cursor:pointer; flex-shrink:0;"
          title="跑 auth-manager check + auth-check.sh，刷新 ${r.id} 状态">重新探活</button>`
      : '';
    const fixBtn = (!canAutoRestart && !canRefreshAuth && fixCmd)
      ? `<button onclick="navigator.clipboard.writeText('${fixCmd}').then(()=>{this.textContent='✓ 已复制';setTimeout(()=>this.textContent='复制修复命令',2000)}).catch(()=>{})"
          style="margin-left:auto; padding:1px 7px; font-size:10px; border:1px solid #e07b00; background:transparent; color:#e07b00; border-radius:3px; cursor:pointer; flex-shrink:0;"
          title="${fixCmd}">复制修复命令</button>`
      : '';
    // 当 refreshBtn 存在时，fixCmd 作为 title 提示（万一探活搞不定，还能手动 claude /login）
    const fixFallbackBtn = (canRefreshAuth && fixCmd)
      ? `<button onclick="navigator.clipboard.writeText('${fixCmd}').then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘',1500)}).catch(()=>{})"
          style="padding:1px 6px; font-size:10px; border:1px solid #888; background:transparent; color:#888; border-radius:3px; cursor:pointer; flex-shrink:0;"
          title="如探活无效，复制并手动执行: ${fixCmd}">⎘</button>`
      : '';
    return `
    <div class="pios-plugin-item" style="flex-wrap:wrap; gap:2px;">
      <span class="pios-agent-dot" style="background:${statusColor}; flex-shrink:0;"></span>
      <span class="pios-plugin-name" style="min-width:100px;">${r.name || r.id}</span>
      <span class="pios-plugin-category" style="color:${statusColor}">${r.status}</span>
      ${detail}
      ${restartBtn}
      ${refreshBtn}
      ${fixBtn}
      ${fixFallbackBtn}
    </div>`;
  }).join('');
}

function renderPiOSPlugins(plugins) {
  const container = document.getElementById('pios-view-plugins');
  if (plugins.length === 0) {
    container.innerHTML = '<div class="panel-empty">No plugins</div>';
    return;
  }
  container.innerHTML = plugins.map(p => `
    <div class="pios-plugin-item">
      <span class="pios-agent-dot ${p.enabled ? 'active' : 'disabled'}"></span>
      <span class="pios-plugin-name">${p.display_name}</span>
      <span class="pios-plugin-category">${p.category}</span>
      <span class="pios-plugin-provides">${(p.provides || []).join(', ')}</span>
    </div>
  `).join('');
}

// 全局语音气泡已移至独立窗口（main.js + renderer/bubble.html）
