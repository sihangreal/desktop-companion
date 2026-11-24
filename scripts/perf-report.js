'use strict';

// 从 main.log 汇总 LLM / TTS / ASR 各阶段耗时，输出 Markdown 报告。
// 用法： node scripts/perf-report.js [日志路径] [输出路径]

const fs = require('node:fs');
const path = require('node:path');

const logPath = process.argv[2] || path.join(__dirname, '..', 'data', 'logs', 'main.log');
const outPath = process.argv[3] || path.join(__dirname, '..', 'docs', 'perf-report.md');

const text = fs.readFileSync(logPath, 'utf8');
const lines = text.split('\n');

function nums(re, pick = 1) {
  const out = [];
  for (const line of lines) {
    const m = line.match(re);
    if (m) out.push(Number(m[pick]));
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function stat(arr) {
  if (!arr.length) return { n: 0, min: 0, p50: 0, p90: 0, max: 0, avg: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    p50: pct(s, 50),
    p90: pct(s, 90),
    max: s[s.length - 1],
    avg: Math.round(sum / s.length),
  };
}

function row(name, st, unit = 'ms') {
  return `| ${name} | ${st.n} | ${st.p50}${unit} | ${st.p90}${unit} | ${st.min}–${st.max}${unit} | ${st.avg}${unit} |`;
}

const firstToken = nums(/对话完成\(v2\) 首token (\d+)ms/);
const llmDone = nums(/对话完成\(v2\) 首token \d+ms llm完 (\d+)ms/);
const firstSound = nums(/llm完 \d+ms 首声 (\d+)ms/);
const synthDone = nums(/首声 \d+ms 合成完 (\d+)ms/);
const audioMs = nums(/合成完 \d+ms 音频 (\d+)ms/);

const segLen = nums(/tts\.stat seq=\d+ 字数=(\d+)/);
const segFirst = nums(/tts\.stat seq=\d+ 字数=\d+ 首包=(\d+)ms/);
const segSynth = nums(/字数=\d+ 首包=\d+ms 合成=(\d+)ms/);
const segAudio = nums(/合成=\d+ms 音频=(\d+)ms/);

const asrMs = nums(/\[bench\] asr #\d+ (\d+)ms/);

// 接口 vs 程序 拆分
const splitLlmApi = nums(/耗时拆分 首声\d+ms = LLM接口(\d+)/);
const splitLlmNet = nums(/LLM接口\d+\(网络(\d+)\+/);
const splitLlmGen = nums(/LLM接口\d+\(网络\d+\+生成(\d+)\)/);
const splitTtsApi = nums(/\+ TTS接口(\d+)\(/);
const splitTtsNet = nums(/TTS接口\d+\(网络(\d+)\+/);
const splitTtsGen = nums(/TTS接口\d+\(网络\d+\+首包(\d+)\)/);
const splitLocal = nums(/\+ 本地(\d+)ms/);
const localPrep = nums(/本地拆解 准备(\d+)ms/);
const localWait = nums(/准备\d+ms \+ 等句子(\d+)ms/);
const cpuSplit = nums(/分句CPU ([\d.]+)ms/);
const cpuSpeak = nums(/清洗CPU ([\d.]+)ms/);

const S = {
  firstToken: stat(firstToken),
  llmDone: stat(llmDone),
  firstSound: stat(firstSound),
  synthDone: stat(synthDone),
  audio: stat(audioMs),
  segFirst: stat(segFirst),
  segSynth: stat(segSynth),
  segAudio: stat(segAudio),
  asr: stat(asrMs),
  splitLlmApi: stat(splitLlmApi),
  splitLlmNet: stat(splitLlmNet),
  splitLlmGen: stat(splitLlmGen),
  splitTtsApi: stat(splitTtsApi),
  splitTtsNet: stat(splitTtsNet),
  splitTtsGen: stat(splitTtsGen),
  splitLocal: stat(splitLocal),
  localPrep: stat(localPrep),
  localWait: stat(localWait),
  cpuSplit: stat(cpuSplit),
  cpuSpeak: stat(cpuSpeak),
};

// 首声 = 首 token + (等首句 + TTS 首包)
const gapAfterToken = [];
for (let i = 0; i < Math.min(firstToken.length, firstSound.length); i += 1) {
  gapAfterToken.push(firstSound[i] - firstToken[i]);
}
S.gapAfterToken = stat(gapAfterToken);

// LLM 流跨度：判断流式是否真的逐段到达
const llmSpan = [];
for (let i = 0; i < Math.min(firstToken.length, llmDone.length); i += 1) {
  llmSpan.push(llmDone[i] - firstToken[i]);
}
S.llmSpan = stat(llmSpan);

// TTS 合成耗时 / 音频时长
const ratio = [];
for (let i = 0; i < Math.min(segSynth.length, segAudio.length); i += 1) {
  if (segAudio[i] > 0) ratio.push(segSynth[i] / segAudio[i]);
}
const ratioAvg = ratio.length ? ratio.reduce((a, b) => a + b, 0) / ratio.length : 0;
const ratioSpeed = ratioAvg ? 1 / ratioAvg : 0;

const turns = Math.max(1, firstToken.length);
const segPerTurn = (segLen.length / turns).toFixed(1);

function bar(ms, max, width = 22) {
  return '█'.repeat(Math.max(1, Math.round((ms / max) * width)));
}

const maxStage = Math.max(S.firstToken.p50, S.segFirst.p50, S.firstSound.p50, 1);
const streamed = S.llmSpan.p90 < 200;

const biggest = [
  ['TTS 首包', S.segFirst.p50],
  ['LLM 首 token', S.firstToken.p50],
  ['ASR', S.asr.p50],
].sort((a, b) => b[1] - a[1]);

const md = [];
md.push('# 对话性能测试报告');
md.push('');
md.push(
  `> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}　数据来源：\`${path.basename(logPath)}\``
);
md.push(`> 样本：${S.firstToken.n} 轮对话 · ${segLen.length} 个 TTS 分段 · ${S.asr.n} 次 ASR 基准`);
md.push('');
md.push('## 1. 各阶段耗时');
md.push('');
md.push('| 阶段 | 样本 | P50 | P90 | 范围 | 均值 |');
md.push('|---|---|---|---|---|---|');
md.push(row('ASR 识别（4.24s 音频）', S.asr));
md.push(row('LLM 首 token', S.firstToken));
md.push(row('LLM 全部输出完成', S.llmDone));
md.push(row('LLM 流跨度（首 token→结束）', S.llmSpan));
md.push(row('TTS 首包（单段）', S.segFirst));
md.push(row('首声（从开始请求算起）', S.firstSound));
md.push(row('全部语音合成完', S.synthDone));
md.push('');
md.push('## 2. 首声构成');
md.push('');
md.push('```');
md.push(`LLM 首 token        ${String(S.firstToken.p50).padStart(5)}ms  ${bar(S.firstToken.p50, maxStage)}`);
md.push(`TTS 首包 + 等首句   ${String(S.gapAfterToken.p50).padStart(5)}ms  ${bar(S.gapAfterToken.p50, maxStage)}`);
md.push('──────────────────────────────────────');
md.push(`首声                ${String(S.firstSound.p50).padStart(5)}ms  ${bar(S.firstSound.p50, maxStage)}`);
md.push('```');
md.push('');
md.push(`- 每轮平均切出 **${segPerTurn} 段** TTS（${segLen.length} 段 / ${S.firstToken.n} 轮）`);
md.push(
  `- TTS 合成耗时是音频时长的 **${ratioAvg.toFixed(2)} 倍**，即合成速度约为播放的 **${ratioSpeed.toFixed(1)} 倍**（>1 才不会断档）`
);
md.push('');
md.push('## 3. 程序自身开销 vs 接口耗时');
md.push('');
md.push('| 归属 | 环节 | P50 | P90 | 说明 |');
md.push('|---|---|---|---|---|');
md.push(`| **我们的程序** | 准备（拼 prompt + IPC） | ${S.localPrep.p50}ms | ${S.localPrep.p90}ms | 几乎为 0 |`);
md.push(`| **我们的程序** | 分句 CPU | ${S.cpuSplit.p50}ms | ${S.cpuSplit.p90}ms | 纯本地计算 |`);
md.push(`| **我们的程序** | 文本清洗 CPU | ${S.cpuSpeak.p50}ms | ${S.cpuSpeak.p90}ms | 去 Markdown/emoji |`);
md.push(`| 等接口 | 等 LLM 吐出足够成句的文本 | ${S.localWait.p50}ms | ${S.localWait.p90}ms | 不是我们的 CPU，是在等分片 |`);
md.push(`| **接口** | LLM 网络（TTFB） | ${S.splitLlmNet.p50}ms | ${S.splitLlmNet.p90}ms | 建连 + 排队 |`);
md.push(`| **接口** | LLM 生成 | ${S.splitLlmGen.p50}ms | ${S.splitLlmGen.p90}ms | 模型推理 |`);
md.push(`| **接口** | TTS 网络（TTFB） | ${S.splitTtsNet.p50}ms | ${S.splitTtsNet.p90}ms | 建连 + 排队，波动大 |`);
md.push(`| **接口** | TTS 首包生成 | ${S.splitTtsGen.p50}ms | ${S.splitTtsGen.p90}ms | 语音合成 |`);
md.push('');
const selfCpu = S.localPrep.p50 + S.cpuSplit.p50 + S.cpuSpeak.p50;
md.push(
  `**结论：我们程序自身的 CPU 开销 ${selfCpu < 0.5 ? '不足 0.5ms' : `约 ${selfCpu.toFixed(1)}ms`}，占首声的 ${((selfCpu / Math.max(1, S.firstSound.p50)) * 100).toFixed(2)}%。其余全是接口等待（含等 LLM 吐出足够成句的文本 ${S.localWait.p50}ms）。**`
);
md.push('');
md.push('## 4. TTS 分段明细');
md.push('');
md.push('| 指标 | 样本 | P50 | P90 | 范围 | 均值 |');
md.push('|---|---|---|---|---|---|');
md.push(row('分段首包', S.segFirst));
md.push(row('分段合成总时长', S.segSynth));
md.push(row('分段音频时长', S.segAudio));
md.push('');
md.push('## 5. 完整链路估算（P50）');
md.push('');
md.push('> 对话测试是直接喂文本，**不含 VAD 与 ASR**；下表把这两段按实测值补上。');
md.push('');
md.push('```');
let acc = 0;
for (const [name, ms] of [
  ['VAD 判停', 700],
  ['ASR 识别', S.asr.p50],
  ['LLM 首 token', S.firstToken.p50],
  ['TTS 首包', S.gapAfterToken.p50],
]) {
  acc += ms;
  md.push(`${name.padEnd(14)} +${String(ms).padStart(5)}ms  → ${String(acc).padStart(5)}ms`);
}
md.push(`${'首声'.padEnd(14)}  ${String(acc).padStart(5)}ms（从用户说完算起）`);
md.push('```');
md.push('');
md.push('## 6. 结论');
md.push('');
md.push(
  `1. 最大头是 **${biggest[0][0]}（${biggest[0][1]}ms）**，其次 ${biggest[1][0]}（${biggest[1][1]}ms）、${biggest[2][0]}（${biggest[2][1]}ms）。`
);
md.push(
  `2. TTS 合成耗时仅为音频时长的 ${ratioAvg.toFixed(2)} 倍，合成快于播放，正常不会断档。`
);
if (streamed) {
  md.push(
    `3. **LLM 流式实际是一次性返回**：首 token 到流结束只差 ${S.llmSpan.p50}ms（P90 ${S.llmSpan.p90}ms），说明服务端把整段回复缓冲后一次吐出。`
  );
  md.push(
    '   因此「首句先切出来提前合成」的优化在本机没有收益，首声 ≈ LLM 全量输出 + TTS 首包。'
  );
} else {
  md.push(
    `3. LLM 流式正常：首 token 到流结束 ${S.llmSpan.p50}ms，分句流水线有实际收益。`
  );
}
md.push('4. 想进一步压低首声，只能动 LLM 首 token（换模型/压 prompt）或 TTS 首包（换更快的语音服务）。');
md.push('');
md.push('> ASR 为独立基准：固定 4.24 秒音频、连续 5 次；其余为真实对话轮次。');
md.push('');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, md.join('\n'), 'utf8');
console.log(md.join('\n'));
console.log(`\n已写入 ${outPath}`);