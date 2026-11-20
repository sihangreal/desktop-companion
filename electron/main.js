'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, globalShortcut, protocol, net, screen } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const store = require('./store');
const logger = require('./logger');

const ROOT = path.join(__dirname, '..');
const isDev = process.argv.includes('--dev');

// 打包后程序目录通常不可写，用户数据要放到 LOCALAPPDATA
const isPackaged = app.isPackaged;
const APP_DATA_BASE =
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local');

// ---------------------------------------------------------------- 本机适配
// 这台机器的 Chromium 沙箱无法初始化（WebView2 也因同样原因崩溃），
// 且默认的 %APPDATA%（Roaming）配置目录创建会阻塞初始化。
// 这两处适配在任何 Windows 机器上都不会造成功能差异。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// userData 固定到应用目录下的 data/（开发）或 LOCALAPPDATA（打包）。
// 本机对 %APPDATA% / %LOCALAPPDATA% 的写入偶发 ACCESS DENIED，
// 所以这里做一次可写性探测，失败就退回程序目录下的 data/。
function pickUserDataDir() {
  const preferred = isPackaged ? path.join(APP_DATA_BASE, 'DesktopCompanion') : path.join(ROOT, 'data');
  const fallback = path.join(ROOT, 'data');
  for (const dir of [preferred, fallback]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* 试下一个 */
    }
  }
  return preferred;
}

const userDataDir = pickUserDataDir();
app.setPath('userData', userDataDir);

let win = null;
let tray = null;
let quitting = false;
let config = null;
let configPath = null;
let lastBoundsSave = 0;

// 单实例：第二个实例直接把已有窗口叫到前面。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.setAppUserModelId('com.deskcompanion.desktop');

// 自定义协议：让渲染进程能播放本地视频/封面，同时不必放开 file:// 权限。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dcasset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// ------------------------------------------------------------------ 配置

function persistBounds() {
  if (!win || win.isDestroyed()) return;
  // 全屏桌面模式下窗口尺寸是屏幕尺寸，不能覆盖掉窗口模式的位置
  if (config.mode === 'desktop') return;
  const now = Date.now();
  if (now - lastBoundsSave < 400) return;
  lastBoundsSave = now;
  const b = win.getBounds();
  config.window = { x: b.x, y: b.y, width: b.width, height: b.height };
  store.save(configPath, config);
}

/** 两种模式：window = 悬浮小窗；desktop = 铺满屏幕的壁纸层 */
function applyMode(mode, save = true) {
  if (!win || win.isDestroyed()) return;
  const desktop = mode === 'desktop';

  if (desktop) {
    const d = screen.getPrimaryDisplay().bounds;
    win.setAlwaysOnTop(false);
    win.setFocusable(false);
    win.setSkipTaskbar(true);
    win.setBounds({ x: d.x, y: d.y, width: d.width, height: d.height });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.blur();
  } else {
    const b = config.window || {};
    win.setFocusable(true);
    win.setAlwaysOnTop(true);
    win.setBounds({
      x: typeof b.x === 'number' ? b.x : 120,
      y: typeof b.y === 'number' ? b.y : 120,
      width: b.width || 480,
      height: b.height || 720,
    });
    // 窗口模式一律可点：穿透只服务于全屏壁纸，否则整个小窗都点不动
    win.setIgnoreMouseEvents(false);
    config.clickThrough = false;
  }

  config.mode = mode;
  if (save) store.save(configPath, config);

  // 只有全屏模式需要轮询光标，做局部点击接管
  if (desktop) startHoverWatch();
  else stopHoverWatch();

  win.webContents.send('mode:changed', { mode });
  logger.log(`模式切换为 ${mode}`);
}

function toggleMode() {
  applyMode(config.mode === 'desktop' ? 'window' : 'desktop');
}

// ------------------------------------------------------------------ 密钥

function secretPath() {
  return path.join(app.getPath('userData'), 'secret.bin');
}

function setApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，无法安全保存密钥');
  }
  fs.mkdirSync(path.dirname(secretPath()), { recursive: true });
  fs.writeFileSync(secretPath(), safeStorage.encryptString(key));
}

function hasApiKey() {
  try {
    const buf = fs.readFileSync(secretPath());
    return safeStorage.decryptString(buf).trim().length > 0;
  } catch {
    return false;
  }
}

function clearApiKey() {
  try {
    fs.unlinkSync(secretPath());
  } catch {
    /* 本来就没有 */
  }
}

function getApiKey() {
  try {
    return safeStorage.decryptString(fs.readFileSync(secretPath()));
  } catch {
    return null;
  }
}

/// 把 16-bit 单声道 PCM 包成 WAV 头。
function pcmToWav(pcm, sampleRate) {
  const head = Buffer.alloc(44);
  const blockAlign = 2;
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * blockAlign, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// ------------------------------------------------------------------ 窗口

function createWindow() {
  const { width, height, x, y } = config.window;
  const opts = {
    width: width || 480,
    height: height || 720,
    minWidth: 360,
    minHeight: 480,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 桌面模式下窗口在别的窗口后面，不能让 Chromium 把音频/定时器节流掉
      backgroundThrottling: false,
      // 允许视频带声音自动播放（壁纸本身有音轨，不能靠用户手势解锁）
      autoplayPolicy: 'no-user-gesture-required',
    },
  };
  if (typeof x === 'number' && typeof y === 'number') {
    opts.x = x;
    opts.y = y;
  }

  win = new BrowserWindow(opts);
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (config.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    win.show();
    logger.log('窗口已显示');
  });

  // 关闭按钮只隐藏，真正退出走托盘
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

// ------------------------------------------------------------------ 托盘

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function createTray() {
  const iconPath = path.join(ROOT, 'assets', 'icon-32.png');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('桌面陪伴');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: toggleWindow },
      { label: '全屏 / 窗口', click: toggleMode },
      {
        label: '设置',
        click: () => {
          if (!win) return;
          win.show();
          win.focus();
          win.webContents.send('settings:open');
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', () => {
    if (!win) return;
    win.show();
    win.focus();
  });
}

// ------------------------------------------------------------------ IPC

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  configPath,
  logDir: path.dirname(logger.logFile || ''),
  dataDir: app.getPath('userData'),
  hasApiKey: hasApiKey(),
  clickThrough: !!config.clickThrough,
  mode: config.mode || 'window',
  playMode: config.playMode || 'single',
  rotateSeconds: config.rotateSeconds || 60,
  rotateScope: config.rotateScope || 'all',
  favorites: Array.isArray(config.favorites) ? config.favorites : [],
  volume: typeof config.volume === 'number' ? config.volume : 70,
  muted: !!config.muted,
}));

// 通用设置写入（播放方式、停留时间、随机范围、收藏、音量）
ipcMain.handle('config:set', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    for (const key of ['playMode', 'rotateSeconds', 'rotateScope', 'favorites', 'volume', 'muted']) {
      if (key in patch) config[key] = patch[key];
    }
    store.save(configPath, config);
    logger.log(
      `设置更新 ${JSON.stringify({
        playMode: config.playMode,
        rotateSeconds: config.rotateSeconds,
        rotateScope: config.rotateScope,
        favorites: (config.favorites || []).length,
        volume: config.volume,
        muted: !!config.muted,
      })}`
    );
  }
  return {
    playMode: config.playMode || 'single',
    rotateSeconds: config.rotateSeconds || 60,
    rotateScope: config.rotateScope || 'all',
    favorites: Array.isArray(config.favorites) ? config.favorites : [],
    volume: typeof config.volume === 'number' ? config.volume : 70,
    muted: !!config.muted,
  };
});

