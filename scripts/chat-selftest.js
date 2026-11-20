'use strict';

// 验证 M2 的流式对话逻辑：LLM 流式 → 按句切分 → 逐句 TTS → 拼成一个 wav 落盘。
// 与 main.js 的 chat:turn 使用同一套切句/清洗规则，用于在没有界面的情况下预检。
// 用法： electron scripts/chat-selftest.js --no-sandbox

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', path.join(ROOT, 'data'));

const BASE = 'https://api.deepseek.com';
const PERSONA = fs.existsSync(path.join(ROOT, 'electron', 'main.js'))
  ? null // 下面直接内联，保持脚本独立
  : null;

const SYSTEM = `你是一个住在用户桌面上的陪伴型角色，中文女性，名字叫小夜。
只用口语，像真人聊天，不要列表、不要 Markdown、不要 emoji。
每次回复不超过 45 个汉字。
第一行只输出情绪标记，形如 [emotion:happy]，可选：neutral happy shy worried sad curious playful。
第二行开始是正文。`;

const MARKS = '。！？；，、,.!?;';

function splitSentences(text, force = false) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (MARKS.includes(ch) || buf.length >= 24) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf && (force || buf.length >= 8)) {
    out.push(buf);
    buf = '';
  }
  return { sentences: out, rest: buf };
}

function speakable(s) {
  return s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*#_`>[\]]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .trim();
}

function wavHeader(dataLen, sampleRate = 24000) {
  const b = Buffer.alloc(44);
  const blockAlign = 2;
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') return;
      try {
        const j = JSON.parse(p);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && d.content) yield d.content;
      } catch {
        /* ignore */
      }
    }
  }
}

app.whenReady().then(async () => {
  const key = safeStorage.decryptString(
    fs.readFileSync(path.join(ROOT, 'data', 'secret.bin'))
  );
  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const userText = '我今天加班到很晚，好累啊';
  console.log(`USER: ${userText}`);

  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userText },
      ],
      stream: true,
      max_tokens: 200,
      temperature: 1.1,
    }),
  });
  if (!res.ok) {
    console.log('LLM FAIL', res.status, (await res.text()).slice(0, 200));
    app.exit(1);
    return;
  }

  let pending = '';
  let started = false;
  let firstToken = 0;
  let emotion = 'neutral';
  const sentences = [];

  for await (const tok of sse(res)) {
    if (!firstToken) firstToken = Date.now() - t0;
    if (!started) {
      pending += tok;
      const m = pending.match(/^\s*\[emotion:\s*([a-z]+)\s*\]\s*\n?/i);
      if (m) {
        emotion = m[1];
        pending = pending.slice(m[0].length);
        started = true;
      } else if (pending.includes('\n') && !/^\s*\[emotion/i.test(pending)) {
        started = true;
      } else {
        continue;
      }
    } else {
      pending += tok;
    }
    const { sentences: ss, rest } = splitSentences(pending);
    pending = rest;
    sentences.push(...ss);
  }
  sentences.push(...splitSentences(pending, true).sentences);

  console.log(`情绪: ${emotion}  首token: ${firstToken}ms`);
  console.log(`切出 ${sentences.length} 句`);

  const pcmParts = [];
  for (const s of sentences) {
    const clean = speakable(s);
    if (!clean) continue;
    const ts = Date.now();
    const r = await fetch(`${BASE}/v1/tools/tts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: clean, voice_id: 'stella', format: 'pcm', filter_markdown: true }),
    });
    if (!r.ok) {
      console.log(`TTS FAIL "${clean}" ${r.status}`);
      continue;
    }
    const pcm = Buffer.from(await r.arrayBuffer());
    pcmParts.push(pcm);
    console.log(`  [${Date.now() - ts}ms] "${clean}" → ${pcm.length} 字节`);
  }

  const all = Buffer.concat(pcmParts);
  const out = path.join(ROOT, 'data', 'selftest-reply.wav');
  fs.writeFileSync(out, Buffer.concat([wavHeader(all.length), all]));
  console.log(`\n总耗时 ${Date.now() - t0}ms，音频 ${(all.length / 48000).toFixed(1)} 秒`);
  console.log(`已写出 ${out}`);
  app.exit(0);
});
