'use strict';

// 从视频里抽帧，作为图生视频的参考图。
// 用 run.cmd 启动（带 --no-sandbox 和环境变量），不要直接跑 electron。

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const logFile = process.env.DC_LOG || path.join(require('node:os').tmpdir(), 'extract-frame.log');
const lines = [];
function log(msg) {
  lines.push(msg);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, lines.join('\n'), 'utf8');
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => log('unhandled: ' + (e && e.stack ? e.stack : e)));

app.commandLine.appendSwitch('allow-file-access-from-files');

// 本机默认的 %APPDATA% 配置目录创建会被拒绝，导致 Chromium 卡在初始化；显式指到可写目录
app.setPath('userData', path.join(require('node:os').tmpdir(), 'frametool-userdata'));

const video = process.env.DC_VIDEO;
const times = (process.env.DC_TIMES || '1,3,5,7,9,11').split(',').map(Number);
const outDir = process.env.DC_OUT || path.join(__dirname, '..', '..', 'frames');

log('start video=' + video);
log('out=' + outDir);

app.whenReady().then(async () => {
  try {
    if (!video || !fs.existsSync(video)) {
      log('ERR 视频不存在');
      app.exit(1);
      return;
    }
    fs.mkdirSync(outDir, { recursive: true });

    const win = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      webPreferences: { offscreen: false, webSecurity: false },
    });
    await win.loadFile(path.join(__dirname, 'frame.html'));
    log('页面已加载');

    const info = await win.webContents.executeJavaScript(
      `window.setup(${JSON.stringify(path.resolve(video))})`
    );
    log(`视频 ${info.w}x${info.h} ${info.duration.toFixed(2)}s`);

    for (const t of times) {
      if (!(t >= 0) || t > info.duration) continue;
      const dataUrl = await win.webContents.executeJavaScript(`window.grab(${t})`);
      const b64 = String(dataUrl).split(',')[1] || '';
      const file = path.join(outDir, `frame-${String(t).replace('.', '_')}s.png`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      log(`写出 ${path.basename(file)} ${Math.round((b64.length * 0.75) / 1024)} KB`);
    }
    log('完成');
  } catch (e) {
    log('ERR ' + (e && e.stack ? e.stack : e));
  }
  app.exit(0);
});