ipcMain.handle('mode:set', (_e, mode) => {
  applyMode(mode === 'desktop' ? 'desktop' : 'window');
  return config.mode;
});

ipcMain.handle('mode:toggle', () => {
  toggleMode();
  return config.mode;
});

ipcMain.handle('secret:set', (_e, key) => {
  const v = String(key || '').trim();
  if (v.length < 8) throw new Error('Key 长度不足，请检查是否复制完整');
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(v)) {
    throw new Error('这看起来不是 API Key：应以 sk- 开头；请从 platform.deepseek.com 复制，不要粘贴命令或路径');
  }
  setApiKey(v);
  logger.log('API Key 已加密保存');
  return true;
});

ipcMain.handle('secret:clear', () => {
  clearApiKey();
  logger.log('API Key 已清除');
  return true;
});

ipcMain.handle('window:clickThrough', (_e, enabled) => {
  const on = !!enabled;
  // 只有全屏桌面模式才有穿透的意义
  if (config.mode !== 'desktop') {
    if (win) win.setIgnoreMouseEvents(false);
    config.clickThrough = false;
    return false;
  }
  if (win) win.setIgnoreMouseEvents(on, { forward: true });
  config.clickThrough = on;
  store.save(configPath, config);
  return on;
});

// 全屏模式下按需接管鼠标：主进程轮询光标位置，落在界面热区上时才关闭穿透。
// 不依赖渲染进程的 mousemove —— 全屏且不可聚焦的窗口收不到鼠标移动事件。
let hitRect = null; // 相对窗口内容区的热区；null 表示整窗可交互
let hoverActive = false;
let hoverTimer = null;

ipcMain.on('ui:hitrect', (_e, rect) => {
  hitRect = rect && typeof rect.w === 'number' ? rect : null;
});

function startHoverWatch() {
  stopHoverWatch();
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed() || config.mode !== 'desktop') return;

    let over = true;
    if (hitRect) {
      const b = win.getContentBounds();
      const p = screen.getCursorScreenPoint();
      const x = b.x + hitRect.x;
      const y = b.y + hitRect.y;
      over = p.x >= x && p.x <= x + hitRect.w && p.y >= y && p.y <= y + hitRect.h;
    }

    if (over !== hoverActive) {
      hoverActive = over;
      win.setIgnoreMouseEvents(!over, { forward: true });
    }
  }, 80);
}

function stopHoverWatch() {
  if (hoverTimer) {
    clearInterval(hoverTimer);
    hoverTimer = null;
  }
  hoverActive = false;
}

ipcMain.handle('window:interactive', (_e, on) => {
  if (!win || config.mode !== 'desktop') return false;
  win.setIgnoreMouseEvents(!on, { forward: true });
  return true;
});

// 渲染进程的调试日志，落到 main.log，便于排查点击/播放问题
ipcMain.on('ui:log', (_e, message) => {
  logger.log(`[ui] ${String(message).slice(0, 300)}`);
});

ipcMain.handle('window:hide', () => {
  if (win) win.hide();
  return true;
});

// ASR：接收渲染进程录好的 16k 单声道 PCM，封装 WAV 后整段提交。
ipcMain.handle('asr:transcribe', async (_e, pcmArray) => {
  const key = getApiKey();
  if (!key) throw new Error('未配置 API Key');

  const pcm = Buffer.from(pcmArray);
  if (pcm.length < 3200) throw new Error('录音太短（不足 100ms）');
  if (pcm.length > 16 * 1024 * 1024) throw new Error('录音过长，超过 8MB 上限');

  const wav = pcmToWav(pcm, 16000);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');

  const t0 = Date.now();
  const res = await fetch('https://api.deepseek.com/v1/tools/asr', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const ms = Date.now() - t0;

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    logger.error(`ASR 失败 HTTP ${res.status}: ${body}`);
    if (res.status === 401) throw new Error('Key 无效或已失效（401）');
    if (res.status === 429) throw new Error('请求过于频繁（429），稍后再试');
    if (res.status === 400) throw new Error(`音频格式被拒绝（400）：${body}`);
    throw new Error(`识别失败 HTTP ${res.status}`);
  }

  const j = await res.json();
  logger.log(`ASR 完成 ${ms}ms 音频 ${j.duration_ms}ms 文本长度 ${(j.text || '').length}`);
  return { text: (j.text || '').trim(), ms, durationMs: j.duration_ms || 0 };
});

