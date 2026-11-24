# 对话引擎 v2 · 架构图（Mermaid）

> 全部为文本定义。VS Code 预览需要装 **Markdown Preview Mermaid Support** 扩展（`bierner.markdown-mermaid`）才能渲染代码块；
> 若不想装扩展，下面每节都附了**已渲染的 PNG**，可直接查看。
>
> 重新生成图片：见 `scripts/mermaid-render/README.md`。

## 1. 数据流

![数据流](assets/v2-flow.png)

```mermaid
flowchart LR
    subgraph R["渲染进程"]
        MIC["麦克风 + VAD<br/>700ms 判停"]
        BUF["顺序缓冲<br/>pushAudio(seq)"]
        PLAY["AudioContext<br/>24kHz PCM16"]
        VID["视频切换<br/>idle / speaking"]
    end

    subgraph M["主进程"]
        ASR["ASR 适配器"]
        ENG["DialogueEngine<br/>runTurn()"]
        SPLIT["SentenceSplitter<br/>标点/24字"]
        POOL["TtsPool<br/>并发上限 2"]
        BUS["ReplyEventBus"]
    end

    subgraph C["云端"]
        DS["DeepSeek<br/>LLM + ASR"]
        MI["MiMo<br/>TTS"]
    end

    MIC -->|"asr:transcribe<br/>PCM16 16k"| ASR
    ASR -->|userText| ENG
    ENG -->|"messages"| DS
    DS -->|"token 流"| ENG
    ENG --> SPLIT
    SPLIT -->|"逐句"| POOL
    POOL <-->|"PCM16 流"| MI
    POOL -->|"audio{seq,pcm}"| BUS
    BUS -->|"reply:event"| BUF
    BUF --> PLAY
    PLAY --> VID
    VID -->|"首个音频块到达"| VID
```

## 2. 单轮时序（含实测耗时）

![时序图](assets/v2-sequence.png)

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant R as 渲染进程
    participant M as 主进程
    participant D as DeepSeek
    participant X as MiMo

    U->>R: 说话
    Note over R: VAD 判停 700ms
    R->>M: asr:transcribe（PCM16 16k，整段）
    M->>D: POST /v1/tools/asr
    D-->>M: text（607–670ms）
    M->>D: POST /chat/completions（stream:true）
    D-->>M: token 流（首 token 387–1275ms）
    Note over M: 剥离开头 [emotion:xxx]
    Note over M: 切句 → seq++ → acquire()
    M->>X: 逐句 TTS（format=pcm16, stream:true）
    X-->>M: SSE delta.audio.data（首包 550–816ms）
    M-->>R: reply:event audio{seq,pcm}
    Note over R: 按 seq 缓冲，当前句立即播
    R-->>U: 首声（实测 1049–2124ms）
    Note over R: 首个音频块到达 → 切 speaking
    X-->>M: 后续句子音频块
    M-->>R: audio / audio-end
    Note over R: 队列排空 +900ms → 切 idle
