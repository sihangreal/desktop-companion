'use strict';

// TTS 适配器。统一输出：AsyncGenerator<Buffer>，PCM16LE / 24kHz / 单声道。
// 两种实现的差别只在"怎么拿音频"：
//   - mimo：OpenAI 兼容 chat/completions + SSE，delta.audio.data 是 base64 块
//   - deepseek：POST /v1/tools/tts，响应体本身就是音频流

const { readSse } = require('./sse');

async function* synthMimo(opts) {
  const { baseUrl, apiKey, model, voice, text, style, signal } = opts;
  const content = style ? `(${style})${text}` : text;

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content }],
      audio: { voice: voice || '冰糖', format: 'pcm16' },
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`MiMo TTS ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }

  for await (const chunk of readSse(res, signal)) {
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    const b64 = delta && delta.audio && delta.audio.data;
    if (b64) yield Buffer.from(b64, 'base64');
  }
}

async function* synthDeepseek(opts) {
  const { baseUrl, apiKey, voice, text, signal } = opts;
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/tools/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice || 'stella', format: 'pcm' }),
    signal,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`DeepSeek TTS ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) yield Buffer.from(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** 按 provider.kind 选实现 */
function synth(opts) {
  const kind = opts.kind || 'mimo';
  if (kind === 'deepseek') return synthDeepseek(opts);
  return synthMimo(opts);
}

module.exports = { synth };
