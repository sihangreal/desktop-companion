'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, globalShortcut, protocol, net, screen } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const store = require('./store');
const logger = require('./logger');
const engine = require('./engine');
const { SessionStore, dateKey } = require('./session');
const { PersonaStore } = require('./persona');
const promptBuilder = require('./prompt');
const { MemoryStore } = require('./memory');
const { removeLook } = require('./looks-admin');
const memoryJob = require('./memory-job');
const asrProvider = require('./providers/asr');

// 三路默认配置；用户可在 data/config.json 的 providers 里逐项覆盖
const DEFAULT_PROVIDERS = {
  llm: {
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyRef: 'deepseek',
  },
  asr: {
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: '',
    keyRef: 'deepseek',
    language: 'zh',
  },
  tts: {
    kind: 'mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: '冰糖',
    keyRef: 'mimo',
  },
};

function providerConfig() {
  const p = (config && config.providers) || {};
  return {
    llm: { ...DEFAULT_PROVIDERS.llm, ...(p.llm || {}) },
    asr: { ...DEFAULT_PROVIDERS.asr, ...(p.asr || {}) },
    tts: { ...DEFAULT_PROVIDERS.tts, ...(p.tts || {}) },
  };
}

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
// 三路可各用各的 Key：deepseek 沿用旧的 secret.bin，其它 provider 用 secret-<ref>.bin

function secretPathFor(ref = 'deepseek') {
  const dir = app.getPath('userData');
  return ref === 'deepseek' ? path.join(dir, 'secret.bin') : path.join(dir, `secret-${ref}.bin`);
}

function setKey(ref, key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，无法安全保存密钥');
  }
  const file = secretPathFor(ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(key));
}

function hasKey(ref) {
  try {
    const buf = fs.readFileSync(secretPathFor(ref));
    return safeStorage.decryptString(buf).trim().length > 0;
  } catch {
    return false;
  }
}

function clearKey(ref) {
  try {
    fs.unlinkSync(secretPathFor(ref));
  } catch {
    /* 本来就没有 */
  }
}

function getKey(ref) {
  // 开发/测试便捷：环境变量优先（MIMO_KEY / DEEPSEEK_KEY）
  const envName = `${String(ref).toUpperCase()}_KEY`;
  if (process.env[envName]) return process.env[envName];
  try {
    return safeStorage.decryptString(fs.readFileSync(secretPathFor(ref)));
  } catch {
    return null;
  }
}

// 兼容旧调用
const setApiKey = (key) => setKey('deepseek', key);
const hasApiKey = () => hasKey('deepseek');
const clearApiKey = () => clearKey('deepseek');
const getApiKey = () => getKey('deepseek');

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
  hasKeys: { deepseek: hasKey('deepseek'), mimo: hasKey('mimo') },
  engine: config.engine || 'v2',
  providers: providerConfig(),
  clickThrough: !!config.clickThrough,
  mode: config.mode || 'window',
  playMode: config.playMode || 'single',
  rotateSeconds: config.rotateSeconds || 60,
  rotateScope: config.rotateScope || 'all',
  favorites: Array.isArray(config.favorites) ? config.favorites : [],
  volume: typeof config.volume === 'number' ? config.volume : 70,
  muted: !!config.muted,
  recordPaused: !!config.recordPaused,
}));

