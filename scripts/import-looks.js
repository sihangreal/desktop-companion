'use strict';

// 从现有壁纸目录导入装扮清单：解析 catalog.js，配对视频与封面，生成 data/looks.json。
// 素材不复制，只记录绝对路径（121 套约 850 MB，复制没有意义）。
//
// 用法： node scripts/import-looks.js ["壁纸目录"]

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEFAULT_SRC =
  'D:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960\\3828392144';

const ROOT = path.join(__dirname, '..');
const srcDir = path.resolve(process.argv[2] || DEFAULT_SRC);

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(srcDir)) fail(`壁纸目录不存在：${srcDir}`);

const catalogPath = path.join(srcDir, 'catalog.js');
if (!fs.existsSync(catalogPath)) fail(`找不到 catalog.js：${catalogPath}`);

// catalog.js 是给浏览器用的脚本：window.PURPLE_LOOKS = Object.freeze([...])
// 放到独立 vm 上下文里跑，拿到数组但不执行任何额外逻辑。
const source = fs.readFileSync(catalogPath, 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
try {
  vm.runInContext(source + '\n;window.__LOOKS__ = window.PURPLE_LOOKS;', sandbox, {
    timeout: 5000,
  });
} catch (e) {
  fail('catalog.js 解析失败: ' + e.message);
}

const looks = sandbox.window.__LOOKS__;
if (!Array.isArray(looks) || looks.length === 0) fail('catalog.js 里没有解析到任何 look');

const mediaDir = path.join(srcDir, 'media');
const media1080 = path.join(mediaDir, '1080p');
const imagesDir = path.join(srcDir, 'images');

const out = [];
const missing = [];

for (const look of looks) {
  const id = look.id;
  if (!id) continue;

  const candidates = [
    path.join(mediaDir, `look-${id}.webm`),
    path.join(media1080, `look-${id}.webm`),
  ];
  const video = candidates.find((p) => fs.existsSync(p)) || null;

  const coverCandidates = [
    path.join(imagesDir, `look-${id}.jpg`),
    path.join(imagesDir, `look-${id}.png`),
  ];
  const cover = coverCandidates.find((p) => fs.existsSync(p)) || null;

  if (!video) {
    missing.push(`${id}(${look.name || '?'})`);
    continue;
  }

  out.push({
    id,
    name: look.name || id,
    short: look.short || look.name || id,
    english: look.english || '',
    group: look.group || 'classic',
    video,
    cover,
    // 封面原图是 16:9 横图、人物多在画面右侧，竖版卡片需要偏右裁切
    coverPos: '84% 20%',
    duration: look.duration || null,
    freeze: look.freeze || null,
    locked: !!look.locked,
  });
}

const manifest = {
  source: srcDir,
  generatedAt: new Date().toISOString(),
  count: out.length,
  looks: out,
};

const dest = path.join(ROOT, 'data', 'looks.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(manifest, null, 2), 'utf8');

const groups = out.reduce((m, l) => ((m[l.group] = (m[l.group] || 0) + 1), m), {});
console.log(`导入 ${out.length} 套（catalog 共 ${looks.length}）`);
console.log('分组: ' + JSON.stringify(groups));
console.log(`无封面: ${out.filter((l) => !l.cover).length}`);
if (missing.length) console.log(`缺视频跳过 ${missing.length}: ${missing.slice(0, 5).join(', ')}…`);
console.log('已写出 ' + dest);
