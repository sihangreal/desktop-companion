'use strict';

// 人设：用户可编辑的身份描述与输出约束。
// 存 data/persona.json，原子写（tmp + rename），损坏时回退默认。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  name: '小夜',
  identity:
    '你是一个住在用户桌面上的陪伴型角色，中文女性，名字叫小夜。' +
    '你认识用户，记得他说过的话，语气自然亲近。',
  constraints: [
    '说话要求：',
    '- 只用口语，像真人聊天，不要书面语、不要列表、不要 Markdown、不要 emoji、不要括号注释。',
    '- 每次回复不超过 45 个汉字，通常一到两句。',
    '- 不要自称 AI 或助手，不要解释你在做什么。',
    '- 语气温柔但不腻，可以有点小情绪和小调侃。',
    '- 第一行只输出情绪标记，形如 [emotion:happy]，可选值：neutral happy shy worried sad curious playful。',
    '- 第二行开始是你的正文。',
  ].join('\n'),
};

const LIMITS = { name: 20, identity: 800, constraints: 600 };

function clampText(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

class PersonaStore {
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    this.cache = null;
  }

  /** 补齐字段；文件缺失或损坏都回退默认（NFR-307） */
  get() {
    if (this.cache) return { ...this.cache };
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e && e.code !== 'ENOENT') this.log(`人设文件损坏，使用默认值: ${e.message}`);
    }
    const merged = {
      name: clampText(data && data.name, LIMITS.name) || DEFAULTS.name,
      identity: clampText(data && data.identity, LIMITS.identity) || DEFAULTS.identity,
      constraints: clampText(data && data.constraints, LIMITS.constraints) || DEFAULTS.constraints,
      updatedAt: (data && data.updatedAt) || null,
    };
    this.cache = merged;
    return { ...merged };
  }

  /** 校验 + 原子写 */
  set(patch = {}) {
    const cur = this.get();
    const next = {
      name: patch.name !== undefined ? clampText(patch.name, LIMITS.name) : cur.name,
      identity: patch.identity !== undefined ? clampText(patch.identity, LIMITS.identity) : cur.identity,
      constraints:
        patch.constraints !== undefined ? clampText(patch.constraints, LIMITS.constraints) : cur.constraints,
    };

    if (!next.name) throw new Error('名字不能为空');
    if (!next.identity) throw new Error('身份描述不能为空');
    if (String(patch.identity || '').trim().length > LIMITS.identity) {
      throw new Error(`身份描述不能超过 ${LIMITS.identity} 字`);
    }

    next.updatedAt = new Date().toISOString();
    this.write(next);
    this.cache = next;
    this.log(`人设已更新 name=${next.name} identity=${next.identity.length}字`);
    return { ...next };
  }

  /** 恢复默认并落盘 */
  reset() {
    const next = { ...DEFAULTS, updatedAt: new Date().toISOString() };
    this.write(next);
    this.cache = next;
    this.log('人设已恢复默认');
    return { ...next };
  }

  write(data) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // Windows 下 Node 会覆盖目标
  }

  /** 组装成 system prompt 的前两段（身份 + 约束） */
  toSystemParts() {
    const p = this.get();
    return { identity: p.identity, constraints: p.constraints, name: p.name, updatedAt: p.updatedAt };
  }
}

module.exports = { PersonaStore, DEFAULTS, LIMITS };
