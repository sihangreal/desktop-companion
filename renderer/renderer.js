'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 基础 UI

function setText(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  if (cls) {
    el.classList.remove('ok', 'bad');
    el.classList.add(cls);
  }
  if (el.parentElement) el.parentElement.title = text;
}

function setStatus(text) {
  const el = $('status');
  if (el) el.textContent = text;
}

function setTranscript(text) {
  const el = $('transcript');
  if (el) el.textContent = text;
}

function setReply(text) {
  const el = $('reply');
  if (el) el.textContent = text;
}

let clickThrough = false;
let currentMode = 'window';

async function refresh() {
  try {
    const info = await window.companion.getAppInfo();
    setText('v-version', info.version, 'ok');
    setText('v-apikey', info.hasApiKey ? '已保存（加密）' : '未设置', info.hasApiKey ? 'ok' : 'bad');
    if (info.hasKeys) {
      setText('v-mimokey', info.hasKeys.mimo ? '已保存（加密）' : '未设置', info.hasKeys.mimo ? 'ok' : 'bad');
    }
    // 人设：只在首次加载时填充，避免覆盖用户正在编辑的内容
    if (!personaLoaded) {
      try {
        const p = await window.companion.getPersona();
        if (p) {
          fillPersona(p);
          personaLoaded = true;
        }
      } catch (err) {
        console.error(err);
      }
    }
    // 记录统计：每次刷新都更新
    if (!recordStatsBusy) {
      recordStatsBusy = true;
      loadRecordStats()
        .catch(() => {})
        .finally(() => {
          recordStatsBusy = false;
        });
    }
    clickThrough = info.clickThrough;
    const btn = $('btn-clickthrough');
    if (btn) btn.textContent = `穿透：${clickThrough ? '开' : '关'}`;
    if (info.mode && info.mode !== currentMode) applyModeUI(info.mode);

    // 播放设置只在首次加载时同步，避免每次刷新重置计时器
    if (!settingsLoaded) {
      playMode = info.playMode || 'single';
      rotateSeconds = info.rotateSeconds || 60;
      rotateScope = info.rotateScope || 'all';
      favorites = new Set(Array.isArray(info.favorites) ? info.favorites : []);
      videoVolume = typeof info.volume === 'number' ? info.volume / 100 : 0.7;
      soundOn = !info.muted;
      const volEl = $('vol');
      if (volEl) volEl.value = String(Math.round(videoVolume * 100));
      settingsLoaded = true;
      schedulePlay();
      applyVideoVolume();
    }
  } catch (err) {
    console.error('app_info 失败', err);
  }
}

$('btn-hide').onclick = () => window.companion.hideWindow();
$('btn-quit').onclick = () => window.companion.quit();

$('btn-save-key').onclick = async () => {
  const input = $('in-key');
  const key = input.value.trim();
  if (!key) return;
  try {
    await window.companion.setApiKey(key);
    input.value = '';
    await refresh();
    setStatus('Key 已保存，可以开始说话了');
  } catch (err) {
    setText('v-apikey', String(err && err.message ? err.message : err), 'bad');
  }
};

$('btn-clear-key').onclick = async () => {
  try {
    await window.companion.clearApiKey('deepseek');
    await refresh();
  } catch (err) {
    console.error(err);
  }
};

$('btn-save-mimo').onclick = async () => {
  const input = $('in-key-mimo');
  const key = input.value.trim();
  if (!key) return;
  try {
    await window.companion.setApiKey(key, 'mimo');
    input.value = '';
    await refresh();
    setStatus('MiMo Key 已保存');
  } catch (err) {
    setText('v-mimokey', String(err && err.message ? err.message : err), 'bad');
  }
};

$('btn-clear-mimo').onclick = async () => {
  try {
    await window.companion.clearApiKey('mimo');
    await refresh();
  } catch (err) {
    console.error(err);
  }
};

// ---- 人设编辑 ----
let personaLoaded = false;

function fillPersona(p) {
  const nameEl = $('in-persona-name');
  const idEl = $('in-persona-identity');
  const cEl = $('in-persona-constraints');
  if (nameEl) nameEl.value = p.name || '';
  if (idEl) idEl.value = p.identity || '';
  if (cEl) cEl.value = p.constraints || '';
}

function setPersonaHint(text, kind) {
  const el = $('persona-hint');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (kind ? ` ${kind}` : '');
}

const btnSavePersona = $('btn-save-persona');
if (btnSavePersona) {
  btnSavePersona.onclick = async () => {
    try {
      const p = await window.companion.setPersona({
        name: $('in-persona-name').value,
        identity: $('in-persona-identity').value,
        constraints: $('in-persona-constraints').value,
      });
      fillPersona(p);
      personaLoaded = true;
      setPersonaHint('已保存，下一轮生效', 'ok');
    } catch (e) {
      setPersonaHint(String(e && e.message ? e.message : e), 'bad');
    }
  };
}

