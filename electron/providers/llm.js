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

const DEFAULT_STYLE = {
  neutral: '平静',
  happy: '轻快',
  shy: '害羞',
  worried: '关切',
  sad: '低落',
  curious: '好奇',
  playful: '俏皮',
};

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
  } = opts;

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

    if (!headDone) {
      pending += text;
      const m = pending.match(/^\s*\[emotion:\s*([a-z]+)\s*\]\s*\n?/i);
      if (m) {
        headDone = true;
        pending = pending.slice(m[0].length);
        yield { emotion: m[1].toLowerCase() };
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
}

module.exports = { stream, DEFAULT_PERSONA, DEFAULT_STYLE };