```

## 3. UML 类图

![UML 类图](assets/v2-class.jpg)

```mermaid
classDiagram
    direction LR

    class VoiceCapture {
        <<component>>
        -stream: MediaStream
        -vadThreshold: number
        +start()
        +onFrame(float32)
        +commitSpeech() PCM16
    }

    class AudioPlayer {
        <<component>>
        -ctx: AudioContext
        -nextPlayAt: number
        -playingCount: number
        +pushAudio(seq, pcm)
        +advanceAudio()
        +enqueuePcm(buf)
    }

    class VideoSwitcher {
        <<component>>
        -activeVideo: vA 或 vB
        -idleTimer: Timeout
        +playStateVideo(state)
        +swapVideo(url)
    }

    class TurnController {
        <<service>>
        -currentTurnAbort: AbortController
        -history: Message[]
        +chatTurnV2(text) TurnResult
    }

    class DialogueEngine {
        <<service>>
        -maxConcurrent: 2
        -seq: number
        -emotion: string
        +runTurn(opts) TurnResult
        -enqueueSentence(s)
        -startTts(s, seq)
    }

    class TtsPool {
        <<utility>>
        -active: number
        -waiters: Promise[]
        +acquire()
        +release()
    }

    class SentenceSplitter {
        <<utility>>
        -MARKS: string
        -maxLen: 24
        +split(text, force) string[]
        +speakable(text) string
    }

    class ReplyEventBus {
        <<channel>>
        -win: BrowserWindow
        +send(type, payload)
    }

    class LlmAdapter {
        <<interface>>
        +stream(req) AsyncIterable
    }

    class TtsAdapter {
        <<interface>>
        +caps: TtsCaps
        +synth(req) AsyncIterable
    }

    class AsrAdapter {
        <<interface>>
        +transcribe(req) AsrResult
    }

    class OpenAiLlmAdapter {
        -baseUrl: string
        -model: string
        +stream(req)
    }

    class MimoTtsAdapter {
        -voice: string
        -format: pcm16
        +synth(req)
    }

    class DeepseekTtsAdapter {
        -voiceId: string
        +synth(req)
    }

    class MimoAsrAdapter {
        -language: zh
        +transcribe(req)
    }

    class DeepseekAsrAdapter {
        -endpoint: /v1/tools/asr
        +transcribe(req)
    }

    class ProviderConfig {
        <<dataclass>>
        +llm
        +tts
        +asr
        +defaults()
    }

    class SecretStore {
        <<utility>>
        -ref: deepseek 或 mimo
        +getKey(ref) string
        +setKey(ref, key)
        +hasKey(ref) boolean
    }

    LlmAdapter <|.. OpenAiLlmAdapter
    TtsAdapter <|.. MimoTtsAdapter
    TtsAdapter <|.. DeepseekTtsAdapter
    AsrAdapter <|.. MimoAsrAdapter
    AsrAdapter <|.. DeepseekAsrAdapter

    TurnController *-- DialogueEngine
    DialogueEngine *-- TtsPool
    DialogueEngine --> SentenceSplitter
    DialogueEngine --> ReplyEventBus
    DialogueEngine --> LlmAdapter
    DialogueEngine --> TtsAdapter
    TurnController --> SecretStore
    TurnController --> ProviderConfig
    ReplyEventBus ..> AudioPlayer : reply:event
    AudioPlayer ..> VideoSwitcher
    VoiceCapture ..> AsrAdapter : asr:transcribe
```

## 4. 回合状态机

![状态机](assets/v2-state.png)

```mermaid
stateDiagram-v2
    [*] --> 待机

    待机 --> 聆听: 常开麦克风
    聆听 --> 识别: VAD 判停（700ms 静音）
    识别 --> 待机: 文本为空 / 噪声
    识别 --> 思考: 拿到 userText

    思考 --> 说话: 首句成型 → 首个音频块
    思考 --> 待机: LLM 失败（兜底台词）

    说话 --> 说话: 后续句子音频到达
    说话 --> 待机: 队列排空 +900ms

    说话 --> 打断: 用户开口（VAD 触发）
    思考 --> 打断: 用户开口
    打断 --> 聆听: abort 全部流 + 清空队列

    note right of 说话
        idle 视频 ↔ speaking 视频
        按 audio 到达切换
    end note
```

## 5. 现状标注

![问题分析](assets/v2-issues.png)

```mermaid
flowchart TD
    A["症状：太慢"] --> A1["LLM 首 token 400–1300ms<br/>（不可控，需换模型或压 prompt）"]
    A --> A2["MiMo 首包固定 ~700ms<br/>（不可控）"]

    B["症状：断续"] --> B1["逗号即切句 → 一句拆 2–4 次请求"]
    B1 --> B2["短句音频 0.5–1s < 合成延迟 0.7s"]
    B2 --> B3["队列排空后重新起播 → 空档"]

    C["症状：语气像拼的"] --> C1["每句独立合成，语气各自重新起头"]

    D["症状：嘴和声音不同步"] --> D1["按 audio 到达切 speaking<br/>而非按实际出声时间"]
    D --> D2["两句间隔 >900ms 会切回 idle 再切回"]
```
