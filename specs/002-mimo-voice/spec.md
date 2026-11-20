# 桌面女伴 v2 · MiMo 语音与流式对话引擎（Spec）

| 项 | 内容 |
|---|---|
| 文档 ID | SPEC-002 |
| 版本 | v2.0（草案） |
| 状态 | Draft |
| 日期 | 2026-11-20 |
| 上游规格 | SPEC-001 v1.3（v1 已实现并可用，本版不推翻它） |
| 产品代号 | `desktop-companion` · 引擎 v2 |
| 后续文档 | `plan-v2.md`、`tasks-v2.md` |

---

## 1. 背景

v1 已跑通：常开聆听 → DeepSeek ASR → DeepSeek LLM → DeepSeek TTS → 播放，122 套装扮、全屏壁纸、双视频（张嘴/闭嘴）。

三个问题促使做 v2：

1. **三路能力被绑死在一家**。LLM 想换更聪明的、TTS 想换更好听的、ASR 想换更准的，现在改一处要动三处。
2. **TTS 不流式**。v1 是「整句合成完再播」，首声要等 1.1–1.3 秒；MiMo 提供低延迟流式，能边合成边播。
3. **声音没有表演**。v1 的 TTS 只有固定音色，情绪标签只影响画面。MiMo 支持 `(怅然)`、`[轻笑]` 这类标签与自然语言风格指令，可以让"她"的语气跟着情绪走。

**核心判断**：v2 的价值不在于换供应商，而在于**把「文本流 → 语音流」打通**，让第一声和第一句话之间的空档消失。

---

## 2. 目标与非目标

### 2.1 目标

- G-1 LLM / ASR / TTS 三路**各自独立配置**：可分别指向不同供应商、不同模型、不同密钥。
- G-2 TTS 走**流式**：音频分块到达即播放，不等整句合成完（MiMo 为首选实现）。
- G-3 情绪驱动音色：LLM 输出的情绪映射成 MiMo 的语音风格标签，随回复生效。
- G-4 打断仍然 ≤ 300ms，且能取消在途的 LLM/TTS 流。
- G-5 v1 的装扮、壁纸、聆听、收藏、播放方式全部保留，不回归。
- G-6 首声延迟 P50 ≤ 1.2s（v1 为 2.8–4.6s 的端到端，首声更晚）。

### 2.2 非目标

| 编号 | 非目标 | 原因 |
|---|---|---|
| NG-1 | 音色克隆 / 音色设计 | MiMo 支持，但需要用户提供样本与授权，P2 再评估 |
| NG-2 | 唱歌模式 | 与陪伴场景无关 |
| NG-3 | 多角色同时在线 | 单角色多装扮的结构不变 |
| NG-4 | 本地模型 | 继续用云端 |
| NG-5 | 改变 v1 的视觉与衣橱 | 只换"嘴和声音" |
| NG-6 | 精确口型同步 | 视频预渲染，MiMo 不返回 viseme |

---

## 3. 关键约束（来自供应商实际能力）

| 能力 | MiMo 现状 | 对设计的影响 |
|---|---|---|
| TTS 端点 | `POST /v1/chat/completions` | 不是 OpenAI `/audio/speech`，适配器必须单独实现 |
| 文本位置 | 待读文本在 `assistant` 消息 | 每句一次请求，`assistant.content` 放句子正文 |
| 风格位置 | `user` 消息放自然语言；正文可插 `(标签)` | 情绪可以直接拼进正文开头，无需额外字段 |
| 流式输出 | `stream:true` + `audio.format:"pcm16"` | 返回 SSE，`choices[].delta.audio.data` 为 base64 |
| 音频格式 | 24kHz / PCM16LE / 单声道 | 与 v1 的播放器一致，无需重采样 |
| 文本输入 | **整段**（不能边生成边追加） | 必须按句切分后再请求，不能把 LLM token 直接灌给 TTS |
| ASR | 同端点，`mimo-v2.5-asr`，`input_audio` data URL | 音频走 base64，wav/mp3，≤10MB |
| ASR 语种 | `asr_options.language` ∈ {auto, zh, en} | 可显式指定 zh，比 DeepSeek 的"自动识别"可控 |

