'use strict';

// ASR 适配器。统一返回 { text, durationMs }。
//   - deepseek：multipart/form-data 上传 wav
//   - mimo：chat/completions + input_audio data URL（base64）

function pcmToWav(pcm, sampleRate = 16000) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

async function asrDeepseek(opts) {
  const { baseUrl, apiKey, pcm, signal } = opts;
  const wav = pcmToWav(pcm, 16000);

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/tools/asr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`ASR ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  return { text: (j.text || '').trim(), durationMs: j.duration_ms || 0 };
}

async function asrMimo(opts) {
  const { baseUrl, apiKey, pcm, language = 'zh', signal } = opts;
  const wav = pcmToWav(pcm, 16000);
  const dataUrl = `data:audio/wav;base64,${wav.toString('base64')}`;

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || 'mimo-v2.5-asr',
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: dataUrl } }],
        },
      ],
      asr_options: { language },
    }),
    signal,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`MiMo ASR ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const text = typeof content === 'string' ? content : '';
  return { text: text.trim(), durationMs: 0 };
}

function transcribe(opts) {
  const kind = opts.kind || 'deepseek';
  if (kind === 'mimo') return asrMimo(opts);
  return asrDeepseek(opts);
}

module.exports = { transcribe, pcmToWav };
