const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vault = path.resolve(root, '../..');
const bubblePath = path.join(root, 'renderer', 'bubble.html');
const poses = ['idle', 'thinking', 'working', 'sensing', 'reflecting', 'talking', 'recording', 'processing', 'alert', 'tired', 'watching'];
const ids = process.argv.slice(2);

if (!ids.length) {
  console.error('Usage: electron scripts/export-inline-npc-png.js <skin> [skin...]');
  process.exit(1);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function exportPose(win, id, pose, outPath) {
  await win.webContents.executeJavaScript(`
    (() => {
      document.body.className = 'npc-enabled skin-${id}';
      document.documentElement.style.background = 'transparent';
      document.body.style.background = 'transparent';
      document.body.style.margin = '0';
      document.body.style.width = '520px';
      document.body.style.height = '520px';
      document.body.style.overflow = 'hidden';
      const target = document.getElementById('npc-${id}');
      for (const child of Array.from(document.body.children)) {
        if (child !== target) child.style.display = 'none';
      }
      target.className = '${pose}';
      target.style.display = 'block';
      target.style.position = 'absolute';
      target.style.left = '260px';
      target.style.bottom = '120px';
      target.style.width = '256px';
      target.style.height = '256px';
      target.style.transform = 'translateX(-50%)';
      target.style.pointerEvents = 'none';
      target.style.animationPlayState = 'running';
      const svg = target.querySelector('svg');
      if (svg) {
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.overflow = 'visible';
      }
      true;
    })();
  `);
  await sleep(pose === 'talking' ? 160 : 120);
  const rect = await win.webContents.executeJavaScript(`
    (() => {
      const r = document.getElementById('npc-${id}').getBoundingClientRect();
      ({ x: Math.max(0, Math.floor(r.x - 18)), y: Math.max(0, Math.floor(r.y - 18)), width: Math.ceil(r.width + 36), height: Math.ceil(r.height + 36) });
    })();
  `);
  const image = await win.webContents.capturePage(rect);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, image.toPNG());
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 520,
    height: 520,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  await win.loadFile(bubblePath);

  for (const id of ids) {
    const spriteDir = path.join(vault, 'Pi', 'Assets', 'npc', id, 'sprites');
    const runtimeDir = path.join(root, 'renderer', 'assets', id);
    fs.mkdirSync(spriteDir, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    for (const pose of poses) {
      const runtimeOut = path.join(runtimeDir, `${id}-${pose}.png`);
      await exportPose(win, id, pose, runtimeOut);
      fs.copyFileSync(runtimeOut, path.join(spriteDir, `${id}-${pose}.png`));
      console.log(`${id}/${pose}`);
    }
  }

  await win.close();
  app.quit();
}

main().catch(err => {
  console.error(err);
  app.quit();
  process.exit(1);
});
