'use strict';

// 会话记录：按本地日期分文件，JSONL 追加写。
// 依赖：仅 node 内置模块。不感知引擎与界面。

const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 7;
const MAX_MEMORY_RECORDS = 400;

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** 本地日期键：YYYY-MM-DD */
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 带本地时区偏移的 ISO 时间 */
function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

class SessionStore {
  constructor({ dir, log = () => {} }) {
    this.dir = dir;
    this.log = log;
    this.date = null;
    this.turns = [];
    this.counter = 0;
    this.badLines = 0;
  }

  file(date = this.date) {
    return path.join(this.dir, `${date}.jsonl`);
  }

  metaFile(date = this.date) {
    return path.join(this.dir, `${date}.meta.json`);
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      return true;
    } catch (e) {
      this.log(`sessions 目录创建失败: ${e.message}`);
      return false;
    }
  }

  /** 打开某天的会话；没有文件时窗口为空（FR-304） */
  open(date = dateKey()) {
    this.date = date;
    this.turns = [];
    this.counter = 0;
    this.badLines = 0;

    if (!this.ensureDir()) return { loaded: 0, bad: 0 };

    let text = '';
    try {
      text = fs.readFileSync(this.file(date), 'utf8');
    } catch {
      return { loaded: 0, bad: 0 }; // 当天首次对话
    }

    const lines = text.split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        if (!rec || !rec.role) throw new Error('缺 role');
        this.turns.push(rec);
        const m = /^t_\d{8}_(\d{4})$/.exec(rec.turnId || '');
        if (m) this.counter = Math.max(this.counter, Number(m[1]));
      } catch {
        this.badLines += 1;
      }
    }

    if (this.turns.length > MAX_MEMORY_RECORDS) {
      this.turns = this.turns.slice(-MAX_MEMORY_RECORDS);
    }
    if (this.badLines) this.log(`会话 ${date}: 跳过 ${this.badLines} 行损坏记录`);
    return { loaded: this.turns.length, bad: this.badLines };
  }

  /** 跨天自动切文件（FR-302） */
  ensureToday(now = new Date()) {
    const key = dateKey(now);
    if (this.date !== key) {
      this.open(key);
      this.log(`会话切换为 ${key}`);
    }
    return key;
  }

  nextTurnId(now = new Date()) {
    this.counter += 1;
    const ys = this.date.replace(/-/g, '');
    return `t_${ys}_${pad(this.counter, 4)}`;
  }

  /** 为同一轮的两条记录预留同一个 turnId */
  reserveTurnId(now = new Date()) {
    try {
      this.ensureToday(now);
    } catch {
      /* 目录不可写时仍返回 id，append 会失败并记日志 */
    }
    return this.nextTurnId(now);
  }

  /**
   * 追加一条记录。失败只记日志，不影响对话（FR-308）
   * record: { role, text, emotion?, firstTokenMs?, firstAudioMs?, audioMs?, provider? }
   */
  append(record) {
    if (!record || !record.role || !record.text) return false;
    const now = new Date();
    try {
      this.ensureToday(now);
      const rec = {
        turnId: record.turnId || this.nextTurnId(now),
        ts: record.ts || isoLocal(now),
        role: record.role,
        text: String(record.text),
      };
      for (const k of ['emotion', 'firstTokenMs', 'firstAudioMs', 'audioMs', 'provider']) {
        if (record[k] !== undefined && record[k] !== null) rec[k] = record[k];
      }

      const line = JSON.stringify(rec) + '\n';
      fs.appendFileSync(this.file(), line, 'utf8');
      this.turns.push(rec);
      if (this.turns.length > MAX_MEMORY_RECORDS) this.turns.shift();
      return true;
    } catch (e) {
      this.log(`会话写入失败: ${e.message}`);
      return false;
    }
  }

  /** 最近一条记录的时间（用于判断人设是否比历史更新） */
  lastTs() {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      if (this.turns[i].ts) return this.turns[i].ts;
    }
    return null;
  }

  /** 只要某时间点之后的轮次（换人设后开新章节用） */
  recentSince(isoTs, n = 12) {
    if (!isoTs) return this.recent(n);
    const from = new Date(isoTs).getTime();
    if (!Number.isFinite(from)) return this.recent(n);
    const kept = this.turns.filter((r) => {
      const t = new Date(r.ts).getTime();
      return Number.isFinite(t) && t > from;
    });
    return kept.slice(-n * 2).map((r) => ({ role: r.role, content: r.text }));
  }

  /** 最近 n 轮（一轮 = user + assistant），返回 [{role, content}] */
  recent(n = 12) {
    const records = this.turns.slice(-n * 2);
    return records.map((r) => ({ role: r.role, content: r.text }));
  }

  /** 删除早于 days 天的会话文件（FR-310） */
  cleanup(days = KEEP_DAYS, now = new Date()) {
    if (!this.ensureDir()) return { removed: 0 };
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    cutoff.setDate(cutoff.getDate() - days);

    let removed = 0;
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return { removed: 0 };
    }

    for (const name of names) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.(jsonl|meta\.json)$/.exec(name);
      if (!m) continue;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (d >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.dir, name));
        removed += 1;
      } catch {
        /* 忽略单个文件失败 */
      }
    }
    return { removed };
  }

  /** 清空全部记录（FR-312） */
  clearAll() {
    if (!this.ensureDir()) return { removed: 0 };
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/\.(jsonl|meta\.json)$/.test(name)) continue;
        try {
          fs.unlinkSync(path.join(this.dir, name));
          removed += 1;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    this.turns = [];
    this.counter = 0;
    return { removed };
  }

  /** 当天统计（S5 使用，先提供） */
  stats() {
    const userTurns = this.turns.filter((r) => r.role === 'user').length;
    return { date: this.date, turns: userTurns, records: this.turns.length, badLines: this.badLines };
  }
}

module.exports = { SessionStore, dateKey, isoLocal };