ipcMain.handle('app:quit', () => {
  quitting = true;
  app.quit();
  return true;
});

// ---------------------------------------------------------------- 衣橱（M3）

let looksCache = null;

function looksPath() {
  return path.join(app.getPath('userData'), 'looks.json');
}

function loadLooks() {
  if (looksCache) return looksCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(looksPath(), 'utf8'));
    looksCache = Array.isArray(parsed.looks) ? parsed : { looks: [] };
  } catch {
    looksCache = { looks: [] };
  }

  // 没有清单，或清单里的文件都不在了（换机器/删了素材）→ 用内置的那一套
  const usable = (looksCache.looks || []).filter((l) => l && fs.existsSync(l.video));
  if (!usable.length) {
    looksCache = makeDefaultLooks() || { looks: [] };
  } else if (usable.length !== looksCache.looks.length) {
    looksCache = { ...looksCache, looks: usable };
  }
  return looksCache;
}

/** 内置的兜底装扮：安装包自带一段视频，保证首次启动就能看到画面 */
function makeDefaultLooks() {
  const dir = path.join(ROOT, 'assets', 'default-look');
  const video = path.join(dir, 'look-01.webm');
  if (!fs.existsSync(video)) return null;

  const manifest = {
    source: dir,
    generatedAt: new Date().toISOString(),
    count: 1,
    builtin: true,
    looks: [
      {
        id: 'default-01',
        name: '夜色红底',
        short: '夜色红底',
        english: 'A SECRET IN RED',
        group: 'classic',
        video,
        cover: fs.existsSync(path.join(dir, 'look-01.jpg')) ? path.join(dir, 'look-01.jpg') : null,
        coverPos: '84% 20%',
        duration: 12,
        freeze: 10.5,
        locked: false,
      },
    ],
  };

  try {
    fs.mkdirSync(path.dirname(looksPath()), { recursive: true });
    fs.writeFileSync(looksPath(), JSON.stringify(manifest, null, 2), 'utf8');
    logger.log(`没有可用装扮，已写入内置兜底清单 ${looksPath()}`);
  } catch (e) {
    logger.error(`写入内置清单失败: ${e.message}`);
  }
  return manifest;
}

function assetUrl(id, kind) {
  return `dcasset://look/${encodeURIComponent(id)}/${kind}`;
}

function registerAssetProtocol() {
  protocol.handle('dcasset', async (request) => {
    try {
      const u = new URL(request.url);
      const parts = u.pathname.split('/').filter(Boolean);
      const id = decodeURIComponent(parts[0] || '');
      const kind = parts[1] || 'video';
      const manifest = loadLooks();
      const look = manifest.looks.find((l) => l.id === id);
      if (!look) return new Response('look not found', { status: 404 });
      const file = kind === 'cover' ? look.cover : kind === 'speaking' ? look.speakingVideo : look.video;
      if (!file || !fs.existsSync(file)) return new Response('file missing', { status: 404 });
      return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
    } catch (e) {
      return new Response('asset error: ' + e.message, { status: 500 });
    }
  });
}

