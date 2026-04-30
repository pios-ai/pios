// Electron headless 自测：加载真实 renderer/bubble.html，启用 starlet + talking pose，
// 隔帧截图看嘴巴位置 / 开合幅度。不改产线代码，不进 build。
// 用法：cd Projects/pios && ./node_modules/.bin/electron scripts/starlet-mouth-selftest.js
//
// 环境变量可调：
//   MOUTH_X / MOUTH_Y / MOUTH_Z  — head bone local 位置偏移
//   MOUTH_W / MOUTH_H            — 椭圆宽高
//   MOUTH_RX / MOUTH_RY / MOUTH_RZ — rotation（弧度）
//   MOUTH_OPACITY / MOUTH_COLOR  — 颜色/不透明
//   POSE                         — 测试哪个 pose（默认 talking）
//   OUT_DIR                      — 截图输出目录（默认 /tmp/starlet-test）
//   FRAMES                       — 截图帧数（默认 6）
//   FRAME_INTERVAL_MS            — 帧间隔（默认 120，嘴巴 4Hz → 半周期 125ms）

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.env.OUT_DIR || '/tmp/starlet-test';
const LOG_PATH = path.join(OUT_DIR, 'selftest.log');
fs.mkdirSync(OUT_DIR, { recursive: true });
function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  try { process.stdout.write(line + '\n'); } catch {}
}
process.on('uncaughtException', (e) => { log('uncaughtException', e.message, e.stack); });
process.on('unhandledRejection', (e) => { log('unhandledRejection', String(e)); });
const POSE = process.env.POSE || 'talking';
const FRAMES = parseInt(process.env.FRAMES || '6', 10);
const FRAME_INTERVAL_MS = parseInt(process.env.FRAME_INTERVAL_MS || '120', 10);

const MOUTH_CFG = {
  x: parseFloat(process.env.MOUTH_X ?? '0'),
  y: parseFloat(process.env.MOUTH_Y ?? '-0.15'),
  z: parseFloat(process.env.MOUTH_Z ?? '0.42'),
  rx: parseFloat(process.env.MOUTH_RX ?? '0'),
  ry: parseFloat(process.env.MOUTH_RY ?? '0'),
  rz: parseFloat(process.env.MOUTH_RZ ?? '0'),
  width: parseFloat(process.env.MOUTH_W ?? '0.18'),
  height: parseFloat(process.env.MOUTH_H ?? '0.06'),
  color: parseInt(process.env.MOUTH_COLOR ?? '0x1a0e14', 16),
  opacity: parseFloat(process.env.MOUTH_OPACITY ?? '0.95'),
  openFreq: 4.0,
  openMin: 0.15,
  openMax: 1.0,
  idleScaleY: 0.25,
};

app.commandLine.appendSwitch('enable-features', 'UseChromeOSDirectVideoDecoder');

app.whenReady().then(async () => {
  log('app ready, OUT_DIR=', OUT_DIR);

  const win = new BrowserWindow({
    width: 420, height: 520,
    show: false,
    transparent: false,
    backgroundColor: '#f5ecd7',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      offscreen: false,
    },
  });

  win.webContents.on('console-message', (_, level, message, line, src) => {
    log('[renderer L' + level + ']', message, 'at', src + ':' + line);
  });
  win.webContents.on('render-process-gone', (_, d) => log('[render-process-gone]', d));
  win.webContents.on('did-fail-load', (_, code, desc, url) => log('[did-fail-load]', code, desc, url));

  const bubblePath = path.join(__dirname, '..', 'renderer', 'bubble.html');
  log('loading', bubblePath);
  await win.loadFile(bubblePath);
  log('loadFile done');

  // 再注入一次（loadFile 后 window 重置）
  await win.webContents.executeJavaScript(`
    window.__STARLET_MOUTH_CFG__ = ${JSON.stringify(MOUTH_CFG)};
    window.__STARLET_TPOSE_AXIS__ = ${JSON.stringify(process.env.TPOSE_AXIS || 'x')};
    window.__STARLET_TPOSE_LIFT__ = ${parseFloat(process.env.TPOSE_LIFT || (Math.PI / 2))};
    document.body.classList.add('npc-enabled');
    document.body.classList.add('npc-huge'); // 最大档，看清嘴巴细节
    applySkin('starlet');
  `);

  // 等 GLB + HDRI 加载（~3s 应足够）
  await new Promise((r) => setTimeout(r, 3500));

  // 切到目标 pose
  await win.webContents.executeJavaScript(`
    (function(){
      const e = document.getElementById('npc-starlet');
      if (e) e.className = ${JSON.stringify(POSE)};
      return 'ok';
    })();
  `);

  // 让 pose 过渡 crossfade 结束
  await new Promise((r) => setTimeout(r, 500));

  // 首先 dump 全部 bone 名字（排查 missing 四肢根因）
  const allBones = await win.webContents.executeJavaScript(`
    (function(){
      if (!starletCtx) return { error: 'no ctx' };
      const out = [];
      starletCtx.scene.traverse(o => {
        out.push({ name: o.name, type: o.type, isBone: !!o.isBone });
      });
      return out.filter(x => x.isBone || /arm|leg|spine|head|neck|root/i.test(x.name));
    })();
  `);
  log('[bone-dump]', JSON.stringify(allBones));

  // 截多帧 + 读骨骼状态验证 tick 2 振荡代码是否真生效
  for (let i = 0; i < FRAMES; i++) {
    const bones = await win.webContents.executeJavaScript(`
      (function(){
        if (!starletCtx || !starletCtx.bones) return { error: 'no ctx' };
        const b = starletCtx.bones;
        const fmt = (x) => typeof x === 'number' ? x.toFixed(4) : 'n/a';
        const armL = b['armL'] || b['arm.L'];
        const armR = b['armR'] || b['arm.R'];
        const legL = b['legL'] || b['leg.L'];
        const legR = b['legR'] || b['leg.R'];
        return {
          armL_z: armL ? fmt(armL.rotation.z) : 'missing',
          armR_z: armR ? fmt(armR.rotation.z) : 'missing',
          legL_x: legL ? fmt(legL.rotation.x) : 'missing',
          legR_x: legR ? fmt(legR.rotation.x) : 'missing',
          head_y: b['head'] ? fmt(b['head'].rotation.y) : 'missing',
        };
      })();
    `);
    log('[bone]', i, JSON.stringify(bones));
    const img = await win.capturePage();
    const outPath = path.join(OUT_DIR, `frame-${String(i).padStart(2, '0')}.png`);
    fs.writeFileSync(outPath, img.toPNG());
    log(`[selftest] saved ${outPath} (${img.getSize().width}x${img.getSize().height})`);
    await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
  }

  // 额外：拍一张 idle pose 对比（嘴应该完全隐藏，露出贴图原嘴）
  await win.webContents.executeJavaScript(`
    (function(){
      const e = document.getElementById('npc-starlet');
      if (e) e.className = 'idle';
      return 'ok';
    })();
  `);
  await new Promise((r) => setTimeout(r, 500));
  const idleImg = await win.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'idle-compare.png'), idleImg.toPNG());
  log('[selftest] saved idle-compare.png');

  log('[selftest] done, cfg=', JSON.stringify(MOUTH_CFG));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