**最重要的约束**：MiMo TTS 是**流式输出、非流式输入**。所以引擎的形态是"句子级流水线"，不是"token 级管道"。

---

## 4. 供应商与适配器

### 4.1 三路解耦

| 通路 | 候选实现 | 默认 |
|---|---|---|
| LLM | DeepSeek `deepseek-chat`、MiMo 文本模型、任意 OpenAI 兼容 | 沿用现有 DeepSeek |
| ASR | DeepSeek `v1/tools/asr`、MiMo `mimo-v2.5-asr` | 新增 MiMo 可选 |
| TTS | DeepSeek `v1/tools/tts`、MiMo `mimo-v2.5-tts` | **MiMo（v2 重点）** |

每一路独立配置：`baseUrl` / `model` / `apiKey`（各自独立密钥，也允许共用）/ `voice` / 超时 / 并发。

### 4.2 适配器契约（能力声明式）

```
LlmAdapter
  stream(messages, opts) -> AsyncIterable<textDelta>
  caps: { streaming: boolean, jsonMode: boolean }

AsrAdapter
  transcribe(audioBytes, mime, opts) -> { text, durationMs }
  caps: { streaming: boolean, languageHint: boolean }

TtsAdapter
  synth(text, style, opts) -> AsyncIterable<audioChunk>   // PCM16 / 24kHz / mono
  caps: { streaming: boolean, styleTags: boolean, styleText: boolean, formats: [...] }
```

**能力必须显式声明**，引擎按 `caps` 决定策略：

- `TtsAdapter.caps.streaming = false`（如 DeepSeek）→ 回落到"整句合成后播放"，行为等同 v1。
- `TtsAdapter.caps.streaming = true`（MiMo）→ 边收边播，首包即出声。
- `caps.styleTags = true` → 引擎把情绪拼成 `(温柔)` 前缀；否则只影响画面。

### 4.3 MiMo TTS 请求形状

```
POST {baseUrl}/chat/completions
Authorization: Bearer {key}

{
  "model": "mimo-v2.5-tts",
  "messages": [
    { "role": "user", "content": "<可选：整体风格指令>" },
    { "role": "assistant", "content": "<情绪标签>要朗读的句子" }
  ],
  "audio": { "voice": "冰糖", "format": "pcm16" },
  "stream": true
}
```

响应为 SSE，音频在 `choices[].delta.audio.data`（base64，PCM16LE 24kHz mono）。流结束时拼接即为完整音频。

### 4.4 MiMo ASR 请求形状

```
POST {baseUrl}/chat/completions
{
  "model": "mimo-v2.5-asr",
  "messages": [{ "role": "user", "content": [
      { "type": "input_audio",
        "input_audio": { "data": "data:audio/wav;base64,..." } } ]}],
  "asr_options": { "language": "zh" }
}
```

---

## 5. 对话引擎 v2（核心重设计）

### 5.1 流水线

```
[常开麦克风]
   │ VAD 判停
   ▼
[ASR] ──► userText
   │
   ▼
[LLM 流式] ──► token 流
   │  ①首行剥离情绪标记 ②按标点/长度切句
   ▼
[句子队列] ──► 每次取一句
   │
   ▼
[TTS 流式] ──► 音频块（24k PCM16）
   │  到达即入播放队列
   ▼
[播放器] ──► 声卡
```

**与 v1 的差别**：v1 是「整句合成 → 播放 → 下一句」；v2 是「句子 1 的音频还在流式到达时，句子 2 已经在合成」，播放队列连续供料。

### 5.2 并发与背压

- 同时最多 **2 条** TTS 流在跑（一句在播、一句在合成）。
- 句子队列长度上限 3；超过则**暂停读取 LLM 流**（真正的背压），避免积压导致打断延迟变长。
- 打断时：取消 LLM 读取 + 关闭所有 TTS 流 + 清空播放队列 + 清空句子队列。

### 5.3 情绪 → 声音

