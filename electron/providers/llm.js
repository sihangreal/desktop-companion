'use strict';

// LLM 适配器：目前只有 OpenAI 兼容的流式实现（DeepSeek / MiMo / 任意兼容网关都走这里）。
// 能力声明：streaming=true, jsonMode 由调用方决定是否使用。

const { readSse } = require('./sse');

const DEFAULT_PERSONA = `你是一个住在用户桌面上的陪伴型角色，中文女性，名字叫小夜。
说话要求：
- 只用口语，像真人聊天，不要书面语、不要列表、不要 Markdown、不要 emoji、不要括号注释。
- 每次回复不超过 45 个汉字，通常一到两句。第一句尽量短，最好 12 字以内。
- 不要自称 AI 或助手，不要解释你在做什么。
- 语气温柔但不腻，可以有点小情绪和小调侃。
- 第一行只输出情绪标记，形如 [emotion:happy]，可选值：neutral happy shy worried sad curious playful。
- 第二行开始是你的正文。`;

const EMOTIONS = 'neutral|happy|shy|worried|sad|curious|playful';

const DEFAULT_STYLE = {
  neutral: '平静',
  happy: '轻快',
  shy: '害羞',
  worried: '关切',
  sad: '低落',
  curious: '好奇',
  playful: '俏皮',
};

/** 首行情绪标记：兼容 [emotion:x] / 裸词 / 只带一半括号 */
function matchEmotionHead(text) {
  const m1 = text.match(new RegExp(`^\\s*\\[emotion:\\s*([a-z]+)\\s*\\]\\s*\\n?`, 'i'));
  if (m1) return { emotion: m1[1].toLowerCase(), rest: text.slice(m1[0].length) };

  const m2 = text.match(new RegExp(`^\\s*\\[?\\s*(${EMOTIONS})\\s*\\]?\\s*\\n`, 'i'));
  if (m2) return { emotion: m2[1].toLowerCase(), rest: text.slice(m2[0].length) };

  // 同一行紧跟正文：happy 你来啦
  const m3 = text.match(new RegExp(`^\\s*\\[?\\s*(${EMOTIONS})\\s*\\]?[\\s,，。.!！?？]+`, 'i'));
  if (m3 && text.length >= m3[0].length + 2) {
    return { emotion: m3[1].toLowerCase(), rest: text.slice(m3[0].length) };
  }
  return null;
}

/**
 * 流式生成。返回 async generator，逐段产出 { delta, emotion? }。
 * 首个分片里如果带情绪标记，会在解析后单独产出 emotion。
 */
async function* stream(opts) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    persona = DEFAULT_PERSONA,
    maxTokens = 220,
    temperature = 1.05,
    signal,
    timing,
  } = opts;

  if (timing) timing.requestAt = Date.now();

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: persona }, ...messages],
      stream: true,
      max_tokens: maxTokens,
      temperature,
    }),
    signal,
  });

  if (timing) timing.ttfbAt = Date.now();

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`LLM ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }

  let pending = '';
  let headDone = false;

  for await (const chunk of readSse(res, signal)) {
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    const text = delta && delta.content;
    if (!text) continue;
    if (timing && !timing.firstDataAt) timing.firstDataAt = Date.now();

    if (!headDone) {
      pending += text;
      const m = matchEmotionHead(pending);
      if (m) {
        headDone = true;
        pending = m.rest;
        yield { emotion: m.emotion };
        if (pending) yield { delta: pending };
        pending = '';
        continue;
      }
      // 没有情绪标记，正文直接从第一行开始
      if (pending.includes('\n')) {
        headDone = true;
        yield { delta: pending };
        pending = '';
      }
      continue;
    }

    yield { delta: text };
  }

  // 全是首行、没出现换行的情况
  if (!headDone && pending) yield { delta: pending };
  if (timing) timing.doneAt = Date.now();
}

/** 非流式一次生成（记忆任务用） */
async function complete(opts) {
  const {
    baseUrl,
    apiKey,
    model,
    system,
    prompt,
    maxTokens = 400,
    temperature = 0.2,
    signal,
  } = opts;

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      stream: false,
      max_tokens: maxTokens,
      temperature,
    }),
    signal,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`LLM ${res.status}: ${body}`);
  }
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

module.exports = { stream, complete, DEFAULT_PERSONA, DEFAULT_STYLE };
