'use strict';

// 配置读写：先写临时文件再原子改名，避免崩溃留下半截 JSON。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  window: { x: null, y: null, width: 480, height: 720 },
  mode: 'window',
  volume: 70,
  muted: false,
  voiceId: 'stella',
  clickThrough: false,
  currentLookId: null,
  // single | random | sequence | favorites
  playMode: 'single',
  rotateSeconds: 60,
  // all | favorites —— 影响「交给心动」与「全部随机」
  rotateScope: 'all',
  favorites: [],
  // v2：对话引擎与三路供应商（providers 为空时用 main.js 里的默认值）
  engine: 'v2',
  emotionStyle: true,
  maxConcurrentTts: 2,
  providers: null,
  recordPaused: false,
  firstRun: true,
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function load(file) {
  try {
    // 容忍 BOM：某些编辑器/脚本写入的 UTF-8 会带 BOM，JSON.parse 会直接失败
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    // 深合并到默认值，保证旧配置缺字段也能用
    const cfg = clone(DEFAULTS);
    for (const [k, v] of Object.entries(parsed || {})) {
      if (k === 'window' && v && typeof v === 'object') Object.assign(cfg.window, v);
      else cfg[k] = v;
    }
    return cfg;
  } catch {
    return clone(DEFAULTS);
  }
}

function save(file, cfg) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { load, save, DEFAULTS };
