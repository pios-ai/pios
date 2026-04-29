'use strict';

// Pi NPC · 派大星状态聚合器
// 把后台信号（runs / notify-history / Cards / gate-state）融合为 bubble:pulse 事件流。
//
// 可插拔约束：
//   - start()/stop() 对称。stop 必须关闭所有 watcher + timer，无残留。
//   - 所有 IO / callback 包 try/catch。内部异常不得冒泡到主进程。
//   - 不添加任何 npm 依赖（避免污染 package.json）。
//
// D2：runs watcher → 推导 Pi 的 4 种主 pose
// D3：notify-history tail → toast；Cards needs_owner → alert
// D4：gate-state → tired；非 pi agent run → watching + satellite

const fs = require('fs');
const path = require('path');
const os = require('os');

// dev-actions event → 展示元数据（icon/verb/dwell），和 pios-engine.TYPE_DISPLAY 保持同步
const DEV_ACTION_TYPE_DISPLAY = {
  change:   { icon: '✍', verb: '修改',     dwell: 5200 },
  verify:   { icon: '✓', verb: '验证通过', dwell: 5200 },
  commit:   { icon: '📦', verb: '提交',     dwell: 5200 },
  rollback: { icon: '↶', verb: '回滚',     dwell: 6500 },
  gate:     { icon: '🚦', verb: '闸门通过', dwell: 5200 },
};
const DEV_ACTION_AGENT_HUE = {
  'pi-triage': 'cyan',
  'sense-maker': 'violet',
  'cron': 'amber',
  'pipeline': 'amber',
  'sentinel': 'amber',
  'auth-health-check': 'amber',
  'codex-worker': 'orange',
  'manual': 'gold',
};
const DEV_ACTION_AGENT_LABEL = {
  'pi-triage': 'Pi',
  'sense-maker': 'Sense',
  'cron': 'Cron',
  'pipeline': 'Pipeline',
  'sentinel': 'Sentinel',
  'auth-health-check': 'Auth',
  'codex-worker': 'Codex',
  'manual': 'Manual',
};

// 卡片徽章权威来源：pios-engine.getOwnerQueue()
// 和 PiOS Home "THINGS NEED YOU" 同源同口径（排除 owner_response_at 已 ack 的卡）
// 不要在这里重写筛选规则 —— 改规则去 pios-engine.js 的 getOwnerQueue
let _getOwnerQueue = null;
let _subscribeChanges = null;
let _buildEvents = null;
try {
  const eng = require('./pios-engine');
  _getOwnerQueue = eng.getOwnerQueue;
  _subscribeChanges = eng.subscribeChanges;   // Cards/Output fs.watch 订阅（同 pios-home SSE 源）
  _buildEvents = eng.buildEvents;             // card stems → 带 agent/hue/verb 的事件数组
} catch {}

// Pi 任务 → pose + 状态文字（只处理 pi agent 的这几个 task）
const POSE_BY_TASK = {
  'triage':      { pose: 'thinking',   label: '分派中' },
  'work':        { pose: 'working',    label: '干活中' },
  'sense-maker': { pose: 'sensing',    label: '对账中' },
  'reflect':     { pose: 'reflecting', label: '反思中' },
};

const RUN_WINDOW_MS     = 30_000;       // 终止态 run 的"余温"窗口
const RUNNING_WINDOW_MS = 20 * 60_000;   // status=running 的保活窗口（兜底防 adapter 不写结束）
const STARTUP_SCAN_MS   = 30 * 60_000;   // 启动扫 runs/ 回溯窗口（最近 30min 的 running 记录）
const TICK_MS           = 5_000;         // 每 5s 重算 & 清理过期
const DEBOUNCE_MS       = 150;           // fs.watch 事件去抖（等文件写完）
const ALERT_HOLD_MS     = 5_000;         // critical 通知来时 alert 姿势持续 5s
const TOAST_MAX_BYTES   = 64 * 1024;     // 单次读 notify-history 最多 64KB，防异常膨胀

const TERMINAL_STATUSES = new Set(['success','error','failed','timeout','interrupted','budget-paused','handed_off']);

