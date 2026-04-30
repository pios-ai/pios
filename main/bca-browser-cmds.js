"use strict";
const path = require("path");
const fs = require("fs");

async function tryHandle(req, res, endpoint, params, ctx) {
  const {
    s,
    createTab, switchToTab, closeTab, sendNotification, handlePiEvent, switchToChatMode,
    forceRelayout, completeURL, deepMerge,
    loadSessions, saveSessions, findTaskRun, materializeTaskSessionFromRun,
    taskRunSessionId, tryCreateHomeTabs,
    _backupSessionJsonl, _compactSession, _fetchContextDetail, _restoreSessionFromBackup,
    getClaudeClient,
    pios, installer,
    _loginSessions, _compactInFlight,
    VAULT_ROOT, APP_VERSION,
  } = ctx;
  let result = { error: "unknown endpoint" };

  try {
    // 选择目标 tab：优先 params.tab_id，其次 activeTab
    function pickTab() {
      if (params.tab_id != null) {
        const t = s.tabs.find(x => x.id === params.tab_id);
        return t || null;
      }
      return s.tabs.find(t => t.id === s.activeTabId) || null;
    }
    const tab = pickTab();
    const wc = tab && tab.view ? tab.view.webContents : null;

    switch (endpoint) {
      case '/navigate': {
        const target = completeURL(params.url || '');
        const wantNewTab = params.new_tab === true || !wc;
        const focus = params.focus !== false; // 默认 true（兼容）
        if (wantNewTab) {
          const newId = createTab(target, { focus });
          result = { result: 'ok', url: target, tab_id: newId, newTab: true };
        } else {
          await wc.loadURL(target);
          result = { result: 'ok', url: target, tab_id: tab.id };
        }
        break;
      }
      case '/new_tab': {
        const target = completeURL(params.url || 'https://www.google.com');
        const focus = params.focus !== false; // 默认 true（兼容手动入口）
        const mute = params.muted === true || (params.focus === false); // 后台 tab 默认静音
        const newId = createTab(target, { focus });
        const newTab = s.tabs.find(t => t.id === newId);
        if (newTab && mute) newTab.view.webContents.audioMuted = true;
        result = { result: 'ok', url: target, tab_id: newId, focus, muted: mute };
        break;
      }
      case '/read_page': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const data = await wc.executeJavaScript(`
          (function() {
            const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => ({level: h.tagName, text: h.textContent.trim()})).slice(0, 20);
            const links = [...document.querySelectorAll('a[href]')].map(a => ({text: a.textContent.trim(), href: a.href})).filter(l => l.text).slice(0, 50);
            const forms = [...document.querySelectorAll('form')].map(f => ({
              action: f.action,
              fields: [...f.querySelectorAll('input,select,textarea')].map(i => ({name: i.name, type: i.type, placeholder: i.placeholder, value: i.value}))
            })).slice(0, 5);
            const tables = [...document.querySelectorAll('table')].map(t => {
              const rows = [...t.querySelectorAll('tr')].slice(0, 10).map(r => [...r.querySelectorAll('td,th')].map(c => c.textContent.trim()));
              return rows;
            }).slice(0, 3);
            return { title: document.title, url: location.href, headings, links, forms, tables };
          })()
        `);
        result = data;
        break;
      }
      case '/get_text': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const text = await wc.executeJavaScript(`document.body.innerText.substring(0, 8000)`);
        const title = await wc.executeJavaScript(`document.title`);
        const pageUrl = await wc.executeJavaScript(`location.href`);
        result = { title, url: pageUrl, text };
        break;
      }
      case '/screenshot': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const img = await wc.capturePage();
        const png = img.toPNG();
        result = { image: png.toString('base64') };
        break;
      }
      case '/click': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const sel = (params.selector || '').replace(/'/g, "\\'");
        const clicked = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector('${sel}');
            if (!el) return { error: 'element not found: ${sel}' };
            el.click();
            return { result: 'clicked', tag: el.tagName, text: el.textContent.substring(0, 100) };
          })()
        `);
        result = clicked;
        break;
      }
      case '/fill': {
        if (!wc) { result = { error: 'no active tab' }; break; }
        const fSel = (params.selector || '').replace(/'/g, "\\'");
        const fVal = (params.value || '').replace(/'/g, "\\'");
        const filled = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector('${fSel}');
            if (!el) return { error: 'element not found: ${fSel}' };
            el.focus();
            el.value = '${fVal}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { result: 'filled', tag: el.tagName, value: '${fVal}' };
          })()
        `);
        result = filled;
        break;
      }
      case '/quick-dismiss': {
        // 快捷小窗 Esc — 隐藏 app，不带出主窗口
        app.hide();
        result = { ok: true };
        break;
      }
      case '/quick-send': {
        // 快捷小窗发送 — 显示主窗口 + 执行
        s.mainWindow.show();
        s.mainWindow.focus();
        const text = params.text || '';
        if (text && s.mainWindow) {
          s.mainWindow.webContents.executeJavaScript(`window._quickSend && window._quickSend(${JSON.stringify(text)})`);
        }
        result = { ok: true };
        break;
      }
      case '/exec_js': {
        const target = params.target === 'main' ? s.mainWindow.webContents : wc;
        if (!target) { result = { error: 'no target' }; break; }
        const jsResult = await target.executeJavaScript(params.code);
        result = { result: String(jsResult).substring(0, 10000) };
        break;
      }
      case '/tabs': {
        result = { tabs: s.tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.id === s.activeTabId })) };
        break;
      }
      case '/switch_tab': {
        const target = s.tabs.find(t => t.id === params.id);
        if (target) { switchToTab(params.id); result = { result: 'ok', url: target.url }; }
        else { result = { error: `tab ${params.id} not found` }; }
        break;
      }
      case '/mute_tab': {
        const mtId = params.tab_id != null ? params.tab_id : (params.id != null ? params.id : s.activeTabId);
        const mt = s.tabs.find(t => t.id === mtId);
        if (!mt) { result = { error: `tab ${mtId} not found` }; break; }
        const muted = params.muted !== undefined ? !!params.muted : true;
        mt.view.webContents.audioMuted = muted;
        result = { result: 'ok', tab_id: mtId, muted };
        break;
      }
      case '/close_tab': {
        const id = params.tab_id != null ? params.tab_id : params.id;
        if (id == null) { result = { error: 'missing tab_id' }; break; }
        if (id === s.homeTabId) { result = { error: 'cannot close Home tab' }; break; }
        const existed = s.tabs.some(t => t.id === id);
        if (!existed) { result = { error: `tab ${id} not found` }; break; }
        closeTab(id);
        result = { result: 'ok', closed: id };
        break;
      }
      case '/back': {
        if (wc) { wc.goBack(); result = { result: 'ok' }; }
        else { result = { error: 'no active tab' }; }
        break;
      }
      case '/forward': {
        if (wc) { wc.goForward(); result = { result: 'ok' }; }
        else { result = { error: 'no active tab' }; }
        break;
      }
    }
  } catch (err) {
    result = { error: err.message };
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}
module.exports = { tryHandle };