const btnResetPersona = $('btn-reset-persona');
if (btnResetPersona) {
  btnResetPersona.onclick = async () => {
    try {
      const p = await window.companion.resetPersona();
      fillPersona(p);
      personaLoaded = true;
      setPersonaHint('已恢复默认', 'ok');
    } catch (e) {
      setPersonaHint(String(e && e.message ? e.message : e), 'bad');
    }
  };
}

// ---- 记录与记忆 ----
let recordPaused = false;
let recordStatsBusy = false;

function setRecordHint(text, kind) {
  const el = $('record-hint');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (kind ? ` ${kind}` : '');
}

async function loadRecordStats() {
  try {
    const s = await window.companion.sessionStats();
    if (!s) return;
    recordPaused = !!s.recordPaused;
    setText('v-session', `${s.turns} 轮 · ${s.records} 条`, 'ok');
    setText('v-facts', s.facts ? `${s.facts} 条` : '暂无', s.facts ? 'ok' : '');
    const btn = $('btn-pause-record');
    if (btn) btn.textContent = `暂停记录：${recordPaused ? '开' : '关'}`;
  } catch (e) {
    console.error(e);
  }
}

const btnExport = $('btn-export');
if (btnExport) {
  btnExport.onclick = async () => {
    try {
      const r = await window.companion.exportSession();
      setRecordHint(`已导出 ${r.turns} 轮 → ${r.path}`, 'ok');
    } catch (e) {
      setRecordHint(String(e && e.message ? e.message : e), 'bad');
    }
  };
}

const btnPauseRecord = $('btn-pause-record');
if (btnPauseRecord) {
  btnPauseRecord.onclick = async () => {
    try {
      recordPaused = !recordPaused;
      await window.companion.setConfig({ recordPaused });
      btnPauseRecord.textContent = `暂停记录：${recordPaused ? '开' : '关'}`;
      setRecordHint(recordPaused ? '已暂停：不写会话、不更新记忆' : '已恢复记录', 'ok');
      await loadRecordStats();
    } catch (e) {
      setRecordHint(String(e && e.message ? e.message : e), 'bad');
    }
  };
}

const btnClearRecords = $('btn-clear-records');
if (btnClearRecords) {
  btnClearRecords.onclick = async () => {
    if (!window.confirm('确定清空全部对话记录和长期记忆？此操作不可恢复。')) return;
    try {
      const r = await window.companion.clearAllSessions();
      setRecordHint(`已清空（${r.removed} 个文件）`, 'ok');
      await loadRecordStats();
    } catch (e) {
      setRecordHint(String(e && e.message ? e.message : e), 'bad');
    }
  };
}

$('btn-clickthrough').onclick = async () => {
  const next = await window.companion.setClickThrough(!clickThrough);
  clickThrough = !!next;
  $('btn-clickthrough').textContent = `穿透：${clickThrough ? '开' : '关'}`;
};

$('btn-sound').onclick = () => {
  soundOn = !soundOn;
  applyVideoVolume(playingCount > 0);
  window.companion
    .setConfig({ muted: !soundOn, volume: Math.round(videoVolume * 100) })
    .catch((e) => console.error(e));
};

$('vol').oninput = (e) => {
  videoVolume = Number(e.target.value) / 100;
  applyVideoVolume(playingCount > 0);
};
$('vol').onchange = (e) => {
  window.companion
    .setConfig({ volume: Number(e.target.value) })
    .catch((err) => console.error(err));
};

// ---------------------------------------------------------------- 状态与播放

let state = 'idle'; // idle | listening | thinking | speaking
let playCtx = null;
let nextPlayAt = 0;
let playingCount = 0;
let replyBuf = '';

function setState(next) {
  state = next;
  const stage = $('stage');
  if (stage) stage.dataset.state = next;

  const label = {
    idle: '在听…',
    listening: '在听…',
    thinking: '（在想）',
    speaking: '♪',
  }[next] || '';

  const av = $('avatar');
  if (av) av.textContent = label;
}

function ensurePlayCtx() {
  if (!playCtx) playCtx = new AudioContext();
  if (playCtx.state === 'suspended') void playCtx.resume();
  return playCtx;
}

// 视频原声：壁纸的视频本身带音轨，不能静音播放
let soundOn = true;
let videoVolume = 0.7;

/** 应用视频音量：只让当前这段出声，另一段强制静音（避免切换时叠音） */
function applyVideoVolume(duck = false) {
  const cur = $(activeVideo);
  if (cur) {
    cur.muted = !soundOn;
    cur.volume = soundOn ? Math.max(0, Math.min(1, videoVolume * (duck ? 0.22 : 1))) : 0;
  }
  const other = $(activeVideo === 'vA' ? 'vB' : 'vA');
  if (other) {
    other.muted = true;
    other.volume = 0;
  }
  const btn = $('btn-sound');
  if (btn) btn.textContent = `声音：${soundOn ? '开' : '关'}`;
}

