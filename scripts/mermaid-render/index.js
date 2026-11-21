const BOOT = 'E:/dp_work/mmd-boot.log';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function boot(m) {
  try {
    fs.appendFileSync(BOOT, m + '\n');
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => boot('uncaught: ' + (e && e.stack)));
process.on('unhandledRejection', (e) => boot('rejection: ' + (e && e.stack ? e.stack : e)));

const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('no-sandbox');
app.setPath('userData', 'E:/dp_work/mmd-tool/userdata');
fs.mkdirSync('E:/dp_work/mmd-tool/userdata', { recursive: true });

const diagrams = require('./diagrams.js');
const OUT = process.env.MMD_OUT || 'E:/dp_work/desktop-companion/docs/assets';
const LOG = 'E:/dp_work/mmd-render.log';

const lines = [];
function log(m) {
  lines.push(m);
  try {
    fs.writeFileSync(LOG, lines.join('\n'), 'utf8');
  } catch {
    /* ignore */
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  log('start, diagrams=' + diagrams.length);

  let win;
  try {
    win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    await win.loadFile(path.join(__dirname, 'render.html'));
    log('page loaded');
  } catch (e) {
    log('FAIL load page: ' + (e && e.message));
    app.exit(1);
    return;
  }

  for (const item of diagrams) {
    try {
      const r = await win.webContents.executeJavaScript(
        `renderToPng(${JSON.stringify(item.code)}, ${item.scale || 2})`
      );
      const b64 = String(r.png || '').split(',')[1] || '';
      if (!b64) throw new Error('空 PNG');
      const file = path.join(OUT, item.name + '.png');
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      log(`saved ${item.name} ${r.w}x${r.h} ${Math.round(b64.length / 1024)}KB -> ${file} exists=${fs.existsSync(file)}`);
    } catch (e) {
      log(`FAIL ${item.name}: ${(e && e.message) || e}`);
    }
  }

  log('done');
  app.exit(0);
});
