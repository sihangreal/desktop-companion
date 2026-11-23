'use strict';

// 记忆任务：一次 LLM 调用同时产出「摘要」与「事实」。
// 全程异步，失败不影响对话（FR-316、FR-322、FR-308 同理）。

const llm = require('./providers/llm');
const { WHITELIST } = require('./memory');

const SYSTEM = [
  '你是对话记忆整理器。只输出 JSON，不要解释、不要 Markdown 代码块。',
  '任务：把新增对话压缩进摘要，并抽取长期事实。',
  '输出格式：{"summary": "≤120字，第三人称，只保留事实与情绪走向", "facts": [{"key": "...", "value": "...", "confidence": 0.0}]}',
  'key 只能是：user.name, user.dislike, user.like, user.job, user.schedule, user.event。',
  '没有新事实时 facts 返回空数组；没有需要更新的摘要时 summary 返回 null。',
].join('\n');

function turnLines(turns) {
  return turns
    .map((t) => `${t.role === 'user' ? '用户' : '她'}：${String(t.text).slice(0, 120)}`)
    .join('\n');
}

function parseJson(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 执行一次记忆任务。
 * @returns {Promise<{ok:boolean, summary?:string|null, facts?:number, reason?:string}>}
 */
async function run(opts) {
  const {
    turns = [],
    oldSummary = '',
    providers,
    apiKey,
    model,
    memory,
    session,
    log = () => {},
    timeoutMs = 10000,
  } = opts;

  if (!turns.length) return { ok: true, reason: 'no-turns' };
  if (!apiKey) return { ok: false, reason: 'no-key' };

  const prompt = [
    oldSummary ? `已有摘要：${oldSummary}` : '已有摘要：（空）',
    '新增对话：',
    turnLines(turns),
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const text = await llm.complete({
      baseUrl: providers.llm.baseUrl,
      apiKey,
      model: model || providers.llm.model,
      system: SYSTEM,
      prompt,
      maxTokens: 400,
      temperature: 0.2,
      signal: ctrl.signal,
    });

    const data = parseJson(text);
    if (!data) {
      log('记忆任务返回无法解析，保留旧值');
      return { ok: false, reason: 'bad-json' };
    }

    let factsCount = 0;
    if (Array.isArray(data.facts) && data.facts.length && memory) {
      const last = turns[turns.length - 1];
      const withSource = data.facts.map((f) => ({ ...f, sourceTurnId: last && last.turnId }));
      const stat = memory.merge(withSource);
      factsCount = stat.added + stat.updated;
    }

    if (data.summary && session) {
      const lastId = turns[turns.length - 1].turnId;
      session.setMeta({ summary: String(data.summary).slice(0, 200), summarizedThrough: lastId });
      log(`摘要已更新（${String(data.summary).length}字）`);
    }

    return { ok: true, summary: data.summary || null, facts: factsCount };
  } catch (e) {
    if (ctrl.signal.aborted) {
      log(`记忆任务超时（>${timeoutMs}ms），保留旧值`);
      return { ok: false, reason: 'timeout' };
    }
    log(`记忆任务失败: ${e.message}`);
    return { ok: false, reason: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { run, SYSTEM, WHITELIST };