// 音频按句到达，可能乱序；用 seq 缓冲，保证播放顺序
let playSeq = 0;
let audioBuffers = new Map();
let endedSeq = new Set();

function resetAudioOrder() {
  playSeq = 0;
  audioBuffers = new Map();
  endedSeq = new Set();
  // 新一轮开始，重置排程游标，避免把「上一轮到现在」的静默算成断档
  nextPlayAt = 0;
}

function pushAudio(seq, pcm) {
  if (typeof seq !== 'number') {
    enqueuePcm(pcm); // 老引擎没有 seq
    return;
  }
  if (seq === playSeq) {
    enqueuePcm(pcm);
  } else {
    if (!audioBuffers.has(seq)) audioBuffers.set(seq, []);
    audioBuffers.get(seq).push(pcm);
  }
}

function advanceAudio() {
  while (endedSeq.has(playSeq)) {
    playSeq += 1;
    const buf = audioBuffers.get(playSeq);
    if (buf && buf.length) {
      audioBuffers.delete(playSeq);
      for (const c of buf) enqueuePcm(c);
    } else {
      break; // 下一句还没到，等它
    }
  }
}

function endAudioSeq(seq) {
  if (typeof seq !== 'number') return;
  endedSeq.add(seq);
  advanceAudio();
}

function enqueuePcm(u8) {
  const ctx = ensurePlayCtx();
  const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = ctx.createBuffer(1, f32.length, 24000);
  buf.copyToChannel(f32, 0);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);

  // 真正的断档 = 队列已空的时间；只在同一轮内（已有音频在播/排队）才统计
  const now = ctx.currentTime;
  const underrunMs = Math.round(Math.max(0, now - nextPlayAt) * 1000);
  const startAt = Math.max(now, nextPlayAt);
  if (underrunMs > 250 && playingCount > 0) {
    window.companion.uiLog(`playback gap ${underrunMs}ms (playing=${playingCount})`);
  }
  src.start(startAt);
  nextPlayAt = startAt + buf.duration;

  if (playingCount === 0) {
    applyVideoVolume(true); // 她开始说话，压低视频原声
    if (idleVideoTimer) {
      clearTimeout(idleVideoTimer);
      idleVideoTimer = null;
    }
    // 按“实际出声时间”切，而不是按音频块到达时间（D1）
    if (speakVideoTimer) clearTimeout(speakVideoTimer);
    const lead = Math.max(0, (startAt - ctx.currentTime) * 1000 - 120);
    speakVideoTimer = setTimeout(() => {
      speakVideoTimer = null;
      playStateVideo('speaking');
    }, lead);
  }
  playingCount++;
  setState('speaking');
  src.onended = () => {
    playingCount--;
    if (playingCount <= 0) {
      playingCount = 0;
      applyVideoVolume(false);
      // 等最后一块真正播完再切回「闭嘴」，而不是 onended 后固定 900ms（D2）
      const tailMs = Math.max(150, Math.round((nextPlayAt - ctx.currentTime) * 1000) + 150);
      if (idleVideoTimer) clearTimeout(idleVideoTimer);
      idleVideoTimer = setTimeout(() => {
        idleVideoTimer = null;
        if (playingCount === 0) playStateVideo('idle');
      }, tailMs);
      releaseTurn();
    }
  };
}

// ---------------------------------------------------------------- 常开聆听

const SAMPLE_RATE = 16000;
const FRAME = 2048;
const SILENCE_MS = 700;
const MAX_SPEECH_MS = 30000;
const MIN_VOICE_MS = 250;

let autoListen = true; // 常开聆听
let busy = false; // 正在识别/对话/播放，期间不拾音
let uiPaused = false; // 衣橱等界面打开时暂停拾音
let micStream = null;
let audioCtx = null;
let procNode = null;

const vad = { speaking: false, silenceMs: 0, voiceMs: 0, hit: 0, noise: 0.008, chunks: [], total: 0 };

function micAvailable() {
  return !!(micStream && audioCtx && procNode);
}

async function startMic() {
  if (micAvailable()) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(micStream);
    procNode = audioCtx.createScriptProcessor(FRAME, 1, 1);
    const mute = audioCtx.createGain();
    mute.gain.value = 0; // 不回放，避免啸叫
    source.connect(procNode);
    procNode.connect(mute);
    mute.connect(audioCtx.destination);
    procNode.onaudioprocess = onFrame;
    const stage = $('stage');
    if (stage) stage.dataset.mic = 'on';
    setState('idle');
    setStatus('在听，直接说话就行');
    return true;
  } catch (err) {
    setStatus('麦克风不可用：' + String(err && err.message ? err.message : err));
    return false;
  }
}

