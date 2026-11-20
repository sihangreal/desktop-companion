'use strict';

// 只打印 Key 的形态（长度/前缀/后缀），不输出完整内容，用于排查粘贴错误。
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', path.join(ROOT, 'data'));

app.whenReady().then(() => {
  const p = path.join(ROOT, 'data', 'secret.bin');
  if (!fs.existsSync(p)) {
    console.log('RESULT: secret.bin 不存在');
    app.exit(1);
    return;
  }
  let key = '';
  try {
    key = safeStorage.decryptString(fs.readFileSync(p));
  } catch (e) {
    console.log('RESULT: 解密失败 ' + e.message);
    app.exit(2);
    return;
  }
  const looksLikeKey = /^sk-[A-Za-z0-9_-]{16,}$/.test(key);
  const looksLikePath = /[\\/]/.test(key) || /\.\w{2,4}$/.test(key);
  console.log(`RESULT: 长度=${key.length} 前缀="${key.slice(0, 7)}" 后缀="…${key.slice(-4)}" 符合sk格式=${looksLikeKey} 疑似路径=${looksLikePath}`);
  app.exit(0);
});
