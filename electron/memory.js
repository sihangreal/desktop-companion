'use strict';

// 长期记忆：结构化事实（称呼 / 偏好 / 雷区等），跨天保留。
// 上限 20 条，超出按 confidence 升序淘汰；原子写。

const fs = require('node:fs');
const path = require('node:path');

const WHITELIST = new Set([
  'user.name',
  'user.dislike',
  'user.like',
  'user.job',
  'user.schedule',
  'user.event',
]);

const MAX_FACTS = 20;
const MIN_CONFIDENCE = 0.6;
const MAX_PER_MULTI_KEY = 4;

// 单值 key：新值覆盖旧值；其余 key 允许多条不同值
const SINGLE_VALUED = new Set(['user.name', 'user.job', 'user.schedule']);

class MemoryStore {
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    this.cache = null;
  }

  read() {
    if (this.cache) return this.cache;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e && e.code !== 'ENOENT') this.log(`记忆文件损坏，按空处理: ${e.message}`);
    }
    const facts = Array.isArray(data && data.facts) ? data.facts : [];
    this.cache = { facts: facts.filter((f) => f && WHITELIST.has(f.key) && f.value) };
    return this.cache;
  }

  facts() {
    return this.read().facts.map((f) => ({ ...f }));
  }

  /**
   * 合并新事实。
   * @returns {{added:number, updated:number, ignored:number, dropped:number}}
   */
  merge(incoming = []) {
    const cur = this.read().facts.map((f) => ({ ...f }));
    const stat = { added: 0, updated: 0, ignored: 0, dropped: 0 };

    for (const raw of incoming) {
      if (!raw || !WHITELIST.has(raw.key) || !raw.value) {
        stat.ignored += 1;
        continue;
      }
      const conf = Number(raw.confidence);
      const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.7;
      const value = String(raw.value).trim().slice(0, 60);
      if (!value) {
        stat.ignored += 1;
        continue;
      }
      const now = new Date().toISOString();

      if (SINGLE_VALUED.has(raw.key)) {
        const prev = cur.find((f) => f.key === raw.key);
        if (!prev) {
          cur.push({ key: raw.key, value, confidence, sourceTurnId: raw.sourceTurnId || null, updatedAt: now });
          stat.added += 1;
          continue;
        }
        if (confidence < MIN_CONFIDENCE) {
          stat.ignored += 1;
          continue;
        }
        if (prev.value !== value) {
          prev.value = value;
          prev.sourceTurnId = raw.sourceTurnId || prev.sourceTurnId || null;
        }
        prev.confidence = Math.max(prev.confidence || 0, confidence);
        prev.updatedAt = now;
        stat.updated += 1;
        continue;
      }

      // 多值 key：按 (key, value) 去重；同 key 超过上限则淘汰置信度最低的
      const dupe = cur.find((f) => f.key === raw.key && f.value === value);
      if (dupe) {
        dupe.confidence = Math.max(dupe.confidence || 0, confidence);
        dupe.updatedAt = now;
        stat.updated += 1;
        continue;
      }
      const sameKey = cur.filter((f) => f.key === raw.key);
      if (sameKey.length >= MAX_PER_MULTI_KEY) {
        sameKey.sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
        const victim = sameKey[0];
        const idx = cur.indexOf(victim);
        if (idx >= 0) cur.splice(idx, 1);
        stat.dropped += 1;
      }
      cur.push({
        key: raw.key,
        value,
        confidence,
        sourceTurnId: raw.sourceTurnId || null,
        updatedAt: now,
      });
      stat.added += 1;
    }

    let list = cur.filter((f) => f && f.key && f.value);
    if (list.length > MAX_FACTS) {
      list.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      const kept = list.slice(0, MAX_FACTS);
      stat.dropped += list.length - kept.length;
      list = kept;
    }

    if (stat.added || stat.updated || stat.dropped) {
      this.cache = { facts: list };
      this.write(list);
      this.log(
        `记忆更新 +${stat.added} ~${stat.updated} 忽略${stat.ignored} 淘汰${stat.dropped} 共${list.length}条`
      );
    }
    return stat;
  }

  clear() {
    this.cache = { facts: [] };
    this.write([]);
    this.log('记忆已清空');
    return true;
  }

  write(list) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ facts: list }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { MemoryStore, WHITELIST, MAX_FACTS, MIN_CONFIDENCE };
