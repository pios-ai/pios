// renderer/lib/dom-helpers.js — small DOM utilities
//
// UMD wrapper. Tested via jsdom in test/unit/renderer/dom-helpers.test.js.
//
// These touch `document` so they only work inside a browser-like context
// (real browser OR jsdom). Pure formatters with no DOM access belong in
// renderer/lib/format-helpers.js instead.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
  } else {
    root.RendererDom = factory(root.document);
  }
}(typeof self !== 'undefined' ? self : this, function (doc) {

  // For node:test under jsdom: caller passes document; for browser: document
  // is a global from the page. Allow late-binding for node side.
  function _doc() {
    if (doc) return doc;
    if (typeof document !== 'undefined') return document;
    throw new Error('RendererDom: no document available — call factory(jsdom.window.document) under node:test');
  }

  /**
   * Escape a string for safe insertion into innerHTML. Uses textContent
   * round-trip — handles &, <, >, " and any non-printable that the host
   * browser's serialiser knows about.
   */
  function escapeHtml(str) {
    const d = _doc().createElement('div');
    d.textContent = String(str == null ? '' : str);
    return d.innerHTML;
  }

  /**
   * Build a tab-bar style favicon <img>; returns a detached element
   * (caller appends). Falls back to '🌐' character for missing/empty src.
   */
  function favicon(src, alt) {
    const d = _doc();
    if (!src) {
      const span = d.createElement('span');
      span.textContent = '🌐';
      span.className = 'favicon-fallback';
      return span;
    }
    const img = d.createElement('img');
    img.src = src;
    img.alt = alt || '';
    img.className = 'favicon';
    return img;
  }

  return {
    escapeHtml,
    favicon,
  };
}));