function stopMic() {
  try {
    if (procNode) procNode.onaudioprocess = null;
  } catch {
    /* ignore */
  }
  try {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  micStream = null;
  procNode = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  vad.speaking = false;
  vad.chunks = [];
  vad.total = 0;
  setState('idle');
  setStatus('麦克风已关闭');
  const stage = $('stage');
  if (stage) stage.dataset.mic = 'off';
}

function onFrame(ev) {
  if (!autoListen || busy || uiPaused || !audioCtx) return;

  const data = ev.inputBuffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / data.length);

  // 自适应噪声底：安静时缓慢跟随环境，避免固定阈值在吵一点的环境里失效
  vad.noise = Math.min(0.06, vad.noise * 0.97 + rms * 0.03);
  const threshold = Math.max(0.012, vad.noise * 3.2);
  const frameMs = (data.length / audioCtx.sampleRate) * 1000;

  if (!vad.speaking) {
    if (rms > threshold) {
      vad.hit += 1;
      if (vad.hit >= 2) {
        vad.speaking = true;
        vad.hit = 0;
        vad.silenceMs = 0;
        vad.voiceMs = 0;
        vad.chunks = [];
        vad.total = 0;
        setState('listening');
      }
    } else {
      vad.hit = 0;
    }
  }

  if (vad.speaking) {
    vad.chunks.push(new Float32Array(data));
    vad.total += data.length;

    if (rms > threshold) {
      vad.silenceMs = 0;
      vad.voiceMs += frameMs;
    } else {
      vad.silenceMs += frameMs;
    }

    if (vad.silenceMs >= SILENCE_MS || vad.voiceMs >= MAX_SPEECH_MS) {
      void commitSpeech();
    }
  }
}

function mergeChunks(chunks, total) {
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function toInt16Pcm(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

async function commitSpeech() {
  if (busy) return;
  const chunks = vad.chunks;
  const total = vad.total;
  const rate = audioCtx ? audioCtx.sampleRate : 48000;
  const voiceMs = vad.voiceMs;

  // 复位 VAD，进入忙碌态（期间不拾音）
  vad.speaking = false;
  vad.chunks = [];
  vad.total = 0;
  vad.silenceMs = 0;
  vad.voiceMs = 0;
  busy = true;
  setState('thinking');
  setStatus('识别中…');

  if (voiceMs < MIN_VOICE_MS) {
    busy = false;
    setState('idle');
    setStatus('在听…');
    return;
  }

  const merged = mergeChunks(chunks, total);
  const pcm = toInt16Pcm(resample(merged, rate, SAMPLE_RATE));

  try {
    const r = await window.companion.transcribe(pcm);
    const text = (r.text || '').trim();
    setTranscript(text);
    if (!text) {
      busy = false;
      setState('idle');
      setStatus('没听清，再说一次？');
      return;
    }
    setStatus(`听到了：${text}`);
    await talkToHer(text);
  } catch (err) {
    busy = false;
    setState('idle');
    setStatus('识别失败：' + String(err && err.message ? err.message : err));
  }
}

/** 一轮结束后释放麦克风门控：若还有音频在播，等播完再放开 */
let clearTimer = null;

function scheduleClear() {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    if (state === 'idle' && playingCount === 0) {
      setTranscript('');
      setReply('');
    }
  }, 9000);
}

function releaseTurn() {
  if (playingCount > 0) return;
  busy = false;
  replyBuf = '';
  setState('idle');
  setStatus(autoListen ? '在听…' : '麦克风已暂停');
  scheduleClear();
}

// ---------------------------------------------------------------- 对话

async function talkToHer(text) {
  lastTurnAt = Date.now();
  replyBuf = '';
  setReply('');
  const t0 = Date.now();
  try {
    await window.companion.sendChat(text);
  } catch (err) {
    setStatus('对话失败：' + String(err && err.message ? err.message : err));
    busy = false;
    setState('idle');
    return;
  }
  const total = Date.now() - t0;
  // 没有音频返回时也要释放，否则会一直不拾音
  setTimeout(() => {
    if (playingCount === 0) {
      busy = false;
      setState('idle');
      setStatus(`总延迟 ${total}ms`);
    }
  }, 1200);
}

