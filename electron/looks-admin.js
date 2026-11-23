'use strict';

// 装扮管理：从清单里移除一套（可只移除引用，或连同文件一起删）。
// 纯逻辑 + 文件操作，不依赖 Electron，便于单测。

const fs = require('node:fs');
const path = require('node:path');

function readManifest(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.looks)) throw new Error('清单格式错误：缺少 looks 数组');
  return data;
}

function writeManifest(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 判断目标文件是否在允许删除的根目录内（防止误删系统文件） */
function isInside(target, roots) {
  const resolved = path.resolve(target);
  return roots.some((root) => {
    if (!root) return false;
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

/**
 * 移除一套装扮。
 * @param {object} opts
 * @param {string} opts.manifestPath looks.json 路径
 * @param {string} opts.id 装扮 id
 * @param {boolean} opts.deleteFiles true=连文件一起删；false=只移除引用
 * @param {string[]} opts.allowedRoots 允许删除的根目录（安全阀）
 * @returns {{removed:string, deleted:string[], skipped:string[], remaining:number}}
 */
function removeLook(opts) {
  const { manifestPath, id, deleteFiles = false, allowedRoots = [], log = () => {} } = opts;
  if (!manifestPath) throw new Error('缺少清单路径');
  if (!id) throw new Error('缺少装扮 id');

  const data = readManifest(manifestPath);
  const look = data.looks.find((l) => l && l.id === id);
  if (!look) throw new Error(`找不到装扮：${id}`);

  const deleted = [];
  const skipped = [];

  if (deleteFiles) {
    const targets = [look.video, look.speakingVideo, look.cover].filter(Boolean);
    for (const p of targets) {
      if (!isInside(p, allowedRoots)) {
        skipped.push(`${p}（不在允许范围内）`);
        continue;
      }
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          deleted.push(p);
          log(`已删除文件 ${p}`);
        } else {
          skipped.push(`${p}（文件不存在）`);
        }
      } catch (e) {
        skipped.push(`${p}（${e.message}）`);
      }
    }
  }

  data.looks = data.looks.filter((l) => !l || l.id !== id);
  data.count = data.looks.length;
  writeManifest(manifestPath, data);
  log(`移除装扮 ${id}（删除文件=${deleteFiles}）剩余 ${data.looks.length} 套`);

  return { removed: id, deleted, skipped, remaining: data.looks.length };
}

module.exports = { removeLook, isInside };
