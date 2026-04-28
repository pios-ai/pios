/**
 * PiOS Afterward i18n — lightweight t() wrapper.
 * Loads locale JSON synchronously via XHR (file:// works in Electron renderer).
 * Default locale: zh-CN. Override: localStorage['pios_locale'] = 'en'
 *
 * Usage:
 *   t('afterward.lock.submit')              → "解锁"
 *   t('afterward.status.test_mode', {n: 5}) → "5× 测试模式"
 *
 * TODO: wire locale switcher in settings panel for full multi-language support.
 */
(function () {
  'use strict';

  const DEFAULT_LOCALE = 'zh-CN';
  const locale = localStorage.getItem('pios_locale') || DEFAULT_LOCALE;

  function loadJSON(relPath) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', relPath, /* async= */ false);
      xhr.send(null);
      // status 0 = success for file:// in Electron; 200 = http
      if (xhr.status === 200 || xhr.status === 0) {
        return JSON.parse(xhr.responseText);
      }
    } catch (e) {
      console.warn('[i18n] failed to load', relPath, e);
    }
    return {};
  }

  const dict = loadJSON(`../locales/${locale}.json`);
  const fallback = (locale !== DEFAULT_LOCALE) ? loadJSON(`../locales/${DEFAULT_LOCALE}.json`) : {};

  /**
   * Translate a key with optional {var} interpolation.
   * @param {string} key
   * @param {Object} [vars]  e.g. { n: 42, name: 'Alice' }
   * @returns {string}
   */
  window.t = function (key, vars) {
    let str = dict[key] || fallback[key] || key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, v);
      }
    }
    return str;
  };

  /** Apply data-i18n* attributes to all matching DOM elements. */
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = window.t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = window.t(el.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = window.t(el.dataset.i18nPlaceholder);
    });
    document.documentElement.lang = locale;
    highlightToggle();
  }

  /** Highlight current locale in toggle buttons. */
  function highlightToggle() {
    document.querySelectorAll('.lang-toggle .lang-opt').forEach(opt => {
      if (opt.dataset.lang === locale) opt.classList.add('active');
      else opt.classList.remove('active');
    });
  }

  /** Switch locale + reload page (simplest way to re-apply everything). */
  window.switchLocale = function (newLocale) {
    if (newLocale === locale) return;
    localStorage.setItem('pios_locale', newLocale);
    window.location.reload();
  };

  /** Wire toggle buttons after DOM is ready. */
  function wireToggles() {
    document.querySelectorAll('.lang-toggle .lang-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        window.switchLocale(opt.dataset.lang);
      });
    });
    highlightToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { applyI18n(); wireToggles(); });
  } else {
    applyI18n();
    wireToggles();
  }
})();