ipcMain.handle('looks:list', () => {
  const m = loadLooks();
  // 旧配置里的装扮可能已经不存在（换机器/删素材），要回退到第一套
  const saved = config.currentLookId;
  const valid = m.looks.some((l) => l.id === saved);
  return {
    source: m.source || '',
    count: m.looks.length,
    builtin: !!m.builtin,
    currentId: valid ? saved : (m.looks[0] && m.looks[0].id) || null,
    looks: m.looks.map((l) => ({
      id: l.id,
      name: l.name,
      short: l.short,
      group: l.group,
      videoUrl: assetUrl(l.id, 'video'),
      speakingUrl: l.speakingVideo ? assetUrl(l.id, 'speaking') : null,
      coverUrl: l.cover ? assetUrl(l.id, 'cover') : null,
      coverPos: l.coverPos || '84% 20%',
    })),
  };
});

ipcMain.handle('look:set', (_e, id) => {
  config.currentLookId = String(id);
  store.save(configPath, config);
  logger.log(`切换装扮 ${id}`);
  return true;
});

// ---------------------------------------------------------------- 对话（M2）

const BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-chat';
const MAX_HISTORY_TURNS = 12;

const PERSONA = `你是一个住在用户桌面上的陪伴型角色，中文女性，名字叫小夜。
说话要求：
- 只用口语，像真人聊天，不要书面语、不要列表、不要 Markdown、不要 emoji、不要括号注释。
- 每次回复不超过 45 个汉字，通常一到两句。
- 不要自称 AI 或助手，不要解释你在做什么。
- 语气温柔但不腻，可以有点小情绪和小调侃。
- 第一行只输出情绪标记，形如 [emotion:happy]，可选值：neutral happy shy worried sad curious playful。
- 第二行开始是你的正文。`;

const history = [];

async function* readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (delta && delta.content) yield delta.content;
      } catch {
        /* 忽略不完整分片 */
      }
    }
  }
}

function splitSentences(text, force = false) {
  const out = [];
  let buf = '';
  const marks = '。！？；，、,.!?;';
  for (const ch of text) {
    buf += ch;
    if (marks.includes(ch) || buf.length >= 24) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf && (force || buf.length >= 8)) {
    out.push(buf);
    buf = '';
  }
  return { sentences: out, rest: buf };
}

async function synthesize(key, text, voiceId) {
  const res = await fetch(`${BASE_URL}/v1/tools/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voiceId, format: 'pcm', filter_markdown: true }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    throw new Error(`TTS HTTP ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function speakable(s) {
  return s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*#_`>[\]]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .trim();
}

ipcMain.handle('chat:turn', async (_e, userText) => {
  const key = getApiKey();
  if (!key) throw new Error('未配置 API Key');

  const send = (type, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('reply:event', { type, ...payload });
  };

  history.push({ role: 'user', content: userText });
  while (history.length > MAX_HISTORY_TURNS * 2) history.shift();

  const t0 = Date.now();
  let firstTokenMs = 0;
  let full = '';
  let emotion = 'neutral';
  let pending = '';
  let bodyStarted = false;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: PERSONA }, ...history],
      stream: true,
      max_tokens: 200,
      temperature: 1.1,
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    history.pop();
    if (res.status === 401) throw new Error('Key 无效（401）');
    if (res.status === 429) throw new Error('请求过于频繁（429）');
    throw new Error(`LLM HTTP ${res.status}: ${body}`);
  }

  try {
    for await (const token of readSse(res)) {
      if (!firstTokenMs) {
        firstTokenMs = Date.now() - t0;
        send('first-token', { ms: firstTokenMs });
      }

      // 首行情绪标记：解析后从正文剔除
      if (!bodyStarted) {
        pending += token;
        const m = pending.match(/^\s*\[emotion:\s*([a-z]+)\s*\]\s*\n?/i);
        if (m) {
          emotion = m[1].toLowerCase();
          pending = pending.slice(m[0].length);
          bodyStarted = true;
          send('emotion', { emotion });
        } else if (pending.includes('\n') && !/^\s*\[emotion/i.test(pending)) {
          bodyStarted = true;
        } else {
          continue;
        }
      } else {
        pending += token;
      }

      const { sentences, rest } = splitSentences(pending);
      pending = rest;
      for (const sentence of sentences) {
        const clean = speakable(sentence);
        if (!clean) continue;
        full += sentence;
        send('delta', { text: sentence });
        try {
          send('audio', { pcm: await synthesize(key, clean, config.voiceId || 'stella') });
        } catch (e) {
          send('warn', { message: e.message });
        }
      }
    }

    // 收尾：处理最后不足一句的残余
    for (const sentence of splitSentences(pending, true).sentences) {
      const clean = speakable(sentence);
      if (!clean) continue;
      full += sentence;
      send('delta', { text: sentence });
      try {
        send('audio', { pcm: await synthesize(key, clean, config.voiceId || 'stella') });
      } catch (e) {
        send('warn', { message: e.message });
      }
    }

    history.push({ role: 'assistant', content: speakable(full) || '……' });
    const totalMs = Date.now() - t0;
    logger.log(
      `对话完成 首token ${firstTokenMs}ms 总 ${totalMs}ms 情绪 ${emotion} 字数 ${speakable(full).length}`
    );
    send('done', { emotion, totalMs, text: full });
    return { emotion, text: full, firstTokenMs, totalMs };
  } catch (e) {
    history.pop();
    logger.error(`对话失败: ${e.message}`);
    send('error', { message: e.message });
    throw e;
  }
});

