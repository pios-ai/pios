// VRM POC self-test：Electron headless 加载 vrm-poc.html，等 VRM 加载后多帧截图 + dump expression/bone 状态
// 用法：cd Projects/pios && ./node_modules/.bin/electron scripts/vrm-poc-selftest.js
//
// 目的：证明 @pixiv/three-vrm 技术链路 work（loader + expression + humanoid bone），不关心风格。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.env.OUT_DIR || '/tmp/vrm-poc';
fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'poc.log');
function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  try { process.stdout.write(line + '\n'); } catch {}
}
process.on('uncaughtException', (e) => log('uncaughtException', e.message, e.stack));
process.on('unhandledRejection', (e) => log('unhandledRejection', String(e)));

const FRAMES = parseInt(process.env.FRAMES || '8', 10);
const INTERVAL = parseInt(process.env.INTERVAL || '150', 10);

app.whenReady().then(async () => {
  log('ready, OUT_DIR=', OUT_DIR);

  const win = new BrowserWindow({
    width: 500, height: 700,
    show: false,
    backgroundColor: '#f5ecd7',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_, level, message, line, src) => {
    log('[renderer L' + level + ']', message);
  });
  win.webContents.on('did-fail-load', (_, code, desc, url) => log('[did-fail-load]', code, desc, url));
  win.webContents.on('render-process-gone', (_, d) => log('[render-gone]', d));

  const htmlPath = path.join(__dirname, 'vrm-poc.html');
  log('loading', htmlPath);
  await win.loadFile(htmlPath);
  log('loadFile done');

  // 轮询等 POC ready（vrm load 可能要 3-5s）
  let waited = 0;
  while (waited < 15000) {
    const ready = await win.webContents.executeJavaScript('!!window.__vrm');
    if (ready) { log('vrm ready after', waited, 'ms'); break; }
    await new Promise(r => setTimeout(r, 250));
    waited += 250;
  }
  if (waited >= 15000) log('WARN: VRM never reached ready state');

  // 等一会让动画跑起来
  await new Promise(r => setTimeout(r, 500));

  // Dump 诊断信息
  const diag = await win.webContents.executeJavaScript(`
    (function(){
      const vrm = window.__vrm;
      if (!vrm) return { error: 'no vrm' };
      const em = vrm.expressionManager;
      const hum = vrm.humanoid;
      return {
        expressions: em ? Object.keys(em.expressionMap || {}) : null,
        hasSpring: !!vrm.springBoneManager,
        hasLookAt: !!vrm.lookAt,
        humanoidBones: hum ? [
          'head','neck','spine','hips',
          'leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm',
          'leftHand','rightHand',
          'leftUpperLeg','rightUpperLeg',
          'leftIndexProximal','rightIndexProximal',
        ].filter(b => hum.getNormalizedBoneNode(b)) : null,
        meta: vrm.meta ? { name: vrm.meta.name, version: vrm.meta.metaVersion || vrm.meta.version } : null,
      };
    })();
  `);
  log('DIAG', JSON.stringify(diag));

  // 多帧截图看嘴巴+手臂动画
  for (let i = 0; i < FRAMES; i++) {
    const img = await win.capturePage();
    const p = path.join(OUT_DIR, `frame-${String(i).padStart(2, '0')}.png`);
    fs.writeFileSync(p, img.toPNG());
    log('saved', p, `(${img.getSize().width}x${img.getSize().height})`);
    await new Promise(r => setTimeout(r, INTERVAL));
  }

  log('done');
  app.quit();
});

app.on('window-all-closed', () => app.quit());