class PiPulse {
  constructor(vaultRoot, getBubbleWin) {
    this.vault = vaultRoot;
    this.getBubble = getBubbleWin;
    this.runsDir = path.join(vaultRoot, 'Pi', 'State', 'runs');
    this.notifyLog = path.join(vaultRoot, 'Pi', 'Log', 'notify-history.jsonl');
    this.authPauseFile = path.join(vaultRoot, 'Pi', 'State', 'auth-pause.json');
    this.cardsDir = path.join(vaultRoot, 'Cards', 'active');
    this.devActionsLog = path.join(vaultRoot, 'Pi', 'Log', `dev-actions-${os.hostname().split('.')[0].toLowerCase()}.jsonl`);
    this.recentRuns = new Map();       // task -> { ts, agent }
    this.pendingDebounce = new Map();  // filename -> timeout id
    this.watchers = [];
    this.timer = null;
    this.started = false;
    this.lastPushedKey = '';           // 去重：相同 state 不重复推
    this.talking = false;              // TTS 播放中 → 不让 tick 把 talking 覆盖成 idle
    this.notifyOffset = 0;             // notify-history tail 游标（字节）
    this.notifyDebounce = null;        // notify-history 事件去抖 timer
    this.alertUntil = 0;               // critical 通知的 alert 姿势持续截止 ts
    this.alertTimer = null;            // alert 到期后重算 pose 的 timer
    this.alertBoundToTalking = false;  // critical 通知落地后，若 TTS 开播则 alert 绑 TTS（边跳边说）
    this.userThinking = false;         // 用户发消息 → Claude/Codex 正在 stream（P6 · 2026-04-19）
    this._thinkingTimeout = null;      // 60s 超时兜底：stream 卡死不会永远 thinking
    this.devActionsOffset = 0;         // dev-actions-*.jsonl tail 游标
    this.devActionsDebounce = null;    // dev-actions 事件去抖 timer
    this.recentStreamIds = new Map();  // event.id → ts（去重两条路径：dev-actions tail + subscribeChanges）
    this.streamDedupCleanupTimer = null;
    this.cardChangePending = new Set(); // subscribeChanges 400ms 去抖攒批
    this.cardChangeTimer = null;
    this.unsubCardChanges = null;
    this.authPaused = false;           // auth-pause.json 存在 → tired pose
    this.recentOtherRuns = new Map();  // non-pi agent: agent -> { ts, task }（卫星轨道）
    this.lastBadgeKey = '';            // badge (need/next/stuck) dedupe key
    this.cardsScanTimer = null;        // 卡目录扫描节流 timer
  }

  setTalking(on) {
    this.talking = !!on;
    // TTS 结束 → 解绑 alert（下次 critical 才重新绑）
    if (!on) this.alertBoundToTalking = false;
    // TTS 开始 → 思考完了，自动清 thinking（talking 接管 pose）
    if (on) this._clearThinkingInternal();
    // 翻转时重置 dedupe key 并立即重算 —— 否则 talking→idle 要等 5s tick 才回到真实 pose
    this.lastPushedKey = '';
    try { this._computeAndPush(); } catch {}
  }

  // P6 · 2026-04-19：用户发消息等 Claude/Codex stream 时的"思考中"姿势
  // TTS 开始时 setTalking(true) 会自动清掉 thinking。stream 无 TTS 或卡死时由 60s 超时兜底。
  setThinking(on) {
    this.userThinking = !!on;
    if (on) {
      if (this._thinkingTimeout) clearTimeout(this._thinkingTimeout);
      this._thinkingTimeout = setTimeout(() => {
        this.userThinking = false;
        this.lastPushedKey = '';
        try { this._computeAndPush(); } catch {}
      }, 60_000);
    } else {
      this._clearThinkingInternal();
    }
    this.lastPushedKey = '';
    try { this._computeAndPush(); } catch {}
  }

  _clearThinkingInternal() {
    this.userThinking = false;
    if (this._thinkingTimeout) { clearTimeout(this._thinkingTimeout); this._thinkingTimeout = null; }
  }

