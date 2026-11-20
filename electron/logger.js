'use strict';

// 极简日志：追加写，超过 2 MB 轮转一次，避免长期运行把盘写满。
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;

let logFile = null;

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'main.log');
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(logFile);
    if (st.size > MAX_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    /* 文件还不存在，忽略 */
  }
}

function write(level, args) {
  if (!logFile) return;
  const line = `[${new Date().toISOString()}] ${level} ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, line);
  } catch {
    /* 日志失败不能影响主流程 */
  }
  if (level === 'ERROR') process.stderr.write(line);
}

module.exports = {
  init,
  log: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  get logFile() {
    return logFile;
  },
};