| LLM 情绪 | MiMo 标签 | 说明 |
|---|---|---|
| neutral | 平静 | 默认 |
| happy | 轻快 | 语速略快 |
| shy | 害羞 | 音量偏小 |
| worried | 关切 | 语速略慢 |
| sad | 低落 | 低沉 |
| curious | 好奇 | 语调上扬 |
| playful | 俏皮 | 轻快、带笑 |

- 标签拼在 `assistant.content` 开头：`(轻快)今天过得怎么样？`
- 若 TTS 不支持标签，则忽略，仅驱动画面。

### 5.4 事件模型（引擎 → 界面）

| 事件 | 负载 | 用途 |
|---|---|---|
| `asr.final` | text, ms | 显示"你说的" |
| `llm.first` | ms | 首字延迟埋点 |
| `llm.delta` | text | 打字机字幕 |
| `llm.emotion` | emotion | 表情/动作 |
| `tts.first` | ms | 首声延迟埋点 |
| `tts.chunk` | pcm | 播放 |
| `turn.done` | 分段耗时 | 收尾、切回 idle 视频 |
| `turn.aborted` | reason | 打断 |
| `turn.error` | stage, code, message | 降级 |

### 5.5 音频

- 统一 **PCM16 / 24kHz / 单声道**（MiMo 原生输出，DeepSeek 也是 24k，无需重采样）。
- 播放器：环形缓冲 + `AudioContext` 定时调度，块间不加间隔。
- 双视频联动沿用 v1：`tts.first` → 切「张嘴」；`turn.done` + 900ms 防抖 → 切「闭嘴」。

---

## 6. 延迟预算（MiMo 流式）

| 段 | v1 实测 | v2 目标 | v2 实测（2026-11-20） |
|---|---|---|---|
| VAD 判停 | 700ms | 700ms | — |
| ASR | 600ms | 600ms | 未测（账户 402，见 §12） |
| LLM 首 token | 400–800ms | 400–800ms | 沿用 v1 |
| 首句成型 | +300ms | +200ms | 待测 |
| TTS 首包 | 1100ms（整句） | 300–500ms | **660 / 1034 / 658ms（三次）** |
| **首声合计** | **≈3.1–4.0s** | **≈2.0–2.8s** | 预计 2.4–3.2s |

**修正**：TTS 首包实测 660–1030ms，高于最初估计的 300–500ms。流式的收益来自「不用等整句合成完」，而不是首包更快。**首声预算按 2.4–3.2s 重估**。

进一步优化（P1）：首句压到 8 字以内、LLM 优先输出短句，可再省 200–300ms。

---

## 7. 配置

```json
{
  "providers": {
    "llm": { "kind": "deepseek", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat", "keyRef": "llm" },
    "asr": { "kind": "mimo", "baseUrl": "https://api.xiaomimimo.com/v1", "model": "mimo-v2.5-asr", "language": "zh", "keyRef": "asr" },
    "tts": { "kind": "mimo", "baseUrl": "https://api.xiaomimimo.com/v1", "model": "mimo-v2.5-tts", "voice": "冰糖", "format": "pcm16", "keyRef": "tts" }
  },
  "engine": "v2",
  "emotionStyle": true,
  "maxConcurrentTts": 2
}
```

- 三路可分别配置密钥（`keyRef` 指向系统凭据里的条目）。
- 密钥继续用 `safeStorage`（DPAPI）存储，明文永不落盘。
- `engine: "v1" | "v2"` 允许回退到旧引擎，便于对比与救急。

---

## 8. 错误与降级

| 场景 | 行为 |
|---|---|
| TTS 流中断（已有部分音频） | 播完已到的块，剩余句改用非流式重试一次，再失败则只显示文字 |
| TTS 401/额度耗尽 | 终止本轮，界面提示，切回 idle 视频，不重试 |
| TTS 返回空音频 | 跳过该句继续下一句，不中断整轮 |
| ASR 失败 | 提示"没听清"，回到聆听 |
| LLM 失败 | 用预设兜底台词（沿用 v1） |
| 供应商不支持流式 | 按 `caps` 回落整句合成，行为等同 v1 |