  start() {
    if (this.started) return;
    this.started = true;

    // 1. watch Pi/State/runs/ 新文件
    try {
      if (fs.existsSync(this.runsDir)) {
        const w = fs.watch(this.runsDir, (event, filename) => {
          if (!this.started) return;
          if (!filename || !filename.endsWith('.json')) return;
          this._scheduleRead(filename);
        });
        w.on('error', e => console.error('[pi-pulse] watcher error', e));
        this.watchers.push(w);
      } else {
        console.warn('[pi-pulse] runs dir not found:', this.runsDir);
      }
    } catch (e) { console.error('[pi-pulse] watch failed', e); }

    // 2. tail notify-history.jsonl（只关心启动之后的新 line，不重放历史）
    try {
      if (fs.existsSync(this.notifyLog)) {
        this.notifyOffset = fs.statSync(this.notifyLog).size;
        const w = fs.watch(this.notifyLog, () => {
          if (!this.started) return;
          if (this.notifyDebounce) clearTimeout(this.notifyDebounce);
          this.notifyDebounce = setTimeout(() => {
            this.notifyDebounce = null;
            if (!this.started) return;
            this._readNotifyTail();
          }, DEBOUNCE_MS);
        });
        w.on('error', e => console.error('[pi-pulse] notify watcher error', e));
        this.watchers.push(w);
      } else {
        this.notifyOffset = 0;
      }
    } catch (e) { console.error('[pi-pulse] notify watch failed', e); }

    // 2.5. tail dev-actions-{host}.jsonl（每条 agent 动作 → 意识流 tag）
    try {
      if (fs.existsSync(this.devActionsLog)) {
        this.devActionsOffset = fs.statSync(this.devActionsLog).size;
        const w = fs.watch(this.devActionsLog, () => {
          if (!this.started) return;
          if (this.devActionsDebounce) clearTimeout(this.devActionsDebounce);
          this.devActionsDebounce = setTimeout(() => {
            this.devActionsDebounce = null;
            if (!this.started) return;
            this._readDevActionsTail();
          }, DEBOUNCE_MS);
        });
        w.on('error', e => console.error('[pi-pulse] dev-actions watcher error', e));
        this.watchers.push(w);
      } else {
        this.devActionsOffset = 0;
      }
    } catch (e) { console.error('[pi-pulse] dev-actions watch failed', e); }

    // 2.6. 订阅 pios-engine card/output 文件变更（和 pios-home 右下意识流同源）
    //      每次 Cards/Output 任何 .md 改动 → buildEvents → stream-event（400ms 去抖攒批，dedup 与 dev-actions tail）
    try {
      if (typeof _subscribeChanges === 'function' && typeof _buildEvents === 'function') {
        this.unsubCardChanges = _subscribeChanges(({ kind, filename }) => {
          if (!this.started) return;
          if (kind !== 'card') return;
          const stem = String(filename || '').replace(/\.md$/, '').split('/').pop();
          if (!stem) return;
          this.cardChangePending.add(stem);
          if (!this.cardChangeTimer) {
            this.cardChangeTimer = setTimeout(() => this._flushCardChanges(), 400);
          }
        });
      }
    } catch (e) { console.error('[pi-pulse] subscribeChanges failed', e); }

    // 2.7. 定期清理 stream 事件去重缓存（id → ts，60s 外丢掉）
    this.streamDedupCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      for (const [id, ts] of this.recentStreamIds) {
        if (ts < cutoff) this.recentStreamIds.delete(id);
      }
    }, 30_000);

    // 3. watch auth-pause.json（存在 → tired）
    try {
      const stateDir = path.dirname(this.authPauseFile);
      if (fs.existsSync(stateDir)) {
        this.authPaused = fs.existsSync(this.authPauseFile);
        const w = fs.watch(stateDir, (event, filename) => {
          if (!this.started) return;
          if (filename && filename !== 'auth-pause.json') return;
          const prev = this.authPaused;
          this.authPaused = fs.existsSync(this.authPauseFile);
          if (prev !== this.authPaused) { this.lastPushedKey = ''; this._computeAndPush(); }
        });
        w.on('error', e => console.error('[pi-pulse] auth-pause watcher', e));
        this.watchers.push(w);
      }
    } catch (e) { console.error('[pi-pulse] auth-pause watch failed', e); }

    // 4. 首次扫 Cards 徽章；cards dir watcher 触发节流重扫
    this._scanNeedsOwnerBadge();
    try {
      if (fs.existsSync(this.cardsDir)) {
        const w = fs.watch(this.cardsDir, (event, filename) => {
          if (!this.started) return;
          if (!filename || !filename.endsWith('.md')) return;
          if (this.cardsScanTimer) return; // 节流：60s 一次
          this.cardsScanTimer = setTimeout(() => {
            this.cardsScanTimer = null;
            if (!this.started) return;
            this._scanNeedsOwnerBadge();
          }, 60_000);
        });
        w.on('error', e => console.error('[pi-pulse] cards watcher', e));
        this.watchers.push(w);
      }
    } catch (e) { console.error('[pi-pulse] cards watch failed', e); }

    // 5. 启动时回扫：把后台已在跑的 running 记录补进来
    this._seedFromRecentRunning();
    this._computeAndPush();

    // 6. 每 5s 重算 + 清理过期 + 刷 badge（有 lastBadgeKey 去重，count 没变不重推）
    this.timer = setInterval(() => {
      try { this._computeAndPush(); } catch (e) { console.error('[pi-pulse] tick', e); }
      try { this._scanNeedsOwnerBadge(); } catch (e) { console.error('[pi-pulse] badge tick', e); }
    }, TICK_MS);

    console.log('[pi-pulse] started (runs:', this.runsDir, '| notify:', this.notifyLog, ')');
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    // 关闭所有 fs.watch
    for (const w of this.watchers) {
      try { w.close && w.close(); } catch {}
    }
    this.watchers = [];
    // 清 debounce 定时器
    for (const t of this.pendingDebounce.values()) {
      try { clearTimeout(t); } catch {}
    }
    this.pendingDebounce.clear();
    if (this.notifyDebounce) { clearTimeout(this.notifyDebounce); this.notifyDebounce = null; }
    if (this.devActionsDebounce) { clearTimeout(this.devActionsDebounce); this.devActionsDebounce = null; }
    if (this.alertTimer) { clearTimeout(this.alertTimer); this.alertTimer = null; }
    if (this.cardsScanTimer) { clearTimeout(this.cardsScanTimer); this.cardsScanTimer = null; }
    if (this.cardChangeTimer) { clearTimeout(this.cardChangeTimer); this.cardChangeTimer = null; }
    if (this.streamDedupCleanupTimer) { clearInterval(this.streamDedupCleanupTimer); this.streamDedupCleanupTimer = null; }
    if (typeof this.unsubCardChanges === 'function') {
      try { this.unsubCardChanges(); } catch {}
      this.unsubCardChanges = null;
    }
    this.cardChangePending.clear();
    this.recentStreamIds.clear();
    this.recentOtherRuns.clear();
    this.lastBadgeKey = '';
    // 清主 tick
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.recentRuns.clear();
    this.lastPushedKey = '';
    this.alertUntil = 0;
    console.log('[pi-pulse] stopped');
  }

  _scheduleRead(filename) {
    // 去抖：同一文件 150ms 内的多次触发合并成一次读
    const existing = this.pendingDebounce.get(filename);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingDebounce.delete(filename);
      if (!this.started) return;
      this._readRun(path.join(this.runsDir, filename));
    }, DEBOUNCE_MS);
    this.pendingDebounce.set(filename, timer);
  }

  _readRun(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      const r = JSON.parse(raw);
      // pios-adapter.sh 写的 record 用 plugin_name；旧/gate_skipped record 用 task
      const task = r && (r.plugin_name || r.task);
      if (!task) return;
      // 忽略 gate_skipped（没真跑，只是定时器到点但 pre_gate 不满足）
      if (r.status === 'gate_skipped') return;
      const agent = r.agent || 'pi';
      const status = r.status || '';
      const now = Date.now();
      const ttl = status === 'running' ? RUNNING_WINDOW_MS : RUN_WINDOW_MS;
      const entry = { ts: now, expiresAt: now + ttl, agent, status };
      if (agent === 'pi') {
        this.recentRuns.set(task, entry);
      } else {
        this.recentOtherRuns.set(agent, { ...entry, task });
      }
      this._computeAndPush();
    } catch (e) {
      // 半写 JSON 或临时文件，静默忽略
    }
  }

  // 启动时回扫 runs/：最近 30min 内、status=running 的记录塞进 recentRuns
  // 解决"PiOS 重启瞬间，后台任务正在跑，pi-pulse 错过 running 事件"的问题
  _seedFromRecentRunning() {
    try {
      if (!fs.existsSync(this.runsDir)) return;
      const now = Date.now();
      const files = fs.readdirSync(this.runsDir);
      let seeded = 0;
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(this.runsDir, f);
        try {
          const stat = fs.statSync(p);
          if (now - stat.mtimeMs > STARTUP_SCAN_MS) continue;
          const r = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (r.status !== 'running') continue;
          const task = r.plugin_name || r.task;
          if (!task) continue;
          const agent = r.agent || 'pi';
          const entry = { ts: now, expiresAt: now + RUNNING_WINDOW_MS, agent, status: 'running' };
          if (agent === 'pi') this.recentRuns.set(task, entry);
          else this.recentOtherRuns.set(agent, { ...entry, task });
          seeded++;
        } catch {}
      }
      if (seeded > 0) console.log(`[pi-pulse] seeded ${seeded} running record(s) from recent runs/`);
    } catch (e) { console.error('[pi-pulse] seed scan', e); }
  }

  _scanNeedsOwnerBadge() {
    // 委托给 pios-engine.getOwnerQueue（same source of truth as Overview TNY）
    // 和 "THINGS NEED YOU" 同 opts：includeInbox + 不 includeOutputs
    // 关键：getOwnerQueue 会排除 owner_response_at 已写入的卡（防翻旧账）
    if (!_getOwnerQueue) return;
    let count = 0;
    try { count = (_getOwnerQueue({ includeOutputs: false, includeInbox: true }) || []).length | 0; }
    catch (e) { console.error('[pi-pulse] getOwnerQueue', e); return; }
    const key = String(count);
    if (key !== this.lastBadgeKey) {
      this.lastBadgeKey = key;
      this._push({ type: 'badge', count });
    }
  }

  _readNotifyTail() {
    try {
      if (!fs.existsSync(this.notifyLog)) return;
      const size = fs.statSync(this.notifyLog).size;
      // rotate/truncate：文件变小，重置游标
      if (size < this.notifyOffset) this.notifyOffset = 0;
      if (size === this.notifyOffset) return;
      const start = Math.max(this.notifyOffset, size - TOAST_MAX_BYTES);
      const fd = fs.openSync(this.notifyLog, 'r');
      const len = size - start;
      const buf = Buffer.alloc(len);
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      this.notifyOffset = size;
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || !rec.msg) continue;
        const level = (rec.level || 'info').toLowerCase();
        if (level === 'silent') continue;
        this._push({ type: 'toast', level, text: String(rec.msg).slice(0, 140) });
        if (level === 'critical') {
          this.alertUntil = Date.now() + ALERT_HOLD_MS;
          this.alertBoundToTalking = true;  // TTS 一开播就绑 alert，直到 TTS 结束
          if (this.alertTimer) clearTimeout(this.alertTimer);
          this.alertTimer = setTimeout(() => {
            this.alertTimer = null;
            try { this._computeAndPush(); } catch {}
          }, ALERT_HOLD_MS + 50);
        }
      }
      this._computeAndPush();
    } catch (e) { console.error('[pi-pulse] notify tail', e); }
  }

  _readDevActionsTail() {
    try {
      if (!fs.existsSync(this.devActionsLog)) return;
      const size = fs.statSync(this.devActionsLog).size;
      if (size < this.devActionsOffset) this.devActionsOffset = 0;
      if (size === this.devActionsOffset) return;
      const start = Math.max(this.devActionsOffset, size - TOAST_MAX_BYTES);
      const fd = fs.openSync(this.devActionsLog, 'r');
      const len = size - start;
      const buf = Buffer.alloc(len);
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      this.devActionsOffset = size;
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec) continue;
        const type = rec.type || 'change';
        const card = rec.card || '';
        if (!card) continue;
        const agent = rec.agent || 'unknown';
        let display = DEV_ACTION_TYPE_DISPLAY[type] || { icon: '·', verb: '已同步', dwell: 5200 };
        if (type === 'verify' && rec.result === 'fail') display = { icon: '✗', verb: '验证失败', dwell: 6500 };
        if (type === 'gate'   && rec.result === 'fail') display = { icon: '⛔', verb: '闸门未通过', dwell: 6500 };
        const event = {
          id: `pst_${rec.ts || Date.now()}_${card}_${type}`,
          agent,
          agent_label: DEV_ACTION_AGENT_LABEL[agent] || 'Pi',
          hue: DEV_ACTION_AGENT_HUE[agent] || 'gray',
          card,
          card_title: rec.desc || card,
          card_dir: rec.dir || 'active',
          icon: display.icon,
          verb: display.verb,
          dwell: display.dwell,
        };
        this._emitStreamEvent(event);
      }
    } catch (e) { console.error('[pi-pulse] dev-actions tail', e); }
  }

  // 去重入口：同 id 60s 内只推一次。两条路径都走这里：
  //   1) dev-actions jsonl tail（显式事件：verify/commit/gate/rollback 等）
  //   2) subscribeChanges → buildEvents（card 文件变动，含 fallback "已同步"）
  _emitStreamEvent(event) {
    if (!event || !event.id) return;
    const now = Date.now();
    const prev = this.recentStreamIds.get(event.id);
    if (prev && (now - prev) < 60_000) return;  // 已推过，跳过
    this.recentStreamIds.set(event.id, now);
    this._push({ type: 'stream-event', event });
  }

  _flushCardChanges() {
    this.cardChangeTimer = null;
    if (!this.started) return;
    if (!_buildEvents || this.cardChangePending.size === 0) {
      this.cardChangePending.clear();
      return;
    }
    const stems = [...this.cardChangePending];
    this.cardChangePending.clear();
    try {
      const events = _buildEvents(stems) || [];
      for (const ev of events) this._emitStreamEvent(ev);
    } catch (e) { console.error('[pi-pulse] buildEvents', e); }
  }

  _computeAndPush() {
    const now = Date.now();
    // 清理过期：用 entry 自带的 expiresAt（running 20min / 终止态 30s）
    for (const [task, info] of this.recentRuns) {
      if (now > (info.expiresAt || 0)) this.recentRuns.delete(task);
    }
    for (const [agent, info] of this.recentOtherRuns) {
      if (now > (info.expiresAt || 0)) this.recentOtherRuns.delete(agent);
    }
    // 卫星：始终反映 recentOtherRuns（名字数组）
    this._pushSatellite();

    // critical + TTS 播放中 → alert talking 叠加（边跳边说），直到 TTS 结束
    if (this.alertBoundToTalking && this.talking) {
      const key = 'alert-talking|注意';
      if (key === this.lastPushedKey) return;
      this.lastPushedKey = key;
      this._push({ type: 'state', primary: 'alert talking', label: '注意' });
      return;
    }
    // critical 通知 → alert 姿势，5s 内压过一切（包括 talking）
    // 原因：critical 往往伴随 TTS 同时开播；若 talking > alert，跳动会被瞬间压没
    if (now < this.alertUntil) {
      const key = 'alert|注意';
      if (key === this.lastPushedKey) return;
      this.lastPushedKey = key;
      this._push({ type: 'state', primary: 'alert', label: '注意' });
      return;
    }

    // 说话中：把 tick 的 push 锁在 talking，不让 idle/thinking 覆盖 TTS 动画
    if (this.talking) {
      const key = 'talking|说话中';
      if (key === this.lastPushedKey) return;
      this.lastPushedKey = key;
      this._push({ type: 'state', primary: 'talking', label: '说话中' });
      return;
    }

    // P6 · 2026-04-19：用户发消息等 Claude/Codex stream → thinking
    // 优先级在 talking 之下（TTS 一开就让位），但在后台 task pose 之上（用户等比后台任务重要）
    if (this.userThinking) {
      const key = 'thinking|思考中';
      if (key === this.lastPushedKey) return;
      this.lastPushedKey = key;
      this._push({ type: 'state', primary: 'thinking', label: '思考中' });
      return;
    }

    // auth-pause 存在 → tired（AI 引擎配额耗尽，pi 在"睡觉")
    if (this.authPaused) {
      const key = 'tired|没电了';
      if (key === this.lastPushedKey) return;
      this.lastPushedKey = key;
      this._push({ type: 'state', primary: 'tired', label: '没电了' });
      return;
    }

    // 推算 primary pose：Pi agent 的 4 种任务里取最近一条
    let primary = 'idle';
    let label = '';
    let mostRecent = 0;
    for (const [task, info] of this.recentRuns) {
      if (info.agent !== 'pi') continue;  // D4 再处理别的 agent
      const mapping = POSE_BY_TASK[task];
      if (!mapping) continue;
      if (info.ts > mostRecent) {
        mostRecent = info.ts;
        primary = mapping.pose;
        label = mapping.label;
      }
    }

    // 去重
    const key = primary + '|' + label;
    if (key === this.lastPushedKey) return;
    this.lastPushedKey = key;

    this._push({ type: 'state', primary, label });
  }

  _pushSatellite() {
    // 卫星按 agent 名去重并输出，bubble 根据数组长度决定是否 watching + 转球
    const agents = [...this.recentOtherRuns.keys()].sort();
    const key = 'sat|' + agents.join(',');
    if (key === this._lastSatKey) return;
    this._lastSatKey = key;
    this._push({ type: 'satellite', agents });
  }

  _push(payload) {
    try {
      const win = this.getBubble && this.getBubble();
      if (win && !win.isDestroyed()) {
        win.webContents.send('bubble:pulse', payload);
      }
    } catch (e) {
      console.error('[pi-pulse] push', e);
    }
  }
}

module.exports = PiPulse;
