'use strict';

// 全链路自检：解密本机保存的 Key，依次验证 LLM / TTS / ASR。
// TTS 产出的 24kHz PCM 直接封装成 WAV 回灌 ASR，可在没有麦克风的机器上验证音频链路。
//
// 用法： electron scripts/api-selftest.js --no-sandbox

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', path.join(ROOT, 'data'));

const BASE = 'https://api.deepseek.com';
const results = [];
const say = (s) => {
  results.push(s);
  console.log(s);
};

function wavHeader(dataLen, sampleRate, channels = 1, bits = 16) {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

function readKey() {
  const p = path.join(ROOT, 'data', 'secret.bin');
  if (!fs.existsSync(p)) throw new Error('secret.bin 不存在：请先在界面里保存 API Key');
  const buf = fs.readFileSync(p);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用');
  return safeStorage.decryptString(buf);
}

async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    say(`[PASS] ${name}  ${Date.now() - t0}ms  ${r}`);
    return true;
  } catch (e) {
    say(`[FAIL] ${name}  ${Date.now() - t0}ms  ${e && e.message ? e.message : e}`);
    return false;
  }
}

app.whenReady().then(async () => {
  let key;
  try {
    key = readKey();
  } catch (e) {
    say(`[FAIL] 读取密钥: ${e.message}`);
    app.exit(1);
    return;
  }
  say(`密钥: 长度 ${key.length}，前缀 ${key.slice(0, 6)}…`);

  const auth = { Authorization: `Bearer ${key}` };

  // 1) LLM
  await timed('LLM chat', async () => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '只回复两个字：你好' }],
        max_tokens: 16,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
    return `回复="${j.choices[0].message.content.trim()}" tokens=${j.usage.total_tokens}`;
  });

  // 2) TTS（24kHz / 16bit / mono 裸 PCM）
  let pcm = null;
  await timed('TTS 合成', async () => {
    const res = await fetch(`${BASE}/v1/tools/tts`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '今天有点累，想早点休息。',
        voice_id: 'stella',
        format: 'pcm',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const ab = await res.arrayBuffer();
    pcm = Buffer.from(ab);
    fs.writeFileSync(path.join(ROOT, 'data', 'selftest-tts.pcm'), pcm);
    return `${pcm.length} 字节 PCM（约 ${(pcm.length / 48000).toFixed(1)} 秒）`;
  });

  // 3) ASR（把 TTS 的 PCM 封装成 24kHz WAV 回灌）
  if (pcm && pcm.length > 0) {
    await timed('ASR 识别（TTS 回灌）', async () => {
      const wav = Buffer.concat([wavHeader(pcm.length, 24000), pcm]);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
      const res = await fetch(`${BASE}/v1/tools/asr`, {
        method: 'POST',
        headers: auth,
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      return `识别="${j.text}" 音频 ${j.duration_ms}ms`;
    });
  }

  const pass = results.filter((r) => r.startsWith('[PASS]')).length;
  say(`\n结论：${pass} 项通过`);
  app.exit(pass >= 3 ? 0 : 2);
});
