'use strict';

// 零依赖自测：node tests/run.js
// 覆盖 prompt 预算裁剪、会话切分、人设校验。

const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { build, est, BUDGET } = require('../electron/prompt');
const { SessionStore, dateKey } = require('../electron/session');
const { PersonaStore } = require('../electron/persona');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

function tmpDir(tag) {
  return path.join(os.tmpdir(), `dc-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

console.log('\n[prompt]');

const persona = {
  identity: '你是小夜，住在用户桌面上的陪伴角色。',
  constraints: '只输出口语，首句不超过12字，总长不超过45字。',
};

test('四段齐全', () => {
  const r = build({
    persona,
    facts: [{ key: 'user.name', value: '阿哲', confidence: 0.9 }],
    summary: '聊过工作压力。',
    recent: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的' },
    ],
    userText: '今天好累',
  });
  assert.ok(r.system.includes('【身份】'));
  assert.ok(r.system.includes('【记忆】'));
  assert.ok(r.system.includes('【摘要】'));
  assert.ok(r.system.includes('【约束】'));
  assert.strictEqual(r.messages.length, 3);
});

test('空段跳过，不留空行', () => {
  const r = build({ persona: { identity: '', constraints: '' }, recent: [], userText: 'hi' });
  assert.strictEqual(r.system, '');
});

test('超长摘要被压缩到预算内', () => {
  const r = build({ persona, summary: '很长的摘要'.repeat(300), recent: [], userText: '嗯' });
  assert.ok(r.budget.systemTokens <= BUDGET.system, `system=${r.budget.systemTokens}`);
  assert.ok(r.budget.summaryChars <= 61);
});

test('facts 最多 5 条', () => {
  const facts = Array.from({ length: 20 }, (_, i) => ({
    key: 'user.event',
    value: `事件${i}`,
    confidence: i / 20,
  }));
  const r = build({ persona, facts, recent: [], userText: '嗯' });
  assert.strictEqual(r.budget.facts, 5);
  assert.ok(r.budget.systemTokens <= BUDGET.system);
});

test('历史超预算被裁剪', () => {
  const recent = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: '这是第几条比较长的对话内容，用来测试预算裁剪是否生效。',
  }));
  const r = build({ persona, recent, userText: '继续' });
  assert.ok(r.budget.historyTokens <= BUDGET.history, `history=${r.budget.historyTokens}`);
  assert.ok(r.budget.historyTurns >= 1);
});

test('新章节附加提示', () => {
  const r = build({ persona, recent: [], userText: '新', newChapter: true });
  assert.ok(r.system.includes('角色设定刚刚更新'));
});

test('est 粗算：中文按字', () => {
  assert.strictEqual(est('你好世界'), 4);
  assert.ok(est('abcdefgh') < 4);
});

console.log('\n[session]');

test('append + recent 往返', () => {
  const dir = tmpDir('sess');
  const s = new SessionStore({ dir, log: () => {} });
  s.open(dateKey());
  const id = s.reserveTurnId();
  s.append({ turnId: id, role: 'user', text: '今天有点累' });
  s.append({ turnId: id, role: 'assistant', text: '那早点休息。' });
  const r = s.recent(12);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].content, '今天有点累');
  assert.strictEqual(r[1].role, 'assistant');
});

test('坏行被跳过', () => {
  const dir = tmpDir('bad');
  const s = new SessionStore({ dir, log: () => {} });
  s.open(dateKey());
  s.append({ role: 'user', text: '正常一条' });
  fs.appendFileSync(path.join(dir, `${dateKey()}.jsonl`), '{坏行}\n', 'utf8');
  const s2 = new SessionStore({ dir, log: () => {} });
  const r = s2.open(dateKey());
  assert.strictEqual(r.bad, 1);
  assert.strictEqual(r.loaded, 1);
});

test('recentSince 按时间切分', () => {
  const dir = tmpDir('chapter');
  const s = new SessionStore({ dir, log: () => {} });
  s.open(dateKey());
  s.append({ ts: '2026-11-23T10:00:00+08:00', role: 'user', text: '旧问题' });
  s.append({ ts: '2026-11-23T10:00:05+08:00', role: 'assistant', text: '旧回答' });
  s.append({ ts: '2026-11-23T13:00:00+08:00', role: 'user', text: '新问题' });
  const r = s.recentSince('2026-11-23T12:00:00+08:00');
  assert.deepStrictEqual(r.map((m) => m.content), ['新问题']);
});

test('清理 7 天前文件', () => {
  const dir = tmpDir('clean');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), 'x');
  fs.writeFileSync(path.join(dir, '2026-01-01.meta.json'), 'x');
  const s = new SessionStore({ dir, log: () => {} });
  const r = s.cleanup(7);
  assert.strictEqual(r.removed, 2);
});

console.log('\n[persona]');

test('默认值、不落盘', () => {
  const file = path.join(tmpDir('persona'), 'persona.json');
  const p = new PersonaStore({ file, log: () => {} });
  assert.strictEqual(p.get().name, '小夜');
  assert.strictEqual(fs.existsSync(file), false);
});

test('保存后可读回，无临时文件', () => {
  const file = path.join(tmpDir('persona2'), 'persona.json');
  const p = new PersonaStore({ file, log: () => {} });
  p.set({ name: '阿凉', identity: '说话很冷淡。' });
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(fs.existsSync(`${file}.tmp`), false);
  assert.strictEqual(new PersonaStore({ file, log: () => {} }).get().name, '阿凉');
});

test('空名字与超长被拒绝', () => {
  const file = path.join(tmpDir('persona3'), 'persona.json');
  const p = new PersonaStore({ file, log: () => {} });
  assert.throws(() => p.set({ name: '' }), /名字不能为空/);
  assert.throws(() => p.set({ identity: '字'.repeat(900) }), /不能超过/);
});

test('损坏文件回退默认', () => {
  const dir = tmpDir('persona4');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'persona.json');
  fs.writeFileSync(file, '{坏的}');
  assert.strictEqual(new PersonaStore({ file, log: () => {} }).get().name, '小夜');
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
