'use strict';

// 对话引擎 v2：LLM 流 → 切句 → TTS 流（并发 2）→ 音频块按序下发。
//
// 关键设计：
//   1. 句子一成型就发 TTS，不等整段回复。
//   2. 最多 N 条 TTS 同时在跑；达到上限就暂停读 LLM（真背压），避免积压。
//   3. 每个句子带 seq，渲染进程按 seq 缓冲播放，保证顺序不乱。

const llm = require('./providers/llm');
const tts = require('./providers/tts');

const MARKS = '。！？；，、,.!?;';

/** 中文切句：到标点或到长度上限就切；force=true 时把残余也吐出来 */
function splitSentences(text, force = false, maxLen = 24) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (MARKS.includes(ch) || buf.length >= maxLen) {
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

/** 去掉不能朗读的东西 */
function speakable(s) {
  return s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*#_`>[\]]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .trim();
}

/**
 * 跑一轮。返回 { text, emotion, timings }。
 * prompt: { system, messages } —— 由 PromptBuilder 组装，引擎不再感知人设与历史来源。
 */
async function runTurn(opts) {
  const {
    prompt,
    providers,
    keys,
    send,
    signal,
    emotionStyle = true,
    maxConcurrent = 2,
  } = opts;

  const t0 = Date.now();
  let firstTokenMs = 0;
  let firstAudioMs = 0;
  let audioBytes = 0;
  let emotion = 'neutral';
  let full = '';
  let pending = '';

  const tasks = [];
  let active = 0;
  const waiters = [];
  let firstSeq = 0;
  let seq = 0;

  async function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    active += 1;
  }
  function release() {
    active -= 1;
    const w = waiters.shift();
    if (w) w();
  }

  const styleOf = (e) => (emotionStyle ? llm.DEFAULT_STYLE[e] || '' : '');

  async function startTts(sentence, seqNo) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const tStart = Date.now();
    let firstChunkMs = 0;
    let bytes = 0;
    try {
      const it = tts.synth({
        kind: providers.tts.kind,
        baseUrl: providers.tts.baseUrl,
        apiKey: keys.tts,
        model: providers.tts.model,
        voice: providers.tts.voice,
        text: sentence,
        style: styleOf(emotion),
        signal: ctrl.signal,
      });
      for await (const buf of it) {
        if (signal && signal.aborted) break;
        if (!firstChunkMs) {
          firstChunkMs = Date.now() - tStart;
          if (!firstAudioMs) {
            firstAudioMs = Date.now() - t0;
            send('tts.first', { ms: firstAudioMs });
          }
        }
        bytes += buf.length;
        audioBytes += buf.length;
        send('audio', { seq: seqNo, pcm: buf });
      }
      send('audio-end', { seq: seqNo });
      send('tts.stat', {
        seq: seqNo,
        len: sentence.length,
        firstMs: firstChunkMs,
        totalMs: Date.now() - tStart,
        ms: Math.round(bytes / 48),
      });
    } catch (e) {
      if (!(signal && signal.aborted)) {
        send('warn', { message: `TTS: ${e.message}` });
      }
      send('audio-end', { seq: seqNo });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      release();
    }
  }

  async function enqueueSentence(raw) {
    const clean = speakable(raw);
    if (!clean) return;
    full += raw;
    send('delta', { text: raw });

    const mySeq = seq;
    seq += 1;
    await acquire();
    if (signal && signal.aborted) {
      release();
      return;
    }
    if (!firstSeq) firstSeq = mySeq;
    const p = startTts(clean, mySeq);
    tasks.push(p);
  }

  // ---- LLM 流式 ----
  const messages = prompt && prompt.messages ? prompt.messages : [];
  let bodyStarted = false;

  for await (const ev of llm.stream({
    baseUrl: providers.llm.baseUrl,
    apiKey: keys.llm,
    model: providers.llm.model,
    messages,
    persona: (prompt && prompt.system) || undefined,
    signal,
  })) {
    if (signal && signal.aborted) break;

    if (!firstTokenMs) {
      firstTokenMs = Date.now() - t0;
      send('first-token', { ms: firstTokenMs });
    }
    if (ev.emotion) {
      emotion = ev.emotion;
      send('emotion', { emotion });
      continue;
    }
    if (!ev.delta) continue;

    bodyStarted = true;
    pending += ev.delta;

    const { sentences, rest } = splitSentences(pending);
    pending = rest;
    for (const s of sentences) {
      await enqueueSentence(s);
      if (signal && signal.aborted) break;
    }
    if (signal && signal.aborted) break;
  }

  if (bodyStarted) {
    for (const s of splitSentences(pending, true).sentences) {
      await enqueueSentence(s);
    }
  }

  await Promise.all(tasks);

  const totalMs = Date.now() - t0;
  return {
    text: full,
    speakText: speakable(full),
    emotion,
    timings: {
      firstTokenMs,
      firstAudioMs,
      totalMs,
      audioMs: Math.round(audioBytes / 48), // 24kHz * 2 字节 = 48 字节/毫秒
    },
  };
}

module.exports = { runTurn, splitSentences, speakable };