// ------------------------------------------------------------------ 生命周期

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  // 日志初始化失败不能拖垮程序：部分环境下 Chromium 子进程可能无权建目录。
  try {
    logger.init(path.join(userData, 'logs'));
  } catch (e) {
    console.error('日志目录创建失败:', e && e.message);
  }
  configPath = path.join(userData, 'config.json');
  config = store.load(configPath);
  logger.log(`启动 v${app.getVersion()}  data=${userData}`);
  console.log(`[boot] v${app.getVersion()} data=${userData}`);

  registerAssetProtocol();
  createWindow();
  createTray();

  // 恢复上次的模式（全屏壁纸 / 悬浮小窗）
  applyMode(config.mode === 'desktop' ? 'desktop' : 'window', false);

  // 全局热键：按一下开始录音，再按一下结束（VAD 也会自动收尾）。
  const registered = globalShortcut.register('Control+Shift+Space', () => {
    if (win && !win.isDestroyed()) win.webContents.send('ptt:toggle');
  });
  logger.log(`热键 Ctrl+Shift+Space 注册${registered ? '成功' : '失败'}`);
  if (!registered) console.error('[hotkey] 注册失败，可能被其他程序占用');

  // 全屏 / 窗口切换
  const modeKey = globalShortcut.register('Control+Shift+M', toggleMode);
  logger.log(`热键 Ctrl+Shift+M 注册${modeKey ? '成功' : '失败'}`);

  // 自动化冒烟：DC_UI_TEST=chat 触发一轮对话，观察空闲/说话视频是否切换
  if (process.env.DC_UI_TEST === 'chat') {
    setTimeout(async () => {
      try {
        const seq = [];
        win.webContents.executeJavaScript(`window.companion.sendChat('你好，随便说句话')`).catch(() => {});
        for (let i = 0; i < 14; i += 1) {
          const src = await win.webContents.executeJavaScript(
            `(document.querySelector('.bgvid.active')?.dataset.src || '').split('/').pop()`
          );
          if (!seq.length || seq[seq.length - 1] !== src) seq.push(src);
          await new Promise((r) => setTimeout(r, 1000));
        }
        logger.log(`[test] 视频切换序列: ${seq.join(' -> ')}`);
      } catch (e) {
        logger.error(`[test] chat 失败: ${e.message}`);
      }
    }, 5000);
  }

  // 自动化冒烟：DC_UI_TEST=audio 检查视频是否真的在解码音频
  if (process.env.DC_UI_TEST === 'audio') {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(() => {
          const v = document.querySelector('.bgvid.active');
          if (!v) return 'no active video';
          return JSON.stringify({
            muted: v.muted,
            volume: v.volume,
            paused: v.paused,
            audioBytes: v.webkitAudioDecodedByteCount,
            videoBytes: v.webkitVideoDecodedByteCount,
            duration: Math.round(v.duration * 10) / 10,
          });
        })()`);
        logger.log(`[test] 视频音频: ${r}`);
      } catch (e) {
        logger.error(`[test] 视频音频失败: ${e.message}`);
      }
    }, 6000);
  }

  // 自动化冒烟：DC_UI_TEST=playmodes 验证收藏、播放方式与随机范围
  if (process.env.DC_UI_TEST === 'playmodes') {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => {
          document.getElementById('desk-wardrobe')?.click();
          await new Promise((r) => setTimeout(r, 500));
          const hearts = document.querySelectorAll('.wardrobe-item .fav');
          hearts[0]?.click();
          hearts[1]?.click();
          await new Promise((r) => setTimeout(r, 400));
          const sel = document.getElementById('sel-mode');
          sel.value = 'sequence';
          sel.dispatchEvent(new Event('change'));
          await new Promise((r) => setTimeout(r, 300));
          document.getElementById('btn-scope').click();
          await new Promise((r) => setTimeout(r, 300));
          const on = [...document.querySelectorAll('.wardrobe-item .fav')].map((b) => (b.classList.contains('on') ? '1' : '0')).join('');
          return 'hearts=' + on + ' mode=' + sel.value + ' scope=' + document.getElementById('btn-scope').textContent;
        })()`);
        logger.log(`[test] 播放方式: ${r}`);
      } catch (e) {
        logger.error(`[test] 播放方式失败: ${e.message}`);
      }
    }, 4000);
  }

  // 自动化冒烟：DC_UI_TEST=wardrobe 模拟点击衣橱并换一套；wardrobe-open 只打开不换
  if (process.env.DC_UI_TEST === 'wardrobe' || process.env.DC_UI_TEST === 'wardrobe-open' || process.env.DC_UI_TEST === 'random') {
    const mode = process.env.DC_UI_TEST;
    const openOnly = mode === 'wardrobe-open';
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => {
          document.getElementById('desk-wardrobe')?.click();
          const items = document.querySelectorAll('.wardrobe-item');
          if (!items.length) return 'no items rendered';
          ${mode === 'random'
            ? `document.getElementById('btn-random').click();
               await new Promise((r) => setTimeout(r, 600));
               document.getElementById('btn-random').click();`
            : openOnly
              ? ''
              : "items[Math.min(2, items.length - 1)].click();"}
          await new Promise((res) => setTimeout(res, 900));
          const open = !document.querySelector('.wardrobe').classList.contains('hidden');
          const imgs = [...document.querySelectorAll('.wardrobe-item img')].slice(0, 2).map((i) => {
            const r = i.getBoundingClientRect();
            return Math.round(r.width) + 'x' + Math.round(r.height) + ' nat=' + i.naturalWidth + 'x' + i.naturalHeight;
          }).join(' ; ');
          const sp = document.querySelector('.wardrobe-item span');
          const sr = sp ? sp.getBoundingClientRect() : null;
          const label = sp ? sp.textContent + '@' + Math.round(sr.width) + 'x' + Math.round(sr.height) : 'none';
          return 'items=' + items.length + ' open=' + open + ' imgs=' + imgs + ' label=' + label;
        })()`);
        logger.log(`[test] 衣橱: ${r}`);
      } catch (e) {
        logger.error(`[test] 衣橱失败: ${e.message}`);
      }
    }, 4000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((e) => {
  console.error('[fatal] 启动失败:', e);
});

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  persistBounds();
});

// 托盘常驻：窗口全关也不退出
app.on('window-all-closed', () => {
  /* 故意留空 */
});