window.companion.onReplyEvent((ev) => {
  if (!ev) return;
  switch (ev.type) {
    case 'first-token':
      resetAudioOrder();
      setStatus(`她开始回复 · 首字 ${ev.ms}ms`);
      break;
    case 'tts.first':
      setStatus(`首声 ${ev.ms}ms`);
      break;
    case 'emotion':
      if ($('stage')) $('stage').dataset.emotion = ev.emotion;
      break;
    case 'delta':
      replyBuf += ev.text;
      setReply(replyBuf);
      break;
    case 'audio':
      try {
        pushAudio(ev.seq, ev.pcm);
      } catch (e) {
        console.error('播放失败', e);
      }
      break;
    case 'audio-end':
      endAudioSeq(ev.seq);
      break;
    case 'warn':
      console.warn('TTS 警告:', ev.message);
      break;
    case 'done':
      setStatus(`回复完成 · 总 ${ev.totalMs}ms`);
      break;
    case 'error':
      setStatus('她出错了：' + ev.message);
      busy = false;
      setState('idle');
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------- 麦克风开关

$('btn-mic').onclick = async () => {
  autoListen = !autoListen;
  if (autoListen) {
    const ok = await startMic();
    $('btn-mic').textContent = ok ? '聆听：开' : '聆听：失败';
  } else {
    stopMic();
    $('btn-mic').textContent = '聆听：关';
  }
};

// 兼容旧热键：Ctrl+Shift+Space 现在用于快速静音/恢复聆听
window.companion.onPttToggle(() => {
  autoListen = !autoListen;
  if (autoListen) {
    void startMic();
    $('btn-mic').textContent = '聆听：开';
  } else {
    stopMic();
    $('btn-mic').textContent = '聆听：关';
  }
});

// ---------------------------------------------------------------- 衣橱

const GROUPS = [
  { id: 'classic', name: '咫尺偏爱' },
  { id: 'sit', name: '片刻倾心' },
  { id: 'recline', name: '慵懒依偎' },
];
const PAGE_SIZE = 4;

let looksData = null;
let currentLookId = null;
let activeVideo = 'vA';
let currentGroup = 'classic';
let currentPage = 0;

async function initLooks() {
  try {
    looksData = await window.companion.listLooks();
  } catch (e) {
    console.error('listLooks 失败', e);
    return;
  }
  if (!looksData || !looksData.looks.length) {
    setStatus('未导入装扮：先运行 node scripts/import-looks.js');
    return;
  }
  const first = looksData.currentId || looksData.looks[0].id;
  applyLook(first, true);
  renderTabs();
  renderPage();
}

function findLook(id) {
  return looksData && looksData.looks.find((l) => l.id === id);
}

let currentLook = null;
let idleVideoTimer = null;
let speakVideoTimer = null;

/** 把画面的视频源换成 url（双 video 交叉淡入） */
let swapToken = 0;

function swapVideo(url, instant) {
  if (!url) return;
  const curEl = $(activeVideo);
  if (curEl.dataset.src === url && !curEl.paused) return; // 已经在播这一段

  const nextId = activeVideo === 'vA' ? 'vB' : 'vA';
  const nextEl = $(nextId);
  const token = (swapToken += 1);

  nextEl.src = url;
  nextEl.dataset.src = url;
  nextEl.currentTime = 0;
  nextEl.loop = true;

  const p = nextEl.play();
  if (p && p.catch) p.catch(() => {});

  // 等新视频能出画面再切换，避免淡入到黑屏；600ms 兜底
  const reveal = () => {
    if (token !== swapToken) return; // 期间又切过，放弃
    if (nextEl.classList.contains('active')) return;

    nextEl.classList.add('active');
    curEl.classList.remove('active');
    activeVideo = nextId;
    // 只让当前这段出声；旧的那段立刻静音，避免两段叠音
    applyVideoVolume(playingCount > 0);

    setTimeout(() => {
      if (!curEl.classList.contains('active')) {
        try {
          curEl.pause();
        } catch {
          /* ignore */
        }
        curEl.removeAttribute('src');
        curEl.dataset.src = '';
        curEl.load();
      }
    }, 320);
  };

  if (instant || nextEl.readyState >= 2) {
    reveal();
  } else {
    const onReady = () => {
      nextEl.removeEventListener('canplay', onReady);
      reveal();
    };
    nextEl.addEventListener('canplay', onReady);
    setTimeout(() => {
      nextEl.removeEventListener('canplay', onReady);
      reveal();
    }, 600);
  }
}

/** 按对话状态切换：她说话时用 speaking 视频，其余用 idle */
function playStateVideo(which) {
  if (!currentLook) return;
  const url =
    which === 'speaking' && currentLook.speakingUrl ? currentLook.speakingUrl : currentLook.videoUrl;
  if (!url) return;
  window.companion.uiLog(`video -> ${which} ${url}`);
  swapVideo(url, false);
}

function applyLook(id, instant) {
  let look = findLook(id);
  if (!look && looksData && looksData.looks.length) {
    // 记下的装扮不在了（换机器/删素材），退回第一套
    look = looksData.looks[0];
    id = look.id;
  }
  if (!look) return;
  currentLookId = id;
  currentLook = look;
  $('stage').dataset.video = '1';
  window.companion.uiLog(`applyLook ${id} (${look.name}) ${look.videoUrl}`);

  swapVideo(look.videoUrl, instant);

  setText('v-look', `${look.name}（${looksData.count} 套）`, 'ok');

  document.querySelectorAll('.wardrobe-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

function groupLooks(id) {
  return looksData ? looksData.looks.filter((l) => l.group === id) : [];
}

function renderTabs() {
  const tabs = $('wardrobe-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  for (const g of GROUPS) {
    const list = groupLooks(g.id);
    const btn = document.createElement('button');
    btn.textContent = `${g.name} ${list.length}`;
    btn.className = currentGroup === g.id ? 'active' : '';
    btn.onclick = () => {
      currentGroup = g.id;
      currentPage = 0;
      renderTabs();
      renderPage();
    };
    tabs.appendChild(btn);
  }
}

function renderPage() {
  if (!looksData) return;
  const list = groupLooks(currentGroup);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (currentPage > pages - 1) currentPage = pages - 1;
  if (currentPage < 0) currentPage = 0;

  const slice = list.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const grid = $('wardrobe-grid');
  grid.innerHTML = '';

  for (const look of slice) {
    const item = document.createElement('div');
    item.className = 'wardrobe-item' + (look.id === currentLookId ? ' active' : '');
    item.dataset.id = look.id;
    const faved = favorites.has(look.id);
    item.innerHTML = `<img src="${look.coverUrl || ''}" alt="${look.name}" loading="lazy" style="object-position:${look.coverPos || '84% 20%'}" /><span>${look.short || look.name}</span><button class="fav${faved ? ' on' : ''}" title="收藏">♥</button><button class="del" title="移除这套">×</button>`;
    item.onclick = () => {
      window.companion.uiLog(`click look ${look.id} ${look.name}`);
      applyLook(look.id, false);
      window.companion.setLook(look.id).catch(console.error);
      toggleWardrobe(false);
    };
    const favBtn = item.querySelector('.fav');
    if (favBtn) {
      favBtn.onclick = (ev) => {
        ev.stopPropagation();
        toggleFavorite(look.id);
      };
    }
    const delBtn = item.querySelector('.del');
    if (delBtn) {
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        askRemoveLook(look);
      };
    }
    grid.appendChild(item);
  }

  const info = $('page-info');
  if (info) info.textContent = `${currentPage + 1} / ${pages}`;
  window.companion.uiLog(`rendered ${currentGroup} page ${currentPage + 1}/${pages} items=${slice.length}`);
  const prev = $('page-prev');
  const next = $('page-next');
  if (prev) prev.disabled = currentPage === 0;
  if (next) next.disabled = currentPage >= pages - 1;
}

function toggleWardrobe(force) {
  const el = $('wardrobe');
  const show = typeof force === 'boolean' ? force : el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  window.companion.uiLog(`toggleWardrobe -> ${show ? 'open' : 'closed'}`);
  if (show) {
    renderTabs();
    renderPage();
  }
  // 浏览衣橱时先别听，免得边挑衣服边触发对话
  uiPaused = show;
  if (!show) {
    vad.speaking = false;
    vad.chunks = [];
    vad.total = 0;
  }
  reportHitRect();
}

$('btn-wardrobe').onclick = () => toggleWardrobe();
$('btn-wardrobe-close').onclick = () => toggleWardrobe(false);
$('desk-wardrobe').onclick = () => toggleWardrobe(true);
$('page-prev').onclick = () => {
  if (currentPage > 0) {
    currentPage -= 1;
    renderPage();
  }
};
$('page-next').onclick = () => {
  currentPage += 1;
  renderPage();
};

// ---------------------------------------------------------------- 播放方式 / 收藏

const PLAY_LABEL = {
  single: '单套循环',
  random: '全部随机',
  sequence: '全部轮播',
  favorites: '全部收藏',
};

let playMode = 'single';
let rotateSeconds = 60;
let rotateScope = 'all';
let favorites = new Set();
let rotateTimer = null;
let lastRotateAt = Date.now();
let lastTurnAt = 0;
let lastPicks = [];
let settingsLoaded = false;

function saveSettings(patch) {
  return window.companion.setConfig(patch).catch((e) => console.error(e));
}

function favoriteList() {
  return (looksData ? looksData.looks : []).filter((l) => favorites.has(l.id));
}

/** 「交给心动」与「全部随机」的候选池：按随机范围取全部或仅收藏 */
function scopePool() {
  if (rotateScope === 'favorites') {
    const favs = favoriteList();
    if (favs.length) return favs;
  }
  return looksData ? looksData.looks : [];
}

/** 换装 + 持久化 + 面板跟随高亮 */
function applyAndPersist(id) {
  applyLook(id, false);
  lastRotateAt = Date.now();
  window.companion.setLook(id).catch(console.error);

  const look = findLook(id);
  if (look) {
    currentGroup = look.group || currentGroup;
    const idx = groupLooks(currentGroup).findIndex((l) => l.id === id);
    if (idx >= 0) currentPage = Math.floor(idx / PAGE_SIZE);
  }
  if (!$('wardrobe').classList.contains('hidden')) {
    renderTabs();
    renderPage();
  }
}

function pickRandom() {
  const pool = scopePool();
  if (!pool.length) return;
  const fresh = pool.filter((l) => l.id !== currentLookId && !lastPicks.includes(l.id));
  const list = fresh.length ? fresh : pool.filter((l) => l.id !== currentLookId);
  if (!list.length) return;

  const pick = list[Math.floor(Math.random() * list.length)];
  lastPicks.push(pick.id);
  if (lastPicks.length > 3) lastPicks.shift();
  window.companion.uiLog(`random -> ${pick.id} ${pick.name}`);
  applyAndPersist(pick.id);
}

function stepSequence() {
  if (!looksData || !looksData.looks.length) return;
  const list = looksData.looks;
  const i = list.findIndex((l) => l.id === currentLookId);
  const next = list[(i + 1) % list.length];
  window.companion.uiLog(`sequence -> ${next.id} ${next.name}`);
  applyAndPersist(next.id);
}

function stepFavorites() {
  const favs = favoriteList();
  if (!favs.length) {
    setStatus('还没有收藏：点封面右上角的爱心');
    return;
  }
  if (favs.length === 1) {
    setStatus('只收藏了 1 套，轮播看不出变化；多收藏几套');
    return;
  }
  const i = favs.findIndex((l) => l.id === currentLookId);
  const next = favs[(i + 1) % favs.length];
  window.companion.uiLog(`favorites -> ${next.id} ${next.name}`);
  applyAndPersist(next.id);
}

function tickPlay() {
  // 只在空闲时轮换，别打断对话或用户正在翻衣橱
  if (state !== 'idle' || uiPaused || busy || playingCount > 0) return;
  if (playMode === 'random') pickRandom();
  else if (playMode === 'sequence') stepSequence();
  else if (playMode === 'favorites') stepFavorites();
}

function schedulePlay() {
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }

  const selMode = $('sel-mode');
  if (selMode) selMode.value = playMode;
  const selInterval = $('sel-interval');
  if (selInterval) selInterval.value = String(rotateSeconds);
  const scopeBtn = $('btn-scope');
  if (scopeBtn) scopeBtn.textContent = `范围：${rotateScope === 'favorites' ? '仅收藏' : '全部'}`;

  window.companion.uiLog(
    `play schedule mode=${playMode} sec=${rotateSeconds} scope=${rotateScope} fav=${favorites.size}`
  );

  if (playMode === 'single') return;
  lastRotateAt = Date.now();
  rotateTimer = setInterval(tickPlay, Math.max(10, rotateSeconds) * 1000);
}

// 轮播看门狗：发现状态卡死或长时间没轮换就自愈（每 10 秒检查一次）
setInterval(() => {
  if (playMode === 'single') return;

  // 状态卡在 speaking/thinking，但既没音频也没在对话 → 强制回到 idle
  if (state !== 'idle' && playingCount === 0 && !busy && Date.now() - lastRotateAt > 15000) {
    window.companion.uiLog(`watchdog: 状态卡在 ${state}（无音频无对话），强制回到 idle`);
    setState('idle');
  }

  // 对话卡死自愈：busy 但长时间没有音频输出
  if (busy && playingCount === 0 && lastTurnAt && Date.now() - lastTurnAt > 25000) {
    window.companion.uiLog('watchdog: 对话超过 25s 未收尾，强制释放');
    busy = false;
    setState('idle');
    lastTurnAt = 0;
  }

  // 已经超过 3 个轮换周期还没换 → 主动补一次
  const staleMs = Date.now() - lastRotateAt;
  const limitMs = Math.max(30, rotateSeconds * 3) * 1000;
  if (staleMs > limitMs && state === 'idle' && !busy && playingCount === 0) {
    window.companion.uiLog(`watchdog: ${Math.round(staleMs / 1000)}s 未轮换，补触发一次`);
    lastRotateAt = Date.now();
    tickPlay();
  }
}, 10000);

// ---------------------------------------------------------------- 移除装扮

let pendingRemove = null;

function askRemoveLook(look) {
  pendingRemove = look;
  const title = $('del-title');
  const desc = $('del-desc');
  if (title) title.textContent = `移除「${look.name}」？`;
  if (desc) {
    desc.innerHTML =
      '<b>仅从列表移除</b>：文件保留，以后还能重新导入。<br/>' +
      '<b>连文件一起删除</b>：会删除视频与封面，<b>不可恢复</b>；' +
      '若素材来自 Steam 创意工坊，原壁纸里的这套也会消失。';
  }
  const dlg = $('del-dialog');
  if (dlg) dlg.classList.remove('hidden');
  window.companion.uiLog('askRemoveLook ' + look.id + ' dialog=' + (dlg ? 'ok' : 'missing') + ' class=' + (dlg ? dlg.className : '-'));
}

async function doRemoveLook(deleteFiles) {
  window.companion.uiLog('doRemoveLook files=' + deleteFiles);
  const look = pendingRemove;
  pendingRemove = null;
  const dlg = $('del-dialog');
  if (dlg) dlg.classList.add('hidden');
  if (!look) return;

  try {
    const r = await window.companion.removeLook(look.id, deleteFiles);
    window.companion.uiLog(
      `remove look ${look.id} files=${deleteFiles} deleted=${r.deleted.length} skipped=${r.skipped.length} remaining=${r.remaining}`
    );

    favorites.delete(look.id);
    if (looksData) {
      looksData.looks = looksData.looks.filter((l) => l.id !== look.id);
      looksData.count = looksData.looks.length;
    }

    if (currentLookId === look.id && looksData && looksData.looks.length) {
      const first = looksData.looks[0];
      applyLook(first.id, true);
      window.companion.setLook(first.id).catch(() => {});
    }

    renderTabs();
    renderPage();
    setStatus(
      deleteFiles
        ? `已移除「${look.name}」，删除 ${r.deleted.length} 个文件`
        : `已移除「${look.name}」（文件保留）`
    );
  } catch (e) {
    setStatus('移除失败：' + (e && e.message ? e.message : e));
  }
}

function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  saveSettings({ favorites: [...favorites] });
  window.companion.uiLog(`favorite ${id} -> ${favorites.has(id)} total=${favorites.size}`);
  renderPage();
  setStatus(`已收藏 ${favorites.size} 套`);
}

$('btn-random').onclick = () => pickRandom();

// 移除装扮弹层
const delRefBtn = $('del-ref');
if (delRefBtn) delRefBtn.onclick = () => doRemoveLook(false);
const delFileBtn = $('del-file');
if (delFileBtn) delFileBtn.onclick = () => doRemoveLook(true);
const delCancelBtn = $('del-cancel');
if (delCancelBtn) {
  delCancelBtn.onclick = () => {
    pendingRemove = null;
    $('del-dialog').classList.add('hidden');
  };
}
const delDialogEl = $('del-dialog');
if (delDialogEl) {
  delDialogEl.onclick = (e) => {
    if (e.target === delDialogEl) {
      pendingRemove = null;
      delDialogEl.classList.add('hidden');
    }
  };
}

$('sel-mode').onchange = (e) => {
  playMode = e.target.value;
  saveSettings({ playMode });
  schedulePlay();
};

$('sel-interval').onchange = (e) => {
  rotateSeconds = Number(e.target.value) || 60;
  saveSettings({ rotateSeconds });
  schedulePlay();
};

$('btn-scope').onclick = () => {
  rotateScope = rotateScope === 'all' ? 'favorites' : 'all';
  saveSettings({ rotateScope });
  schedulePlay();
};

// ---------------------------------------------------------------- 模式切换

function applyModeUI(mode) {
  currentMode = mode === 'desktop' ? 'desktop' : 'window';
  document.body.classList.toggle('desktop-mode', currentMode === 'desktop');
  const btn = $('btn-fullscreen');
  if (btn) btn.textContent = currentMode === 'desktop' ? '窗口' : '全屏';
  if (currentMode === 'desktop') {
    const hint = $('mode-hint');
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 3200);
  }
  reportHitRect();
}

// ---------------------------------------------------------------- 局部点击接管

// 全屏模式下窗口整体穿透，主进程轮询光标是否落在下面这个热区里。
// 热区为 null 时表示整窗可交互（衣橱打开时用）。
function reportHitRect() {
  if (currentMode !== 'desktop') {
    window.companion.setHitRect(null);
    return;
  }
  const wardrobe = $('wardrobe');
  if (wardrobe && !wardrobe.classList.contains('hidden')) {
    window.companion.setHitRect(null); // 衣橱打开时整窗可点
    return;
  }
  const el = $('desk-wardrobe');
  if (!el) {
    window.companion.setHitRect(null);
    return;
  }
  const r = el.getBoundingClientRect();
  window.companion.setHitRect({ x: r.x, y: r.y, w: r.width, h: r.height });
}

window.addEventListener('resize', reportHitRect);

$('btn-fullscreen').onclick = async () => {
  const mode = await window.companion.toggleMode();
  applyModeUI(mode);
};

window.companion.onModeChanged((p) => applyModeUI(p.mode));

// ---------------------------------------------------------------- 启动

setState('idle');
initLooks();
refresh();
setInterval(refresh, 5000);

// 启动即在听，不用按任何键
void startMic();
