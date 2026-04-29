// renderer/lib/format-helpers.js — pure formatters used by the renderer
//
// UMD wrapper: works as both a browser <script> tag (sets window.RendererFormat)
// and a node:test require() target (returns module.exports). No DOM, no IPC,
// no external deps — easy to unit-test.
//
// New renderer code should prefer adding helpers here over defining them
// inline in renderer/app.js. See test/CONVENTIONS.md "Renderer testing".

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RendererFormat = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Relative time string in zh-CN: "刚刚" / "5 分钟前" / "3 小时前" / "Apr 12".
   * Threshold ladder: <60s → 刚刚, <1h → minutes, <1d → hours, else date.
   */
  function relativeTime(iso, now) {
    const d = new Date(iso);
    const reference = now instanceof Date ? now : new Date();
    const diff = reference - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }

  /** Bytes → human-readable (B / KB / MB). */
  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  /**
   * Cron string → human label.
   *   "*\/15 * * * *" → "every 15min"
   *   "0 9 * * *"     → "9:00"  (HH:MM)
   *   "0 9 * * 1,3,5" → "Mon/Wed/Fri 9:00"
   * Returns '' for empty / null / undefined input.
   */
  function cronSchedule(cron) {
    if (!cron) return '';
    if (cron.startsWith('*/')) return `every ${cron.split(' ')[0].slice(2)}min`;
    const parts = cron.split(' ');
    const m = parts[0], h = parts[1], days = parts[4];
    const time = `${h}:${m.padStart(2, '0')}`;
    if (days === '*') return time;
    const dayMap = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };
    const dayStr = days.split(',').map(d => dayMap[d] || d).join('/');
    return `${dayStr} ${time}`;
  }

  /**
   * Inline-image src normaliser: relative file paths get a file:// prefix so
   * they render in <img>. http(s) and data URIs pass through. Used when
   * markdown contains `![](path/to/img.png)` from local agents.
   */
  function inlineImageSrc(src) {
    if (!src) return src;
    if (/^\/[A-Za-z0-9._\-/~]+\.(png|jpe?g|gif|webp|svg|bmp)([?#].*)?$/i.test(src)) {
      return `file://${src}`;
    }
    return src;
  }

  /**
   * Parse a Codex / GPT response that may contain `<say>...</say>` voice tags.
   * Returns { say, show } where:
   *   say  — voice content joined with '，' (TTS reads this)
   *   show — text with all <say> tags stripped (rendered to chat bubble)
   * Tag form: `<say>...</say>` or `<say voice="x">...</say>`.
   */
  function parseSayBlocks(text) {
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

  return {
    relativeTime,
    fileSize,
    cronSchedule,
    inlineImageSrc,
    parseSayBlocks,
  };
}));
