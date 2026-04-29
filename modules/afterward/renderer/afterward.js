/**
 * Afterward UI — view logic.
 * All vault crypto goes through Python core via window.afterward (preload bridge).
 * i18n: all user-visible strings use t() from i18n.js (loaded before this file).
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let unlocked = false;
let autoLockTimer = null;
const AUTO_LOCK_MS = 5 * 60 * 1000;  // 5 min

// ─── Lock screen ──────────────────────────────────────────

function showLock(msg = '') {
  unlocked = false;
  $('#app').classList.add('hidden');
  $('#lock-screen').classList.remove('hidden');
  document.body.classList.add('locked');
  $('#lock-password').value = '';
  $('#lock-error').textContent = msg;
  setTimeout(() => $('#lock-password').focus(), 100);
}

function showApp() {
  unlocked = true;
  $('#lock-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  document.body.classList.remove('locked');
  resetAutoLock();
  refreshStatus();
}

async function attemptUnlock() {
  const password = $('#lock-password').value;
  if (!password) return;
  $('#lock-error').textContent = t('afterward.lock.verifying');

  try {
    const result = await window.afterward.unlock(password);
    if (result.ok) {
      // Successful unlock = also counts as challenge pass
      await window.afterward.challengePass();
      showApp();
    } else {
      $('#lock-error').textContent = result.error || t('afterward.lock.wrong_pwd');
      $('#lock-password').value = '';
      $('#lock-password').focus();
    }
  } catch (e) {
    $('#lock-error').textContent = t('afterward.lock.error_fmt', { msg: e.message });
  }
}

$('#lock-submit').addEventListener('click', attemptUnlock);
$('#lock-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptUnlock();
});

// ─── Auto-lock on idle ────────────────────────────────────

function resetAutoLock() {
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => {
    if (unlocked) showLock(t('afterward.lock.idle_locked'));
  }, AUTO_LOCK_MS);
}

['mousemove', 'keydown', 'click'].forEach(evt => {
  document.addEventListener(evt, () => { if (unlocked) resetAutoLock(); });
});

$('#lock-now').addEventListener('click', async () => {
  try { await window.afterward.lock?.(); } catch {}
  showLock(t('afterward.lock.manual_locked'));
});

// ─── Tabs ─────────────────────────────────────────────────

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    $$('.tab').forEach(tabEl => tabEl.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    $(`[data-panel="${target}"]`).classList.remove('hidden');

    // Lazy-load panel content
    if (target === 'vault') refreshVaultList();
    if (target === 'home') refreshStatus();
    if (target === 'actions') loadInstructions('actions');
    if (target === 'missions') loadInstructions('missions');
    if (target === 'trustees') loadTrustees();
    if (target === 'audit') loadAudit();
  });
});

// ─── Status panel ─────────────────────────────────────────

function fmtDays(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1) return `${(n * 24).toFixed(1)}h`;
  return `${n.toFixed(1)} days`;
}

async function refreshStatus() {
  try {
    const status = await window.afterward.status();
    if (status.state === 'NOT_INITIALIZED') {
      $('#status-state').textContent = t('afterward.status.not_init');
      $('#status-state').dataset.state = '';
      $('#status-last-challenge').textContent = status.detail || t('afterward.status.init_required');
      return;
    }
    $('#status-state').textContent = status.state;
    $('#status-state').dataset.state = status.state;
    $('#status-last-challenge').textContent = fmtDays(status.virtual_days_since_last_challenge);
    $('#status-days-passive').textContent = fmtDays(status.virtual_days_since_passive_heartbeat);
    $('#status-trustees').textContent =
      `${status.trustee_confirmations_count} / ${status.trustee_threshold}`;
    $('#status-compression').textContent =
      status.time_compression === 1
        ? t('afterward.status.realtime')
        : t('afterward.status.test_mode', { n: status.time_compression });
  } catch (e) {
    $('#status-state').textContent = t('afterward.status.error');
    $('#status-last-challenge').textContent = e.message;
  }
}

$('#refresh-status').addEventListener('click', refreshStatus);
$('#check-state-btn').addEventListener('click', async () => {
  await window.afterward.checkState();
  await refreshStatus();
});

// ─── Heartbeat / daily challenge ──────────────────────────

$('#challenge-submit').addEventListener('click', async () => {
  const password = $('#challenge-password').value;
  if (!password) return;
  const result = await window.afterward.unlock(password);
  if (result.ok) {
    await window.afterward.challengePass();
    $('#challenge-result').textContent = t('afterward.heartbeat.ok');
    $('#challenge-result').className = 'result ok';
    $('#challenge-password').value = '';
    refreshStatus();
  } else {
    $('#challenge-result').textContent = `✗ ${result.error}`;
    $('#challenge-result').className = 'result fail';
  }
});

$('#challenge-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#challenge-submit').click();
});

// ─── Vault list + editor ──────────────────────────────────

let _currentEditPath = null;

async function refreshVaultList() {
  const list = await window.afterward.vaultList();
  const container = $('#vault-list');
  if (!list || list.length === 0) {
    container.innerHTML = `<div style="color:var(--text-faint); padding:10px 12px; font-size:12px;">${t('afterward.vault.empty')}</div>`;
    return;
  }
  container.innerHTML = list.map(item => `
    <div class="vault-item" data-path="${item.path}">
      <span class="vname">${item.path}</span>
      <span class="vmeta">${(item.size / 1024).toFixed(1)} KB · ${new Date(item.mtime).toLocaleDateString()}</span>
    </div>
  `).join('');
  container.querySelectorAll('.vault-item').forEach(el => {
    el.addEventListener('click', () => openVaultItem(el.dataset.path));
  });
}

async function openVaultItem(relPath) {
  _currentEditPath = relPath;
  document.querySelectorAll('.vault-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.vault-item[data-path="${relPath}"]`)?.classList.add('active');
  $('#vault-placeholder').classList.add('hidden');
  $('#vault-editor').classList.remove('hidden');
  $('#editor-path').value = relPath;
  $('#editor-result').textContent = t('afterward.vault.decrypting');
  $('#editor-content').value = '';
  try {
    const r = await window.afterward.vaultRead(relPath);
    if (r.ok) {
      $('#editor-content').value = r.content;
      $('#editor-result').textContent = t('afterward.vault.decrypted_n', { n: r.content.length });
      $('#editor-result').className = 'result ok';
    } else {
      $('#editor-result').textContent = `✗ ${r.error}`;
      $('#editor-result').className = 'result fail';
    }
  } catch (e) {
    $('#editor-result').textContent = `✗ ${e.message}`;
    $('#editor-result').className = 'result fail';
  }
}

function openNewVaultItem() {
  _currentEditPath = null;
  document.querySelectorAll('.vault-item').forEach(el => el.classList.remove('active'));
  $('#vault-placeholder').classList.add('hidden');
  $('#vault-editor').classList.remove('hidden');
  $('#editor-path').value = 'letters/';
  $('#editor-content').value = '';
  $('#editor-result').textContent = t('afterward.vault.new_hint');
  $('#editor-result').className = 'result';
  $('#editor-path').focus();
}

async function saveVaultItem() {
  const relPath = $('#editor-path').value.trim();
  const content = $('#editor-content').value;
  if (!relPath.endsWith('.enc')) {
    $('#editor-result').textContent = t('afterward.vault.path_enc_required');
    $('#editor-result').className = 'result fail';
    return;
  }
  $('#editor-result').textContent = t('afterward.vault.encrypting');
  $('#editor-result').className = 'result';
  try {
    const r = await window.afterward.vaultWrite(relPath, content);
    if (r.ok) {
      _currentEditPath = relPath;
      $('#editor-result').textContent = t('afterward.vault.saved_n', { n: content.length });
      $('#editor-result').className = 'result ok';
      refreshVaultList();
    } else {
      $('#editor-result').textContent = `✗ ${r.error}`;
      $('#editor-result').className = 'result fail';
    }
  } catch (e) {
    $('#editor-result').textContent = `✗ ${e.message}`;
    $('#editor-result').className = 'result fail';
  }
}

function closeVaultEditor() {
  _currentEditPath = null;
  $('#editor-content').value = '';
  $('#editor-path').value = '';
  $('#vault-editor').classList.add('hidden');
  $('#vault-placeholder').classList.remove('hidden');
  document.querySelectorAll('.vault-item').forEach(el => el.classList.remove('active'));
}

$('#vault-new-btn')?.addEventListener('click', openNewVaultItem);
$('#editor-save')?.addEventListener('click', saveVaultItem);
$('#editor-close')?.addEventListener('click', closeVaultEditor);
// Cmd/Ctrl+S to save
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && !$('#vault-editor').classList.contains('hidden')) {
    e.preventDefault();
    saveVaultItem();
  }
});

// ─── Instructions (Actions + Missions) ────────────────────

function splitInstructionsYaml(fullYaml) {
  // Very simple split: extract "actions:" block and "missions:" block.
  // We don't parse YAML in JS — just isolate the sections for display.
  // Daemon uses PyYAML for real parsing.
  const lines = fullYaml.split('\n');
  const out = { actions: [], missions: [], pre: [] };
  let current = 'pre';
  for (const line of lines) {
    if (/^actions\s*:/.test(line)) { current = 'actions'; out.actions.push(line); continue; }
    if (/^missions\s*:/.test(line)) { current = 'missions'; out.missions.push(line); continue; }
    if (/^\w+\s*:/.test(line) && current !== 'pre') { current = 'other'; }
    if (current === 'actions') out.actions.push(line);
    else if (current === 'missions') out.missions.push(line);
    else out.pre.push(line);
  }
  return out;
}

async function loadInstructions(section) {
  const elYaml = $(`#${section}-yaml`);
  const elMeta = $(`#${section}-meta`);
  const elResult = $(`#${section}-result`);
  elMeta.textContent = t('afterward.common.loading');
  try {
    const r = await window.afterward.instructionsRead();
    if (!r.ok) {
      elMeta.textContent = '';
      elResult.textContent = `✗ ${r.error}`;
      elResult.className = 'result fail';
      return;
    }
    const sections = splitInstructionsYaml(r.yaml);
    elYaml.value = sections[section].join('\n').trim() || `${section}: []`;
    elMeta.textContent = t('afterward.decrypted_n', { n: elYaml.value.length });
    elResult.textContent = '';
  } catch (e) {
    elMeta.textContent = '';
    elResult.textContent = `✗ ${e.message}`;
    elResult.className = 'result fail';
  }
}

async function saveInstructions(section) {
  const elYaml = $(`#${section}-yaml`);
  const elResult = $(`#${section}-result`);
  elResult.textContent = t('afterward.vault.encrypting');
  elResult.className = 'result';

  try {
    // Reload current full YAML, replace target section, re-save
    const r = await window.afterward.instructionsRead();
    if (!r.ok) { elResult.textContent = `✗ ${r.error}`; elResult.className = 'result fail'; return; }
    const sections = splitInstructionsYaml(r.yaml);
    // Replace section with edited content
    const otherSection = section === 'actions' ? 'missions' : 'actions';
    const preamble = (sections.pre.join('\n').trim() + '\n').replace(/^\n+/, '');
    const edited = elYaml.value.trim();
    const otherBlock = sections[otherSection].join('\n').trim();
    const newYaml = [
      preamble,
      section === 'actions' ? edited : otherBlock,
      section === 'missions' ? edited : otherBlock,
    ].filter(Boolean).join('\n\n') + '\n';

    const w = await window.afterward.instructionsWrite(newYaml);
    if (w.ok) {
      elResult.textContent = t('afterward.vault.saved_n', { n: newYaml.length });
      elResult.className = 'result ok';
    } else {
      elResult.textContent = `✗ ${w.error}`;
      elResult.className = 'result fail';
    }
  } catch (e) {
    elResult.textContent = `✗ ${e.message}`;
    elResult.className = 'result fail';
  }
}

$('#actions-reload')?.addEventListener('click', () => loadInstructions('actions'));
$('#missions-reload')?.addEventListener('click', () => loadInstructions('missions'));
$('#actions-save')?.addEventListener('click', () => saveInstructions('actions'));
$('#missions-save')?.addEventListener('click', () => saveInstructions('missions'));

// ─── Trustees ──────────────────────────────────────────────

async function loadTrustees() {
  const grid = $('#trustees-grid');
  grid.innerHTML = t('afterward.trustees.loading');
  try {
    const r = await window.afterward.trusteesRead();
    if (!r.ok) { grid.innerHTML = `<p class="result fail">${r.error}</p>`; return; }
    grid.innerHTML = r.trustees.map(trustee => `
      <div class="trustee-card">
        <div class="t-idx">#${trustee.index}</div>
        <div class="t-name">${trustee.name || t('afterward.trustees.no_name')}</div>
        <div class="t-field"><span class="t-field-label">${t('afterward.trustees.email')}</span><span class="t-field-val">${trustee.email || '—'}</span></div>
        <div class="t-field"><span class="t-field-label">${t('afterward.trustees.phone')}</span><span class="t-field-val">${trustee.phone || '—'}</span></div>
        <div class="t-status">${t('afterward.trustees.status')}</div>
      </div>
    `).join('');
  } catch (e) {
    grid.innerHTML = `<p class="result fail">${e.message}</p>`;
  }
}

// ─── Drill ─────────────────────────────────────────────────

async function runDrill() {
  const btn = $('#drill-run-btn');
  const out = $('#drill-output');
  const result = $('#drill-result');
  btn.disabled = true;
  btn.textContent = t('afterward.drill.running');
  out.classList.remove('hidden');
  out.innerHTML = `<div class="drill-event">${t('afterward.drill.starting')}</div>`;
  result.textContent = '';

  try {
    const r = await window.afterward.drillRun();
    out.innerHTML = '';
    let lifecyclePassed = false;
    for (const evt of r.events || []) {
      if (evt.drill_complete !== undefined) {
        lifecyclePassed = evt.passed === true;
        const key = lifecyclePassed ? 'afterward.drill.complete_pass' : 'afterward.drill.complete_fail';
        out.innerHTML += `<div class="drill-event" style="margin-top:10px;color:${lifecyclePassed ? 'var(--ok)' : 'var(--danger)'}">${t(key, { state: evt.final_state })}</div>`;
      } else {
        const [name, data] = Array.isArray(evt) ? evt : [Object.keys(evt)[0], evt[Object.keys(evt)[0]]];
        out.innerHTML += `<div class="drill-event"><span class="drill-name">${name}</span><span class="drill-data">${JSON.stringify(data)}</span></div>`;
      }
    }
    if (r.ok && lifecyclePassed) {
      result.textContent = t('afterward.drill.passed');
      result.className = 'result ok';
    } else {
      result.textContent = t('afterward.drill.failed') + (r.error ? '：' + r.error : '');
      result.className = 'result fail';
      if (r.stderr) out.innerHTML += `<div class="drill-event" style="color:var(--danger)">stderr: ${r.stderr}</div>`;
    }
  } catch (e) {
    result.textContent = `✗ ${e.message}`;
    result.className = 'result fail';
  } finally {
    btn.disabled = false;
    btn.textContent = t('afterward.drill.start_btn');
  }
}

$('#drill-run-btn')?.addEventListener('click', runDrill);

// ─── Audit log ─────────────────────────────────────────────

async function loadAudit() {
  const list = $('#audit-list');
  const meta = $('#audit-meta');
  list.innerHTML = t('afterward.common.loading');
  try {
    const r = await window.afterward.auditRead(200);
    if (!r.ok) { list.innerHTML = `<p class="result fail">${r.error}</p>`; return; }
    meta.textContent = t('afterward.audit.count', { n: r.events.length, total: r.total });
    if (r.events.length === 0) {
      list.innerHTML = `<div class="audit-entry" style="color:var(--text-faint)">${t('afterward.audit.empty')}</div>`;
      return;
    }
    list.innerHTML = r.events.map(e => {
      const { at, event, ...rest } = e;
      return `
        <div class="audit-entry">
          <span class="audit-time">${at?.slice(0, 19).replace('T', ' ') || ''}</span>
          <span class="audit-event">${event || '?'}</span>
          <span class="audit-detail">${Object.keys(rest).length ? JSON.stringify(rest) : ''}</span>
        </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p class="result fail">${e.message}</p>`;
  }
}

$('#audit-reload')?.addEventListener('click', loadAudit);

// ─── Change master password ────────────────────────────────

async function handleChangePassword() {
  const oldPwd = $('#pwd-old').value;
  const newPwd = $('#pwd-new').value;
  const newPwd2 = $('#pwd-new2').value;
  const resultEl = $('#pwd-change-result');
  const sharesEl = $('#pwd-change-new-shares');
  sharesEl.classList.add('hidden');
  sharesEl.innerHTML = '';

  if (!oldPwd || !newPwd) {
    resultEl.textContent = t('afterward.pwdchange.err_both_required');
    resultEl.className = 'result fail';
    return;
  }
  if (newPwd.length < 6) {
    resultEl.textContent = t('afterward.onboard.pwd_min_len');
    resultEl.className = 'result fail';
    return;
  }
  if (newPwd !== newPwd2) {
    resultEl.textContent = t('afterward.onboard.pwd_mismatch');
    resultEl.className = 'result fail';
    return;
  }
  if (oldPwd === newPwd) {
    resultEl.textContent = t('afterward.pwdchange.err_same');
    resultEl.className = 'result fail';
    return;
  }

  const btn = $('#pwd-change-btn');
  btn.disabled = true;
  resultEl.textContent = t('afterward.pwdchange.running');
  resultEl.className = 'result';

  try {
    const r = await window.afterward.changePassword(oldPwd, newPwd);
    if (!r.ok) {
      resultEl.textContent = `✗ ${r.error || '未知错误'}`;
      resultEl.className = 'result fail';
      btn.disabled = false;
      return;
    }
    resultEl.textContent = t('afterward.pwdchange.success', {
      n: r.re_encrypted_files,
      shares: r.shares?.length || 0,
    });
    resultEl.className = 'result ok';
    $('#pwd-old').value = '';
    $('#pwd-new').value = '';
    $('#pwd-new2').value = '';

    // Show new shares with copy + auto-clear clipboard (same flow as onboarding)
    if (r.shares?.length) {
      sharesEl.classList.remove('hidden');
      sharesEl.innerHTML = `<p class="explainer warn-box">${t('afterward.pwdchange.new_shares_warn')}</p>`;
      const list = document.createElement('div');
      r.shares.forEach(s => {
        const div = document.createElement('div');
        div.className = 'share-item';
        div.innerHTML = `
          <div class="share-to">${t('afterward.onboard.share_to', { i: s.index, name: s.trustee_name })}</div>
          <div class="share-to-email">${s.trustee_email || t('afterward.onboard.no_email')}</div>
          <div class="share-value">${s.share}</div>
          <button class="copy-btn" data-share="${s.share}">${t('afterward.onboard.copy_share')}</button>
        `;
        list.appendChild(div);
      });
      sharesEl.appendChild(list);
      list.querySelectorAll('.copy-btn').forEach(btn => {
        let timer = null;
        btn.addEventListener('click', async () => {
          if (timer) clearTimeout(timer);
          await navigator.clipboard.writeText(btn.dataset.share);
          btn.textContent = `✓ ${t('afterward.common.copied')}`;
          btn.classList.add('copied');
          timer = setTimeout(async () => {
            try { await navigator.clipboard.writeText(''); } catch {}
            btn.textContent = t('afterward.onboard.copy_share');
            btn.classList.remove('copied');
          }, 30000);
        });
      });
    }
  } catch (e) {
    resultEl.textContent = `✗ ${e.message}`;
    resultEl.className = 'result fail';
  } finally {
    btn.disabled = false;
  }
}

$('#pwd-change-btn')?.addEventListener('click', handleChangePassword);

// ─── Touch ID ──────────────────────────────────────────────

async function refreshTouchIDStatus() {
  const statusEl = $('#touchid-status');
  const enableBtn = $('#touchid-enable-btn');
  const disableBtn = $('#touchid-disable-btn');
  try {
    const s = await window.afterward.touchidAvailable();
    if (!s.available) {
      statusEl.textContent = t('afterward.touchid.unavailable');
      statusEl.className = 'result';
      enableBtn.classList.add('hidden');
      disableBtn.classList.add('hidden');
      return;
    }
    if (s.enabled) {
      statusEl.textContent = t('afterward.touchid.enabled');
      statusEl.className = 'result ok';
      enableBtn.classList.add('hidden');
      disableBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = t('afterward.touchid.available_off');
      statusEl.className = 'result';
      enableBtn.classList.remove('hidden');
      disableBtn.classList.add('hidden');
    }
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className = 'result fail';
  }
}

$('#touchid-enable-btn')?.addEventListener('click', async () => {
  const statusEl = $('#touchid-status');
  statusEl.textContent = t('afterward.touchid.prompting');
  try {
    const r = await window.afterward.touchidEnable();
    if (r.ok) {
      statusEl.textContent = t('afterward.touchid.enabled_now');
      statusEl.className = 'result ok';
    } else {
      statusEl.textContent = `✗ ${r.error}`;
      statusEl.className = 'result fail';
    }
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className = 'result fail';
  }
  await refreshTouchIDStatus();
});

$('#touchid-disable-btn')?.addEventListener('click', async () => {
  const r = await window.afterward.touchidDisable();
  if (r.ok) await refreshTouchIDStatus();
});

// Lock screen: show Touch ID button if enabled
async function refreshLockTouchID() {
  const btn = $('#touchid-unlock-btn');
  if (!btn || !window.afterward?.touchidAvailable) return;
  try {
    const s = await window.afterward.touchidAvailable();
    if (s.available && s.enabled) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  } catch {
    btn.classList.add('hidden');
  }
}

$('#touchid-unlock-btn')?.addEventListener('click', async () => {
  $('#lock-error').textContent = t('afterward.touchid.prompting');
  try {
    const r = await window.afterward.touchidUnlock();
    if (r.ok) {
      await window.afterward.challengePass();
      showApp();
    } else {
      $('#lock-error').textContent = `✗ ${r.error}`;
    }
  } catch (e) {
    $('#lock-error').textContent = `✗ ${e.message}`;
  }
});

// Hook refresh into heartbeat tab + lock screen showing
const _origTabClick = $$('.tab');
$$('.tab').forEach(tab => {
  if (tab.dataset.tab === 'heartbeat') {
    tab.addEventListener('click', refreshTouchIDStatus);
  }
});

// Also refresh on lock screen entry
const _origShowLock = showLock;
showLock = function (msg = '') {
  _origShowLock(msg);
  refreshLockTouchID();
};

// ─── Pi access tokens (授权 Pi) ─────────────────────────────

async function refreshTokenList() {
  const el = $('#pi-auth-list');
  if (!el) return;
  try {
    const r = await window.afterward.listTokens();
    if (!r.ok) { el.textContent = '—'; return; }
    if (r.tokens.length === 0) {
      el.innerHTML = `<div style="padding:14px;color:var(--text-faint);font-size:12px;font-style:italic">${t('afterward.piauth.none_active')}</div>`;
      return;
    }
    el.innerHTML = r.tokens.map(tk => {
      const scopeLabel = tk.scope === 'read_write' ? t('afterward.piauth.scope_rw') : t('afterward.piauth.scope_read');
      const remaining = tk.expires_in_sec;
      const hrs = Math.floor(remaining / 3600);
      const mins = Math.floor((remaining % 3600) / 60);
      const countdown = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
      return `
        <div class="pi-auth-item">
          <span class="tk-prefix">${tk.token_prefix}</span>
          <div>
            <div class="tk-meta">${tk.label || '(未命名)'}</div>
            <div class="tk-meta-dim">${scopeLabel}${tk.paths ? ' · ' + tk.paths.length + ' paths' : ''}</div>
          </div>
          <span class="tk-countdown">${countdown}</span>
          <button class="tk-revoke" data-token="${tk._full_token_for_revoke}">${t('afterward.piauth.revoke')}</button>
        </div>`;
    }).join('');
    el.querySelectorAll('.tk-revoke').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.afterward.revokeToken(btn.dataset.token);
        refreshTokenList();
      });
    });
  } catch (e) {
    el.textContent = `✗ ${e.message}`;
  }
}

$('#pi-auth-generate')?.addEventListener('click', async () => {
  const scope = $('#pi-auth-scope').value;
  const ttl_seconds = Number($('#pi-auth-ttl').value);
  const label = $('#pi-auth-label').value.trim();

  const btn = $('#pi-auth-generate');
  const newEl = $('#pi-auth-new-token');
  btn.disabled = true;
  try {
    const r = await window.afterward.authorizePi({ scope, ttl_seconds, label });
    if (!r.ok) {
      newEl.classList.remove('hidden');
      newEl.innerHTML = `<p class="result fail">✗ ${r.error}</p>`;
      return;
    }
    const expiresMin = Math.floor(ttl_seconds / 60);
    newEl.classList.remove('hidden');
    newEl.innerHTML = `
      <div class="token-label">${t('afterward.piauth.new_token_label', { min: expiresMin })}</div>
      <div class="token-value">${r.token}</div>
      <button class="copy-btn" data-token="${r.token}">${t('afterward.piauth.copy_token')}</button>
      <div class="token-hint">${t('afterward.piauth.new_token_hint', { label: r.label })}</div>
    `;
    const copyBtn = newEl.querySelector('.copy-btn');
    let clipTimer = null;
    // Build a self-explanatory handoff string so the receiving Claude/Pi session
    // knows exactly what the token is, how to call the API, and — critically —
    // that it must run /selfdestruct before the conversation ends.
    const buildHandoff = () => {
      const ttlMin = Math.round((new Date(r.expires_at) - Date.now()) / 60000);
      const pathsLine = Array.isArray(r.paths) && r.paths.length
        ? `限定路径: ${r.paths.join(', ')}`
        : '可读全部 vault';
      const writeOpLine = r.scope === 'read_write'
        ? '\n- POST /write  body: {path, content}  — 加密写入（仅 read_write scope 可用）'
        : '';
      return `我给你一个 Afterward vault 的 API token（${r.scope} scope，${ttlMin} 分钟后过期，${pathsLine}）。用它调 PiOS 本地 HTTP API 读加密文件。

Token: ${r.token}
Base URL: http://127.0.0.1:17891/afterward/api/
Auth headers:
  X-Afterward-Token: <token>
  X-Claude-Session-Id: <你自己的 Claude Code session_id>   ← /read 必传；/selfdestruct 靠它精确 scope 清理

端点：
- GET /list                      — 列所有 .enc 文件
- GET /read?path=<relpath>       — 解密读取。**必须**带 X-Claude-Session-Id header，否则 400。服务端靠这个 sid 在 /selfdestruct 时只删你这个会话的 JSONL，不会误杀他人${writeOpLine}
- GET /whoami                    — 查 token 状态
- GET /selfdestruct              — **对话结束前必调**。服务端自己起 60s 后台循环（每 3s 扫一次），按 /read 时注册过的 session_id **精确 unlink** {sid}.jsonl + DELETE DB 行 + osascript quit Claude。**你只负责调这个端点**，服务端自己兜底，不要自己跑任何 bash。

怎么拿你自己的 session_id：
- 首选：环境变量（Claude Code 可能暴露 \`$CLAUDE_SESSION_ID\` / \`$CLAUDE_CODE_SESSION_ID\` / transcript path 里的 UUID）
- 实在不知道：bash 查 \`ls -t ~/.claude/projects/-Users-&lt;you&gt;-&lt;vault&gt;/*.jsonl | head -1\`，然后**验证**文件里 \`.sessionId\` 字段确实是你（\`head -1 <file> | jq .sessionId\`），再用它
- 还是不确定：**不要乱传，不要 /read**。服务端宁愿拒绝读也不接受模糊 sid。
- sub-agent（Agent tool）自己也要传**它自己的** session_id（不是 parent 的），否则 /selfdestruct 清不到它的 JSONL

纪律（2026-04-21 血泪教训，见 Pi/Memory/feedback_afterward_self_destruct.md）：
一旦 /read 过，session JSONL 含 plaintext。完事调 /selfdestruct，服务端自己 60s 循环兜底。
**严禁**：
① \`find ~/.claude/projects/-Users-&lt;you&gt;-&lt;vault&gt; -newermt ... -delete\` — 这会盲扫整个目录，把同 vault 的其他 Claude 会话一起删。曾因此误杀过同 vault 的不相关研究会话。不要重蹈。
② 按时间窗 DELETE session-index.db — 同理会误伤其他 session 的索引行。
③ 自己实现"兜底循环" — 服务端已经做了，Claude 这边插手只会打架。
调一次 /selfdestruct 就够，剩下等 Claude 自己被 osascript quit。`;
    };
    copyBtn.addEventListener('click', async () => {
      if (clipTimer) clearTimeout(clipTimer);
      await navigator.clipboard.writeText(buildHandoff());
      copyBtn.textContent = t('afterward.piauth.copied_30s');
      copyBtn.classList.add('copied');
      clipTimer = setTimeout(async () => {
        try { await navigator.clipboard.writeText(''); } catch {}
        copyBtn.textContent = t('afterward.piauth.copy_token');
        copyBtn.classList.remove('copied');
      }, 30000);
    });
    $('#pi-auth-label').value = '';
    refreshTokenList();
  } catch (e) {
    newEl.classList.remove('hidden');
    newEl.innerHTML = `<p class="result fail">✗ ${e.message}</p>`;
  } finally {
    btn.disabled = false;
  }
});

// Refresh token list when Home tab opens + every 30s if Home active
const _origRefreshStatus = refreshStatus;
refreshStatus = async function () {
  await _origRefreshStatus();
  refreshTokenList();
};
setInterval(() => {
  if (!unlocked) return;
  const homePanel = document.querySelector('[data-panel="home"]');
  if (homePanel && !homePanel.classList.contains('hidden')) refreshTokenList();
}, 30000);

// ─── Onboarding wizard ────────────────────────────────────

function showOnboard(step = 1) {
  $('#lock-screen').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#onboard-screen').classList.remove('hidden');
  document.body.classList.add('locked');
  goToOnboardStep(step);
}

function goToOnboardStep(step) {
  document.querySelectorAll('.onboard-step').forEach(s => s.classList.add('hidden'));
  $(`.onboard-step[data-step="${step}"]`).classList.remove('hidden');
  if (step === 3) renderTrusteeRows();
}

document.querySelectorAll('.onboard-next').forEach(btn => {
  btn.addEventListener('click', () => goToOnboardStep(btn.dataset.next));
});
document.querySelectorAll('[data-prev]').forEach(btn => {
  btn.addEventListener('click', () => goToOnboardStep(btn.dataset.prev));
});

function renderTrusteeRows() {
  const container = $('#trustee-rows');
  if (container.children.length > 0) return;  // already rendered
  for (let i = 1; i <= 5; i++) {
    const row = document.createElement('div');
    row.className = 'trustee-row';
    row.innerHTML = `
      <span class="trustee-label">#${i}</span>
      <input type="text" placeholder="${t('afterward.onboard.trustee_name_ph')}" data-idx="${i}" data-field="name" />
      <input type="email" placeholder="${t('afterward.onboard.trustee_email_ph')}" data-idx="${i}" data-field="email" />
    `;
    container.appendChild(row);
  }
}

let _onboardPassword = '';

$('#onboard-pwd-next').addEventListener('click', () => {
  const p1 = $('#onboard-pwd1').value;
  const p2 = $('#onboard-pwd2').value;
  const err = $('#onboard-pwd-error');
  if (p1.length < 6) {
    err.textContent = t('afterward.onboard.pwd_min_len');
    return;
  }
  if (p1 !== p2) {
    err.textContent = t('afterward.onboard.pwd_mismatch');
    return;
  }
  _onboardPassword = p1;
  $('#onboard-pwd1').value = '';
  $('#onboard-pwd2').value = '';
  err.textContent = '';
  goToOnboardStep(3);
});

$('#onboard-trustee-next').addEventListener('click', async () => {
  const err = $('#onboard-trustee-error');
  err.textContent = '';
  const trustees = [];
  for (let i = 1; i <= 5; i++) {
    const name = document.querySelector(`input[data-idx="${i}"][data-field="name"]`).value.trim();
    const email = document.querySelector(`input[data-idx="${i}"][data-field="email"]`).value.trim();
    if (!name) {
      err.textContent = t('afterward.onboard.trustee_name_required', { i });
      return;
    }
    trustees.push({ index: i, name, email });
  }

  // Call backend to initialize
  $('#onboard-trustee-next').disabled = true;
  $('#onboard-trustee-next').textContent = t('afterward.onboard.generating');
  try {
    const result = await window.afterward.onboard(_onboardPassword, trustees);
    if (!result.ok) {
      err.textContent = result.error || '未知错误';
      $('#onboard-trustee-next').disabled = false;
      $('#onboard-trustee-next').textContent = t('afterward.onboard.step3.cta');
      return;
    }
    renderSharesList(result.shares);
    goToOnboardStep(4);
  } catch (e) {
    err.textContent = t('afterward.lock.error_fmt', { msg: e.message });
    $('#onboard-trustee-next').disabled = false;
    $('#onboard-trustee-next').textContent = t('afterward.onboard.step3.cta');
  }
});

function renderSharesList(shares) {
  const container = $('#shares-list');
  container.innerHTML = '';
  shares.forEach(s => {
    const div = document.createElement('div');
    div.className = 'share-item';
    div.innerHTML = `
      <div class="share-to">${t('afterward.onboard.share_to', { i: s.index, name: s.trustee_name })}</div>
      <div class="share-to-email">${s.trustee_email || t('afterward.onboard.no_email')}</div>
      <div class="share-value">${s.share}</div>
      <button class="copy-btn" data-share="${s.share}">${t('afterward.onboard.copy_share')}</button>
    `;
    container.appendChild(div);
  });
  container.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(btn.dataset.share);
      btn.textContent = t('afterward.common.copied');
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = t('afterward.onboard.copy_share');
        btn.classList.remove('copied');
      }, 2000);
    });
  });
}

$('#shares-distributed').addEventListener('change', (e) => {
  $('#onboard-finish').disabled = !e.target.checked;
});

$('#onboard-finish').addEventListener('click', () => {
  // Clear shares from memory + UI
  $('#shares-list').innerHTML = '';
  _onboardPassword = '';
  $('#onboard-screen').classList.add('hidden');
  showLock(t('afterward.onboard.setup_done'));
});

// ─── Initial load ──────────────────────────────────────────

async function startup() {
  try {
    const init = await window.afterward.isInitialized();
    if (init.initialized) {
      showLock();
    } else {
      showOnboard(1);
    }
  } catch (e) {
    // If backend isn't available (e.g. in browser preview), default to lock
    showLock();
  }
}

startup();