---

## 9. 验收标准

| ID | 标准 | 方法 |
|---|---|---|
| SC-201 | 首声延迟 P50 ≤ 1.2s、P90 ≤ 2.0s（从松手算） | 内置分段计时，20 轮 |
| SC-202 | 打断后 300ms 内静音，且不再有残留音频 | 录音回放 |
| SC-203 | 三路可独立切换供应商，切换后无需改代码 | 配置切换后各跑 3 轮 |
| SC-204 | 句间空档 ≤ 150ms | 波形分析 |
| SC-205 | 情绪标签生效：同句不同情绪，听感可区分 | 人工盲听 6 句 |
| SC-206 | 连续 20 轮无自激回声、无重复播报 | 实测 + 日志 |
| SC-207 | v1 功能不回归：装扮/收藏/播放方式/全屏/双视频 | 回归清单逐项 |

---

## 10. 交付形态

- 同一代码库，新增 `engine v2` 与 `providers/` 适配层；`engine: "v1"` 可回退。
- 打包仍为绿色版 zip；v2 作为独立的构建产物（`桌面陪伴-v2-win64.zip`），可与 v1 并存安装。
- 默认供应商组合：**LLM=DeepSeek、ASR=MiMo、TTS=MiMo**（用户可改）。

---

## 11. 开放问题

| ID | 问题 | 默认 |
|---|---|---|
| Q-1 | 音色选哪个（冰糖 / 茉莉） | 冰糖（更中性、耐听） |
| Q-2 | 是否要「声音克隆」作为 P2 | 暂不做 |
| Q-3 | MiMo 文本模型是否作为 LLM 备选 | 预留适配器，暂不启用 |
| Q-4 | 三路是否共用一个 Key | 默认共用，支持分开 |

---

## 12. 接口实测记录（2026-11-20）

用真实 Key 跑通的结果，作为实现依据。

### TTS 流式

```
POST https://api.xiaomimimo.com/v1/chat/completions
{ "model":"mimo-v2.5-tts",
  "messages":[{"role":"assistant","content":"(轻快)今天过得怎么样呀？"}],
  "audio":{"voice":"冰糖","format":"pcm16"}, "stream":true }

→ HTTP 200  text/event-stream
→ 首个 chunk: choices[0].delta.audio = null（只有 role）
→ 音频块:     choices[0].delta.audio.data = base64(PCM16LE 24k mono)
→ 5 个块 / 76800 字节 ≈ 1.6s
```

**关键点**：首个 SSE 分片的 `audio` 是 `null`，必须先判空再取 `data`，否则会崩。

### 首包延迟（3 次，同一句）

| 次 | 首包 | 音频时长 | RMS |
|---|---|---|---|
| 1 | 672ms | 2.40s | 0.098 |
| 2 | 1034ms | 1.92s | 0.168 |
| 3 | 658ms | 2.88s | 0.113 |

RMS 0.1–0.17，确认是真人声而非静音。

### TTS 非流式

```
"stream": false, "audio":{"format":"wav"}
→ HTTP 200, 1082ms, 99884 字节 wav（choices[0].message.audio.data）
```

### ASR

```
POST 同一端点, model=mimo-v2.5-asr
messages[0].content = [{type:'input_audio', input_audio:{data:'data:audio/wav;base64,...'}}]
asr_options = {language:'zh'}

→ HTTP 402 {"code":"402","message":"Insufficient account balance","type":"insufficient_balance"}
```

**阻塞项**：账户余额不足以调用 ASR。在充值或确认额度之前，ASR 继续用 DeepSeek，TTS 用 MiMo。

### 实现要求（由实测得出）

1. SSE 解析必须容忍 `delta.audio === null`（首片）。
2. 音频块大小不固定，播放器要按到达顺序直接入队，不能假设定长。
3. TTS 首个音频块约 0.7–1.0 秒，**首句必须短**（≤12 字）才能把首声压进 3 秒。
4. 流式期间若用户打断，直接 `AbortController.abort()` 断开连接，已收到的块丢弃。
