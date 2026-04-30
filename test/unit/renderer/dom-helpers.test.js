'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { JSDOM } = require('jsdom');

// renderer/lib/dom-helpers.js exports a factory that takes `document`. Under
// node:test we create a fresh JSDOM document and pass it. In a real browser
// the UMD wrapper auto-uses window.document.

const factory = require(path.join(__dirname, '../../..', 'renderer/lib/dom-helpers'));

test.describe('renderer/lib/dom-helpers — escapeHtml', () => {
  let dom, helpers;
  test.before(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    helpers = factory(dom.window.document);
  });

  test('escapes <, >, & for safe innerHTML insertion', () => {
    const out = helpers.escapeHtml('<script>alert("xss")</script>');
    // jsdom-serialised: < and > become &lt; / &gt;; quotes inside text don't need escaping
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /&lt;\/script&gt;$/);
    assert.doesNotMatch(out, /<script>/, 'raw <script> must not survive');
  });

  test('handles & ampersands', () => {
    assert.strictEqual(helpers.escapeHtml('a & b'), 'a &amp; b');
  });

  test('null/undefined → empty string (no throw)', () => {
    assert.strictEqual(helpers.escapeHtml(null), '');
    assert.strictEqual(helpers.escapeHtml(undefined), '');
  });

  test('numbers and other non-strings stringified safely', () => {
    assert.strictEqual(helpers.escapeHtml(42), '42');
    assert.strictEqual(helpers.escapeHtml(true), 'true');
  });
});

test.describe('renderer/lib/dom-helpers — favicon', () => {
  let dom, helpers;
  test.before(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    helpers = factory(dom.window.document);
  });

  test('returns <img> element with given src + alt for non-empty src', () => {
    const el = helpers.favicon('https://example.com/icon.png', 'Example');
    assert.strictEqual(el.tagName, 'IMG');
    assert.strictEqual(el.getAttribute('src'), 'https://example.com/icon.png');
    assert.strictEqual(el.getAttribute('alt'), 'Example');
    assert.strictEqual(el.className, 'favicon');
  });

  test('empty/null src → fallback <span> with 🌐', () => {
    const el = helpers.favicon('');
    assert.strictEqual(el.tagName, 'SPAN');
    assert.strictEqual(el.textContent, '🌐');
    assert.strictEqual(el.className, 'favicon-fallback');
  });
});