// 通用设置写入（播放方式、停留时间、随机范围、收藏、音量）
ipcMain.handle('config:set', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    for (const key of ['playMode', 'rotateSeconds', 'rotateScope', 'favorites', 'volume', 'muted', 'recordPaused']) {
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

// 人设读写（保存后下一轮生效）
ipcMain.handle('persona:get', () => (personaStore ? personaStore.get() : null));

ipcMain.handle('persona:set', (_e, patch) => {
  if (!personaStore) throw new Error('人设存储不可用');
  return personaStore.set(patch || {});
});

ipcMain.handle('persona:reset', () => {
  if (!personaStore) throw new Error('人设存储不可用');
  return personaStore.reset();
});

// 会话记录：统计、导出、清空
ipcMain.handle('session:stats', () => {
  if (!sessionStore) return null;
  const s = sessionStore.stats();
  const meta = sessionStore.meta();
  return {
    ...s,
    summary: meta.summary || '',
    summaries: sessionStore.recentSummaries(5),
    facts: memoryStore ? memoryStore.facts().length : 0,
    recordPaused: !!config.recordPaused,
  };
});

ipcMain.handle('session:export', () => {
  if (!sessionStore) throw new Error('会话存储不可用');
  const p = personaStore ? personaStore.get() : { name: '她' };
  const facts = memoryStore ? memoryStore.facts() : [];
  const r = sessionStore.exportToday({ assistantName: p.name || '她', facts });
  logger.log(`导出记录 ${r.path}（${r.turns} 轮）`);
  return r;
});

ipcMain.handle('session:clearAll', () => {
  let removed = 0;
  if (sessionStore) removed += sessionStore.clearAll().removed;
  if (memoryStore) memoryStore.clear();
  logger.log(`清空全部记录：删除 ${removed} 个会话文件，记忆已清空`);
  return { removed };
});

// 移除装扮：只移除引用，或连同文件删除
ipcMain.handle('look:remove', (_e, payload) => {
  const id = payload && payload.id;
  const deleteFiles = !!(payload && payload.deleteFiles);
  const m = loadLooks();
  const allowedRoots = [
    path.join(ROOT, 'assets'),
    m.source || '',
    'D:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960',
  ].filter(Boolean);

  const r = removeLook({
    manifestPath: looksPath(),
    id,
    deleteFiles,
    allowedRoots,
    log: (x) => logger.log(`[looks] ${x}`),
  });

  looksCache = null; // 下次访问重新读盘
  return r;
});

ipcMain.handle('mode:set', (_e, mode) => {  applyMode(mode === 'desktop' ? 'desktop' : 'window');
  return config.mode;
});

ipcMain.handle('mode:toggle', () => {
  toggleMode();
  return config.mode;
});

ipcMain.handle('secret:set', (_e, payload) => {
  // 兼容旧调用：secret:set('sk-...')；新调用：secret:set({ ref, key })
  const ref = typeof payload === 'object' && payload ? payload.ref || 'deepseek' : 'deepseek';
  const raw = typeof payload === 'object' && payload ? payload.key : payload;
  const v = String(raw || '').trim();

  if (v.length < 8) throw new Error('Key 长度不足，请检查是否复制完整');
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(v)) {
    throw new Error('这看起来不是 API Key：应以 sk- 开头，不要粘贴命令或路径');
  }

  setKey(ref, v);
  logger.log(`API Key(${ref}) 已加密保存`);
  return true;
});

ipcMain.handle('secret:clear', (_e, ref) => {
  clearKey(typeof ref === 'string' && ref ? ref : 'deepseek');
  logger.log(`API Key(${ref || 'deepseek'}) 已清除`);
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

// ASR：接收渲染进程录好的 16k 单声道 PCM，按配置的 provider 提交。
ipcMain.handle('asr:transcribe', async (_e, pcmArray) => {
  const prov = providerConfig().asr;
  const key = getKey(prov.keyRef || 'deepseek');
  if (!key) throw new Error(`未配置 ${prov.keyRef || 'deepseek'} 的 API Key`);

  const pcm = Buffer.from(pcmArray);
  if (pcm.length < 3200) throw new Error('录音太短（不足 100ms）');
  if (pcm.length > 16 * 1024 * 1024) throw new Error('录音过长，超过 8MB 上限');

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);

  try {
    const { text, durationMs } = await asrProvider.transcribe({
      kind: prov.kind,
      baseUrl: prov.baseUrl,
      apiKey: key,
      model: prov.model,
      language: prov.language,
      pcm,
      signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    logger.log(`ASR(${prov.kind}) 完成 ${ms}ms 音频 ${durationMs}ms 文本长度 ${text.length}`);
    return { text, ms, durationMs };
  } catch (e) {
    logger.error(`ASR(${prov.kind}) 失败: ${e.message}`);
    if (e.status === 401) throw new Error('Key 无效或已失效（401）');
    if (e.status === 402) throw new Error('账户余额不足（402）');
    if (e.status === 429) throw new Error('请求过于频繁（429），稍后再试');
    throw new Error(`识别失败：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
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

// ---------------------------------------------------------------- 引擎 v2

let currentTurnAbort = null;
let sessionStore = null;
let personaStore = null;
let memoryStore = null;

// 记忆任务：把溢出窗口的轮次压成摘要，并抽取长期事实
function scheduleMemoryJob(prov, keys) {
  if (!sessionStore || !memoryStore || !keys.llm) return;
  if (config.recordPaused) return;

  const turns = sessionStore.overflowTurns(MAX_HISTORY_TURNS);
  if (!turns.length) return;

  const oldSummary = sessionStore.meta().summary;
  memoryJob
    .run({
      turns,
      oldSummary,
      providers: prov,
      apiKey: keys.llm,
      model: prov.llm.model,
      memory: memoryStore,
      session: sessionStore,
      log: (m) => logger.log(`[memory] ${m}`),
    })
    .then((r) => {
      if (r && r.ok) logger.log(`[memory] 完成 ${turns.length} 条 → 摘要${r.summary ? '更新' : '不变'} 事实+${r.facts || 0}`);
    })
    .catch((e) => logger.error(`[memory] 异常: ${e.message}`));
}

async function chatTurnV2(userText) {
  const send = (type, payload) => {
    // 观测：逐句 TTS 统计落盘，便于分析切句策略效果
    if (type === 'tts.stat') {
      logger.log(
        `tts.stat seq=${payload.seq} 字数=${payload.len} 首包=${payload.firstMs}ms 合成=${payload.totalMs}ms 音频=${payload.ms}ms`
      );
    }
    if (win && !win.isDestroyed()) win.webContents.send('reply:event', { type, ...payload });
  };

  const prov = providerConfig();
  const keys = {
    llm: getKey(prov.llm.keyRef || 'deepseek'),
    tts: getKey(prov.tts.keyRef || 'mimo'),
  };

  logger.log(
    `v2 回合开始 llm=${prov.llm.kind}/${prov.llm.model}(key=${keys.llm ? '有' : '无'}) tts=${prov.tts.kind}/${prov.tts.model}/${prov.tts.voice}(key=${keys.tts ? '有' : '无'})`
  );

  const ctrl = new AbortController();
  currentTurnAbort = ctrl;

  // 人设每轮现取，保存后下一轮立即生效（FR-331）
  const persona = personaStore
    ? personaStore.toSystemParts()
    : { identity: PERSONA, constraints: '' };

  // 人设比历史更新时，明确要求压过历史里的旧语气（否则模型会模仿旧回复）
  const personaAt = persona.updatedAt ? new Date(persona.updatedAt).getTime() : 0;
  const lastTs = sessionStore && sessionStore.lastTs ? sessionStore.lastTs() : null;
  const personaFresh = !!(personaAt && lastTs && personaAt > new Date(lastTs).getTime());

  // 上下文来自会话记录；记录不可用时退回内存窗口
  // 人设比历史新 → 开新章节：旧轮次不进上下文（A 方案），摘要与事实后续仍会带入
  let before;
  if (sessionStore) {
    before = personaFresh
      ? sessionStore.recentSince(persona.updatedAt, MAX_HISTORY_TURNS)
      : sessionStore.recent(MAX_HISTORY_TURNS);
    if (personaFresh) logger.log('人设已更新 → 开启新章节，旧历史不入上下文');
  } else {
    before = history.slice();
  }

  // 四段 system + 预算裁剪
  const facts = memoryStore ? memoryStore.facts() : [];
  const dayMeta = sessionStore ? sessionStore.meta() : { summary: '', summarizedThrough: null };
  // 当天第一条之前，把昨天的摘要带进来（FR-318）
  const isFirstToday = sessionStore ? sessionStore.turns.length === 0 : false;
  const yesterdaySummary = isFirstToday && sessionStore ? sessionStore.previousSummary() : null;

  const built = promptBuilder.build({
    persona,
    facts,
    summary: dayMeta.summary,
    yesterdaySummary,
    recent: before,
    userText,
    newChapter: personaFresh,
  });
  logger.log(
    `system ${built.budget.systemTokens}t 历史 ${built.budget.historyTokens}t/${built.budget.historyTurns}轮 预览: ` +
      built.system.slice(0, 200).replace(/\n/g, ' / ')
  );

  const turnId = sessionStore ? sessionStore.reserveTurnId() : null;
  const canRecord = sessionStore && !config.recordPaused;
  if (canRecord) sessionStore.append({ turnId, role: 'user', text: userText });

  try {
    if (!keys.llm) throw new Error('未配置 LLM 的 API Key');
    if (!keys.tts) throw new Error('未配置 TTS 的 API Key（MiMo）');

    const r = await engine.runTurn({
      prompt: built,
      providers: prov,
      keys,
      send,
      signal: ctrl.signal,
      emotionStyle: config.emotionStyle !== false,
      maxConcurrent: Math.max(1, config.maxConcurrentTts || 2),
    });

    if (canRecord) {
      sessionStore.append({
        turnId,
        role: 'assistant',
        text: r.speakText || '……',
        emotion: r.emotion,
        firstTokenMs: r.timings.firstTokenMs,
        firstAudioMs: r.timings.firstAudioMs,
        audioMs: r.timings.audioMs,
        provider: { llm: prov.llm.model, tts: prov.tts.model },
      });
    } else {
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: r.speakText || '……' });
      while (history.length > MAX_HISTORY_TURNS * 2) history.shift();
    }

    logger.log(
      `对话完成(v2) 首token ${r.timings.firstTokenMs}ms llm完 ${r.timings.llmDoneMs}ms 首声 ${r.timings.firstAudioMs}ms 合成完 ${r.timings.totalMs}ms 音频 ${r.timings.audioMs}ms 情绪 ${r.emotion} 字数 ${r.speakText.length}`
    );
    send('done', { emotion: r.emotion, totalMs: r.timings.totalMs, text: r.text });

    // 记忆任务：异步，不阻塞本轮（FR-316、T-410）
    scheduleMemoryJob(prov, keys);

    return { ...r.timings, emotion: r.emotion, text: r.text };
  } catch (e) {
    logger.error(`对话失败(v2): ${e.message}`);
    send('error', { message: e.message });
    throw e;
  } finally {
    currentTurnAbort = null;
  }
}

ipcMain.handle('chat:turn', async (_e, userText) => {
  if ((config.engine || 'v2') === 'v2') return chatTurnV2(userText);

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

  // 人设：用户可编辑，缺文件时用默认值
  try {
    personaStore = new PersonaStore({
      file: path.join(userData, 'persona.json'),
      log: (m) => logger.log(`[persona] ${m}`),
    });
    const p = personaStore.get();
    logger.log(`人设就绪 name=${p.name} identity=${p.identity.length}字`);
  } catch (e) {
    personaStore = null;
    logger.error(`人设初始化失败，用内置默认: ${e.message}`);
  }

  // 长期记忆：结构化事实，跨天保留
  try {
    memoryStore = new MemoryStore({
      file: path.join(userData, 'memory.json'),
      log: (m) => logger.log(`[memory] ${m}`),
    });
    logger.log(`记忆就绪 ${memoryStore.facts().length} 条`);
  } catch (e) {
    memoryStore = null;
    logger.error(`记忆初始化失败: ${e.message}`);
  }

  // 会话记录：启动时清理过期文件，并载入当天上下文
  try {
    sessionStore = new SessionStore({
      dir: path.join(userData, 'sessions'),
      log: (m) => logger.log(`[session] ${m}`),
    });
    const { removed } = sessionStore.cleanup(7);
    const { loaded, bad } = sessionStore.open(dateKey());
    logger.log(
      `会话就绪 ${sessionStore.date} 载入 ${loaded} 条${bad ? `（跳过 ${bad} 条坏行）` : ''}，清理 ${removed} 个过期文件`
    );
  } catch (e) {
    sessionStore = null;
    logger.error(`会话初始化失败，降级为无记录模式: ${e.message}`);
  }

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

  // 自动化冒烟：DC_UI_TEST=bench 用现成 WAV 反复测 ASR 耗时
  if (process.env.DC_UI_TEST === 'bench') {
    setTimeout(async () => {
      try {
        const prov = providerConfig();
        const key = getKey(prov.asr.keyRef || 'deepseek');
        const wavPath = path.join(userData, 'selftest-reply.wav');
        if (!fs.existsSync(wavPath)) throw new Error('缺少 bench 音频 ' + wavPath);

        const buf = fs.readFileSync(wavPath);
        const pcm24 = buf.subarray(44); // 24kHz mono 16bit
        const n24 = Math.floor(pcm24.length / 2);
        const n16 = Math.floor((n24 * 2) / 3);
        const pcm16k = Buffer.alloc(n16 * 2);
        for (let i = 0; i < n16; i += 1) {
          const src = i * 1.5;
          const i0 = Math.floor(src);
          const frac = src - i0;
          const a = pcm24.readInt16LE(i0 * 2);
          const b = i0 + 1 < n24 ? pcm24.readInt16LE((i0 + 1) * 2) : a;
          pcm16k.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
        }
        logger.log(`[bench] ASR 基准开始，音频 ${(n16 / 16000).toFixed(2)}s`);

        for (let i = 0; i < 5; i += 1) {
          const t = Date.now();
          try {
            const r = await asrProvider.transcribe({
              kind: prov.asr.kind,
              baseUrl: prov.asr.baseUrl,
              apiKey: key,
              model: prov.asr.model,
              language: prov.asr.language,
              pcm: pcm16k,
            });
            logger.log(`[bench] asr #${i + 1} ${Date.now() - t}ms text=${r.text.slice(0, 40)}`);
          } catch (e) {
            logger.log(`[bench] asr #${i + 1} FAIL ${e.message}`);
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        logger.log('[bench] ASR 完成');
      } catch (e) {
        logger.error(`[bench] 失败: ${e.message}`);
      }
    }, 4000);
  }

  // 自动化冒烟：DC_UI_TEST=del 点开衣橱并点击第一张封面的删除按钮，检查弹层是否可见
  if (process.env.DC_UI_TEST === 'del') {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => {
          const openBtn = document.getElementById('desk-wardrobe') || document.getElementById('btn-wardrobe');
          openBtn && openBtn.click();
          await new Promise((r) => setTimeout(r, 700));
          const del = document.querySelector('.wardrobe-item .del');
          if (!del) return JSON.stringify({ ok: false, reason: 'no-del-button', wardrobe: document.getElementById('wardrobe')?.className });
          del.click();
          await new Promise((r) => setTimeout(r, 400));
          const dlg = document.getElementById('del-dialog');
          if (!dlg) return JSON.stringify({ ok: false, reason: 'no-dialog-element' });
          const cs = getComputedStyle(dlg);
          let after = null;
          if ('${process.env.DC_DEL_ACTION || ''}') {
            document.getElementById('del-ref').click();
            await new Promise((r) => setTimeout(r, 900));
            const info = await window.companion.listLooks();
            after = { count: info.count, currentId: info.currentId };
          }
          return JSON.stringify({
            ok: true,
            hasHidden: dlg.classList.contains('hidden'),
            display: cs.display,
            visibility: cs.visibility,
            zIndex: cs.zIndex,
            rect: dlg.getBoundingClientRect().width + 'x' + dlg.getBoundingClientRect().height,
            panelDisplay: getComputedStyle(document.querySelector('.panel')).display,
            bodyClass: document.body.className,
            after,
          });
        })()`);
        logger.log(`[test] 删除弹层: ${r}`);
      } catch (e) {
        logger.error(`[test] 删除弹层失败: ${e.message}`);
      }
    }, 4000);
  }

  // 自动化冒烟：DC_UI_TEST=chatN 跑多轮对话，用于验收上下文与记忆
  if (process.env.DC_UI_TEST === 'chatN') {
    const script = [
      '我叫阿哲，记住我的名字',
      '我最近在准备面试，有点紧张',
      '我不喜欢被叫宝贝',
      '今天天气还行',
      '中午吃了个三明治',
      '下午要开会',
      '会开得有点久',
      '晚上想早点睡',
      '你有什么推荐的吗',
      '随便聊聊吧',
      '最近睡得不太好',
      '工作压力有点大',
      '周末想去走走',
      '不知道去哪',
      '你觉得呢',
      '再聊两句',
      '有点困了',
      '差不多了',
      '还有最后一件事',
      '你还记得我叫什么吗',
    ];
    setTimeout(async () => {
      try {
        const texts = JSON.stringify(script);
        const r = await win.webContents.executeJavaScript(`(async () => {
          const list = ${texts};
          let ok = 0, fail = 0;
          for (const t of list) {
            try {
              await window.companion.sendChat(t);
              ok += 1;
            } catch (e) {
              fail += 1;
            }
            await new Promise((res) => setTimeout(res, 600));
          }
          return ok + '/' + list.length + ' (fail=' + fail + ')';
        })()`);
        logger.log(`[test] 多轮对话完成 ${r}`);
      } catch (e) {
        logger.error(`[test] 多轮对话失败: ${e.message}`);
      }
    }, 5000);
  }

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
