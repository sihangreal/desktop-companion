// 五张图的 Mermaid 源码（与 docs/engine-v2-diagrams.md 保持一致）
module.exports = [
  {
    name: 'v2-flow',
    zoom: 1,
    code: `flowchart LR
    subgraph R["渲染进程"]
        direction TB
        MIC["麦克风 + VAD<br/>700ms 判停"]
        BUF["顺序缓冲<br/>pushAudio seq"]
        PLAY["AudioContext<br/>24kHz PCM16"]
        VID["视频切换<br/>idle / speaking"]
    end
    subgraph M["主进程"]
        direction TB
        ASR["ASR 适配器"]
        ENG["DialogueEngine<br/>runTurn()"]
        SPLIT["SentenceSplitter"]
        POOL["TtsPool<br/>并发上限 2"]
        BUS["ReplyEventBus"]
    end
    subgraph C["云端"]
        direction TB
        DS["DeepSeek<br/>LLM + ASR"]
        MI["MiMo<br/>TTS"]
    end
    MIC -->|asr:transcribe| ASR
    ASR -->|userText| ENG
    ENG <-->|token 流| DS
    ENG --> SPLIT
    SPLIT -->|逐句| POOL
    POOL <-->|PCM16 流| MI
    POOL -->|audio seq| BUS
    BUS -->|reply:event| BUF
    BUF --> PLAY
    PLAY --> VID`,
  },
  {
    name: 'v2-sequence',
    zoom: 1,
    code: `sequenceDiagram
    autonumber
    participant U as 用户
    participant R as 渲染进程
    participant M as 主进程
    participant D as DeepSeek
    participant X as MiMo
    U->>R: 说话
    Note over R: VAD 判停 700ms
    R->>M: asr:transcribe PCM16 16k
    M->>D: POST /v1/tools/asr
    D-->>M: text 607-670ms
    M->>D: POST /chat/completions stream
    D-->>M: token 流 首token 387-1275ms
    Note over M: 剥离 emotion 标记 切句 seq++
    M->>X: 逐句 TTS pcm16 stream
    X-->>M: delta.audio.data 首包 550-816ms
    M-->>R: reply:event audio seq pcm
    Note over R: 按 seq 缓冲 当前句立即播
    Note over R: 首个音频块到达 切 speaking
    R-->>U: 首声 1049-2124ms
    X-->>M: 后续句子音频块
    M-->>R: audio / audio-end
    Note over R: 队列排空 +900ms 切 idle`,
  },
  {
    name: 'v2-class',
    zoom: 0.72,
    code: `classDiagram
    direction LR
    class VoiceCapture {
        <<component>>
        +start()
        +onFrame(float32)
        +commitSpeech() PCM16
    }
    class AudioPlayer {
        <<component>>
        +pushAudio(seq, pcm)
        +advanceAudio()
        +enqueuePcm(buf)
    }
    class VideoSwitcher {
        <<component>>
        +playStateVideo(state)
        +swapVideo(url)
    }
    class TurnController {
        <<service>>
        +chatTurnV2(text) TurnResult
    }
    class DialogueEngine {
        <<service>>
        -maxConcurrent: 2
        -seq: number
        +runTurn(opts) TurnResult
        -enqueueSentence(s)
        -startTts(s, seq)
    }
    class TtsPool {
        <<utility>>
        +acquire()
        +release()
    }
    class SentenceSplitter {
        <<utility>>
        +split(text, force) string[]
        +speakable(text) string
    }
    class ReplyEventBus {
        <<channel>>
        +send(type, payload)
    }
    class LlmAdapter {
        <<interface>>
        +stream(req) AsyncIterable
    }
    class TtsAdapter {
        <<interface>>
        +synth(req) AsyncIterable
    }
    class AsrAdapter {
        <<interface>>
        +transcribe(req) AsrResult
    }
    class OpenAiLlmAdapter {
        -model: string
        +stream(req)
    }
    class MimoTtsAdapter {
        -voice: string
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
        +transcribe(req)
    }
    class ProviderConfig {
        <<dataclass>>
        +llm
        +tts
        +asr
    }
    class SecretStore {
        <<utility>>
        +getKey(ref) string
        +setKey(ref, key)
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
    ReplyEventBus ..> AudioPlayer
    AudioPlayer ..> VideoSwitcher
    VoiceCapture ..> AsrAdapter`,
  },
  {
    name: 'v2-state',
    zoom: 1,
    code: `stateDiagram-v2
    [*] --> 待机
    待机 --> 聆听: 常开麦克风
    聆听 --> 识别: VAD 判停 700ms
    识别 --> 思考: 拿到 userText
    识别 --> 待机: 文本为空
    思考 --> 说话: 首句音频到达
    说话 --> 说话: 后续句子
    说话 --> 待机: 队列排空 +900ms
    说话 --> 打断: 用户开口
    思考 --> 打断: 用户开口
    打断 --> 聆听: abort + 清空队列`,
  },
  {
    name: 'v2-issues',
    zoom: 1,
    code: `flowchart TD
    A["症状：太慢"] --> A1["LLM 首 token 400-1300ms"]
    A --> A2["MiMo 首包固定 700ms"]
    B["症状：断续"] --> B1["逗号即切句 一句拆 2-4 次请求"]
    B1 --> B2["短句音频 0.5-1s 小于合成延迟 0.7s"]
    B2 --> B3["队列排空后重新起播 出现空档"]
    C["症状：语气像拼的"] --> C1["每句独立合成 语气各自起头"]
    D["症状：嘴和声音不同步"] --> D1["按到达时间切 speaking 非出声时间"]
    D --> D2["两句间隔超 900ms 会来回闪"]`,
  },
];
