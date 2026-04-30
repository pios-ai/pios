// Lifecycle timers: pi-chitchat / presence-watch / wechat-aggregator
// 三个 setInterval-driven 子系统，全部依赖 mainWindow + presence + powerMonitor。
// 提取自 main.js app.whenReady 块。

const path = require('path');
const fs = require('fs');

function start(deps) {
  const { vaultRoot, getMainWindow, app } = deps;
  const _getPresenceForFlush = require('../backend/presence').getPresence;

  // ── Pi 主动闲聊定时器：每 30min 检查门控条件 ──
  const piChitchat = require('../backend/pi-chitchat');
  setInterval(() => {
    try {
      piChitchat.maybeChat(getMainWindow(), vaultRoot);
    } catch (e) {
      console.error('[pi-chitchat] timer error:', e.message);
    }
  }, 30 * 60 * 1000);

  // ── presence-watch 60s：flush pending + 相遇问候（pi-greet） ──
  // P6 Phase 6A+6C：让"离开 Mac <4h 的积压消息"在你回来自动 bubble 补发；
  // 同时触发 pi-greet 按 last_seen delta 判断打不打招呼。
  // 2026-04-23 K2/K3 修：K2 grace 20s 防"一坐回来气泡瞬间糊脸"；K3 5min debounce 防反复切换刷屏
  const piRoute = require('../backend/pi-route');
  const piGreet = require('../backend/pi-greet');
  let _lastPresenceStatusForFlush = null;
  let _presentArrivedAt = 0;
  let _flushedThisPresent = false;
  let _lastFlushAt = 0;
  const GRACE_MS = 20 * 1000;
  const DEBOUNCE_MS = 5 * 60 * 1000;
  setInterval(() => {
    try {
      const mw = getMainWindow();
      const curr = _getPresenceForFlush().status;
      const now = Date.now();

      if (curr === 'present' && _lastPresenceStatusForFlush !== 'present') {
        _presentArrivedAt = now;
        _flushedThisPresent = false;
      }
      if (curr !== 'present') {
        _presentArrivedAt = 0;
        _flushedThisPresent = false;
      }

      if (curr === 'present'
          && !_flushedThisPresent
          && _presentArrivedAt > 0
          && (now - _presentArrivedAt) >= GRACE_MS
          && (now - _lastFlushAt) >= DEBOUNCE_MS) {
        _flushedThisPresent = true;
        _lastFlushAt = now;
        piRoute.flushPending(mw).then(r => {
          if (r && r.flushed > 0) {
            console.log(`[pi-route] flushed ${r.flushed} pending messages on presence return (after ${Math.floor((now - _presentArrivedAt)/1000)}s grace)`);
          }
        }).catch(e => console.error('[pi-route] flushPending error:', e.message));
      }

      _lastPresenceStatusForFlush = curr;
      piGreet.onPresenceChange(mw);
    } catch (e) {
      console.error('[presence-watch] error:', e.message);
    }
  }, 60 * 1000);

  // ── WeChat 聚合器：3 条触发通道 ──
  // (a) setInterval 5min tick（awake 兜底；macOS 睡眠暂停）
  // (b) enqueue 时 fire-and-forget tick（macOS 睡眠也有效，cron 唤醒）
  // (c) powerMonitor.on('resume') —— macOS 恢复时立即 tick，赶在 presence flush-pending 清空 queue 之前
  const _wechatAggregator = require('../backend/wechat-aggregator');

  const _runAggregatorTick = async () => {
    const dbgLog = path.join(vaultRoot, 'Pi/Log/wechat-aggregator-debug.log');
    try {
      const p = _getPresenceForFlush();
      if (p.status === 'present') {
        try { fs.appendFileSync(dbgLog, `[${new Date().toISOString()}] {"ev":"tick-skip-present","idle_s":${p.idle_s||0}}\n`); } catch {}
        return;
      }
      const r = await _wechatAggregator.tick({
        sendWeChatDirect: async (text, source) => {
          const { execSync } = require('child_process');
          const wechatSh = path.join(vaultRoot, 'Pi', 'Tools', 'notify-wechat.sh');
          try {
            const out = execSync(`bash "${wechatSh}" ${JSON.stringify(text)}`, {
              timeout: 15000, stdio: ['ignore','pipe','pipe'], encoding: 'utf8',
            });
            try { fs.appendFileSync(dbgLog, `[${new Date().toISOString()}] {"ev":"direct-send-ok","len":${text.length},"out":${JSON.stringify((out||'').slice(0,200))}}\n`); } catch {}
            try { global._appendPiMainProactive && global._appendPiMainProactive(text, source || 'wechat-aggregator'); } catch {}
          } catch (e) {
            try { fs.appendFileSync(dbgLog, `[${new Date().toISOString()}] {"ev":"direct-send-fail","err":${JSON.stringify(e.message)},"stderr":${JSON.stringify((e.stderr||'').toString().slice(0,300))}}\n`); } catch {}
            console.error('[wechat-aggregator direct send] failed:', e.message);
          }
        },
      });
      if (r && r.fired) {
        console.log(`[wechat-aggregator] fired reason=${r.reason} count=${r.count||0} fallback=${!!r.fallback} suppressed=${!!r.suppressed}`);
      }
    } catch (e) { console.error('[wechat-aggregator] tick error:', e.message); }
  };

  // (a)
  const _wechatAggTimer = setInterval(_runAggregatorTick, 5 * 60 * 1000);
  app.on('will-quit', () => { if (_wechatAggTimer) clearInterval(_wechatAggTimer); });

  // (b)
  _wechatAggregator.setOnEnqueueTickCb(_runAggregatorTick);

  // (c)
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', () => {
      console.log('[wechat-aggregator] powerMonitor resume → immediate tick');
      _runAggregatorTick().catch(() => {});
    });
  } catch (e) { console.warn('[wechat-aggregator] powerMonitor unavailable:', e.message); }
}

module.exports = { start };
